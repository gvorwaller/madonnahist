/**
 * OCR Worker — two-stage pipeline:
 *   1. page_ocr:    Google Vision full-page → per-cell ocr_runs + enqueue llm_cleanup jobs
 *   2. llm_cleanup: Claude Vision per-cell crop + Google Vision text → llm_draft_runs
 *
 * Usage: npx tsx --env-file=.env backend/workers/ocr-worker.ts [flags]
 *   --limit=N             Process at most N jobs (across both stages)
 *   --page-id=N           Process only jobs for this page
 *   --dry-run             Claim jobs but skip API calls
 *   --stage=page_ocr      Run only the page OCR stage
 *   --stage=llm_cleanup   Run only the LLM cleanup stage
 *   --retry-stale-minutes=N  Re-claim in_progress jobs older than N minutes (default 10)
 *   --show-prompt            Print the assembled cleanup prompt and exit
 */
import sharp from 'sharp';
import Anthropic from '@anthropic-ai/sdk';
import { query, withClient, withTransaction, shutdown } from './lib/db.js';
import { getObject, getApiKey } from './lib/spaces.js';
import { cropRegion } from '../../src/lib/image/crop.js';
import { transcribeFullPage, mapWordsToCells, wordsToText, type WordBox } from '../../src/lib/ocr/vendors/google-vision.js';
import crypto from 'crypto';

const MAX_ATTEMPTS = 3;
const STALE_MINUTES = Number(process.argv.find(a => a.startsWith('--retry-stale-minutes='))?.split('=')[1] ?? 10);
const LIMIT = Number(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] ?? 0);
const PAGE_ID_FILTER = process.argv.find(a => a.startsWith('--page-id='))?.split('=')[1];
const DRY_RUN = process.argv.includes('--dry-run');
const SHOW_PROMPT = process.argv.includes('--show-prompt');
const STAGE_FILTER = process.argv.find(a => a.startsWith('--stage='))?.split('=')[1] as 'page_ocr' | 'llm_cleanup' | undefined;
const PROMPT_REFRESH_INTERVAL = 50;

interface PromptCache {
	prompt: string;
	version: string;
	jobsSinceRefresh: number;
}

let promptCache: PromptCache | null = null;

async function buildCleanupPrompt(): Promise<{ prompt: string; version: string }> {
	const vocabRes = await query<{ term: string; category: string; context_note: string | null }>(
		`SELECT term, category, context_note FROM ocr_vocabulary WHERE is_active = true ORDER BY category, term`
	);

	const lexRes = await query<{ ocr_token: string; corrected_token: string; frequency: number }>(
		`SELECT ocr_token, corrected_token, frequency FROM correction_lexicon WHERE frequency >= 2 ORDER BY frequency DESC LIMIT 50`
	);

	const notationRes = await query<{ input_shorthand: string; canonical_form: string; meaning: string }>(
		`SELECT input_shorthand, canonical_form, meaning FROM notation_key ORDER BY id`
	);

	const byCategory = new Map<string, string[]>();
	for (const row of vocabRes.rows) {
		const entry = row.context_note ? `${row.term} (${row.context_note})` : row.term;
		if (!byCategory.has(row.category)) byCategory.set(row.category, []);
		byCategory.get(row.category)!.push(entry);
	}

	const categoryLabels: Record<string, string> = {
		person: 'Names', activity: 'Activities', place: 'Places', term: 'Terms'
	};

	let contextBlock = 'FAMILY CONTEXT (common names and terms in this calendar):\n';
	for (const [cat, label] of Object.entries(categoryLabels)) {
		const items = byCategory.get(cat);
		if (items && items.length > 0) {
			contextBlock += `${label}: ${items.join(', ')}\n`;
		}
	}
	contextBlock += 'Weight entries appear as numbers like "114", "125 lb"';

	let notationBlock = '';
	if (notationRes.rows.length > 0) {
		notationBlock = '\n\nNOTATION SYMBOLS (shorthand used in the calendar):\n' +
			notationRes.rows.map(r => `"${r.input_shorthand}" (or "${r.canonical_form}") means "${r.meaning}" — always expand to the full word`).join('\n');
	}

	let lexiconBlock = '';
	if (lexRes.rows.length > 0) {
		lexiconBlock = '\n\nKNOWN OCR ERRORS (the handwriting OCR often misreads these):\n' +
			lexRes.rows.map(r => `"${r.ocr_token}" → "${r.corrected_token}"`).join('\n');
	}

	const prompt =
		'You are cleaning up a machine-generated OCR transcript of one handwritten calendar day entry.\n\n' +
		'You will receive:\n' +
		'1. The raw OCR text (from Google Vision) — noisy but character-level accurate\n' +
		'2. An image of the handwritten entry for visual verification\n\n' +
		contextBlock +
		notationBlock +
		lexiconBlock +
		'\n\nINSTRUCTIONS:\n' +
		'- Fix obvious OCR errors using the image and family context\n' +
		'- Preserve the original line breaks and structure\n' +
		'- If you cannot confidently read a word, keep the OCR version and add [?] after it\n' +
		'- Do NOT add content that isn\'t in the handwriting\n' +
		'- Do NOT add headers, labels, markdown, or commentary\n' +
		'- Output ONLY the cleaned transcription text';

	const hash = crypto.createHash('sha256').update(prompt).digest('hex').slice(0, 8);
	const version = `dynamic-v1-${hash}`;

	return { prompt, version };
}

