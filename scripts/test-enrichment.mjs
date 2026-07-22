#!/usr/bin/env node
// Enrichment worker end-to-end test (Phase D of
// docs/2026-07-21-next-phases-search-viewer-narrative-plan.md).
//
// Runs entirely against the isolated local test stack (madonnahist_test,
// 127.0.0.1:15434) — no dev server needed, unlike scripts/test-viewer-security.mjs.
// Self-provisions a throwaway user, calendar_pages row, and calendar_days
// row directly in the DB, spawns the real worker binary
// (backend/workers/enrichment-worker.ts) as a child process with
// MADONNAHIST_LLM_STUB=1 so no live Anthropic call is ever made, and cleans
// up in a finally block. Never touches port 5433/5435 or
// PGDATABASE=madonnahist — see requireTestSafety() below.
//
// What this asserts (per the plan's Phase D verify section):
//   - accepting a day (INSERT INTO day_corrections status_after='accepted')
//     auto-enqueues exactly one entity_extract job for that day
//   - running the worker once writes entities/day_entities/day_tags rows
//     with source='ai' matching the stubbed LLM response
//   - re-accepting the day (a new day_corrections row) enqueues a fresh job;
//     running the worker again with a DIFFERENT stubbed response replaces
//     the AI rows (old ones gone, new ones present) rather than duplicating
//   - a human-sourced tag added between runs survives the AI-row replacement
//   - a stale job (payload correction_id no longer the latest) is a no-op —
//     it's marked done without touching the day's entities/tags at all
//
// Usage: node scripts/test-enrichment.mjs (or: npm run test:enrichment)

import pg from 'pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

function loadDotEnv(file) {
	let text;
	try {
		text = readFileSync(file, 'utf8');
	} catch {
		return;
	}
	for (const line of text.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;
		const eq = trimmed.indexOf('=');
		if (eq === -1) continue;
		const key = trimmed.slice(0, eq).trim();
		const value = trimmed.slice(eq + 1).trim();
		if (process.env[key] === undefined) process.env[key] = value;
	}
}

loadDotEnv(path.join(REPO_ROOT, '.env.test'));

function requireTestSafety() {
	const problems = [];
	if (process.env.MADONNAHIST_ENV !== 'test') {
		problems.push('MADONNAHIST_ENV must be "test"');
	}
	if (process.env.PGPORT === '5433' || process.env.PGPORT === '5435') {
		problems.push(`refusing reserved port ${process.env.PGPORT} (5433=BTC-dashboard, 5435=production tunnel)`);
	}
	if (process.env.PGDATABASE === 'madonnahist') {
		problems.push('refusing production database name "madonnahist"');
	}
	if (!process.env.PGDATABASE || !process.env.PGPASSWORD || !process.env.WORKER_PGPASSWORD) {
		problems.push('PGDATABASE/PGPASSWORD/WORKER_PGPASSWORD must be set (copy .env.test.example to .env.test)');
	}
	return problems;
}

// Distinctive markers — never-elsewhere-occurring, same convention as
// scripts/test-viewer-security.mjs — so assertions can only match this
// fixture's own rows.
const MARKER = 'ZQXPLENRICH';
const USERNAME = '_enrichment_test_user';
const FIXTURE_YEAR = 1897;
const FIXTURE_MONTH = 3;
const ENTRY_DATE = '1897-03-05';
const CAPTURE_SESSION = '_enrichment_test';

const STUB_A = {
	entities: [
		{ type: 'person', name: `${MARKER}Person`, confidence: 0.9 },
		{ type: 'place', name: `${MARKER}Place`, confidence: 0.6 }
	],
	tags: [{ label: `${MARKER.toLowerCase()}-tag-a`, confidence: 0.8 }]
};

const STUB_B = {
	entities: [
		// Drops the place, adds a second person — proves replacement, not
		// accumulation.
		{ type: 'person', name: `${MARKER}Person`, confidence: 0.95 },
		{ type: 'person', name: `${MARKER}PersonTwo`, confidence: 0.5 }
	],
	tags: [{ label: `${MARKER.toLowerCase()}-tag-b`, confidence: 0.7 }]
};

const HUMAN_TAG_SLUG = `${MARKER.toLowerCase()}-human-tag`;
const HUMAN_TAG_LABEL = `${MARKER} Human Tag`;

