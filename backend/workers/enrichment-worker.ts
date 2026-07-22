/**
 * Enrichment Worker — Phase D of
 * docs/2026-07-21-next-phases-search-viewer-narrative-plan.md.
 *
 * Job types:
 *   entity_extract    — implemented here: reads an accepted day's corrected
 *                        text + day_narrative, asks Claude for mentioned
 *                        people/places/events and suggested topical tags,
 *                        and replaces that day's AI-sourced day_entities /
 *                        day_tags rows in one transaction.
 *   narrative_summary — NOT implemented until Phase E. Claimed jobs are
 *                        immediately marked 'failed' with an explanatory
 *                        note so a stray enqueue can't wedge the queue
 *                        (endless pending/in_progress churn).
 *
 * Cloned from backend/workers/ocr-worker.ts's skeleton (claimJobs via
 * SELECT ... FOR UPDATE SKIP LOCKED, --daemon poll loop, heartbeat via
 * app_state, MAX_ATTEMPTS retry cap) with two hardening changes called out
 * in the plan's review:
 *
 *   - CLAIM_BATCH_CAP is a hard-coded ceiling on how many jobs a single
 *     claim query can take, independent of --limit. ocr-worker's claimJobs
 *     has no SQL LIMIT unless --limit is passed; a --backfill enqueue of
 *     every accepted day followed by an unbounded claim would grab the
 *     whole backlog in one go and could still be "in_progress" when the
 *     next poll's stale-retry window opens, double-processing jobs that
 *     are actually still running. Capping the claim keeps each batch inside
 *     one poll's real wall-clock time.
 *   - Distinct heartbeat key ('enrichment_worker_heartbeat') — the OCR
 *     worker owns app_state.worker_heartbeat exclusively; sharing it would
 *     make the two workers indistinguishable on /admin/system-health.
 *
 * Usage: npx tsx --env-file=.env backend/workers/enrichment-worker.ts [flags]
 *   --limit=N     Cap how many jobs a single claim batch takes (still bounded
 *                 by CLAIM_BATCH_CAP regardless of this value)
 *   --dry-run     Claim jobs but skip the LLM call and any writes
 *   --daemon      Run as persistent queue poller (for PM2)
 *   --backfill    Enqueue entity_extract for every currently-accepted day
 *                 that lacks a pending/in_progress job, then exit
 */
import { query, withClient, withTransaction, shutdown } from './lib/db.js';
import { completeJson } from './lib/llm.js';
import { slugifyTagLabel, isValidTagLabel, MAX_TAG_LABEL_LENGTH } from '../../src/lib/server/tags.js';

const MAX_ATTEMPTS = 3;
const CLAIM_BATCH_CAP = 5;
const ENTITY_EXTRACT_STALE_MINUTES = 10;
const NARRATIVE_SUMMARY_STALE_MINUTES = 30;

const LIMIT = Number(process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? 0);
const DRY_RUN = process.argv.includes('--dry-run');
const DAEMON = process.argv.includes('--daemon');
const BACKFILL = process.argv.includes('--backfill');
const DAEMON_POLL_MS = 5000;

function log(msg: string) {
	console.log(`[Enrichment] ${msg}`);
}

interface ClaimedJob {
	id: number;
	job_type: string;
	payload: Record<string, unknown>;
}

// ─── Job claiming ───

async function claimJobs(jobType: string, staleMinutes: number): Promise<ClaimedJob[]> {
	const batchSize = LIMIT > 0 ? Math.min(LIMIT, CLAIM_BATCH_CAP) : CLAIM_BATCH_CAP;

	return withClient(async (client) => {
		await client.query('BEGIN');

		const res = await client.query<{ id: number; job_type: string; payload: Record<string, unknown> }>(
			`SELECT id, job_type, payload FROM job_runs
			  WHERE job_type = $2
			    AND ((status = 'pending') OR (status = 'in_progress' AND started_at < NOW() - ($3 * INTERVAL '1 minute')))
			    AND attempts < $1
			  ORDER BY enqueued_at
			  LIMIT ${batchSize}
			  FOR UPDATE SKIP LOCKED`,
			[MAX_ATTEMPTS, jobType, staleMinutes]
		);

		if (res.rows.length === 0) {
			await client.query('COMMIT');
			return [];
		}

		await client.query(
			`UPDATE job_runs SET status = 'in_progress', started_at = NOW(), attempts = attempts + 1
			  WHERE id = ANY($1)`,
			[res.rows.map((r) => r.id)]
		);
		await client.query('COMMIT');
		return res.rows;
	});
}

// ─── entity_extract ───