async function getCleanupPrompt(): Promise<{ prompt: string; version: string }> {
	if (promptCache && promptCache.jobsSinceRefresh < PROMPT_REFRESH_INTERVAL) {
		promptCache.jobsSinceRefresh++;
		return { prompt: promptCache.prompt, version: promptCache.version };
	}

	const result = await buildCleanupPrompt();
	promptCache = { ...result, jobsSinceRefresh: 0 };
	log(`Prompt loaded: ${result.version} (${result.prompt.length} chars)`);
	return result;
}

function log(msg: string) {
	console.log(`[OCR] ${msg}`);
}

interface ClaimedJob {
	id: number;
	job_type: string;
	payload: Record<string, unknown>;
}

interface DayInfo {
	id: number;
	entry_date: string;
	grid_row: number | null;
	grid_col: number | null;
	crop_bounds: { x: number; y: number; width: number; height: number } | null;
}

// ─── Job claiming ───

async function claimJobs(jobType: string): Promise<ClaimedJob[]> {
	return withClient(async (client) => {
		await client.query('BEGIN');
		const params: unknown[] = [MAX_ATTEMPTS, jobType];
		let filterClause = '';
		if (PAGE_ID_FILTER) {
			filterClause = ` AND payload->>'page_id' = $3`;
			params.push(PAGE_ID_FILTER);
		}
		const limitClause = LIMIT > 0 ? ` LIMIT ${LIMIT}` : '';

		const res = await client.query<{ id: number; job_type: string; payload: Record<string, unknown> }>(
			`SELECT id, job_type, payload FROM job_runs
			  WHERE job_type = $2
			    AND ((status = 'pending') OR (status = 'in_progress' AND started_at < NOW() - INTERVAL '${STALE_MINUTES} minutes'))
			    AND attempts < $1
			    ${filterClause}
			  ORDER BY enqueued_at ${limitClause}
			  FOR UPDATE SKIP LOCKED`,
			params
		);

		if (res.rows.length === 0) {
			await client.query('COMMIT');
			return [];
		}

		await client.query(
			`UPDATE job_runs SET status = 'in_progress', started_at = NOW(), attempts = attempts + 1
			  WHERE id = ANY($1)`, [res.rows.map(r => r.id)]
		);
		await client.query('COMMIT');
		return res.rows;
	});
}

