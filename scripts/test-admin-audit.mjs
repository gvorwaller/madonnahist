#!/usr/bin/env node
// Admin audit-log viewer content test for /admin/audit (td-310bf7).
//
// Gating (403 for viewer/corrector, 200 for admin, unauthenticated redirect)
// is covered by scripts/test-auth-matrix.mjs, which sweeps /admin/audit into
// its existing role matrix — this script focuses on what the auth matrix
// can't: that the filters actually filter (and compose with AND), that the
// date range is inclusive at both ends, and the pagination boundary.
//
// Runs against a dev server already started on the isolated test stack:
//   npx vite dev --host 127.0.0.1 --port 5177 --strictPort --mode test
//
// Self-provisions a throwaway admin user plus a batch of audit_log rows
// inserted directly (user_id left NULL — this is a pure read view over the
// table, so there's no need to drive real app actions just to populate rows;
// NULL also exercises the "—" display for a null user). Drives real HTTP
// requests against the running server and cleans up in a finally block.
// Never touches port 5433/5435 or PGDATABASE=madonnahist — see
// requireTestSafety() below.
//
// Usage: node scripts/test-admin-audit.mjs [baseUrl]
//   (or: npm run test:admin-audit)

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
const TEST_PASSWORD = 'AdminAuditTest!2026';
const ADMIN_USERNAME = '_adminaudit_admin';

const ARGON2_OPTS = {
	type: argon2.argon2id,
	memoryCost: 19456,
	timeCost: 2,
	parallelism: 1
};

// Synthetic, never-elsewhere-used action/entity_type/description markers.
const ACTION_ALPHA = '_test_action_alpha';
const ACTION_BETA = '_test_action_beta';
const ACTION_PAGE = '_test_action_page';
const ENTITY_ALPHA = '_test_entity_alpha';
const ENTITY_BETA = '_test_entity_beta';
const ALPHA_MARKER = 'ALPHAMARKERTEST';
const BETA_MARKER = 'BETAMARKERTEST';
const DETAILS_MARKER = 'DETAILSMARKERTEST';
const PAGE_ROW_COUNT = 51;

let pass = 0;
let fail = 0;
const rows = [];