const ENTITY_EXTRACT_SYSTEM = `You are extracting structured mentions from one day's entry in a family history calendar archive spanning roughly the 1960s to the present.

Read the corrected transcription (and any narrative note) for a single day and identify:
1. Entities actually named in the text: people (by name), places (specific named locations), and events (named occasions — birthdays, holidays, specific trips).
2. Suggested topical tags: short, general, reusable labels describing what the day was about (e.g. "birthday", "travel", "illness", "church").

Respond with ONLY a JSON object of this exact shape:
{
  "entities": [ { "type": "person" | "place" | "event", "name": "string", "confidence": number between 0 and 1 } ],
  "tags": [ { "label": "string", "confidence": number between 0 and 1 } ]
}

Rules:
- Use each person's actual name as written, not a pronoun or bare relationship title.
- Omit anything you are not reasonably confident is actually named in the text — never invent an entity.
- Keep tag labels short (1-3 words) and general enough to reuse across many days.
- If nothing qualifies for a field, return an empty array for it.`;

interface RawEntity {
	type?: unknown;
	name?: unknown;
	confidence?: unknown;
}
interface RawTag {
	label?: unknown;
	confidence?: unknown;
}
interface EntityExtractResult {
	entities?: RawEntity[];
	tags?: RawTag[];
}

interface SanitizedEntity {
	type: 'person' | 'place' | 'event';
	name: string;
	confidence: number | null;
}
interface SanitizedTag {
	label: string;
	confidence: number | null;
}

function clampConfidence(c: unknown): number | null {
	const n = Number(c);
	if (!Number.isFinite(n)) return null;
	return Math.min(1, Math.max(0, n));
}

function sanitizeEntities(raw: unknown): SanitizedEntity[] {
	if (!Array.isArray(raw)) return [];
	const out: SanitizedEntity[] = [];
	for (const e of raw as RawEntity[]) {
		const type = e?.type;
		const name = typeof e?.name === 'string' ? e.name.trim() : '';
		if (name === '') continue;
		if (name.length > MAX_TAG_LABEL_LENGTH) continue;
		if (type !== 'person' && type !== 'place' && type !== 'event') continue;
		out.push({ type, name, confidence: clampConfidence(e?.confidence) });
	}
	return out;
}

function sanitizeTags(raw: unknown): SanitizedTag[] {
	if (!Array.isArray(raw)) return [];
	const out: SanitizedTag[] = [];
	for (const t of raw as RawTag[]) {
		const label = typeof t?.label === 'string' ? t.label.trim() : '';
		if (!isValidTagLabel(label)) continue;
		out.push({ label, confidence: clampConfidence(t?.confidence) });
	}
	return out;
}

interface DayRow {
	id: number;
	entry_date: string;
	correction_status: string;
	corrected_text: string | null;
	day_narrative: string | null;
}

