#!/usr/bin/env node
// Family-viewer authorization test for /app/* (Phase B of
// docs/2026-07-21-next-phases-search-viewer-narrative-plan.md).
//
// Runs against a dev server already started on the isolated test stack:
//   npx vite dev --host 127.0.0.1 --port 5177 --strictPort --mode test
//
// Self-provisions a throwaway viewer user plus one calendar_pages row and
// two calendar_days rows (one accepted, one pending) directly in
// madonnahist_test (127.0.0.1:15434), drives real HTTP requests against the
// running server, and cleans up in a finally block. Never touches port
// 5433/5435 or PGDATABASE=madonnahist — see requireTestSafety() below.
//
// What this asserts (per the plan's Phase B verify section):
//   - accepted day page renders the real corrected_text
//   - pending day page renders the friendly "not transcribed" state and
//     NEVER leaks its corrected_text
//   - day image endpoint: accepted is 200-or-graceful (a fake local object
//     path means the object store fetch itself may 404/500 — that's fine,
//     the point here is authorization, not object bytes); pending is a hard
//     404 (denied before any object-store fetch is attempted)
//   - search finds accepted-day text and never pending-day text
//
// Usage: node scripts/test-viewer-security.mjs [baseUrl]
//   (or: npm run test:viewer)

import argon2 from 'argon2';
import pg from 'pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

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
	if (!process.env.PGDATABASE || !process.env.PGPASSWORD) {
		problems.push('PGDATABASE/PGPASSWORD must be set (copy .env.test.example to .env.test)');
	}
	return problems;
}

const BASE_URL = process.argv[2] ?? 'http://127.0.0.1:5177';
const SESSION_COOKIE_NAME = 'madonnahist_session';
const TEST_PASSWORD = 'ViewerSecurityTest!2026';
const VIEWER_USERNAME = '_viewersecurity_viewer';

const ARGON2_OPTS = {
	type: argon2.argon2id,
	memoryCost: 19456,
	timeCost: 2,
	parallelism: 1
};

// Distinctive, never-elsewhere-occurring markers so a plain substring/FTS
// match can only mean "this fixture's text," not a coincidence.
const ACCEPTED_MARKER = 'ZQXPLORPTEST';
const PENDING_MARKER = 'WOBBLEFRIMPTEST';

const FIXTURE_YEAR = 1899;
const FIXTURE_MONTH = 1;
const ACCEPTED_DATE = '1899-01-10';
const PENDING_DATE = '1899-01-11';
const FIXTURE_CAPTURE_SESSION = '_viewer_security_test';

let pass = 0;
let fail = 0;
const rows = [];

function record(label, ok, detail) {
	if (ok) pass++;
	else fail++;
	rows.push({ label, ok, detail });
}

// SvelteKit serializes form-action results as a 200 JSON envelope unless the
// request signals a real browser navigation — always send Accept: text/html
// so redirects/401/403/404 come back as actual status codes. Mirrors
// scripts/test-auth-matrix.mjs.
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
		[VIEWER_USERNAME, 'Viewer Security Test', passwordHash]
	);
	return res.rows[0].id;
}

async function cleanupViewer(pool, userId) {
	if (!userId) return;
	await pool.query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
	await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
}

async function provisionFixtureDays(pool) {
	// madonnahist_app has no UPDATE grant on calendar_days.corrected_text /
	// correction_status (the sacred human-truth invariant — see
	// backend/db/migrations/0006_fix_calendar_days_app_grants.sql), so an
	// `ON CONFLICT ... DO UPDATE` touching those columns would itself hit a
	// permission error even though this is nominally an INSERT. Idempotency
	// instead comes from deleting any leftover fixture rows for these exact
	// dates first (DELETE is unrestricted for madonnahist_app), then a plain
	// INSERT — never an UPDATE — sets corrected_text/correction_status.
	await pool.query(
		`INSERT INTO calendar_pages (year, month, page_image_path, capture_session)
		 VALUES ($1, $2, $3, $4)
		 ON CONFLICT (year, month) DO NOTHING`,
		[FIXTURE_YEAR, FIXTURE_MONTH, 'fixtures/viewer-security-test/fake-page.jpg', FIXTURE_CAPTURE_SESSION]
	);
	const pageRes = await pool.query(
		`SELECT id FROM calendar_pages WHERE year = $1 AND month = $2`,
		[FIXTURE_YEAR, FIXTURE_MONTH]
	);
	const pageId = pageRes.rows[0].id;

	await pool.query(`DELETE FROM calendar_days WHERE entry_date = ANY($1::date[])`, [
		[ACCEPTED_DATE, PENDING_DATE]
	]);

	await pool.query(
		`INSERT INTO calendar_days (page_id, entry_date, day_image_path, corrected_text, correction_status)
		 VALUES ($1, $2, $3, $4, 'accepted')`,
		[pageId, ACCEPTED_DATE, 'fixtures/viewer-security-test/fake-accepted.jpg',
			`Distinctive fixture entry for viewer security test: ${ACCEPTED_MARKER} happened here. A second sentence follows for preview purposes.`]
	);

	await pool.query(
		`INSERT INTO calendar_days (page_id, entry_date, day_image_path, corrected_text, correction_status)
		 VALUES ($1, $2, $3, $4, 'pending')`,
		[pageId, PENDING_DATE, 'fixtures/viewer-security-test/fake-pending.jpg',
			`Distinctive fixture entry for viewer security test: ${PENDING_MARKER} happened here — this must never leak.`]
	);

	return pageId;
}