function record(label, ok, detail) {
	if (ok) pass++;
	else fail++;
	rows.push({ label, ok, detail });
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

async function provisionAdmin(pool) {
	const passwordHash = await argon2.hash(TEST_PASSWORD, ARGON2_OPTS);
	const res = await pool.query(
		`INSERT INTO users (username, display_name, role, password_hash)
		 VALUES ($1, $2, 'admin', $3)
		 ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = 'admin'
		 RETURNING id`,
		[ADMIN_USERNAME, 'Admin Audit Test Admin', passwordHash]
	);
	return res.rows[0].id;
}

async function cleanupAdmin(pool, userId) {
	if (!userId) return;
	await pool.query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
	// td-310bf7: login inserts its own audit_log row — must go before users delete.
	await pool.query(`DELETE FROM audit_log WHERE user_id = $1`, [userId]);
	await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
}

async function provisionFixtureRows(pool) {
	await pool.query(`DELETE FROM audit_log WHERE action = ANY($1)`, [[ACTION_ALPHA, ACTION_BETA, ACTION_PAGE]]);

	// Alpha: Jan 2020, entity_type alpha. Beta: Feb 2020, entity_type beta.
	// Distinct months so the date-range filter test has a clean boundary.
	await pool.query(
		`INSERT INTO audit_log (user_id, action, entity_type, entity_id, description, occurred_at)
		 VALUES (NULL, $1, $2, 1, $3, '2020-01-15T12:00:00Z')`,
		[ACTION_ALPHA, ENTITY_ALPHA, `${ALPHA_MARKER} description one`]
	);
	await pool.query(
		`INSERT INTO audit_log (user_id, action, entity_type, entity_id, description, occurred_at)
		 VALUES (NULL, $1, $2, 2, $3, '2020-02-15T12:00:00Z')`,
		[ACTION_BETA, ENTITY_BETA, `${BETA_MARKER} description two`]
	);

	// Timezone-boundary rows (regression guard for startOfDayInAppTzAsUtc,
	// which returned DOUBLE the tz offset until 2026-07-23 — mid-day fixtures
	// alone can't catch an offset-sized shift). Home tz America/New_York is
	// EST (UTC-5) in January: local 2020-01-15 00:30 = 05:30Z (must be
	// INSIDE from=2020-01-15), local 2020-01-14 23:30 = 04:30Z on the 15th
	// UTC (must be OUTSIDE from=2020-01-15 — it's still the 14th locally).
	await pool.query(
		`INSERT INTO audit_log (user_id, action, entity_type, entity_id, description, occurred_at)
		 VALUES (NULL, $1, $2, 4, $3, '2020-01-15T05:30:00Z')`,
		[ACTION_ALPHA, ENTITY_ALPHA, `${ALPHA_MARKER} tz-boundary inside`]
	);
	await pool.query(
		`INSERT INTO audit_log (user_id, action, entity_type, entity_id, description, occurred_at)
		 VALUES (NULL, $1, $2, 5, $3, '2020-01-15T04:30:00Z')`,
		[ACTION_ALPHA, ENTITY_ALPHA, `${ALPHA_MARKER} tz-boundary outside`]
	);

	// A row with before/after JSON, for the expandable-details assertion.
	await pool.query(
		`INSERT INTO audit_log (user_id, action, entity_type, entity_id, description, before_value, after_value, occurred_at)
		 VALUES (NULL, $1, $2, 3, $3, $4::jsonb, $5::jsonb, '2020-01-20T12:00:00Z')`,
		[ACTION_ALPHA, ENTITY_ALPHA, `${DETAILS_MARKER} description with details`,
			JSON.stringify({ before: 'x' }), JSON.stringify({ after: 'y' })]
	);

	// Pagination boundary: 51 rows, deterministic ascending occurred_at so
	// ORDER BY occurred_at DESC gives a stable, predictable page split.
	for (let i = 1; i <= PAGE_ROW_COUNT; i++) {
		const occurredAt = new Date(Date.UTC(2019, 0, 1, 0, 0, i)).toISOString();
		await pool.query(
			`INSERT INTO audit_log (user_id, action, entity_type, entity_id, description, occurred_at)
			 VALUES (NULL, $1, 'pagination_test', $2, $3, $4)`,
			[ACTION_PAGE, i, `PAGEBOUNDARYTEST idx=${i}`, occurredAt]
		);
	}
}

async function cleanupFixtureRows(pool) {
	await pool.query(`DELETE FROM audit_log WHERE action = ANY($1)`, [[ACTION_ALPHA, ACTION_BETA, ACTION_PAGE]]);
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

	let adminId;
	try {
		try {
			await fetch(`${BASE_URL}/api/health`);
		} catch (err) {
			console.error(`ERROR: could not reach ${BASE_URL} — start the dev server first:`);
			console.error('  npx vite dev --host 127.0.0.1 --port 5177 --strictPort --mode test');
			throw err;
		}

		adminId = await provisionAdmin(pool);
		await provisionFixtureRows(pool);
		const adminCookie = await login(ADMIN_USERNAME, TEST_PASSWORD);

		async function get(qs) {
			const res = await fetchNoRedirect(`${BASE_URL}/admin/audit${qs}`, { headers: { Cookie: adminCookie } });
			return { status: res.status, body: await res.text() };
		}

		// ── action filter ────────────────────────────────────────────────────
		{
			const { status, body } = await get(`?action=${ACTION_ALPHA}`);
			const ok = status === 200 && body.includes(ALPHA_MARKER) && !body.includes(BETA_MARKER);
			record('GET /admin/audit?action=<alpha> finds alpha, excludes beta', ok, `status ${status}`);
		}

		// ── entityType filter ────────────────────────────────────────────────
		{
			const { status, body } = await get(`?entityType=${ENTITY_BETA}`);
			const ok = status === 200 && body.includes(BETA_MARKER) && !body.includes(ALPHA_MARKER);
			record('GET /admin/audit?entityType=<beta> finds beta, excludes alpha', ok, `status ${status}`);
		}

		// ── free-text description search (ILIKE) ────────────────────────────
		{
			const { status, body } = await get(`?q=${ALPHA_MARKER}`);
			const ok = status === 200 && body.includes(ALPHA_MARKER) && !body.includes(BETA_MARKER);
			record('GET /admin/audit?q=<alpha marker> finds alpha via description search', ok, `status ${status}`);
		}
		{
			// Case-insensitive: ILIKE, not LIKE.
			const { status, body } = await get(`?q=${ALPHA_MARKER.toLowerCase()}`);
			const ok = status === 200 && body.includes(ALPHA_MARKER);
			record('GET /admin/audit?q=<lowercase alpha marker> still finds it (ILIKE)', ok, `status ${status}`);
		}

		// ── null user renders as em dash ──────────────────────────────────────
		{
			const { status, body } = await get(`?action=${ACTION_ALPHA}&entityType=${ENTITY_ALPHA}&q=${ALPHA_MARKER}`);
			const ok = status === 200 && body.includes('—');
			record('GET /admin/audit [null-user row] renders "—" for user', ok, `status ${status}`);
		}

		// ── date range: inclusive at both ends, excludes the other month ────
		{
			const { status, body } = await get('?from=2020-01-01&to=2020-01-31');
			const ok = status === 200 && body.includes(ALPHA_MARKER) && !body.includes(BETA_MARKER);
			record('GET /admin/audit?from=2020-01-01&to=2020-01-31 includes Jan row, excludes Feb row', ok,
				`status ${status}`);
		}
		{
			// Timezone boundary: from=2020-01-15 must include local 00:30 of the
			// 15th (05:30Z) and exclude local 23:30 of the 14th (04:30Z).
			const { status, body } = await get('?from=2020-01-15&to=2020-01-15');
			const ok = status === 200 && body.includes('tz-boundary inside') && !body.includes('tz-boundary outside');
			record('date filter respects home-timezone midnight boundary (offset regression guard)', ok,
				`status=${status} inside=${body.includes('tz-boundary inside')} outside=${body.includes('tz-boundary outside')}`);
		}
		{
			const { status, body } = await get('?from=2020-02-01');
			const ok = status === 200 && body.includes(BETA_MARKER) && !body.includes(ALPHA_MARKER);
			record('GET /admin/audit?from=2020-02-01 (open-ended) includes Feb row, excludes Jan row', ok,
				`status ${status}`);
		}
		{
			// "to" is inclusive of the whole day — a row timestamped mid-day on
			// the boundary date itself must still appear.
			const { status, body } = await get('?to=2020-01-15');
			const ok = status === 200 && body.includes(ALPHA_MARKER);
			record('GET /admin/audit?to=2020-01-15 includes a row occurring ON that date (inclusive)', ok,
				`status ${status}`);
		}

		// ── AND composition: a filter combination matching neither row → zero ─
		{
			const { status, body } = await get(`?action=${ACTION_ALPHA}&entityType=${ENTITY_BETA}`);
			const ok = status === 200 && !body.includes(ALPHA_MARKER) && !body.includes(BETA_MARKER)
				&& /\b0 entries\b/.test(body);
			record('GET /admin/audit?action=<alpha>&entityType=<beta> (mismatched AND) finds nothing', ok,
				`status ${status}`);
		}

		// ── expandable details: toggle present only when before/after exist ──
		// Checked via an actual `<button class="detail-toggle...">` element,
		// NOT a bare `body.includes('detail-toggle')` — Svelte's SSR output
		// always emits the component's scoped `<style>` block, which contains
		// the literal string "detail-toggle" in its CSS selector regardless of
		// whether any row actually rendered the button, so a plain substring
		// check would be a false positive every time.
		const DETAIL_TOGGLE_BUTTON = /<button class="detail-toggle/;
		{
			const { status, body } = await get(`?q=${DETAILS_MARKER}`);
			const ok = status === 200 && body.includes(DETAILS_MARKER) && DETAIL_TOGGLE_BUTTON.test(body);
			record('GET /admin/audit [row with before/after] renders a Details toggle', ok, `status ${status}`);
		}
		{
			const { status, body } = await get(`?q=${ALPHA_MARKER}&entityType=${ENTITY_ALPHA}&action=${ACTION_ALPHA}`);
			// Both the plain alpha row (no before/after) and the details row
			// (has before/after, but its description doesn't match q=ALPHA_MARKER
			// alone unless combined) — narrow to just the plain alpha row via q,
			// which only that row's description contains as its own marker.
			const ok = status === 200 && body.includes(ALPHA_MARKER) && !DETAIL_TOGGLE_BUTTON.test(body);
			record('GET /admin/audit [row with no before/after] renders no Details toggle', ok, `status ${status}`);
		}

		// ── pagination boundary ──────────────────────────────────────────────
		{
			const { status, body } = await get(`?action=${ACTION_PAGE}`);
			const ok = status === 200 && body.includes(`${PAGE_ROW_COUNT} entries`) && body.includes('Page 1 of 2');
			record('GET /admin/audit?action=<page> total=51, "Page 1 of 2"', ok, `status ${status}`);
			const hasNewest = body.includes(`idx=${PAGE_ROW_COUNT}`);
			const hasOldest = body.includes('idx=1<') || /idx=1(?!\d)/.test(body);
			record('GET /admin/audit?action=<page> page 1 shows the 50 newest (idx=51 present)', hasNewest,
				hasNewest ? 'idx=51 present' : 'idx=51 missing from page 1');
			record('GET /admin/audit?action=<page> page 1 excludes the oldest row (idx=1)', !hasOldest,
				hasOldest ? 'IDX=1 LEAKED ONTO PAGE 1' : 'idx=1 correctly absent from page 1');
		}
		{
			const { status, body } = await get(`?action=${ACTION_PAGE}&page=2`);
			const ok = status === 200 && body.includes('Page 2 of 2') && body.includes('idx=1<');
			record('GET /admin/audit?action=<page>&page=2 shows the 51st (oldest) row', ok, `status ${status}`);
			const noNewest = !body.includes(`idx=${PAGE_ROW_COUNT}`);
			record('GET /admin/audit?action=<page>&page=2 excludes the newest row', noNewest,
				noNewest ? 'idx=51 correctly absent from page 2' : 'IDX=51 LEAKED ONTO PAGE 2');
		}
		{
			// Pager preserves the active filter in its Next link. `&` inside an
			// href attribute is rendered as the HTML entity `&amp;` by SvelteKit's
			// SSR output (correctly — a literal bare `&` there would be invalid
			// HTML) — a real browser decodes this back to `&` when following the
			// link, so the entity-encoded form is what to look for here.
			const { body } = await get(`?action=${ACTION_PAGE}&page=1`);
			const expected = `/admin/audit?action=${ACTION_PAGE}&amp;page=2`;
			const ok = body.includes(expected);
			record('GET /admin/audit pager Next link preserves the active filter', ok,
				ok ? 'expected pager href present' : `expected pager href missing: ${expected}`);
		}

		console.log('\nAdmin audit results:\n');
		const width = Math.max(...rows.map((r) => r.label.length)) + 2;
		for (const r of rows) {
			const mark = r.ok ? 'PASS' : 'FAIL';
			console.log(`${mark}  ${r.label.padEnd(width)} ${r.detail}`);
		}
		console.log(`\n${pass} passed, ${fail} failed (${rows.length} total)`);

		if (fail > 0) process.exitCode = 1;
	} finally {
		await cleanupFixtureRows(pool);
		await cleanupAdmin(pool, adminId);
		await pool.end();
	}
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
