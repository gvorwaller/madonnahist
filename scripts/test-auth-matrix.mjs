#!/usr/bin/env node
// Route-gating auth matrix test for src/hooks.server.ts (Phase A of
// docs/2026-07-21-next-phases-search-viewer-narrative-plan.md).
//
// Runs against a dev server already started on the isolated test stack:
//   npx vite dev --host 127.0.0.1 --port 5177 --strictPort --mode test
//
// Self-provisions one throwaway user per role directly in madonnahist_test
// (127.0.0.1:15434), drives real HTTP requests against the running server,
// and cleans up in a finally block. Never touches port 5433/5435 or
// PGDATABASE=madonnahist — see requireTestSafety() below.
//
// Usage: node scripts/test-auth-matrix.mjs [baseUrl]
//   (or: npm run test:auth)

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
const TEST_PASSWORD = 'AuthMatrixTest!2026';

const ARGON2_OPTS = {
	type: argon2.argon2id,
	memoryCost: 19456,
	timeCost: 2,
	parallelism: 1
};

const TEST_USERS = [
	{ role: 'viewer', username: '_authmatrix_viewer' },
	{ role: 'corrector', username: '_authmatrix_corrector' },
	{ role: 'admin', username: '_authmatrix_admin' }
];

// ── Route-gating expectations, mirroring src/hooks.server.ts ───────────────
const PUBLIC_PATHS = ['/login', '/api/health'];
function isPublic(p) {
	return PUBLIC_PATHS.includes(p);
}
function matchesPrefix(path, prefix) {
	return path === prefix || path.startsWith(prefix + '/');
}
function roleAllowed(path, role) {
	if (matchesPrefix(path, '/admin')) return role === 'admin';
	if (matchesPrefix(path, '/correct')) return role === 'admin' || role === 'corrector';
	if (matchesPrefix(path, '/app')) return true;
	if (path === '/') return true;
	return false;
}

// td-310bf7: /admin/audit swept into the same gating matrix as every other
// /admin path — roleAllowed()'s existing '/admin' prefix rule already covers
// it (admin-only), so this needs no new expectation logic, just the path.
const PATHS = ['/login', '/api/health', '/', '/app', '/correct', '/admin', '/admin/audit', '/nonexistent-path'];
const METHODS = ['GET', 'POST'];
const ROLES = ['unauthenticated', 'viewer', 'corrector', 'admin'];

let pass = 0;
let fail = 0;
const rows = [];

function record(label, ok, detail) {
	if (ok) pass++;
	else fail++;
	rows.push({ label, ok, detail });
}

// SvelteKit serializes form-action results as a 200 JSON envelope
// (`{"type":"redirect"|"failure"|"error",...}`) unless the request's Accept
// header signals a real browser navigation (`text/html`) — a plain `fetch()`
// or `curl` without this header never sees the real HTTP status. Always send
// it so redirects/401/403/404 come back as actual status codes, matching
// what a real form submission or link click produces.
async function fetchNoRedirect(url, opts) {
	return fetch(url, {
		...opts,
		redirect: 'manual',
		headers: { Accept: 'text/html', ...(opts?.headers ?? {}) }
	});
}