// ─── Stage 1: Google Vision full-page OCR ───

async function runPageOcr() {
	log('Stage 1: Google Vision full-page OCR');

	const gvApiKey = await getApiKey('google_vision', 'API_KEY', 'GOOGLE_VISION_API_KEY');
	const jobs = await claimJobs('page_ocr');
	if (jobs.length === 0) { log('  No pending page_ocr jobs'); return; }
	log(`  Claimed ${jobs.length} page_ocr job(s)`);

	let succeeded = 0, failed = 0;

	for (const job of jobs) {
		const pageId = job.payload.page_id as number;
		const jobGridVersion = job.payload.grid_version as number | undefined;

		try {
			const pageRes = await query<{
				page_image_path: string; grid_version: number;
				warped_image_path: string | null; grid_lines: { xLines: number[]; yLines: number[] } | null;
			}>(`SELECT page_image_path, grid_version, warped_image_path, grid_lines
			      FROM calendar_pages WHERE id = $1`, [pageId]);

			if (!pageRes.rows[0]) {
				await query(`UPDATE job_runs SET status='failed', last_error='page not found', completed_at=NOW() WHERE id=$1`, [job.id]);
				failed++;
				continue;
			}

			const page = pageRes.rows[0];

			// Grid version stale check
			if (jobGridVersion !== undefined && jobGridVersion < page.grid_version) {
				log(`  page ${pageId}: STALE grid_version=${jobGridVersion} < ${page.grid_version}, skipping`);
				await query(`UPDATE job_runs SET status='canceled', completed_at=NOW(), last_error='stale grid version' WHERE id=$1`, [job.id]);
				continue;
			}

			if (!page.grid_lines) {
				await query(`UPDATE job_runs SET status='failed', last_error='no grid_lines on page', completed_at=NOW() WHERE id=$1`, [job.id]);
				failed++;
				continue;
			}

			const imagePath = page.warped_image_path ?? page.page_image_path;
			log(`  page ${pageId}: downloading ${imagePath}${page.warped_image_path ? ' (warped)' : ''}`);

			const rawImage = await getObject(imagePath);
			const imageBuffer = await sharp(rawImage)
				.rotate()
				.grayscale()
				.normalize()
				.sharpen({ sigma: 1.5 })
				.jpeg({ quality: 95 })
				.toBuffer();
			log(`    ${(imageBuffer.length / 1024 / 1024).toFixed(1)} MB`);

			if (DRY_RUN) {
				log(`    [DRY] would send to Google Vision`);
				await query(`UPDATE job_runs SET status='pending', started_at=NULL WHERE id=$1`, [job.id]);
				continue;
			}

			// Google Vision full-page OCR
			const gvResult = await transcribeFullPage({ apiKey: gvApiKey }, imageBuffer);
			log(`    Google Vision: ${gvResult.words.length} words, ${gvResult.latencyMs}ms, conf=${gvResult.pageConfidence?.toFixed(2) ?? 'n/a'}`);

			// Map words to grid cells
			const { xLines, yLines } = page.grid_lines;
			const cellWordMap = mapWordsToCells(gvResult.words, xLines, yLines);

			// Get days for this page
			const dayRes = await query<DayInfo>(
				`SELECT id, entry_date::text AS entry_date, grid_row, grid_col, crop_bounds
				   FROM calendar_days WHERE page_id = $1 ORDER BY entry_date`, [pageId]
			);

			const gridLinesHash = crypto.createHash('md5')
				.update(JSON.stringify({ xLines, yLines }))
				.digest('hex')
				.slice(0, 8);

			await withTransaction(async (client) => {
				const ocrRunIds = new Map<number, number>();

				for (const day of dayRes.rows) {
					if (day.grid_row === null || day.grid_col === null) continue;

					const cellKey = `${day.grid_row},${day.grid_col}`;
					const cellWords = cellWordMap.get(cellKey) ?? [];
					const cellText = wordsToText(cellWords);
					const cellConfidence = cellWords.length > 0
						? cellWords.reduce((sum, w) => sum + w.confidence, 0) / cellWords.length
						: null;

					const cellBoxes = cellWords.map(w => ({
						text: w.text,
						confidence: w.confidence,
						cx: w.cx, cy: w.cy,
						minX: w.minX, maxX: w.maxX,
						minY: w.minY, maxY: w.maxY
					}));

					const vendorMeta = {
						method: 'google-vision-full-page',
						grid_version: page.grid_version,
						warped_image_path: imagePath,
						gridLinesHash,
						wordCount: cellWords.length,
						wordBoxes: cellBoxes,
						pageLatencyMs: gvResult.latencyMs,
						pageTotalWords: gvResult.words.length,
						emptyReason: cellWords.length === 0 ? 'no_words_in_cell' : undefined
					};

					const ins = await client.query<{ id: number }>(
						`INSERT INTO ocr_runs (day_id, vendor, source_image_path, raw_text, confidence_score, vendor_meta, created_by_job_run_id)
						 VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7) RETURNING id`,
						[day.id, 'google-vision', imagePath, cellText, cellConfidence,
						 JSON.stringify(vendorMeta), job.id]
					);
					ocrRunIds.set(day.id, ins.rows[0].id);

					const preview = cellText.length > 60
						? cellText.slice(0, 57).replace(/\n/g, ' ') + '...'
						: cellText.replace(/\n/g, ' ');
					log(`    day ${day.entry_date} (${cellKey}): ${cellWords.length} words ${cellText === '' ? '[EMPTY]' : `"${preview}"`}`);
				}

				// Enqueue llm_cleanup jobs for each day
				for (const day of dayRes.rows) {
					if (day.grid_row === null || day.grid_col === null) continue;
					const ocrRunId = ocrRunIds.get(day.id);
					if (!ocrRunId) continue;

					await client.query(
						`INSERT INTO job_runs (job_type, payload)
						 VALUES ('llm_cleanup', $1::jsonb)`,
						[JSON.stringify({
							day_id: day.id,
							page_id: pageId,
							ocr_run_id: ocrRunId,
							grid_version: page.grid_version
						})]
					);
				}

				// Mark page_ocr job done
				await client.query(
					`UPDATE job_runs SET status='done', completed_at=NOW(), last_error=NULL WHERE id=$1`, [job.id]
				);
			});

			log(`    page ${pageId}: ${dayRes.rows.length} ocr_runs + llm_cleanup jobs created`);
			succeeded++;

		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			log(`  page ${pageId}: FAILED: ${msg}`);
			await query(`UPDATE job_runs SET status='failed', last_error=$2, completed_at=NOW() WHERE id=$1`,
				[job.id, msg.slice(0, 500)]);
			failed++;
		}
	}

	log(`Stage 1 complete: ${succeeded} succeeded, ${failed} failed`);
}

