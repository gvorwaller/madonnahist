/**
 * Enrichment Worker — Phase D of
 * docs/2026-07-21-next-phases-search-viewer-narrative-plan.md.
 *
 * Job types:
 *   entity_extract    — reads an accepted day's corrected text +
 *                        day_narrative, asks Claude for mentioned
 *                        people/places/events and suggested topical tags,
 *                        and replaces that day's AI-sourced day_entities /
 *                        day_tags rows in one transaction.
 *   narrative_summary — Phase E of the plan, reworked by td-f1f49b
 *                        (docs/2026-11-20-narrative-models-guidance-plan.md).
 *                        Payload {scope, scope_key, model?, mode?, base_text?,
 *                        style_guidance?, year_guidance?, requested_by?};
 *                        only scope='year' is implemented (decade/person
 *                        deferred, td-e25bd4). Gathers the year's accepted
 *                        days, asks the chosen model (Claude or Gemini) for a
 *                        faithful narrative steered by the admin's guidance,
 *                        and appends one candidate row to narrative_drafts.
 *                        It never writes narrative_summaries: migration 0033
 *                        revoked that, and the admin promotes a candidate
 *                        from /admin/narratives.
 *
 *   pdf_export        — Phase H of the plan. Payload
 *                        {scope: 'year', scope_key, requested_by, content_mode}
 *                        or (Gaylon, 2026-07-23) {scope: 'story', scope_key,
 *                        requested_by, content_mode: 'full'} — scope_key is
 *                        an adhoc_narratives id and content_mode is always
 *                        'full' for a story (no narrative/days split to
 *                        choose between). 'year' jobs are enqueued by admin
 *                        (src/routes/admin/exports/+page.server.ts); 'story'
 *                        jobs are auto-enqueued the moment an admin saves a
 *                        story (src/routes/admin/ask/+page.server.ts's save
 *                        action). Either way the worker issues a short-lived
 *                        scoped render token (src/lib/server/render-token.ts),
 *                        launches headless Chromium via playwright-core,
 *                        loads the book route (src/routes/app/book/[scope]/[key])
 *                        or the story route (src/routes/app/stories/[id])
 *                        with ?render=pdf carrying that token as a cookie,
 *                        prints to PDF, uploads it to Spaces
 *                        (backend/workers/lib/spaces.ts's putObject), and
 *                        records a pdf_exports row. Claimed ONE at a time
 *                        regardless of --limit (see claimJobs()'s
 *                        maxBatchOverride param) — Chromium is memory-heavy
 *                        on the shared droplet, so this is stricter than
 *                        CLAIM_BATCH_CAP below, not just subject to it.
 *
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
 *   --job-ids=1,2 Only claim these job_runs ids (any type). For tests and
 *                 for running one specific job by hand; without it, the
 *                 oldest jobs of each type are claimed as usual.
 */
import { query, withClient, withTransaction, shutdown } from './lib/db.js';
import { completeJson, completeNarrative } from './lib/llm.js';
import {
	DEFAULT_NARRATIVE_MODEL,
	MAX_GUIDANCE_LENGTH,
	MAX_NARRATIVE_LENGTH,
	findNarrativeModel,
	isNarrativeMode
} from '../../src/lib/narrative-models.js';
import { putObject } from './lib/spaces.js';
import { slugifyTagLabel, isValidTagLabel, MAX_TAG_LABEL_LENGTH } from '../../src/lib/server/tags.js';
import { ENTITY_DAY_LOCK_CLASS } from '../../src/lib/entity-locks.js';
import { issueRenderToken, RENDER_TOKEN_COOKIE_NAME } from '../../src/lib/server/render-token.js';
import { chromium, type Browser } from 'playwright-core';

const MAX_ATTEMPTS = 3;
const CLAIM_BATCH_CAP = 5;
const ENTITY_EXTRACT_STALE_MINUTES = 10;
const NARRATIVE_SUMMARY_STALE_MINUTES = 30;
const PDF_EXPORT_STALE_MINUTES = 10;

const LIMIT = Number(process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? 0);
const DRY_RUN = process.argv.includes('--dry-run');
const DAEMON = process.argv.includes('--daemon');
const BACKFILL = process.argv.includes('--backfill');
const JOB_IDS_ARG = process.argv.find((a) => a.startsWith('--job-ids='))?.split('=')[1];
const JOB_IDS: number[] | null = JOB_IDS_ARG === undefined ? null : JOB_IDS_ARG.split(',').filter(Boolean).map(Number);
if (JOB_IDS && (JOB_IDS.length === 0 || JOB_IDS.some((n) => !Number.isSafeInteger(n) || n <= 0))) {
	throw new Error(`--job-ids must be a comma-separated list of job ids, got ${JSON.stringify(JOB_IDS_ARG)}`);
}
const DAEMON_POLL_MS = 5000;

function log(msg: string) {
	console.log(`[Enrichment] ${msg}`);
}