async function processEntityExtract(job: ClaimedJob): Promise<void> {
	const dayId = job.payload.day_id as number | undefined;
	const payloadCorrectionId = (job.payload.correction_id as number | null | undefined) ?? null;

	if (typeof dayId !== 'number') {
		await query(`UPDATE job_runs SET status='failed', last_error='payload missing day_id', completed_at=NOW() WHERE id=$1`, [job.id]);
		log(`  job ${job.id}: FAILED (payload missing day_id)`);
		return;
	}

	try {
		const dayRes = await query<DayRow>(
			`SELECT id, entry_date::text AS entry_date, correction_status, corrected_text, day_narrative
			   FROM calendar_days WHERE id = $1`,
			[dayId]
		);
		const day = dayRes.rows[0];
		if (!day) {
			await query(`UPDATE job_runs SET status='failed', last_error='day not found', completed_at=NOW() WHERE id=$1`, [job.id]);
			log(`  day_id=${dayId}: FAILED (not found)`);
			return;
		}

		// Staleness guard (Phase D item 4): re-read the day and skip unless it
		// is still accepted AND the payload's correction_id is still the
		// latest day_corrections row for it. A re-accept (new correction) or a
		// --backfill overlapping a fresh manual accept both land here safely
		// as a no-op rather than letting a stale job overwrite fresh AI rows.
		//
		// day_corrections.id is BIGSERIAL — node-pg returns int8 columns as JS
		// strings (to avoid precision loss beyond Number.MAX_SAFE_INTEGER),
		// while the JSONB payload's correction_id may be a genuine JS number
		// (when the day_corrections trigger built it via jsonb_build_object)
		// or a string (when --backfill's own pg round-trip produced it).
		// Comparing with strict `!==` across those representations gave a
		// false "stale" verdict for every single job during development.
		// Normalizing both sides through String() makes the comparison
		// representation-independent; String(null) === 'null' on both sides
		// when there's genuinely no correction yet, so that case still
		// matches too.
		const latestRes = await query<{ id: string | number }>(
			`SELECT id FROM day_corrections WHERE day_id = $1 ORDER BY created_at DESC LIMIT 1`,
			[dayId]
		);
		const latestCorrectionId = latestRes.rows[0]?.id ?? null;

		if (day.correction_status !== 'accepted' || String(latestCorrectionId) !== String(payloadCorrectionId)) {
			await query(
				`UPDATE job_runs SET status='done', last_error=$2, completed_at=NOW() WHERE id=$1`,
				[job.id, `skipped: not accepted or correction_id stale (payload=${payloadCorrectionId}, latest=${latestCorrectionId}, status=${day.correction_status})`]
			);
			log(`  day_id=${dayId}: SKIPPED (stale or not accepted)`);
			return;
		}

		if (DRY_RUN) {
			log(`  [DRY] day_id=${dayId} (${day.entry_date}) would extract entities`);
			await query(`UPDATE job_runs SET status='pending', started_at=NULL WHERE id=$1`, [job.id]);
			return;
		}

		const text = [day.corrected_text ?? '', day.day_narrative ?? ''].join('\n').trim();

		let entities: SanitizedEntity[] = [];
		let tags: SanitizedTag[] = [];

		if (text !== '') {
			const user =
				`DATE: ${day.entry_date}\n\n` +
				`CORRECTED TEXT:\n${day.corrected_text ?? ''}\n\n` +
				`DAY NARRATIVE:\n${day.day_narrative ?? ''}`;
			const result = await completeJson<EntityExtractResult>(ENTITY_EXTRACT_SYSTEM, user, 1536);
			entities = sanitizeEntities(result.entities);
			tags = sanitizeTags(result.tags);
		}

		await withTransaction(async (client) => {
			// Wholesale replace this day's AI-sourced rows — the worker's RLS
			// DELETE policy (0020_entity_enrichment.sql) restricts this to
			// source='ai' regardless of the WHERE clause, so a human tag or
			// entity link is structurally unreachable here.
			await client.query(`DELETE FROM day_entities WHERE day_id = $1 AND source = 'ai'`, [dayId]);
			await client.query(`DELETE FROM day_tags WHERE day_id = $1 AND source = 'ai'`, [dayId]);

			const seenEntityIds = new Set<number>();
			for (const e of entities) {
				const slug = slugifyTagLabel(e.name);
				if (slug === '') continue;

				await client.query(
					`INSERT INTO entities (slug, display_name, entity_type)
					 VALUES ($1, $2, $3)
					 ON CONFLICT (entity_type, slug) DO NOTHING`,
					[slug, e.name, e.type]
				);
				const entRes = await client.query<{ id: number }>(
					`SELECT id FROM entities WHERE entity_type = $1 AND slug = $2`,
					[e.type, slug]
				);
				const entityId = entRes.rows[0]?.id;
				if (!entityId || seenEntityIds.has(entityId)) continue;
				seenEntityIds.add(entityId);

				await client.query(
					`INSERT INTO day_entities (day_id, entity_id, source, confidence_score)
					 VALUES ($1, $2, 'ai', $3)
					 ON CONFLICT (day_id, entity_id) DO NOTHING`,
					[dayId, entityId, e.confidence]
				);
			}

			const seenTagSlugs = new Set<string>();
			for (const t of tags) {
				const slug = slugifyTagLabel(t.label);
				if (slug === '' || seenTagSlugs.has(slug)) continue;
				seenTagSlugs.add(slug);

				await client.query(
					`INSERT INTO day_tags (day_id, tag_slug, tag_label, source)
					 VALUES ($1, $2, $3, 'ai')
					 ON CONFLICT (day_id, tag_slug) DO NOTHING`,
					[dayId, slug, t.label]
				);
			}

			await client.query(`UPDATE job_runs SET status='done', completed_at=NOW() WHERE id=$1`, [job.id]);
		});

		log(`  day_id=${dayId} (${day.entry_date}): ${entities.length} entities, ${tags.length} tags`);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		log(`  day_id=${dayId} FAILED: ${msg}`);
		await query(`UPDATE job_runs SET status='failed', last_error=$2, completed_at=NOW() WHERE id=$1`, [job.id, msg.slice(0, 500)]);
	}
}

// ─── narrative_summary (not implemented until Phase E) ───

async function processNarrativeSummary(job: ClaimedJob): Promise<void> {
	await query(
		`UPDATE job_runs SET status='failed', last_error=$2, completed_at=NOW() WHERE id=$1`,
		[job.id, 'narrative_summary not implemented until Phase E']
	);
	log(`  job ${job.id}: narrative_summary not implemented until Phase E — marked failed`);
}