let pass = 0;
let fail = 0;
const rows = [];

function record(label, ok, detail) {
	if (ok) pass++;
	else fail++;
	rows.push({ label, ok, detail });
}

function runWorkerOnce(stub) {
	const result = spawnSync('npx', ['tsx', 'backend/workers/enrichment-worker.ts', '--limit=1'], {
		cwd: REPO_ROOT,
		encoding: 'utf8',
		env: {
			...process.env,
			MADONNAHIST_LLM_STUB: '1',
			MADONNAHIST_LLM_STUB_JSON: JSON.stringify(stub)
		}
	});
	if (result.status !== 0) {
		console.error('Worker stdout:', result.stdout);
		console.error('Worker stderr:', result.stderr);
		throw new Error(`worker exited with status ${result.status}`);
	}
	return result.stdout;
}

async function provisionFixture(pool) {
	await pool.query(
		`INSERT INTO users (username, display_name, role, password_hash)
		 VALUES ($1, $2, 'corrector', 'x')
		 ON CONFLICT (username) DO UPDATE SET display_name = EXCLUDED.display_name
		 RETURNING id`,
		[USERNAME, 'Enrichment Test']
	);
	const userRes = await pool.query(`SELECT id FROM users WHERE username = $1`, [USERNAME]);
	const userId = userRes.rows[0].id;

	await pool.query(
		`INSERT INTO calendar_pages (year, month, page_image_path, capture_session)
		 VALUES ($1, $2, $3, $4)
		 ON CONFLICT (year, month) DO NOTHING`,
		[FIXTURE_YEAR, FIXTURE_MONTH, 'fixtures/enrichment-test/fake-page.jpg', CAPTURE_SESSION]
	);
	const pageRes = await pool.query(`SELECT id FROM calendar_pages WHERE year = $1 AND month = $2`, [
		FIXTURE_YEAR,
		FIXTURE_MONTH
	]);
	const pageId = pageRes.rows[0].id;

	// Clean up any leftover day/job/entity rows from a previous (possibly
	// crashed) run of this same fixture before inserting fresh ones.
	await pool.query(`DELETE FROM calendar_days WHERE entry_date = $1`, [ENTRY_DATE]);
	await pool.query(
		`DELETE FROM entities WHERE (entity_type = 'person' AND slug LIKE $1) OR (entity_type = 'place' AND slug LIKE $1)`,
		[`${MARKER.toLowerCase()}%`]
	);

	const dayRes = await pool.query(
		`INSERT INTO calendar_days (page_id, entry_date) VALUES ($1, $2) RETURNING id`,
		[pageId, ENTRY_DATE]
	);
	const dayId = dayRes.rows[0].id;

	// Test hygiene, isolated-DB-only: clear any stray pending/in_progress
	// entity_extract or narrative_summary jobs left behind by other test
	// runs (e.g. backend/db/tests/v4_invariants.sh's own day_corrections
	// inserts fire the same auto-enqueue trigger). Without this, the
	// worker's --limit=1 claim (oldest enqueued_at first) could pick up
	// someone else's stray job instead of this fixture's, making the test
	// non-deterministic depending on run order. Never run against anything
	// but madonnahist_test — requireTestSafety() above guards that.
	await pool.query(
		`DELETE FROM job_runs WHERE job_type IN ('entity_extract', 'narrative_summary') AND status IN ('pending', 'in_progress')`
	);

	return { userId, pageId, dayId };
}

async function cleanupFixture(pool, { pageId, userId } = {}) {
	if (pageId) {
		await pool.query(`DELETE FROM job_runs WHERE (payload->>'day_id')::int IN (SELECT id FROM calendar_days WHERE page_id = $1)`, [pageId]);
		await pool.query(`DELETE FROM calendar_days WHERE page_id = $1`, [pageId]);
		await pool.query(`DELETE FROM calendar_pages WHERE id = $1`, [pageId]);
	}
	await pool.query(
		`DELETE FROM entities WHERE (entity_type = 'person' AND slug LIKE $1) OR (entity_type = 'place' AND slug LIKE $1)`,
		[`${MARKER.toLowerCase()}%`]
	);
	if (userId) {
		await pool.query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
		await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
	}
}