interface ClaimedJob {
	id: number;
	job_type: string;
	payload: Record<string, unknown>;
	/** job_runs.attempts after this claim: identifies this attempt, so a
	 *  stale attempt (reclaimed after the stale timeout) can't finish a job
	 *  that a newer attempt now owns. */
	attempt: number;
}

// ─── Job claiming ───

/**
 * `maxBatchOverride`, when given, replaces the normal --limit/CLAIM_BATCH_CAP
 * calculation entirely rather than merely capping it — used by pdf_export
 * (passed 1) so a claim is always exactly one job regardless of --limit,
 * independent of and stricter than CLAIM_BATCH_CAP's existing role for the
 * other two job types.
 */
async function claimJobs(jobType: string, staleMinutes: number, maxBatchOverride?: number): Promise<ClaimedJob[]> {
	const batchSize = maxBatchOverride ?? (LIMIT > 0 ? Math.min(LIMIT, CLAIM_BATCH_CAP) : CLAIM_BATCH_CAP);

	return withClient(async (client) => {
		await client.query('BEGIN');

		// A job whose last allowed attempt went stale (the worker died or hung
		// mid-job) can never be claimed again; mark it failed so it stops
		// looking "in progress" to the admin pages, which would otherwise
		// refuse to queue that work again.
		const gaveUp = await client.query(
			`UPDATE job_runs
			    SET status = 'failed', completed_at = NOW(),
			        last_error = 'gave up after ' || attempts || ' attempts: the last one stopped without finishing (worker crash or timeout)'
			  WHERE job_type = $2 AND status = 'in_progress' AND attempts >= $1
			    AND started_at < NOW() - ($3 * INTERVAL '1 minute')
			    AND ($4::bigint[] IS NULL OR id = ANY($4))`,
			[MAX_ATTEMPTS, jobType, staleMinutes, JOB_IDS]
		);
		if ((gaveUp.rowCount ?? 0) > 0) log(`Marked ${gaveUp.rowCount} exhausted ${jobType} job(s) failed`);

		const res = await client.query<{ id: number; job_type: string; payload: Record<string, unknown>; attempts: number }>(
			`SELECT id, job_type, payload, attempts FROM job_runs
			  WHERE job_type = $2
			    AND ((status = 'pending') OR (status = 'in_progress' AND started_at < NOW() - ($3 * INTERVAL '1 minute')))
			    AND attempts < $1
			    AND ($4::bigint[] IS NULL OR id = ANY($4))
			  ORDER BY enqueued_at
			  LIMIT ${batchSize}
			  FOR UPDATE SKIP LOCKED`,
			[MAX_ATTEMPTS, jobType, staleMinutes, JOB_IDS]
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
		return res.rows.map(({ attempts, ...r }) => ({ ...r, attempt: attempts + 1 }));
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

// Approved tag names (tag_vocabulary, /admin/tags — td-3418e6) are fed to
// the extractor as preferred labels so the AI reuses names the family
// already sees instead of inventing near-duplicates. Most-used first,
// capped, and cached briefly so a backfill doesn't re-query per day.
const PREFERRED_TAGS_CAP = 150;
const PREFERRED_TAGS_TTL_MS = 5 * 60 * 1000;
let preferredTagsCache: { at: number; labels: string[] } | null = null;

async function preferredTagLabels(): Promise<string[]> {
	if (preferredTagsCache && Date.now() - preferredTagsCache.at < PREFERRED_TAGS_TTL_MS) {
		return preferredTagsCache.labels;
	}
	const res = await query<{ label: string }>(
		`SELECT tv.label
		   FROM tag_vocabulary tv
		   LEFT JOIN day_tags dt ON dt.tag_slug = tv.tag_slug
		  WHERE tv.status = 'approved'
		  GROUP BY tv.id, tv.label
		  ORDER BY COUNT(dt.day_id) DESC, tv.label
		  LIMIT ${PREFERRED_TAGS_CAP}`
	);
	preferredTagsCache = { at: Date.now(), labels: res.rows.map((r) => r.label) };
	return preferredTagsCache.labels;
}

function entityExtractSystem(preferred: string[]): string {
	if (preferred.length === 0) return ENTITY_EXTRACT_SYSTEM;
	return (
		ENTITY_EXTRACT_SYSTEM +
		`\n\nPreferred tag labels (already curated for this archive). When one of these fits the day, use it exactly as written instead of a new synonym; only add a new label when none of these fits:\n` +
		preferred.map((l) => `- ${l}`).join('\n')
	);
}

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
			const result = await completeJson<EntityExtractResult>(
				entityExtractSystem(await preferredTagLabels()),
				user,
				1536
			);
			entities = sanitizeEntities(result.entities);
			tags = sanitizeTags(result.tags);
		}

		let stale = false;
		await withTransaction(async (client) => {
			// The same per-day lock the admin's merge/move takes (td-c6e871,
			// src/lib/entity-locks.ts), so a move can't land between the
			// block read below and the AI-link rebuild. Only this one day's
			// lock: the admin side takes the graph lock first, so no cycle.
			await client.query('SELECT pg_advisory_xact_lock($1, $2)', [ENTITY_DAY_LOCK_CLASS, dayId]);
			// CODEX1 review finding 3 (2026-07-24): the staleness guard above
			// runs BEFORE the LLM call; a human re-accepting a changed
			// correction during that call would get stale extraction committed
			// over their fresh text's metadata. Revalidate inside the write
			// transaction, immediately before the destructive replace.
			const recheck = await client.query(
				`SELECT cd.correction_status,
				        (SELECT dc.id FROM day_corrections dc WHERE dc.day_id = cd.id ORDER BY dc.id DESC LIMIT 1) AS latest_id
				   FROM calendar_days cd WHERE cd.id = $1`,
				[dayId]
			);
			const rc = recheck.rows[0];
			if (!rc || rc.correction_status !== 'accepted' || String(rc.latest_id) !== String(payloadCorrectionId)) {
				await client.query(
					`UPDATE job_runs SET status='done', last_error=$2, completed_at=NOW() WHERE id=$1`,
					[job.id, `skipped: correction changed during extraction (latest=${rc?.latest_id}, status=${rc?.correction_status})`]
				);
				stale = true;
				return;
			}
			// Wholesale replace this day's AI-sourced rows — the worker's RLS
			// DELETE policy (0020_entity_enrichment.sql) restricts this to
			// source='ai' regardless of the WHERE clause, so a human tag or
			// entity link is structurally unreachable here.
			await client.query(`DELETE FROM day_entities WHERE day_id = $1 AND source = 'ai'`, [dayId]);
			await client.query(`DELETE FROM day_tags WHERE day_id = $1 AND source = 'ai'`, [dayId]);

			// Entities the admin moved this day away from (day_entity_blocks,
			// always canonical ids). An extracted name is skipped when its
			// canonical family is blocked: the same spelling after a merge
			// and any other alias spelling are both caught.
			const blockRes = await client.query<{ entity_id: string }>(
				`SELECT entity_id FROM day_entity_blocks WHERE day_id = $1`,
				[dayId]
			);
			const blocked = new Set(blockRes.rows.map((r) => Number(r.entity_id)));

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
				const entRes = await client.query<{ id: number; canon: string }>(
					`SELECT id, COALESCE(alias_of_entity_id, id) AS canon FROM entities WHERE entity_type = $1 AND slug = $2`,
					[e.type, slug]
				);
				const entityId = entRes.rows[0]?.id;
				if (!entityId || seenEntityIds.has(entityId)) continue;
				if (blocked.has(Number(entRes.rows[0].canon))) continue;
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

		if (stale) {
			log(`  day_id=${dayId} (${day.entry_date}): SKIPPED (correction changed during extraction)`);
			return;
		}
		log(`  day_id=${dayId} (${day.entry_date}): ${entities.length} entities, ${tags.length} tags`);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		log(`  day_id=${dayId} FAILED: ${msg}`);
		await query(`UPDATE job_runs SET status='failed', last_error=$2, completed_at=NOW() WHERE id=$1`, [job.id, msg.slice(0, 500)]);
	}
}

// ─── narrative_summary ───
//
// td-f1f49b (docs/2026-11-20-narrative-models-guidance-plan.md): each job
// produces one candidate in narrative_drafts, on the model the admin chose,
// steered by the house style and the year's notes. The worker never writes
// narrative_summaries (0033 revoked that); the admin promotes a candidate
// with "Use this" on /admin/narratives.

const YEAR_NARRATIVE_BASE = `You are writing a warm, faithful year-summary narrative for a private family history archive spanning roughly the 1960s to the present. The source material is a set of daily calendar-entry transcriptions for one year, each written by a family member at the time.

You will be given every accepted day's transcribed text for one calendar year, grouped by month.

Write a single flowing narrative (roughly 400-800 words) that:
- Reads in a warm, personal, family-history voice — as if written for the family, not a stranger.
- References months and seasons to give the reader a sense of the year's shape and passage of time.
- Draws out recurring people, places, and themes that actually appear in the entries.
- Is strictly faithful to the source material: never invent a fact, event, name, date, or detail that is not present in the entries or stated explicitly in the editor's notes. If the entries are sparse or repetitive, say so plainly rather than embellishing.`;

const YEAR_NARRATIVE_OUTPUT_RULES = `Output rules (these always apply): write plain prose — no markdown headings, no bullet lists, no code fences. Respond with ONLY the narrative text itself — no preamble, no title, no commentary about the task.`;

/**
 * Keep typed or transcribed text from closing or opening the prompt's own
 * tags. Applied to everything interpolated into a tag: guidance, the
 * current narrative, and the day entries themselves.
 */
function stripPromptTags(text: string): string {
	return text.replace(/<\/?\s*(house_style|editor_notes|current_narrative|entries)\b[^>]*>/gi, '');
}

function buildYearNarrativeSystem(opts: {
	year: string;
	styleGuidance: string;
	yearGuidance: string;
	revise: boolean;
}): string {
	const parts = [YEAR_NARRATIVE_BASE];
	if (opts.styleGuidance) {
		parts.push(
			`The family editor has set a house style, below. It governs voice, tone, structure, and length only — it never adds facts, people, places, or events. Where it differs from the defaults above on tone, structure, or length, follow it, within the output rules at the end.\n<house_style>\n${stripPromptTags(opts.styleGuidance)}\n</house_style>`
		);
	}
	if (opts.yearGuidance) {
		parts.push(
			`The family editor has written notes for ${opts.year}, below. Treat them as authoritative: they identify people, explain shorthand, and correct how the entries should be read. You may state background facts the notes give explicitly, and use them to interpret the entries. Do not build scenes or details beyond what the notes literally say, and do not tie a fact from the notes to a particular month or date unless that month's or date's entries support it. Where the notes ask for a different emphasis or approach, follow them within these rules.\n<editor_notes year="${opts.year}">\n${stripPromptTags(opts.yearGuidance)}\n</editor_notes>`
		);
	}
	if (opts.revise) {
		parts.push(
			`You are revising an existing narrative, given in the user message inside <current_narrative>. It is a draft, not a source: it may contain mistakes. Make the changes the editor's notes and house style ask for. Keep the rest of it only where the entries or the editor's notes support it, and remove or correct anything they don't.`
		);
	}
	parts.push(YEAR_NARRATIVE_OUTPUT_RULES);
	return parts.join('\n\n');
}

const MONTH_NAMES = [
	'January', 'February', 'March', 'April', 'May', 'June',
	'July', 'August', 'September', 'October', 'November', 'December'
];

interface AcceptedDayRow {
	entry_date: string;
	corrected_text: string | null;
	day_narrative: string | null;
}

function isValidYearScopeKey(s: unknown): s is string {
	return typeof s === 'string' && /^\d{4}$/.test(s);
}

/** Builds the per-month-grouped prompt body fed to the year-narrative system prompt. */
function buildYearNarrativePrompt(scopeKey: string, days: AcceptedDayRow[], baseText: string | null): string {
	const byMonth = new Map<number, AcceptedDayRow[]>();
	for (const d of days) {
		const month = Number(d.entry_date.slice(5, 7));
		const list = byMonth.get(month);
		if (list) list.push(d);
		else byMonth.set(month, [d]);
	}

	const sections: string[] = [];
	for (const [month, rows] of [...byMonth.entries()].sort((a, b) => a[0] - b[0])) {
		sections.push(`## ${MONTH_NAMES[month - 1]}`);
		for (const r of rows) {
			const text = [r.corrected_text ?? '', r.day_narrative ?? ''].filter((s) => s.trim() !== '').join(' — ');
			if (text.trim() !== '') sections.push(`${r.entry_date}: ${stripPromptTags(text)}`);
		}
	}
	let prompt = `YEAR: ${scopeKey}\n\n<entries year="${scopeKey}">\n${sections.join('\n')}\n</entries>`;
	if (baseText) {
		prompt +=
			`\n\n<current_narrative>\n${stripPromptTags(baseText)}\n</current_narrative>\n\n` +
			`Revise the narrative above as instructed, using the entries as the source of truth.`;
	}
	return prompt;
}

interface NarrativeJobSpec {
	scope: 'year';
	scopeKey: string;
	model: NonNullable<ReturnType<typeof findNarrativeModel>>;
	mode: 'fresh' | 'revise';
	baseText: string | null;
	/** null for a job queued before td-f1f49b: read the saved guidance instead. */
	guidance: { style: string; year: string } | null;
	requestedBy: number | null;
}

/**
 * Validate a job's payload before any paid call. Two shapes are accepted:
 * the admin page's (td-f1f49b: model, mode, guidance copies, requester),
 * and the plain {scope, scope_key} of jobs queued before it, which run as
 * the default model in fresh mode with the saved guidance. Anything else —
 * including a half-formed modern payload — fails rather than falling back.
 */
function parseNarrativePayload(raw: unknown): NarrativeJobSpec | string {
	// JSONB NOT NULL still allows a JSON null, array, or scalar.
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		return `payload must be a JSON object, got ${raw === null ? 'null' : Array.isArray(raw) ? 'an array' : typeof raw}`;
	}
	const p = raw as Record<string, unknown>;
	if (p.scope !== 'year') {
		return `scope not implemented: ${JSON.stringify(p.scope)} (only 'year' is implemented; decade/person are deferred, td-e25bd4)`;
	}
	const scopeKey = p.scope_key;
	if (!isValidYearScopeKey(scopeKey)) {
		return `invalid scope_key for scope='year': ${JSON.stringify(scopeKey)} (expected a 4-digit year string)`;
	}
	const extra = Object.keys(p).filter((k) => k !== 'scope' && k !== 'scope_key');
	if (extra.length === 0) {
		return {
			scope: 'year',
			scopeKey,
			model: findNarrativeModel(DEFAULT_NARRATIVE_MODEL)!,
			mode: 'fresh',
			baseText: null,
			guidance: null,
			requestedBy: null
		};
	}

	const known = new Set(['model', 'mode', 'base_text', 'style_guidance', 'year_guidance', 'requested_by']);
	const unknown = extra.filter((k) => !known.has(k));
	if (unknown.length > 0) return `unexpected payload field(s): ${unknown.join(', ')}`;
	const model = typeof p.model === 'string' ? findNarrativeModel(p.model) : undefined;
	if (!model) return `model not offered for narratives: ${JSON.stringify(p.model)}`;
	if (!isNarrativeMode(p.mode)) return `invalid mode: ${JSON.stringify(p.mode)} (expected 'fresh' or 'revise')`;
	const mode = p.mode;
	for (const k of ['style_guidance', 'year_guidance'] as const) {
		const v = p[k];
		if (typeof v !== 'string') return `${k} must be a string`;
		if (v.length > MAX_GUIDANCE_LENGTH) return `${k} is longer than ${MAX_GUIDANCE_LENGTH} characters`;
	}
	let baseText: string | null = null;
	if (mode === 'revise') {
		if (typeof p.base_text !== 'string' || !p.base_text.trim()) return 'revise job has no base_text to revise';
		if (p.base_text.length > MAX_NARRATIVE_LENGTH) return `base_text is longer than ${MAX_NARRATIVE_LENGTH} characters`;
		baseText = p.base_text.trim();
	} else if (p.base_text !== undefined) {
		return 'base_text is only allowed on a revise job';
	}
	const rb = p.requested_by;
	if (!(typeof rb === 'number' && Number.isInteger(rb) && rb > 0 && rb <= 2_147_483_647)) {
		return `invalid requested_by: ${JSON.stringify(rb)}`;
	}
	return {
		scope: 'year',
		scopeKey,
		model,
		mode,
		baseText,
		guidance: { style: (p.style_guidance as string).trim(), year: (p.year_guidance as string).trim() },
		requestedBy: rb
	};
}

/** The guidance saved now, for a job queued before td-f1f49b (which carries none). */
async function readSavedGuidance(scopeKey: string): Promise<{ style: string; year: string }> {
	const [styleRes, yearRes] = await Promise.all([
		query<{ value: { text?: unknown } }>(`SELECT value FROM app_state WHERE key = 'narrative_style_guidance'`),
		query<{ guidance_text: string }>(
			`SELECT guidance_text FROM narrative_guidance WHERE scope = 'year' AND scope_key = $1`,
			[scopeKey]
		)
	]);
	const styleText = styleRes.rows[0]?.value?.text;
	return {
		style: typeof styleText === 'string' ? styleText.trim() : '',
		year: yearRes.rows[0]?.guidance_text.trim() ?? ''
	};
}

/**
 * Finish a narrative job, but only while this attempt still owns it: a
 * stale attempt (one the claim query reclaimed after the stale timeout) must
 * not overwrite the newer attempt's outcome. Returns false if superseded.
 */
async function finishNarrativeJob(job: ClaimedJob, status: 'done' | 'failed', note: string): Promise<boolean> {
	const res = await query(
		`UPDATE job_runs SET status = $3, last_error = $4, completed_at = NOW()
		  WHERE id = $1 AND attempts = $2 AND status = 'in_progress'`,
		[job.id, job.attempt, status, note]
	);
	return res.rowCount === 1;
}

async function failNarrativeJob(job: ClaimedJob, reason: string): Promise<void> {
	await finishNarrativeJob(job, 'failed', reason);
	log(`  job ${job.id}: FAILED (${reason})`);
}

async function processNarrativeSummary(job: ClaimedJob): Promise<void> {
	let label = `job ${job.id}`;
	try {
		const spec = parseNarrativePayload(job.payload);
		if (typeof spec === 'string') {
			await failNarrativeJob(job, spec);
			return;
		}
		const { scopeKey, model, mode, baseText } = spec;
		label = `scope=year scope_key=${scopeKey} model=${model.id} mode=${mode}`;

		if (DRY_RUN) {
			// Hand the job back exactly as it was: undo this claim's attempt,
			// and only if this attempt still owns it.
			log(`  [DRY] ${label} would generate a candidate`);
			await query(
				`UPDATE job_runs SET status = 'pending', started_at = NULL, attempts = attempts - 1
				  WHERE id = $1 AND attempts = $2 AND status = 'in_progress'`,
				[job.id, job.attempt]
			);
			return;
		}

		const daysRes = await query<AcceptedDayRow>(
			`SELECT entry_date::text AS entry_date, corrected_text, day_narrative
			   FROM calendar_days
			  WHERE correction_status = 'accepted' AND EXTRACT(YEAR FROM entry_date)::int = $1
			  ORDER BY entry_date`,
			[Number(scopeKey)]
		);
		const days = daysRes.rows;
		if (days.length === 0) {
			await finishNarrativeJob(job, 'done', `skipped: no accepted days for ${scopeKey}`);
			log(`  ${label}: SKIPPED (no accepted days)`);
			return;
		}

		const guidance = spec.guidance ?? (await readSavedGuidance(scopeKey));
		const system = buildYearNarrativeSystem({
			year: scopeKey,
			styleGuidance: guidance.style,
			yearGuidance: guidance.year,
			revise: mode === 'revise'
		});
		const user = buildYearNarrativePrompt(scopeKey, days, baseText);
		const result = await completeNarrative({ model: model.id, system, user });

		// The draft and the job's completion commit together: a crash can't
		// leave a draft behind a job that will run (and be paid for) again.
		const draftId = await withTransaction(async (client) => {
			const live = await client.query(
				`SELECT 1 FROM job_runs WHERE id = $1 AND attempts = $2 AND status = 'in_progress' FOR UPDATE`,
				[job.id, job.attempt]
			);
			if (live.rowCount !== 1) return null;
			// The draft is kept even if the requester's account was deleted
			// while the job ran: a SAVEPOINT lets the insert retry without the
			// requester instead of losing the paid result to an FK error.
			const insertDraft = (requester: number | null) =>
				client.query<{ id: string }>(
					`INSERT INTO narrative_drafts
					   (scope, scope_key, model_name, provider, mode, base_text, style_guidance, year_guidance,
					    draft_text, day_count, input_tokens, output_tokens, requested_by, job_run_id)
					 VALUES ('year', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
					 ON CONFLICT (job_run_id) DO NOTHING
					 RETURNING id`,
					[
						scopeKey,
						model.id,
						model.provider,
						mode,
						baseText,
						guidance.style || null,
						guidance.year || null,
						result.text,
						days.length,
						result.inputTokens,
						result.outputTokens,
						requester,
						job.id
					]
				);
			let ins;
			await client.query('SAVEPOINT draft_insert');
			try {
				ins = await insertDraft(spec.requestedBy);
			} catch (err) {
				const fkUser =
					spec.requestedBy !== null &&
					(err as { code?: string; constraint?: string }).code === '23503' &&
					(err as { constraint?: string }).constraint === 'narrative_drafts_requested_by_fkey';
				if (!fkUser) throw err;
				await client.query('ROLLBACK TO SAVEPOINT draft_insert');
				log(`  ${label}: requester ${spec.requestedBy} no longer exists; saving the draft unattributed`);
				ins = await insertDraft(null);
			}
			const id =
				ins.rows[0]?.id ??
				(await client.query<{ id: string }>(`SELECT id::text AS id FROM narrative_drafts WHERE job_run_id = $1`, [job.id]))
					.rows[0].id;
			const note = `draft #${id} from ${days.length} accepted day(s) via ${model.id}`;
			await client.query(`UPDATE job_runs SET status = 'done', last_error = $2, completed_at = NOW() WHERE id = $1`, [
				job.id,
				note
			]);
			return id;
		});
		if (draftId === null) {
			log(`  ${label}: superseded by a newer attempt; result discarded`);
			return;
		}
		log(`  ${label}: draft #${draftId} from ${days.length} accepted day(s)`);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		log(`  ${label} FAILED: ${msg}`);
		await finishNarrativeJob(job, 'failed', msg.slice(0, 500));
	}
}

// ─── pdf_export ───

// Under render-token.ts's hard 15-min ceiling — generous for a large year's
// render (page load + waiting for every image to finish + PDF generation +
// upload) while leaving headroom so a token can never be minted right at the
// module's own max.
const RENDER_TOKEN_TTL_MS = 10 * 60 * 1000;

function isValidYearScopeKeyForExport(s: unknown): s is string {
	return typeof s === 'string' && /^\d{4}$/.test(s);
}

// Story scope_key (Gaylon, 2026-07-23): the adhoc_narratives row's own
// BIGSERIAL id, passed through as a string in the job payload (same
// string-everywhere convention 'year' already uses for its scope_key).
function isValidStoryScopeKeyForExport(s: unknown): s is string {
	return typeof s === 'string' && /^\d+$/.test(s) && Number(s) > 0;
}

// Phase H content modes (Gaylon, 2026-07-23): matches
// src/routes/app/book/[scope]/[key]/+page.server.ts's BookContentMode
// exactly. Defaults to 'full' when the payload omits it (every job enqueued
// before this feature shipped never set content_mode, and 'full' is the
// original — and only — behavior those old payloads ever meant). Only
// meaningful for scope='year' — a scope='story' job's content_mode is
// ALWAYS forced to 'full' below regardless of what the payload says: a
// story PDF has no narrative/days split to choose between (it's already
// just one written answer), so 'content modes N/A for stories' per the spec
// is enforced here rather than merely assumed from what
// src/routes/admin/ask/+page.server.ts's save action happens to send.
type PdfContentMode = 'full' | 'narrative' | 'days';

function isValidContentMode(s: unknown): s is PdfContentMode {
	return s === 'full' || s === 'narrative' || s === 'days';
}

function internalBaseUrl(): string {
	return process.env.MADONNAHIST_INTERNAL_URL ?? 'http://127.0.0.1:3002';
}

async function processPdfExport(job: ClaimedJob): Promise<void> {
	const scope = job.payload.scope;
	const scopeKey = job.payload.scope_key;
	const requestedByRaw = job.payload.requested_by;
	const requestedBy =
		typeof requestedByRaw === 'number' && Number.isFinite(requestedByRaw)
			? requestedByRaw
			: typeof requestedByRaw === 'string' && requestedByRaw !== '' && Number.isFinite(Number(requestedByRaw))
				? Number(requestedByRaw)
				: null;

	if (scope !== 'year' && scope !== 'story') {
		await query(
			`UPDATE job_runs SET status='failed', last_error=$2, completed_at=NOW() WHERE id=$1`,
			[job.id, `scope not implemented: ${JSON.stringify(scope)} (only 'year' and 'story' are implemented)`]
		);
		log(`  job ${job.id}: FAILED (scope not implemented: ${JSON.stringify(scope)})`);
		return;
	}
	if (scope === 'year' && !isValidYearScopeKeyForExport(scopeKey)) {
		await query(
			`UPDATE job_runs SET status='failed', last_error=$2, completed_at=NOW() WHERE id=$1`,
			[job.id, `invalid scope_key for scope='year': ${JSON.stringify(scopeKey)} (expected a 4-digit year string)`]
		);
		log(`  job ${job.id}: FAILED (invalid scope_key: ${JSON.stringify(scopeKey)})`);
		return;
	}
	if (scope === 'story' && !isValidStoryScopeKeyForExport(scopeKey)) {
		await query(
			`UPDATE job_runs SET status='failed', last_error=$2, completed_at=NOW() WHERE id=$1`,
			[job.id, `invalid scope_key for scope='story': ${JSON.stringify(scopeKey)} (expected a positive adhoc_narratives id as a string)`]
		);
		log(`  job ${job.id}: FAILED (invalid scope_key: ${JSON.stringify(scopeKey)})`);
		return;
	}

	let contentMode: PdfContentMode = 'full';
	if (scope === 'year') {
		const contentModeRaw = job.payload.content_mode;
		const contentModeCandidate = contentModeRaw === undefined ? 'full' : contentModeRaw;
		if (!isValidContentMode(contentModeCandidate)) {
			await query(
				`UPDATE job_runs SET status='failed', last_error=$2, completed_at=NOW() WHERE id=$1`,
				[job.id, `invalid content_mode: ${JSON.stringify(contentModeRaw)} (expected 'full', 'narrative', or 'days')`]
			);
			log(`  job ${job.id}: FAILED (invalid content_mode: ${JSON.stringify(contentModeRaw)})`);
			return;
		}
		contentMode = contentModeCandidate;
	}

	if (DRY_RUN) {
		log(`  [DRY] scope=${scope} scope_key=${scopeKey} mode=${contentMode} would render PDF`);
		await query(`UPDATE job_runs SET status='pending', started_at=NULL WHERE id=$1`, [job.id]);
		return;
	}

	let browser: Browser | undefined;
	try {
		let dayCount: number;
		if (scope === 'year') {
			const countRes = await query<{ total: number }>(
				`SELECT COUNT(*)::int AS total FROM calendar_days
				  WHERE correction_status = 'accepted' AND EXTRACT(YEAR FROM entry_date)::int = $1`,
				[Number(scopeKey)]
			);
			dayCount = countRes.rows[0]?.total ?? 0;
		} else {
			// story: day_count is the subset size the story was written from,
			// already recorded on the adhoc_narratives row itself
			// (src/routes/admin/ask/+page.server.ts's save action) — no separate
			// count query needed. A missing row (deleted between enqueue and
			// this run — e.g. an admin's delete action, which now also cleans up
			// any in-flight pdf_export job's eventual output) fails the job
			// cleanly rather than rendering a PDF for content that's already
			// gone.
			const storyRes = await query<{ day_count: number }>(
				`SELECT day_count FROM adhoc_narratives WHERE id = $1`,
				[Number(scopeKey)]
			);
			if (!storyRes.rows[0]) {
				await query(`UPDATE job_runs SET status='failed', last_error=$2, completed_at=NOW() WHERE id=$1`, [
					job.id,
					`adhoc_narratives row ${scopeKey} no longer exists (deleted before this job ran)`
				]);
				log(`  job ${job.id}: FAILED (story ${scopeKey} no longer exists)`);
				return;
			}
			dayCount = storyRes.rows[0].day_count;
		}

		const token = issueRenderToken(scope, scopeKey, process.env.AUTH_SECRET, RENDER_TOKEN_TTL_MS);
		const baseUrl = internalBaseUrl();
		const renderUrl =
			scope === 'year'
				? `${baseUrl}/app/book/year/${scopeKey}?render=pdf&content=${contentMode}`
				: `${baseUrl}/app/stories/${scopeKey}?render=pdf`;
		const parsedBase = new URL(baseUrl);

		browser = await chromium.launch({
			executablePath: process.env.MADONNAHIST_CHROMIUM_PATH || undefined
		});
		const context = await browser.newContext();
		// Set via the Playwright API directly on this context, never through a
		// real Set-Cookie response from the app — the app only ever READS this
		// cookie (src/hooks.server.ts). secure:false is deliberate for a plain
		// http:// internal base URL (the default MADONNAHIST_INTERNAL_URL);
		// Chromium would otherwise silently drop a Secure-flagged cookie sent
		// over http to a non-"localhost" host like 127.0.0.1.
		await context.addCookies([
			{
				name: RENDER_TOKEN_COOKIE_NAME,
				value: token,
				domain: parsedBase.hostname,
				path: '/',
				httpOnly: true,
				secure: parsedBase.protocol === 'https:',
				sameSite: 'Strict'
			}
		]);

		const page = await context.newPage();
		const response = await page.goto(renderUrl, { waitUntil: 'networkidle', timeout: 120_000 });
		// CODEX1 review finding 8 (2026-07-24): without these assertions a
		// login redirect, error page, or broken images could be persisted as a
		// "successful" export. Require: 2xx response, the final URL still on
		// the intended path (a redirect to /login would change it), and every
		// image both complete AND actually decoded (naturalWidth > 0 — a
		// failed image reports complete=true with naturalWidth=0).
		if (!response || !response.ok()) {
			throw new Error(`render fetch failed: HTTP ${response?.status() ?? 'no response'} for ${renderUrl}`);
		}
		const finalPath = new URL(page.url()).pathname;
		const expectedPath = new URL(renderUrl).pathname;
		if (finalPath !== expectedPath) {
			throw new Error(`render redirected: expected ${expectedPath}, landed on ${finalPath}`);
		}
		await page.waitForFunction(
			() => Array.from(document.images).every((img) => img.complete && img.naturalWidth > 0),
			undefined,
			{ timeout: 60_000 }
		);

		const footerLabel = scope === 'year' ? scopeKey : 'Family story';
		const pdfBuffer = await page.pdf({
			format: 'Letter',
			margin: { top: '0.75in', bottom: '0.75in', left: '0.75in', right: '0.75in' },
			printBackground: true,
			displayHeaderFooter: true,
			headerTemplate: '<div></div>',
			footerTemplate:
				'<div style="width:100%; font-size:9px; text-align:center; color:#555; font-family: sans-serif;">' +
				`${footerLabel} &mdash; page <span class="pageNumber"></span> of <span class="totalPages"></span></div>`
		});

		await browser.close();
		browser = undefined;

		// Mode is folded into the object key so 'full' keeps the original,
		// pre-Phase-H-content-modes naming (exports already on disk/Spaces
		// from before this feature match the same pattern) while 'narrative'/
		// 'days' are visually distinct at a glance in the Spaces console. A
		// story export has no content-mode split at all, so its key never gets
		// a mode segment.
		const objectKeyModeSuffix = contentMode === 'full' ? '' : `-${contentMode}`;
		const objectKey =
			scope === 'year'
				? `exports/book-year-${scopeKey}${objectKeyModeSuffix}-${job.id}.pdf`
				: `exports/story-${scopeKey}-${job.id}.pdf`;
		await putObject(objectKey, pdfBuffer, 'application/pdf');

		await query(
			`INSERT INTO pdf_exports (scope, scope_key, object_key, byte_size, day_count, requested_by, content_mode)
			 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
			[scope, scopeKey, objectKey, pdfBuffer.length, dayCount, requestedBy, contentMode]
		);

		await query(`UPDATE job_runs SET status='done', last_error=$2, completed_at=NOW() WHERE id=$1`, [
			job.id,
			`rendered ${objectKey} (${pdfBuffer.length} bytes, ${dayCount} accepted day(s), mode=${contentMode})`
		]);
		log(`  scope=${scope} scope_key=${scopeKey}: rendered ${objectKey} (${pdfBuffer.length} bytes, ${dayCount} accepted day(s), mode=${contentMode})`);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		log(`  scope=${scope} scope_key=${scopeKey} FAILED: ${msg}`);
		await query(`UPDATE job_runs SET status='failed', last_error=$2, completed_at=NOW() WHERE id=$1`, [job.id, msg.slice(0, 500)]);
	} finally {
		// Always close, success or failure — a leaked Chromium process is
		// exactly the memory risk this job type's single-claim serialization
		// (claimJobs' maxBatchOverride=1 above) exists to avoid.
		if (browser) {
			await browser.close().catch(() => {});
		}
	}
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

	// maxBatchOverride=1: never more than one pdf_export in flight per poll,
	// regardless of --limit — see claimJobs()'s doc comment.
	const pdfJobs = await claimJobs('pdf_export', PDF_EXPORT_STALE_MINUTES, 1);
	if (pdfJobs.length > 0) log(`Claimed ${pdfJobs.length} pdf_export job(s)`);
	for (const job of pdfJobs) {
		await processPdfExport(job);
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
	log('Enrichment Worker — entity_extract + narrative_summary + pdf_export');

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