// ─── Stage 2: Claude LLM cleanup ───

async function runLlmCleanup() {
	log('Stage 2: Claude LLM cleanup');

	const anthropicKey = process.env.ANTHROPIC_API_KEY;
	if (!anthropicKey) throw new Error('ANTHROPIC_API_KEY not set');
	const anthropic = new Anthropic({ apiKey: anthropicKey });
	const model = 'claude-sonnet-4-6';

	const jobs = await claimJobs('llm_cleanup');
	if (jobs.length === 0) { log('  No pending llm_cleanup jobs'); return; }
	log(`  Claimed ${jobs.length} llm_cleanup job(s)`);

	// Group by page to share the downloaded image
	const pageGroups = new Map<number, ClaimedJob[]>();
	for (const job of jobs) {
		const pid = job.payload.page_id as number;
		if (!pageGroups.has(pid)) pageGroups.set(pid, []);
		pageGroups.get(pid)!.push(job);
	}

	let succeeded = 0, failed = 0;

	for (const [pageId, pageJobs] of pageGroups) {
		const pageRes = await query<{
			page_image_path: string; grid_version: number;
			warped_image_path: string | null;
		}>(`SELECT page_image_path, grid_version, warped_image_path
		      FROM calendar_pages WHERE id = $1`, [pageId]);

		if (!pageRes.rows[0]) {
			for (const j of pageJobs) {
				await query(`UPDATE job_runs SET status='failed', last_error='page not found', completed_at=NOW() WHERE id=$1`, [j.id]);
			}
			failed += pageJobs.length;
			continue;
		}

		const page = pageRes.rows[0];
		const imagePath = page.warped_image_path ?? page.page_image_path;
		log(`  page ${pageId}: downloading ${imagePath}`);

		let pageBuffer: Buffer;
		try {
			const raw = await getObject(imagePath);
			pageBuffer = await sharp(raw)
				.rotate()
				.grayscale()
				.normalize()
				.sharpen({ sigma: 1.5 })
				.toBuffer();
		} catch (err) {
			log(`    download failed: ${err instanceof Error ? err.message : err}`);
			for (const j of pageJobs) {
				await query(`UPDATE job_runs SET status='failed', last_error='image download failed', completed_at=NOW() WHERE id=$1`, [j.id]);
			}
			failed += pageJobs.length;
			continue;
		}

		for (const job of pageJobs) {
			const dayId = job.payload.day_id as number;
			const ocrRunId = job.payload.ocr_run_id as number;
			const jobGridVersion = job.payload.grid_version as number | undefined;

			try {
				// Grid version stale check
				if (jobGridVersion !== undefined && jobGridVersion < page.grid_version) {
					log(`    day_id=${dayId}: STALE grid_version=${jobGridVersion} < ${page.grid_version}`);
					await query(`UPDATE job_runs SET status='canceled', completed_at=NOW(), last_error='stale grid version' WHERE id=$1`, [job.id]);
					continue;
				}

				// Get the OCR run text
				const ocrRes = await query<{ raw_text: string }>(
					`SELECT raw_text FROM ocr_runs WHERE id = $1`, [ocrRunId]
				);
				if (!ocrRes.rows[0]) {
					await query(`UPDATE job_runs SET status='failed', last_error='ocr_run not found', completed_at=NOW() WHERE id=$1`, [job.id]);
					failed++;
					continue;
				}
				const ocrText = ocrRes.rows[0].raw_text;

				// Get day info for crop + date context
				const dayRes = await query<DayInfo>(
					`SELECT id, entry_date::text AS entry_date, grid_row, grid_col, crop_bounds
					   FROM calendar_days WHERE id = $1`, [dayId]
				);
				if (!dayRes.rows[0] || !dayRes.rows[0].crop_bounds) {
					await query(`UPDATE job_runs SET status='failed', last_error='day not found or no crop_bounds', completed_at=NOW() WHERE id=$1`, [job.id]);
					failed++;
					continue;
				}
				const day = dayRes.rows[0];

				// Crop the cell from the page image
				const cellBuffer = await cropRegion(pageBuffer, day.crop_bounds!);
				const cellJpeg = await sharp(cellBuffer)
					.grayscale()
					.normalize()
					.sharpen({ sigma: 1.5 })
					.jpeg({ quality: 95 })
					.toBuffer();

				if (DRY_RUN) {
					log(`    [DRY] day_id=${dayId} (${day.entry_date}) ocr="${ocrText.slice(0, 50).replace(/\n/g, ' ')}..."`);
					await query(`UPDATE job_runs SET status='pending', started_at=NULL WHERE id=$1`, [job.id]);
					continue;
				}

				// Skip Claude call if OCR returned empty
				if (ocrText.trim() === '') {
					const { version: emptyPromptVersion } = await getCleanupPrompt();
					await withTransaction(async (client) => {
						await client.query(
							`INSERT INTO llm_draft_runs (day_id, based_on_ocr_run_id, model_name, prompt_version, draft_text, confidence_note, created_by_job_run_id)
							 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
							[dayId, ocrRunId, model, emptyPromptVersion, '', 'empty cell — no OCR text to clean', job.id]
						);
						await client.query(`UPDATE job_runs SET status='done', completed_at=NOW() WHERE id=$1`, [job.id]);
					});
					log(`    day_id=${dayId} (${day.entry_date}) [EMPTY — skipped Claude]`);
					succeeded++;
					continue;
				}

				// Build the prompt with date context
				const { prompt: cleanupPrompt, version: promptVersion } = await getCleanupPrompt();
				const dateLabel = new Date(day.entry_date + 'T00:00:00').toLocaleDateString('en-US', {
					weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
				});

				const fullPrompt =
					`${cleanupPrompt}\n\n` +
					`DATE: ${dateLabel}\n\n` +
					`RAW OCR TEXT:\n${ocrText}`;

				const imageB64 = cellJpeg.toString('base64');
				const start = performance.now();

				const response = await anthropic.messages.create({
					model,
					max_tokens: 1024,
					messages: [{
						role: 'user',
						content: [
							{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageB64 } },
							{ type: 'text', text: fullPrompt }
						]
					}]
				});

				const latencyMs = Math.round(performance.now() - start);
				const draftText = response.content
					.filter((b): b is Anthropic.TextBlock => b.type === 'text')
					.map(b => b.text)
					.join('\n')
					.trim();

				const confidenceNote = `Claude ${model}, ${latencyMs}ms, ${response.usage.input_tokens}+${response.usage.output_tokens} tokens`;

				await withTransaction(async (client) => {
					await client.query(
						`INSERT INTO llm_draft_runs (day_id, based_on_ocr_run_id, model_name, prompt_version, draft_text, confidence_note, created_by_job_run_id)
						 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
						[dayId, ocrRunId, model, promptVersion, draftText, confidenceNote, job.id]
					);
					await client.query(`UPDATE job_runs SET status='done', completed_at=NOW() WHERE id=$1`, [job.id]);
				});

				const preview = draftText.length > 60
					? draftText.slice(0, 57).replace(/\n/g, ' ') + '...'
					: draftText.replace(/\n/g, ' ');
				log(`    day_id=${dayId} (${day.entry_date}) ${latencyMs}ms "${preview}"`);
				succeeded++;

			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				if (/429|500|502|503|overloaded/i.test(msg)) {
					log(`    day_id=${dayId} TRANSIENT: ${msg}`);
				} else {
					log(`    day_id=${dayId} FAILED: ${msg}`);
					await query(`UPDATE job_runs SET status='failed', last_error=$2, completed_at=NOW() WHERE id=$1`,
						[job.id, msg.slice(0, 500)]);
					failed++;
				}
			}
		}
	}

	log(`Stage 2 complete: ${succeeded} succeeded, ${failed} failed`);
}

// ─── Main ───

async function main() {
	log('OCR Worker — two-stage pipeline');

	if (SHOW_PROMPT) {
		const { prompt, version } = await buildCleanupPrompt();
		console.log(`\n=== Cleanup Prompt (${version}) ===\n`);
		console.log(prompt);
		console.log(`\n=== ${prompt.length} chars ===`);
		return;
	}

	if (DRY_RUN) log('DRY RUN');

	if (!STAGE_FILTER || STAGE_FILTER === 'page_ocr') {
		await runPageOcr();
	}
	if (!STAGE_FILTER || STAGE_FILTER === 'llm_cleanup') {
		await runLlmCleanup();
	}
}

main()
	.catch(err => { console.error('[OCR] Fatal:', err); process.exitCode = 1; })
	.finally(() => shutdown());
