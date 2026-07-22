#!/usr/bin/env node
// Year-narrative end-to-end test (Phase E of
// docs/2026-07-21-next-phases-search-viewer-narrative-plan.md).
//
// Combines the two existing test patterns:
//   - DB fixture provisioning + spawning the real worker binary with
//     MADONNAHIST_LLM_STUB=1 (scripts/test-enrichment.mjs)
//   - HTTP checks against a running dev server as a logged-in viewer
//     (scripts/test-viewer-security.mjs)
//
// Requires a dev server already running on the isolated test stack:
//   npx vite dev --host 127.0.0.1 --port 5177 --strictPort --mode test
//
// Runs entirely against madonnahist_test (127.0.0.1:15434). Self-provisions a
// throwaway viewer user, a calendar_pages row, two accepted calendar_days
// rows (inserted directly with correction_status='accepted', same trick as
// test-viewer-security.mjs — madonnahist_app has no UPDATE grant on
// corrected_text/correction_status, but a plain INSERT is unrestricted), and
// cleans up in a finally block. Never touches port 5433/5435 or
// PGDATABASE=madonnahist — see requireTestSafety() below.
//
// What this asserts (per the plan's Phase E verify section):
//   - a narrative_summary job for a fixture year with accepted days, run
//     once through the real worker (stub LLM), produces a draft row with
//     is_published=false and summary_text equal to the stubbed text
//   - the job result note reports the accepted-day count
//   - /app/year/[year] as a viewer does NOT show the draft or its "AI
//     generated" label
//   - publishing the row (simulating the admin UI's `publish` action via
//     direct SQL) makes it appear on /app/year/[year] with the generated
//     label
//   - a narrative_summary job enqueued for that now-published year is a
//     guaranteed no-op: summary_text stays byte-for-byte unchanged and the
//     job note says "skipped: published — unpublish first" — the LLM stub
//     text for this run is deliberately different, so any overwrite would
//     be caught
//   - the unpublish-then-regenerate path (simulating the admin UI's
//     `unpublishAndRegenerate` action) does update summary_text, and the
//     row stays unpublished afterward (the worker cannot publish)
//
// Usage: node scripts/test-narratives.mjs [baseUrl] (or: npm run test:narratives)

import argon2 from 'argon2';
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

const BASE_URL = process.argv[2] ?? 'http://127.0.0.1:5177';
const SESSION_COOKIE_NAME = 'madonnahist_session';
const TEST_PASSWORD = 'NarrativeTest!2026';
const VIEWER_USERNAME = '_narrative_test_viewer';

const ARGON2_OPTS = {
	type: argon2.argon2id,
	memoryCost: 19456,
	timeCost: 2,
	parallelism: 1
};

// Distinctive, never-elsewhere-occurring marker so a plain substring check
// can only mean "this fixture's text," not a coincidence.
const MARKER = 'ZQXPLNARRATIVE';
// Must be >= MIN_YEAR (1900) in src/routes/app/year/[year]/+page.server.ts —
// unlike the day-detail and entity-extraction fixtures elsewhere, this test
// hits /app/year/[year] directly, which rejects any year below 1900 as
// "not a valid year" before ever reaching the narrative query.
const FIXTURE_YEAR = 1901;
const FIXTURE_MONTH = 6;
const CAPTURE_SESSION = '_narrative_test';
const DAY_1 = '1901-06-01';
const DAY_2 = '1901-06-15';

const STUB_TEXT_A =
	`${MARKER} first paragraph of the initial generated year narrative.\n\n` +
	`${MARKER} second paragraph, distinct from the first.`;
const STUB_TEXT_B = `${MARKER}OVERWRITE this text must never be written — the year is published.`;
const STUB_TEXT_C = `${MARKER}REGEN regenerated narrative text after unpublish.`;

const GENERATED_LABEL = 'AI-generated year summary, reviewed by the family';

let pass = 0;
let fail = 0;
const rows = [];

