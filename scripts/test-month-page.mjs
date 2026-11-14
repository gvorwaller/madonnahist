#!/usr/bin/env node
// Viewer month page test for /app/month/[monthKey] (td-852d99).
//
// Runs against a dev server already started on the isolated test stack:
//   npx vite dev --host 127.0.0.1 --port 5177 --strictPort --mode test
//
// Self-provisions a throwaway viewer user, two calendar_pages rows (one with
// some accepted days, one with zero accepted days but real ingested days —
// exercising the "photo shows regardless of transcription progress" policy),
// each with a real tiny JPEG written into the local object store
// (.local/object-store-test), drives real HTTP requests against the running
// server, and cleans up in a finally block. Never touches port 5433/5435 or
// PGDATABASE=madonnahist — see requireTestSafety() below.
//
// What this asserts:
//   - month page renders for an authenticated viewer, 200, with the
//     page-image endpoint also 200 and image/jpeg
//   - the reading list shows every accepted day in full, a line for each run
//     of untranscribed days, and never pending text (V3 Slice 3)
//   - its day links carry ?from=/app/month/<monthKey>
//   - photo tap cells mark only accepted days as ready (td-ed1751)
//   - month arrows link the neighbouring captured pages
//   - a month with zero accepted days still renders its photo (the whole
//     point of td-852d99) with no day links and no tappable cells
//   - an invalid monthKey renders a friendly page, never a crash
//   - a valid-format monthKey with no ingested page yet renders a friendly
//     "not captured yet" page, never a raw 404
//   - unauthenticated requests to both the page and the image endpoint are
//     denied before reaching any route logic
//
// Usage: node scripts/test-month-page.mjs [baseUrl]
//   (or: npm run test:month)

import argon2 from 'argon2';
import pg from 'pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import sharp from 'sharp';

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
const TEST_PASSWORD = 'MonthPageTest!2026';
const VIEWER_USERNAME = '_monthpage_viewer';

const ARGON2_OPTS = {
	type: argon2.argon2id,
	memoryCost: 19456,
	timeCost: 2,
	parallelism: 1
};

// Distinct from every other script's FIXTURE_YEAR (1896/1897/1899/1901/1902/1911).
const FIXTURE_YEAR = 1903;
const ACCEPTED_MONTH = 6; // has some accepted days
const ZERO_ACCEPTED_MONTH = 7; // has ingested days, none accepted
const MISSING_MONTH = 8; // valid key, never ingested — no calendar_pages row
const CAPTURE_SESSION = '_month_page_test';
const ACCEPTED_MARKER = 'MONTHPAGEACCEPTEDTEST';
const PENDING_MARKER = 'MONTHPAGEPENDINGTEST';

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

async function provisionViewer(pool) {
	const passwordHash = await argon2.hash(TEST_PASSWORD, ARGON2_OPTS);
	const res = await pool.query(
		`INSERT INTO users (username, display_name, role, password_hash)
		 VALUES ($1, $2, 'viewer', $3)
		 ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = 'viewer'
		 RETURNING id`,
		[VIEWER_USERNAME, 'Month Page Test Viewer', passwordHash]
	);
	return res.rows[0].id;
}

async function cleanupViewer(pool, userId) {
	if (!userId) return;
	await pool.query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
	// td-310bf7: login inserts an audit_log row now — must go before users delete.
	await pool.query(`DELETE FROM audit_log WHERE user_id = $1`, [userId]);
	await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
}

function localObjectStoreRoot() {
	return path.resolve(REPO_ROOT, process.env.MADONNAHIST_LOCAL_OBJECT_STORE_DIR ?? '.local/object-store-test');
}

async function writeFixtureImage(objectKey) {
	const { mkdir, writeFile } = await import('node:fs/promises');
	const fullPath = path.join(localObjectStoreRoot(), objectKey);
	await mkdir(path.dirname(fullPath), { recursive: true });
	const buffer = await sharp({
		create: { width: 40, height: 30, channels: 3, background: { r: 90, g: 120, b: 160 } }
	})
		.jpeg()
		.toBuffer();
	await writeFile(fullPath, buffer);
}