// ─── --backfill ───

async function runBackfill(): Promise<void> {
	log('Backfill: enqueueing entity_extract for accepted days lacking a pending/in_progress job');

	const res = await query<{ day_id: number; correction_id: string | number | null }>(
		`SELECT cd.id AS day_id, lc.correction_id
		   FROM calendar_days cd
		   LEFT JOIN LATERAL (
		     SELECT id AS correction_id FROM day_corrections
		      WHERE day_id = cd.id ORDER BY created_at DESC LIMIT 1
		   ) lc ON true
		  WHERE cd.correction_status = 'accepted'
		    AND NOT EXISTS (
		      SELECT 1 FROM job_runs
		       WHERE job_type = 'entity_extract'
		         AND status IN ('pending', 'in_progress')
		         AND (payload->>'day_id')::int = cd.id
		    )`
	);

	let count = 0;
	for (const row of res.rows) {
		// Normalize correction_id to a genuine JSON number — day_corrections.id
		// is BIGSERIAL and comes back from node-pg as a string; storing it
		// unconverted would embed a JSON string here while the day_corrections
		// trigger's own enqueue (0020_entity_enrichment.sql) always produces a
		// JSON number via jsonb_build_object. The staleness-guard comparison
		// in processEntityExtract() normalizes via String() on read either
		// way, but keeping the two payload producers consistent avoids
		// depending on that twice.
		const correctionId = row.correction_id === null ? null : Number(row.correction_id);
		await query(
			`INSERT INTO job_runs (job_type, payload) VALUES ('entity_extract', $1::jsonb)`,
			[JSON.stringify({ day_id: row.day_id, correction_id: correctionId })]
		);
		count++;
	}
	log(`Backfill: enqueued ${count} entity_extract job(s)`);
}

// ─── Main ───

async function runOnce(): Promise<number> {
	let processed = 0;

	const entityJobs = await claimJobs('entity_extract', ENTITY_EXTRACT_STALE_MINUTES);
	if (entityJobs.length > 0) log(`Claimed ${entityJobs.length} entity_extract job(s)`);
	for (const job of entityJobs) {
		await processEntityExtract(job);
		processed++;
	}

	const narrativeJobs = await claimJobs('narrative_summary', NARRATIVE_SUMMARY_STALE_MINUTES);
	if (narrativeJobs.length > 0) log(`Claimed ${narrativeJobs.length} narrative_summary job(s)`);
	for (const job of narrativeJobs) {
		await processNarrativeSummary(job);
		processed++;
	}

	return processed;
}

async function writeHeartbeat(): Promise<void> {
	try {
		const rss = Math.round(process.memoryUsage().rss / 1024 / 1024);
		await query(
			`INSERT INTO app_state (key, value, updated_at)
			 VALUES ('enrichment_worker_heartbeat', $1::jsonb, NOW())
			 ON CONFLICT (key) DO UPDATE SET value = $1::jsonb, updated_at = NOW()`,
			[JSON.stringify({ pid: process.pid, rss_mb: rss, last_poll: new Date().toISOString() })]
		);
	} catch { /* best-effort */ }
}

async function runDaemon(): Promise<void> {
	log('Enrichment Worker — daemon mode (persistent polling)');
	let shuttingDown = false;
	let pollCount = 0;

	const graceful = () => {
		if (shuttingDown) return;
		shuttingDown = true;
		log('Shutting down gracefully...');
	};
	process.on('SIGINT', graceful);
	process.on('SIGTERM', graceful);

	while (!shuttingDown) {
		try {
			const processed = await runOnce();
			await writeHeartbeat();

			pollCount++;
			if (pollCount % 60 === 0) {
				const mem = process.memoryUsage();
				log(`[MEM] rss=${Math.round(mem.rss / 1024 / 1024)}MB heap=${Math.round(mem.heapUsed / 1024 / 1024)}MB`);
			}

			if (processed === 0 && !shuttingDown) {
				await new Promise((r) => setTimeout(r, DAEMON_POLL_MS));
			}
		} catch (err) {
			log(`Poll error: ${err instanceof Error ? err.message : err}`);
			if (!shuttingDown) {
				await new Promise((r) => setTimeout(r, DAEMON_POLL_MS));
			}
		}
	}
}

async function main() {
	log('Enrichment Worker — entity_extract (narrative_summary stubbed until Phase E)');

	if (BACKFILL) {
		await runBackfill();
		return;
	}

	if (DRY_RUN) log('DRY RUN');

	if (DAEMON) {
		await runDaemon();
	} else {
		await runOnce();
	}
}

main()
	.catch((err) => { console.error('[Enrichment] Fatal:', err); process.exitCode = 1; })
	.finally(() => shutdown());