async function cleanupFixtureDays(pool, pageId) {
	if (!pageId) return;
	await pool.query(`DELETE FROM calendar_days WHERE page_id = $1`, [pageId]);
	await pool.query(`DELETE FROM calendar_pages WHERE id = $1`, [pageId]);
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

		// ── Day detail: accepted ────────────────────────────────────────────
		{
			const res = await fetchNoRedirect(`${BASE_URL}/app/day/${ACCEPTED_DATE}`, {
				headers: { Cookie: viewerCookie }
			});
			const body = await res.text();
			const okStatus = res.status === 200;
			record('GET /app/day/<accepted> [viewer] status', okStatus, `expected 200, got ${res.status}`);
			const hasMarker = body.includes(ACCEPTED_MARKER);
			record('GET /app/day/<accepted> [viewer] shows corrected_text', hasMarker,
				hasMarker ? 'marker present' : 'marker missing from body');
		}

		// ── Day detail: pending ─────────────────────────────────────────────
		{
			const res = await fetchNoRedirect(`${BASE_URL}/app/day/${PENDING_DATE}`, {
				headers: { Cookie: viewerCookie }
			});
			const body = await res.text();
			const okStatus = res.status === 200;
			record('GET /app/day/<pending> [viewer] renders (not a 404 page)', okStatus,
				`expected 200 (friendly state), got ${res.status}`);
			const leaked = body.includes(PENDING_MARKER);
			record('GET /app/day/<pending> [viewer] never leaks corrected_text', !leaked,
				leaked ? 'PENDING MARKER LEAKED INTO RESPONSE BODY' : 'marker absent, as required');
			const friendly = body.toLowerCase().includes('not transcribed') || body.toLowerCase().includes("isn't transcribed") || body.toLowerCase().includes('is not transcribed');
			record('GET /app/day/<pending> [viewer] shows friendly not-yet-transcribed copy', friendly,
				friendly ? 'friendly copy found' : 'no friendly "not transcribed" copy found in body');
		}

		// ── Day image: accepted (fake local path — 200/404/500 all acceptable;
		//    the point is authorization, not object-store bytes) ────────────
		{
			const res = await fetchNoRedirect(`${BASE_URL}/app/day/${ACCEPTED_DATE}/image`, {
				headers: { Cookie: viewerCookie }
			});
			const ok = res.status === 200 || res.status === 404 || res.status === 500;
			record('GET /app/day/<accepted>/image [viewer]', ok,
				ok ? `${res.status} (200-or-graceful, as expected)` : `unexpected status ${res.status}`);
		}

		// ── Day image: pending — must be a hard 404, denied before any
		//    object-store fetch is attempted ─────────────────────────────────
		{
			const res = await fetchNoRedirect(`${BASE_URL}/app/day/${PENDING_DATE}/image`, {
				headers: { Cookie: viewerCookie }
			});
			const ok = res.status === 404;
			record('GET /app/day/<pending>/image [viewer] is 404', ok, `expected 404, got ${res.status}`);
		}

		// ── Search: finds accepted-day text ─────────────────────────────────
		// Check for an actual result-card link to the accepted day, not just
		// a marker substring — the search box itself echoes back whatever
		// `q` was (`value="<marker>"`), so a naive body.includes() would
		// pass even with zero real matches.
		{
			const url = `${BASE_URL}/app/search?${new URLSearchParams({ q: ACCEPTED_MARKER })}`;
			const res = await fetchNoRedirect(url, { headers: { Cookie: viewerCookie } });
			const body = await res.text();
			const linksToAcceptedDay = body.includes(`/app/day/${ACCEPTED_DATE}`);
			const found = res.status === 200 && linksToAcceptedDay;
			record('GET /app/search?q=<accepted marker> [viewer] finds it', found,
				found ? 'result card links to the accepted day' : `status ${res.status}, day-link present: ${linksToAcceptedDay}`);
		}

		// ── Search: never finds pending-day text ────────────────────────────
		// Same reasoning in reverse: assert no result card links to the
		// pending day, rather than a bare marker-substring check (which the
		// echoed search-box value and the "No results for ..." hint text
		// would both trip regardless of whether anything actually matched).
		{
			const url = `${BASE_URL}/app/search?${new URLSearchParams({ q: PENDING_MARKER })}`;
			const res = await fetchNoRedirect(url, { headers: { Cookie: viewerCookie } });
			const body = await res.text();
			const linksToPendingDay = body.includes(`/app/day/${PENDING_DATE}`);
			record('GET /app/search?q=<pending marker> [viewer] never finds it', !linksToPendingDay,
				linksToPendingDay ? 'PENDING DAY LEAKED INTO SEARCH RESULTS' : 'no result card for the pending day, as required');
		}

		console.log('\nViewer security results:\n');
		const width = Math.max(...rows.map((r) => r.label.length)) + 2;
		for (const r of rows) {
			const mark = r.ok ? 'PASS' : 'FAIL';
			console.log(`${mark}  ${r.label.padEnd(width)} ${r.detail}`);
		}
		console.log(`\n${pass} passed, ${fail} failed (${rows.length} total)`);

		if (fail > 0) process.exitCode = 1;
	} finally {
		await cleanupFixtureDays(pool, pageId);
		await cleanupViewer(pool, viewerId);
		await pool.end();
	}
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