function record(label, ok, detail) {
	if (ok) pass++;
	else fail++;
	rows.push({ label, ok, detail });
}

function runWorkerOnce(stubText) {
	const result = spawnSync('npx', ['tsx', 'backend/workers/enrichment-worker.ts', '--limit=1'], {
		cwd: REPO_ROOT,
		encoding: 'utf8',
		env: {
			...process.env,
			MADONNAHIST_LLM_STUB: '1',
			MADONNAHIST_LLM_STUB_TEXT: stubText
		}
	});
	if (result.status !== 0) {
		console.error('Worker stdout:', result.stdout);
		console.error('Worker stderr:', result.stderr);
		throw new Error(`worker exited with status ${result.status}`);
	}
	return result.stdout;
}

async function fetchNoRedirect(url, opts) {
	return fetch(url, {
		...opts,
		redirect: 'manual',
		headers: { Accept: 'text/html', ...(opts?.headers ?? {}) }
	});
}

function extractSessionCookie(res) {
	const raw = typeof res.headers.getSetCookie === 'function'
		? res.headers.getSetCookie()
		: [res.headers.get('set-cookie')].filter(Boolean);
	for (const c of raw) {
		const m = c.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`));
		if (m) return `${SESSION_COOKIE_NAME}=${m[1]}`;
	}
	return null;
}

async function login(username, password) {
	const res = await fetchNoRedirect(`${BASE_URL}/login?/login`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ username, password }).toString()
	});
	if (res.status !== 303) {
		throw new Error(`login for ${username} expected 303, got ${res.status}: ${await res.text()}`);
	}
	const cookie = extractSessionCookie(res);
	if (!cookie) throw new Error(`login for ${username} did not set a session cookie`);
	return cookie;
}

async function provisionViewer(pool) {
	const passwordHash = await argon2.hash(TEST_PASSWORD, ARGON2_OPTS);
	const res = await pool.query(
		`INSERT INTO users (username, display_name, role, password_hash)
		 VALUES ($1, $2, 'viewer', $3)
		 ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = 'viewer'
		 RETURNING id`,
		[VIEWER_USERNAME, 'Narrative Test Viewer', passwordHash]
	);
	return res.rows[0].id;
}

async function cleanupViewer(pool, userId) {
	if (!userId) return;
	await pool.query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
	await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
}

async function provisionFixtureDays(pool) {
	await pool.query(
		`INSERT INTO calendar_pages (year, month, page_image_path, capture_session)
		 VALUES ($1, $2, $3, $4)
		 ON CONFLICT (year, month) DO NOTHING`,
		[FIXTURE_YEAR, FIXTURE_MONTH, 'fixtures/narrative-test/fake-page.jpg', CAPTURE_SESSION]
	);
	const pageRes = await pool.query(`SELECT id FROM calendar_pages WHERE year = $1 AND month = $2`, [
		FIXTURE_YEAR,
		FIXTURE_MONTH
	]);
	const pageId = pageRes.rows[0].id;

	await pool.query(`DELETE FROM calendar_days WHERE entry_date = ANY($1::date[])`, [[DAY_1, DAY_2]]);
	await pool.query(`DELETE FROM narrative_summaries WHERE scope = 'year' AND scope_key = $1`, [String(FIXTURE_YEAR)]);
	await pool.query(
		`DELETE FROM job_runs WHERE job_type = 'narrative_summary' AND payload->>'scope' = 'year' AND payload->>'scope_key' = $1`,
		[String(FIXTURE_YEAR)]
	);

	await pool.query(
		`INSERT INTO calendar_days (page_id, entry_date, corrected_text, correction_status)
		 VALUES ($1, $2, $3, 'accepted')`,
		[pageId, DAY_1, `${MARKER} fixture day one text.`]
	);
	await pool.query(
		`INSERT INTO calendar_days (page_id, entry_date, corrected_text, correction_status)
		 VALUES ($1, $2, $3, 'accepted')`,
		[pageId, DAY_2, `${MARKER} fixture day two text.`]
	);

	return pageId;
}

async function cleanupFixture(pool, pageId) {
	if (!pageId) return;
	await pool.query(`DELETE FROM job_runs WHERE (payload->>'day_id')::int IN (SELECT id FROM calendar_days WHERE page_id = $1)`, [pageId]);
	await pool.query(`DELETE FROM job_runs WHERE job_type = 'narrative_summary' AND payload->>'scope' = 'year' AND payload->>'scope_key' = $1`, [String(FIXTURE_YEAR)]);
	await pool.query(`DELETE FROM calendar_days WHERE page_id = $1`, [pageId]);
	await pool.query(`DELETE FROM calendar_pages WHERE id = $1`, [pageId]);
	await pool.query(`DELETE FROM narrative_summaries WHERE scope = 'year' AND scope_key = $1`, [String(FIXTURE_YEAR)]);
}

function enqueueNarrativeJob(pool) {
	return pool.query(`INSERT INTO job_runs (job_type, payload) VALUES ('narrative_summary', $1::jsonb) RETURNING id`, [
		JSON.stringify({ scope: 'year', scope_key: String(FIXTURE_YEAR) })
	]);
}

async function getNarrativeRow(pool) {
	const res = await pool.query(
		`SELECT summary_text, generated_by, is_published FROM narrative_summaries WHERE scope = 'year' AND scope_key = $1`,
		[String(FIXTURE_YEAR)]
	);
	return res.rows[0] ?? null;
}

async function getLatestJobNote(pool) {
	const res = await pool.query(
		`SELECT status, last_error FROM job_runs
		  WHERE job_type = 'narrative_summary' AND payload->>'scope' = 'year' AND payload->>'scope_key' = $1
		  ORDER BY id DESC LIMIT 1`,
		[String(FIXTURE_YEAR)]
	);
	return res.rows[0] ?? null;
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

	let viewerId;
	let pageId;
	try {
		try {
			await fetch(`${BASE_URL}/api/health`);
		} catch (err) {
			console.error(`ERROR: could not reach ${BASE_URL} — start the dev server first:`);
			console.error('  npx vite dev --host 127.0.0.1 --port 5177 --strictPort --mode test');
			throw err;
		}

		viewerId = await provisionViewer(pool);
		pageId = await provisionFixtureDays(pool);
		const viewerCookie = await login(VIEWER_USERNAME, TEST_PASSWORD);

		// ── Generate: enqueue + run worker once with stub A ─────────────────
		await enqueueNarrativeJob(pool);
		runWorkerOnce(STUB_TEXT_A);

		const afterA = await getNarrativeRow(pool);
		record(
			'worker generates a draft row (is_published=false)',
			afterA !== null && afterA.is_published === false,
			`got ${JSON.stringify(afterA)}`
		);
		record(
			'draft summary_text matches the stubbed text',
			afterA?.summary_text === STUB_TEXT_A,
			`got ${JSON.stringify(afterA?.summary_text)}`
		);

		const jobNoteA = await getLatestJobNote(pool);
		record(
			'job result note reports the accepted-day count',
			jobNoteA?.status === 'done' && /generated from 2 accepted day/.test(jobNoteA?.last_error ?? ''),
			`got ${JSON.stringify(jobNoteA)}`
		);

		// ── Draft invisible on /app/year/[year] as a viewer ─────────────────
		{
			const res = await fetchNoRedirect(`${BASE_URL}/app/year/${FIXTURE_YEAR}`, { headers: { Cookie: viewerCookie } });
			const body = await res.text();
			const leaked = body.includes(MARKER) || body.includes(GENERATED_LABEL);
			record(
				'GET /app/year/<fixture year> [viewer] does NOT show the unpublished draft',
				res.status === 200 && !leaked,
				leaked ? 'DRAFT NARRATIVE LEAKED INTO UNPUBLISHED YEAR PAGE' : `status ${res.status}, no leak`
			);
		}

		// ── Publish via direct SQL (simulating the admin UI's publish action) ─
		await pool.query(`UPDATE narrative_summaries SET is_published = true WHERE scope = 'year' AND scope_key = $1`, [
			String(FIXTURE_YEAR)
		]);

		// ── Published narrative appears with the generated label ────────────
		{
			const res = await fetchNoRedirect(`${BASE_URL}/app/year/${FIXTURE_YEAR}`, { headers: { Cookie: viewerCookie } });
			const body = await res.text();
			const showsText = body.includes(MARKER);
			const showsLabel = body.includes(GENERATED_LABEL);
			record(
				'GET /app/year/<fixture year> [viewer] shows the published narrative text',
				res.status === 200 && showsText,
				`status ${res.status}, text present: ${showsText}`
			);
			record(
				'GET /app/year/<fixture year> [viewer] shows the "AI-generated" label',
				showsLabel,
				showsLabel ? 'label present' : 'label missing from body'
			);
		}

		// ── A narrative_summary job for a now-published year is a no-op ─────
		await enqueueNarrativeJob(pool);
		runWorkerOnce(STUB_TEXT_B); // if honored, this would overwrite the published text — must not happen

		const afterB = await getNarrativeRow(pool);
		record(
			'published row unchanged after a job targeting it runs (worker never touches a published row)',
			afterB?.summary_text === STUB_TEXT_A && afterB?.is_published === true,
			`got ${JSON.stringify(afterB)}`
		);

		const jobNoteB = await getLatestJobNote(pool);
		record(
			'job on a published scope is marked done with the "skipped: published" note, not reprocessed',
			jobNoteB?.status === 'done' && jobNoteB?.last_error === 'skipped: published — unpublish first',
			`got ${JSON.stringify(jobNoteB)}`
		);

		// ── Unpublish + regenerate path (simulating the admin UI's
		//    unpublishAndRegenerate action) ──────────────────────────────────
		await pool.query(`UPDATE narrative_summaries SET is_published = false WHERE scope = 'year' AND scope_key = $1`, [
			String(FIXTURE_YEAR)
		]);
		await enqueueNarrativeJob(pool);
		runWorkerOnce(STUB_TEXT_C);

		const afterC = await getNarrativeRow(pool);
		record(
			'unpublish + regenerate: summary_text updates to the new draft',
			afterC?.summary_text === STUB_TEXT_C,
			`got ${JSON.stringify(afterC?.summary_text)}`
		);
		record(
			'unpublish + regenerate: row stays unpublished (worker cannot publish)',
			afterC?.is_published === false,
			`got is_published=${afterC?.is_published}`
		);

		{
			const res = await fetchNoRedirect(`${BASE_URL}/app/year/${FIXTURE_YEAR}`, { headers: { Cookie: viewerCookie } });
			const body = await res.text();
			const leaked = body.includes(MARKER) || body.includes(GENERATED_LABEL);
			record(
				'GET /app/year/<fixture year> [viewer] hides the regenerated draft until republished',
				res.status === 200 && !leaked,
				leaked ? 'REGENERATED DRAFT LEAKED BEFORE REPUBLISH' : `status ${res.status}, no leak`
			);
		}

		console.log('\nNarrative summary results:\n');
		const width = Math.max(...rows.map((r) => r.label.length)) + 2;
		for (const r of rows) {
			const mark = r.ok ? 'PASS' : 'FAIL';
			console.log(`${mark}  ${r.label.padEnd(width)} ${r.detail}`);
		}
		console.log(`\n${pass} passed, ${fail} failed (${rows.length} total)`);

		if (fail > 0) process.exitCode = 1;
	} finally {
		await cleanupFixture(pool, pageId);
		await cleanupViewer(pool, viewerId);
		await pool.end();
	}
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