function extractSessionCookie(res) {
	// Node fetch exposes multiple Set-Cookie headers via getSetCookie() when present.
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

async function provisionUsers(pool) {
	const ids = {};
	const passwordHash = await argon2.hash(TEST_PASSWORD, ARGON2_OPTS);
	for (const u of TEST_USERS) {
		const res = await pool.query(
			`INSERT INTO users (username, display_name, role, password_hash)
			 VALUES ($1, $2, $3, $4)
			 ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role
			 RETURNING id`,
			[u.username, `Auth Matrix ${u.role}`, u.role, passwordHash]
		);
		ids[u.role] = res.rows[0].id;
	}
	return ids;
}

async function cleanupUsers(pool, ids) {
	const idList = Object.values(ids);
	if (idList.length === 0) return;
	await pool.query(`DELETE FROM sessions WHERE user_id = ANY($1::int[])`, [idList]);
	// td-310bf7: the login action now inserts an audit_log row on success,
	// and audit_log.user_id REFERENCES users(id) with no ON DELETE action —
	// this test logs each role in multiple times (the matrix pass plus the
	// explicit logout re-login), so those rows must go before the users
	// delete or it hits a foreign key violation. Same precedent as
	// scripts/test-ask.mjs and scripts/test-pdf-export.mjs's cleanupUsers.
	await pool.query(`DELETE FROM audit_log WHERE user_id = ANY($1::int[])`, [idList]);
	await pool.query(`DELETE FROM users WHERE id = ANY($1::int[])`, [idList]);
}

function expectedFor(path, method, role) {
	if (isPublic(path)) {
		// Gating never applies — downstream status is whatever the route does.
		return { kind: 'ungated' };
	}
	if (role === 'unauthenticated') {
		return method === 'GET'
			? { kind: 'exact', status: 303, why: 'unauthenticated GET redirects to /login' }
			: { kind: 'exact', status: 401, why: 'unauthenticated POST gets 401 JSON' };
	}
	if (!roleAllowed(path, role)) {
		return { kind: 'exact', status: 403, why: `role ${role} not allowed on ${path}` };
	}
	return { kind: 'gated-allowed', why: `role ${role} allowed on ${path}` };
}

async function checkOne(path, method, role, cookie) {
	const headers = cookie ? { Cookie: cookie } : {};
	const res = await fetchNoRedirect(`${BASE_URL}${path}`, { method, headers });
	const expected = expectedFor(path, method, role);
	const label = `${method} ${path} [${role}]`;

	if (expected.kind === 'exact') {
		const ok = res.status === expected.status;
		record(label, ok, ok
			? `${res.status} (${expected.why})`
			: `expected ${expected.status}, got ${res.status} (${expected.why})`);
	} else if (expected.kind === 'gated-allowed') {
		// Gating passed the request through; whatever the app does downstream
		// is out of scope here, but it must NOT be a gating-shaped denial.
		const ok = res.status !== 401 && res.status !== 403;
		record(label, ok, ok
			? `${res.status} (not denied — ${expected.why})`
			: `got gating-denial status ${res.status} but ${expected.why}`);
	} else {
		// ungated (public path): just confirm it never returns a gating denial
		// caused by the hook (401/403 could still legitimately come from the
		// route itself, e.g. a bad login, so we only assert reachability).
		record(label, true, `${res.status} (public path, ungated)`);
	}
}

async function checkLogoutSucceeds(role, cookie) {
	const res = await fetchNoRedirect(`${BASE_URL}/login?/logout`, {
		method: 'POST',
		headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
		body: ''
	});
	const ok = res.status === 303;
	record(`POST /login?/logout [${role}]`, ok, ok ? '303 (logged out)' : `expected 303, got ${res.status}`);
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

	let ids = {};
	try {
		// Confirm the dev server is reachable before doing anything else.
		try {
			await fetch(`${BASE_URL}/api/health`);
		} catch (err) {
			console.error(`ERROR: could not reach ${BASE_URL} — start the dev server first:`);
			console.error('  npx vite dev --host 127.0.0.1 --port 5177 --strictPort --mode test');
			throw err;
		}

		ids = await provisionUsers(pool);

		const cookies = { unauthenticated: null };
		for (const u of TEST_USERS) {
			cookies[u.role] = await login(u.username, TEST_PASSWORD);
		}

		// td-310bf7: the login action's success path inserts an audit_log row
		// (action='login', entity_type='users', entity_id=user id) — verify
		// directly against the DB rather than the HTTP response, since the
		// insert is a server-side side effect with no visible trace in the
		// 303 redirect itself.
		for (const u of TEST_USERS) {
			const res = await pool.query(
				`SELECT 1 FROM audit_log WHERE user_id = $1 AND action = 'login' AND entity_type = 'users' AND entity_id = $1`,
				[ids[u.role]]
			);
			const ok = res.rows.length > 0;
			record(`login [${u.role}] inserts an audit_log row`, ok,
				ok ? 'audit_log row found' : 'NO audit_log ROW FOUND FOR THIS LOGIN');
		}

		for (const path of PATHS) {
			for (const method of METHODS) {
				for (const role of ROLES) {
					await checkOne(path, method, role, cookies[role]);
				}
			}
		}

		// Explicit requirement: logout must work for every authenticated role.
		// Each check consumes and re-establishes a session so later matrix
		// assertions (already run above) aren't affected by this consuming it.
		for (const role of ['viewer', 'corrector', 'admin']) {
			const cookie = await login(
				TEST_USERS.find(u => u.role === role).username,
				TEST_PASSWORD
			);
			await checkLogoutSucceeds(role, cookie);
		}

		console.log('\nAuth matrix results:\n');
		const width = Math.max(...rows.map(r => r.label.length)) + 2;
		for (const r of rows) {
			const mark = r.ok ? 'PASS' : 'FAIL';
			console.log(`${mark}  ${r.label.padEnd(width)} ${r.detail}`);
		}
		console.log(`\n${pass} passed, ${fail} failed (${rows.length} total)`);

		if (fail > 0) process.exitCode = 1;
	} finally {
		await cleanupUsers(pool, ids);
		await pool.end();
	}
}

main().catch(err => {
	console.error(err);
	process.exitCode = 1;
});