async function getAiRows(pool, dayId) {
	const entitiesRes = await pool.query(
		`SELECT e.entity_type, e.display_name, de.confidence_score
		   FROM day_entities de JOIN entities e ON e.id = de.entity_id
		  WHERE de.day_id = $1 AND de.source = 'ai'
		  ORDER BY e.entity_type, e.display_name`,
		[dayId]
	);
	const tagsRes = await pool.query(
		`SELECT tag_slug, tag_label FROM day_tags WHERE day_id = $1 AND source = 'ai' ORDER BY tag_slug`,
		[dayId]
	);
	const humanTagsRes = await pool.query(
		`SELECT tag_slug, tag_label FROM day_tags WHERE day_id = $1 AND source = 'human' ORDER BY tag_slug`,
		[dayId]
	);
	return { entities: entitiesRes.rows, aiTags: tagsRes.rows, humanTags: humanTagsRes.rows };
}

async function main() {
	const problems = requireTestSafety();
	if (problems.length > 0) {
		for (const p of problems) console.error(`ERROR: ${p}`);
		process.exitCode = 1;
		return;
	}

	const pool = new pg.Pool({
		host: process.env.PGHOST ?? '127.0.0.1',
		port: Number(process.env.PGPORT ?? 15434),
		database: process.env.PGDATABASE,
		user: process.env.PGUSER ?? 'madonnahist_app',
		password: process.env.PGPASSWORD
	});

	let fixture;
	try {
		fixture = await provisionFixture(pool);
		const { userId, dayId } = fixture;

		// ── Accept #1 → auto-enqueue ────────────────────────────────────────
		await pool.query(
			`INSERT INTO day_corrections (day_id, corrected_text, status_after, editor_user_id)
			 VALUES ($1, $2, 'accepted', $3)`,
			[dayId, `${MARKER} accepted text mentioning a person and a place.`, userId]
		);

		const jobsAfterFirstAccept = await pool.query(
			`SELECT id, status, payload FROM job_runs WHERE job_type = 'entity_extract' AND (payload->>'day_id')::int = $1`,
			[dayId]
		);
		record(
			'accepting a day auto-enqueues exactly one entity_extract job',
			jobsAfterFirstAccept.rows.length === 1 && jobsAfterFirstAccept.rows[0].status === 'pending',
			`found ${jobsAfterFirstAccept.rows.length} job(s): ${JSON.stringify(jobsAfterFirstAccept.rows)}`
		);

		// ── Run #1 with STUB_A ───────────────────────────────────────────────
		runWorkerOnce(STUB_A);

		const afterRunA = await getAiRows(pool, dayId);
		const namesA = afterRunA.entities.map((e) => `${e.entity_type}:${e.display_name}`).sort();
		const expectedA = [`person:${MARKER}Person`, `place:${MARKER}Place`].sort();
		record(
			'first run creates AI entities matching stub A',
			JSON.stringify(namesA) === JSON.stringify(expectedA),
			`got ${JSON.stringify(namesA)}, expected ${JSON.stringify(expectedA)}`
		);
		record(
			'first run creates AI tag matching stub A',
			afterRunA.aiTags.length === 1 && afterRunA.aiTags[0].tag_slug === `${MARKER.toLowerCase()}-tag-a`,
			`got ${JSON.stringify(afterRunA.aiTags)}`
		);

		const job1After = await pool.query(`SELECT status FROM job_runs WHERE job_type = 'entity_extract' AND (payload->>'day_id')::int = $1`, [dayId]);
		record(
			'job marked done after successful processing',
			job1After.rows.every((r) => r.status === 'done'),
			`statuses: ${JSON.stringify(job1After.rows.map((r) => r.status))}`
		);

		// ── Add a human tag between runs ────────────────────────────────────
		await pool.query(
			`INSERT INTO day_tags (day_id, tag_slug, tag_label, source) VALUES ($1, $2, $3, 'human')`,
			[dayId, HUMAN_TAG_SLUG, HUMAN_TAG_LABEL]
		);

		// ── Re-accept → fresh job, then run #2 with STUB_B ──────────────────
		await pool.query(
			`INSERT INTO day_corrections (day_id, corrected_text, status_after, editor_user_id)
			 VALUES ($1, $2, 'accepted', $3)`,
			[dayId, `${MARKER} re-accepted text mentioning two people.`, userId]
		);

		const jobsAfterReaccept = await pool.query(
			`SELECT id, status FROM job_runs WHERE job_type = 'entity_extract' AND (payload->>'day_id')::int = $1 ORDER BY id`,
			[dayId]
		);
		record(
			're-accepting enqueues a fresh job (2 total, latest pending)',
			jobsAfterReaccept.rows.length === 2 && jobsAfterReaccept.rows[1].status === 'pending',
			`jobs: ${JSON.stringify(jobsAfterReaccept.rows)}`
		);

		runWorkerOnce(STUB_B);

		const afterRunB = await getAiRows(pool, dayId);
		const namesB = afterRunB.entities.map((e) => `${e.entity_type}:${e.display_name}`).sort();
		const expectedB = [`person:${MARKER}Person`, `person:${MARKER}PersonTwo`].sort();
		record(
			'second run replaces AI entities with stub B (place gone, second person added)',
			JSON.stringify(namesB) === JSON.stringify(expectedB),
			`got ${JSON.stringify(namesB)}, expected ${JSON.stringify(expectedB)}`
		);
		record(
			'second run replaces AI tag with stub B (not accumulated)',
			afterRunB.aiTags.length === 1 && afterRunB.aiTags[0].tag_slug === `${MARKER.toLowerCase()}-tag-b`,
			`got ${JSON.stringify(afterRunB.aiTags)}`
		);
		record(
			'human tag survives AI-row replacement',
			afterRunB.humanTags.length === 1 && afterRunB.humanTags[0].tag_slug === HUMAN_TAG_SLUG,
			`got ${JSON.stringify(afterRunB.humanTags)}`
		);

		// ── Stale job: payload correction_id no longer the latest ───────────
		const latestCorrectionRes = await pool.query(
			`SELECT id FROM day_corrections WHERE day_id = $1 ORDER BY created_at DESC LIMIT 1`,
			[dayId]
		);
		const latestCorrectionId = Number(latestCorrectionRes.rows[0].id);
		const staleCorrectionId = latestCorrectionId - 1; // the first accept's correction, no longer latest

		const staleJobRes = await pool.query(
			`INSERT INTO job_runs (job_type, payload) VALUES ('entity_extract', $1::jsonb) RETURNING id`,
			[JSON.stringify({ day_id: dayId, correction_id: staleCorrectionId })]
		);
		const staleJobId = staleJobRes.rows[0].id;

		// Snapshot AI state before running the stale job — it must be
		// byte-for-byte unchanged afterward.
		const beforeStale = await getAiRows(pool, dayId);

		runWorkerOnce(STUB_A); // if this were honored, it would wrongly restore stub A

		const staleJobAfter = await pool.query(`SELECT status, last_error FROM job_runs WHERE id = $1`, [staleJobId]);
		record(
			'stale job (old correction_id) is marked done with a skip note, not reprocessed',
			staleJobAfter.rows[0]?.status === 'done' && /stale|not accepted/i.test(staleJobAfter.rows[0]?.last_error ?? ''),
			`got ${JSON.stringify(staleJobAfter.rows[0])}`
		);

		const afterStale = await getAiRows(pool, dayId);
		record(
			'stale job is a true no-op — AI/human rows unchanged from before it ran',
			JSON.stringify(afterStale) === JSON.stringify(beforeStale),
			JSON.stringify(afterStale) === JSON.stringify(beforeStale)
				? 'unchanged, as required'
				: `before=${JSON.stringify(beforeStale)} after=${JSON.stringify(afterStale)}`
		);

		console.log('\nEnrichment worker results:\n');
		const width = Math.max(...rows.map((r) => r.label.length)) + 2;
		for (const r of rows) {
			const mark = r.ok ? 'PASS' : 'FAIL';
			console.log(`${mark}  ${r.label.padEnd(width)} ${r.detail}`);
		}
		console.log(`\n${pass} passed, ${fail} failed (${rows.length} total)`);

		if (fail > 0) process.exitCode = 1;
	} finally {
		await cleanupFixture(pool, fixture ?? {});
		await pool.end();
	}
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