/** A 5x5 px cell on the 40x30 fixture page, one per day, left to right. */
function cellBounds(day) {
	const i = day - 1;
	return JSON.stringify({ x: (i % 7) * 5, y: Math.floor(i / 7) * 5, width: 5, height: 5 });
}

async function provisionMonth(pool, month, { acceptedDayCount, pendingDayCount }) {
	const objectKey = `fixtures/month-page-test/${FIXTURE_YEAR}-${month}/page.jpg`;
	await writeFixtureImage(objectKey);

	await pool.query(
		`INSERT INTO calendar_pages (year, month, page_image_path, capture_session, image_width, image_height)
		 VALUES ($1, $2, $3, $4, 40, 30)
		 ON CONFLICT (year, month) DO NOTHING`,
		[FIXTURE_YEAR, month, objectKey, CAPTURE_SESSION]
	);
	const pageRes = await pool.query(`SELECT id FROM calendar_pages WHERE year = $1 AND month = $2`, [
		FIXTURE_YEAR,
		month
	]);
	const pageId = pageRes.rows[0].id;

	await pool.query(`DELETE FROM calendar_days WHERE page_id = $1`, [pageId]);

	for (let i = 0; i < acceptedDayCount; i++) {
		const day = i + 1;
		const date = `${FIXTURE_YEAR}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
		await pool.query(
			`INSERT INTO calendar_days (page_id, entry_date, day_image_path, corrected_text, correction_status, crop_bounds)
			 VALUES ($1, $2, $3, $4, 'accepted', $5)`,
			[pageId, date, `fixtures/month-page-test/${date}.jpg`, `${ACCEPTED_MARKER} for ${date}.`, cellBounds(day)]
		);
	}
	for (let i = 0; i < pendingDayCount; i++) {
		const day = acceptedDayCount + i + 1;
		const date = `${FIXTURE_YEAR}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
		await pool.query(
			`INSERT INTO calendar_days (page_id, entry_date, day_image_path, corrected_text, correction_status, crop_bounds)
			 VALUES ($1, $2, $3, $4, 'pending', $5)`,
			[pageId, date, `fixtures/month-page-test/${date}.jpg`, `${PENDING_MARKER} for ${date}.`, cellBounds(day)]
		);
	}

	return pageId;
}

async function cleanupMonth(pool, pageId) {
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
	let acceptedPageId;
	let zeroAcceptedPageId;
	try {
		try {
			await fetch(`${BASE_URL}/api/health`);
		} catch (err) {
			console.error(`ERROR: could not reach ${BASE_URL} — start the dev server first:`);
			console.error('  npx vite dev --host 127.0.0.1 --port 5177 --strictPort --mode test');
			throw err;
		}

		viewerId = await provisionViewer(pool);
		acceptedPageId = await provisionMonth(pool, ACCEPTED_MONTH, { acceptedDayCount: 3, pendingDayCount: 2 });
		zeroAcceptedPageId = await provisionMonth(pool, ZERO_ACCEPTED_MONTH, { acceptedDayCount: 0, pendingDayCount: 4 });

		const viewerCookie = await login(VIEWER_USERNAME, TEST_PASSWORD);
		const acceptedMonthKey = `${FIXTURE_YEAR}-${String(ACCEPTED_MONTH).padStart(2, '0')}`;
		const zeroAcceptedMonthKey = `${FIXTURE_YEAR}-${String(ZERO_ACCEPTED_MONTH).padStart(2, '0')}`;
		const missingMonthKey = `${FIXTURE_YEAR}-${String(MISSING_MONTH).padStart(2, '0')}`;

		// ── Month page with accepted days: photo, reading list, no pending text ──
		{
			const res = await fetchNoRedirect(`${BASE_URL}/app/month/${acceptedMonthKey}`, {
				headers: { Cookie: viewerCookie }
			});
			const body = await res.text();
			record('GET /app/month/<accepted month> [viewer] status 200', res.status === 200, `got ${res.status}`);
			const hasImage = body.includes(`/app/month/${acceptedMonthKey}/page-image`);
			record('GET /app/month/<accepted month> [viewer] renders the page image', hasImage,
				hasImage ? 'image src present' : 'image src missing');
			const readCount = (body.match(new RegExp(`<p class="diary[^"]*">${ACCEPTED_MARKER}`, 'g')) ?? []).length;
			record('GET /app/month/<accepted month> [viewer] reading list has every accepted day in full', readCount === 3,
				`expected 3 entries, got ${readCount}`);
			const noPending = !body.includes(PENDING_MARKER);
			record('GET /app/month/<accepted month> [viewer] no pending text anywhere (page or data)', noPending,
				noPending ? 'pending marker absent' : 'PENDING TEXT LEAKED');
			const gap = body.includes('June 4–30 aren’t transcribed yet.') || body.includes("June 4–30 aren't transcribed yet.");
			record('GET /app/month/<accepted month> [viewer] gap line for untranscribed days', gap,
				gap ? '"June 4–30 aren\'t transcribed yet." present' : 'gap line missing');
			const noCoverage = !/\d+ of \d+ days transcribed/.test(body);
			record('GET /app/month/<accepted month> [viewer] no "N of M transcribed" banner', noCoverage,
				noCoverage ? 'banner gone' : 'coverage banner still present');
			// Photo cells are drawn client-side once the image shape is checked; the
			// page data must mark only accepted days as ready (3 ready, 2 inert).
			const ready = (body.match(/ready:true/g) ?? []).length;
			const inert = (body.match(/ready:false/g) ?? []).length;
			record('GET /app/month/<accepted month> [viewer] photo cells: only accepted days are tappable',
				ready === 3 && inert === 2, `ready ${ready}, inert ${inert}`);
			const nextLink = body.includes(`href="/app/month/${zeroAcceptedMonthKey}"`);
			record('GET /app/month/<accepted month> [viewer] next-month arrow goes to the next captured page', nextLink,
				nextLink ? 'next link present' : 'next link missing');
		}

		// ── Reading-list links carry the from param ─────────────────────────
		{
			const res = await fetchNoRedirect(`${BASE_URL}/app/month/${acceptedMonthKey}`, {
				headers: { Cookie: viewerCookie }
			});
			const body = await res.text();
			const expectedDate = `${FIXTURE_YEAR}-${String(ACCEPTED_MONTH).padStart(2, '0')}-01`;
			const expectedHref = `/app/day/${expectedDate}?from=${encodeURIComponent(`/app/month/${acceptedMonthKey}`)}`;
			const hasLink = body.includes(expectedHref);
			record('GET /app/month/<accepted month> [viewer] reading-list day link carries ?from=', hasLink,
				hasLink ? 'expected href present' : `expected href missing: ${expectedHref}`);
		}

		// ── Page-image endpoint: 200, image/jpeg ─────────────────────────────
		{
			const res = await fetchNoRedirect(`${BASE_URL}/app/month/${acceptedMonthKey}/page-image`, {
				headers: { Cookie: viewerCookie }
			});
			const ok = res.status === 200 && (res.headers.get('content-type') ?? '').includes('image/jpeg');
			record('GET /app/month/<accepted month>/page-image [viewer] 200 image/jpeg', ok,
				`status ${res.status}, content-type ${res.headers.get('content-type')}`);
		}

		// ── Zero accepted days: photo still shows, nothing is tappable ───────
		{
			const res = await fetchNoRedirect(`${BASE_URL}/app/month/${zeroAcceptedMonthKey}`, {
				headers: { Cookie: viewerCookie }
			});
			const body = await res.text();
			record('GET /app/month/<zero-accepted month> [viewer] status 200', res.status === 200, `got ${res.status}`);
			const hasImage = body.includes(`/app/month/${zeroAcceptedMonthKey}/page-image`);
			record('GET /app/month/<zero-accepted month> [viewer] still renders the photo', hasImage,
				hasImage ? 'image src present' : 'IMAGE MISSING — the whole point of td-852d99');
			const emptyState = body.includes('Nothing to read yet');
			record('GET /app/month/<zero-accepted month> [viewer] friendly "nothing to read yet"', emptyState,
				emptyState ? 'empty state present' : 'empty state missing');
			const noDayLinks = !/\/app\/day\/\d{4}-\d{2}-\d{2}/.test(body);
			record('GET /app/month/<zero-accepted month> [viewer] no day links at all', noDayLinks,
				noDayLinks ? 'no day-detail links in body' : 'A DAY LINK LEAKED INTO AN ALL-PENDING MONTH');
			const noReady = !/ready:true/.test(body) && !body.includes(PENDING_MARKER);
			record('GET /app/month/<zero-accepted month> [viewer] no tappable cells, no pending text', noReady,
				noReady ? 'all cells inert' : 'A PENDING DAY IS TAPPABLE OR ITS TEXT LEAKED');
			const prevLink = body.includes(`href="/app/month/${acceptedMonthKey}"`);
			record('GET /app/month/<zero-accepted month> [viewer] previous-month arrow', prevLink,
				prevLink ? 'prev link present' : 'prev link missing');
			const imgRes = await fetchNoRedirect(`${BASE_URL}/app/month/${zeroAcceptedMonthKey}/page-image`, {
				headers: { Cookie: viewerCookie }
			});
			record('GET /app/month/<zero-accepted month>/page-image [viewer] 200', imgRes.status === 200,
				`got ${imgRes.status}`);
		}

		// ── Invalid monthKey: friendly page, never a crash ──────────────────
		{
			const res = await fetchNoRedirect(`${BASE_URL}/app/month/not-a-key`, { headers: { Cookie: viewerCookie } });
			const body = await res.text();
			const ok = res.status === 200 && body.includes('Not a valid month') && !/internal error|stack trace/i.test(body);
			record('GET /app/month/<invalid key> [viewer] friendly page', ok, `status ${res.status}`);

			const imgRes = await fetchNoRedirect(`${BASE_URL}/app/month/not-a-key/page-image`, {
				headers: { Cookie: viewerCookie }
			});
			record('GET /app/month/<invalid key>/page-image [viewer] 404', imgRes.status === 404,
				`expected 404, got ${imgRes.status}`);
		}

		// ── Valid key, never-ingested month: friendly "not captured" page ──
		{
			const res = await fetchNoRedirect(`${BASE_URL}/app/month/${missingMonthKey}`, {
				headers: { Cookie: viewerCookie }
			});
			const body = await res.text();
			const ok = res.status === 200 && body.includes('Not captured yet') && !/internal error|stack trace/i.test(body);
			record('GET /app/month/<never-ingested month> [viewer] friendly "not captured" page', ok,
				`status ${res.status}`);

			const imgRes = await fetchNoRedirect(`${BASE_URL}/app/month/${missingMonthKey}/page-image`, {
				headers: { Cookie: viewerCookie }
			});
			record('GET /app/month/<never-ingested month>/page-image [viewer] 404', imgRes.status === 404,
				`expected 404, got ${imgRes.status}`);
		}

		// ── Unauthenticated: redirected, never reaches route logic ─────────
		{
			const res = await fetchNoRedirect(`${BASE_URL}/app/month/${acceptedMonthKey}`, {});
			record('GET /app/month/<accepted month> [unauthenticated] redirects to login', res.status === 303,
				`expected 303, got ${res.status}`);
		}
		{
			const res = await fetchNoRedirect(`${BASE_URL}/app/month/${acceptedMonthKey}/page-image`, {});
			record('GET /app/month/<accepted month>/page-image [unauthenticated] redirects to login', res.status === 303,
				`expected 303, got ${res.status}`);
		}

		console.log('\nMonth page results:\n');
		const width = Math.max(...rows.map((r) => r.label.length)) + 2;
		for (const r of rows) {
			const mark = r.ok ? 'PASS' : 'FAIL';
			console.log(`${mark}  ${r.label.padEnd(width)} ${r.detail}`);
		}
		console.log(`\n${pass} passed, ${fail} failed (${rows.length} total)`);

		if (fail > 0) process.exitCode = 1;
	} finally {
		const { rm } = await import('node:fs/promises');
		await rm(path.join(localObjectStoreRoot(), 'fixtures/month-page-test'), { recursive: true, force: true });
		await cleanupMonth(pool, acceptedPageId);
		await cleanupMonth(pool, zeroAcceptedPageId);
		await cleanupViewer(pool, viewerId);
		await pool.end();
	}
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
