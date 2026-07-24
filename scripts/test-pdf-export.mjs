#!/usr/bin/env node
// PDF/print export end-to-end test (Phase H of
// docs/2026-07-21-next-phases-search-viewer-narrative-plan.md).
//
// Requires a dev server already running on the isolated test stack:
//   npx vite dev --host 127.0.0.1 --port 5177 --strictPort --mode test
//
// Combines the established test patterns:
//   - DB fixture provisioning + spawning the real worker binary
//     (scripts/test-enrichment.mjs, scripts/test-narratives.mjs) — here with
//     MADONNAHIST_INTERNAL_URL pointed at the already-running dev server so
//     the worker's headless Chromium renders the SAME server this script
//     drives via HTTP, rather than a second one.
//   - HTTP checks against that running dev server as logged-in admin/viewer
//     users (scripts/test-viewer-security.mjs, scripts/test-ask.mjs).
//   - A locally-signed render token (mirroring
//     src/lib/server/render-token.ts's HMAC-SHA256-over-`scope:key:expiresAtMs`
//     exactly) to drive the render-token security matrix directly, since
//     this is a plain .mjs script and cannot import that .ts module without
//     a TS loader.
//
// Runs entirely against madonnahist_test (127.0.0.1:15434) and the local
// object store (.local/object-store-test). Self-provisions an admin user, a
// viewer user, a fixture year with 3 accepted days (each with a real tiny
// JPEG written directly into the local object store, via `sharp` — already
// an app dependency) and 1 pending day, drives the real /admin/exports
// actions and the real enrichment worker, and cleans up in a finally block.
// Never touches port 5433/5435, PGDATABASE=madonnahist, or production
// DigitalOcean Spaces — see requireTestSafety() below.
//
// What this asserts:
//   - /admin/exports POST ?/generate enqueues a pdf_export job_runs row;
//     a second POST while it's pending/in_progress is deduped (409)
//   - running the enrichment worker once (real Chromium via playwright-core,
//     against the already-running dev server) produces: job_runs row
//     status='done'; exactly one new pdf_exports row with day_count=3
//     (only the 3 accepted days, not the pending one) and byte_size>10KB;
//     an object file in .local/object-store-test starting with the %PDF-
//     magic bytes and >10KB
//   - PDF text extraction is unreliable to assert against directly, so
//     instead: the rendered book HTML (fetched directly with a locally
//     signed render token cookie, ?render=pdf) includes all 3 accepted
//     markers and excludes the pending marker AND the human-facing reader
//     chrome (progress bar / exit button / "continue to next year") —
//     verifying the same subset and rendering mode the worker's Chromium
//     actually saw — separately from confirming a real PDF was produced
//   - render-token security matrix: the token opens ONLY its own book page
//     (GET) and same-year /app/day/[date]/image paths; a POST to its own book page
//     is 401; another year's book page is a redirect-to-login (never the
//     content); /correct and /admin both redirect (GET, unauthenticated);
//     an expired token and a tampered-signature token both fail identically
//     to no token at all
//   - download endpoint: admin 200 + application/pdf + %PDF- magic bytes;
//     viewer 403; unauthenticated redirect (no session, GET)
//   - delete removes both the pdf_exports row and the object-store file;
//     the download endpoint then 404s
//   - story scope (Gaylon, 2026-07-23, stories PDF upgrade): an
//     adhoc_narratives row + its pdf_export job_runs row are seeded
//     directly (not via /admin/ask's HTTP save action — that enqueue is
//     covered by scripts/test-ask.mjs), then the real worker/Chromium run
//     produces a scope='story' pdf_exports row with content_mode='full' and
//     an exports/story-<id>-<jobid>.pdf object key; the story list page
//     shows the question but NEVER the narrative text; the story detail
//     page shows the full narrative and a "Download PDF" link; the new
//     /app/stories/[id]/pdf endpoint streams it (viewer 200, unauthenticated
//     redirect, nonexistent id 404); the render-token security matrix for
//     scope='story' opens ONLY that story's own page — not another story
//     id, not a day image, not a book page — the inverse of a 'year'
//     token's allowance, which is separately regression-checked to still
//     reach day images unchanged
//
// Usage: node scripts/test-pdf-export.mjs [baseUrl] (or: npm run test:pdf)

import argon2 from 'argon2';
import pg from 'pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
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
	if (process.env.MADONNAHIST_OBJECT_STORE !== 'local') {
		problems.push('MADONNAHIST_OBJECT_STORE must be "local" (never production DigitalOcean Spaces)');
	}
	if (!process.env.PGDATABASE || !process.env.PGPASSWORD || !process.env.WORKER_PGPASSWORD || !process.env.AUTH_SECRET) {
		problems.push('PGDATABASE/PGPASSWORD/WORKER_PGPASSWORD/AUTH_SECRET must be set (copy .env.test.example to .env.test)');
	}
	return problems;
}

const BASE_URL = process.argv[2] ?? 'http://127.0.0.1:5177';
const SESSION_COOKIE_NAME = 'madonnahist_session';
const RENDER_TOKEN_COOKIE_NAME = 'madonnahist_render_token';
const RENDER_TOKEN_MAX_TTL_MS = 15 * 60 * 1000;
const TEST_PASSWORD = 'PdfExportTest!2026';
const ADMIN_USERNAME = '_pdf_test_admin';
const VIEWER_USERNAME = '_pdf_test_viewer';
const CAPTURE_SESSION = '_pdf_export_test';

const ARGON2_OPTS = {
	type: argon2.argon2id,
	memoryCost: 19456,
	timeCost: 2,
	parallelism: 1
};

// Distinctive, never-elsewhere-occurring markers.
const MARKER = 'ZQXPLPDFEXPORT';
const PENDING_MARKER = 'WOBBLEFRIMPDFPENDING';
// Content-mode fixture (Gaylon, 2026-07-23): a published narrative for
// FIXTURE_YEAR so ?content=narrative has something real to render.
const NARRATIVE_MARKER = 'ZQXPLPDFNARRATIVE published narrative text for the content-mode test.';

const FIXTURE_YEAR = 1911;
const OTHER_YEAR = 1912; // exists only as an out-of-scope render-token target, never given fixture data
const FIXTURE_MONTH = 4;
const ACCEPTED_DATES = ['1911-04-01', '1911-04-02', '1911-04-03'];
const PENDING_DATE = '1911-04-04';

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
// scripts/test-auth-matrix.mjs / test-viewer-security.mjs.
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

// Posts a form action with Accept: application/json (mirrors use:enhance's
// negotiation) — see scripts/test-ask.mjs for the full rationale.
async function postAction(pathWithAction, formObj, cookie) {
	const body = new URLSearchParams();
	for (const [k, v] of Object.entries(formObj)) {
		if (v !== null && v !== undefined) body.set(k, String(v));
	}
	const res = await fetch(`${BASE_URL}${pathWithAction}`, {
		method: 'POST',
		redirect: 'manual',
		headers: {
			Accept: 'application/json',
			'Content-Type': 'application/x-www-form-urlencoded',
			...(cookie ? { Cookie: cookie } : {})
		},
		body: body.toString()
	});
	const status = res.status;
	const text = await res.text();
	let envelope = null;
	try {
		envelope = JSON.parse(text);
	} catch {
		envelope = null;
	}
	return { status, envelope, rawText: text };
}

// ─── Locally-signed render token, mirroring src/lib/server/render-token.ts's
//     issueRenderToken()/verifyRenderToken() byte-for-byte (HMAC-SHA256 over
//     `scope:key:expiresAtMs`, base64url digest) — this script is plain
//     Node ESM and cannot import that .ts module without a TS loader, so the
//     signing algorithm is reproduced here instead. Any drift between the
//     two would show up as every "valid token" assertion below failing. ───
function signRenderToken(scope, key, expiresAtMs, secret) {
	const payload = `${scope}:${key}:${expiresAtMs}`;
	const sig = createHmac('sha256', secret).update(payload).digest('base64url');
	return `${payload}:${sig}`;
}
function makeValidRenderToken(scope, key, ttlMs = RENDER_TOKEN_MAX_TTL_MS) {
	return signRenderToken(scope, key, Date.now() + ttlMs, process.env.AUTH_SECRET);
}
function makeExpiredRenderToken(scope, key) {
	return signRenderToken(scope, key, Date.now() - 60_000, process.env.AUTH_SECRET);
}
function makeTamperedRenderToken(scope, key) {
	const valid = makeValidRenderToken(scope, key);
	return valid.slice(0, -4) + 'AAAA'; // corrupt the trailing signature bytes
}

async function provisionUsers(pool) {
	const passwordHash = await argon2.hash(TEST_PASSWORD, ARGON2_OPTS);
	const adminRes = await pool.query(
		`INSERT INTO users (username, display_name, role, password_hash)
		 VALUES ($1, $2, 'admin', $3)
		 ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = 'admin'
		 RETURNING id`,
		[ADMIN_USERNAME, 'PDF Export Test Admin', passwordHash]
	);
	const viewerRes = await pool.query(
		`INSERT INTO users (username, display_name, role, password_hash)
		 VALUES ($1, $2, 'viewer', $3)
		 ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = 'viewer'
		 RETURNING id`,
		[VIEWER_USERNAME, 'PDF Export Test Viewer', passwordHash]
	);
	return { adminId: adminRes.rows[0].id, viewerId: viewerRes.rows[0].id };
}

async function cleanupUsers(pool, ids) {
	const idList = Object.values(ids).filter(Boolean);
	if (idList.length === 0) return;
	await pool.query(`DELETE FROM sessions WHERE user_id = ANY($1::int[])`, [idList]);
	// DELETE, not UPDATE: madonnahist_app deliberately has no UPDATE grant on
	// pdf_exports (migration 0024_pdf_exports.sql — a row is immutable once
	// written), so nulling out requested_by would hit a permission error.
	// DELETE is granted and also correctly cleans up any stray row left by an
	// aborted prior run before the users.id FK (RESTRICT, no cascade) would
	// otherwise block deleting the user below.
	await pool.query(`DELETE FROM pdf_exports WHERE requested_by = ANY($1::int[])`, [idList]);
	await pool.query(`DELETE FROM audit_log WHERE user_id = ANY($1::int[])`, [idList]);
	await pool.query(`DELETE FROM users WHERE id = ANY($1::int[])`, [idList]);
}

function localObjectStoreRoot() {
	return path.resolve(REPO_ROOT, process.env.MADONNAHIST_LOCAL_OBJECT_STORE_DIR ?? '.local/object-store-test');
}

async function writeFixtureImage(objectKey) {
	const { mkdir, writeFile } = await import('node:fs/promises');
	const fullPath = path.join(localObjectStoreRoot(), objectKey);
	await mkdir(path.dirname(fullPath), { recursive: true });
	const buffer = await sharp({
		create: { width: 24, height: 24, channels: 3, background: { r: 180, g: 140, b: 90 } }
	})
		.jpeg()
		.toBuffer();
	await writeFile(fullPath, buffer);
}

async function provisionFixture(pool) {
	await pool.query(
		`INSERT INTO calendar_pages (year, month, page_image_path, capture_session)
		 VALUES ($1, $2, $3, $4)
		 ON CONFLICT (year, month) DO NOTHING`,
		[FIXTURE_YEAR, FIXTURE_MONTH, 'fixtures/pdf-export-test/page.jpg', CAPTURE_SESSION]
	);
	const pageRes = await pool.query(`SELECT id FROM calendar_pages WHERE year = $1 AND month = $2`, [
		FIXTURE_YEAR,
		FIXTURE_MONTH
	]);
	const pageId = pageRes.rows[0].id;

	const allDates = [...ACCEPTED_DATES, PENDING_DATE];
	await pool.query(`DELETE FROM calendar_days WHERE entry_date = ANY($1::date[])`, [allDates]);

	for (const [i, date] of ACCEPTED_DATES.entries()) {
		const objectKey = `fixtures/pdf-export-test/${date}.jpg`;
		await writeFixtureImage(objectKey);
		await pool.query(
			`INSERT INTO calendar_days (page_id, entry_date, day_image_path, corrected_text, correction_status)
			 VALUES ($1, $2, $3, $4, 'accepted')`,
			[pageId, date, objectKey, `${MARKER}_DAY_${i + 1} distinctive accepted fixture text for ${date}.`]
		);
	}

	await pool.query(
		`INSERT INTO calendar_days (page_id, entry_date, day_image_path, corrected_text, correction_status)
		 VALUES ($1, $2, $3, $4, 'pending')`,
		[pageId, PENDING_DATE, `fixtures/pdf-export-test/${PENDING_DATE}.jpg`, `${PENDING_MARKER} must never appear in the book or the PDF.`]
	);

	return { pageId };
}

async function cleanupFixture(pool) {
	const { rm } = await import('node:fs/promises');
	const allDates = [...ACCEPTED_DATES, PENDING_DATE];
	await pool.query(`DELETE FROM calendar_days WHERE entry_date = ANY($1::date[])`, [allDates]);
	await pool.query(`DELETE FROM calendar_pages WHERE year = $1 AND month = $2`, [FIXTURE_YEAR, FIXTURE_MONTH]);
	await rm(path.join(localObjectStoreRoot(), 'fixtures/pdf-export-test'), { recursive: true, force: true });
}

// Content-mode fixture (Gaylon, 2026-07-23): a published narrative for
// FIXTURE_YEAR, same idempotent delete-then-insert shape as
// scripts/test-viewer-security.mjs's provisionBookNarrative().
async function provisionNarrative(pool) {
	await pool.query(`DELETE FROM narrative_summaries WHERE scope = 'year' AND scope_key = $1`, [String(FIXTURE_YEAR)]);
	await pool.query(
		`INSERT INTO narrative_summaries (scope, scope_key, summary_text, generated_by, is_published)
		 VALUES ('year', $1, $2, '_pdf_export_test', true)`,
		[String(FIXTURE_YEAR), NARRATIVE_MARKER]
	);
}

async function cleanupNarrative(pool) {
	await pool.query(`DELETE FROM narrative_summaries WHERE scope = 'year' AND scope_key = $1`, [String(FIXTURE_YEAR)]);
}

function runWorkerOnce() {
	const result = spawnSync('npx', ['tsx', 'backend/workers/enrichment-worker.ts', '--limit=1'], {
		cwd: REPO_ROOT,
		encoding: 'utf8',
		env: {
			...process.env,
			MADONNAHIST_INTERNAL_URL: BASE_URL
		},
		timeout: 120_000
	});
	if (result.status !== 0) {
		console.error('Worker stdout:', result.stdout);
		console.error('Worker stderr:', result.stderr);
		throw new Error(`worker exited with status ${result.status}`);
	}
	return result.stdout;
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
	let fixtureProvisioned = false;
	let exportId = null;
	// Content-mode exports (Gaylon, 2026-07-23) — narrative-only and days-only
	// pdf_exports rows created and deleted inline in the content-mode block
	// below; tracked here too so an assertion failure mid-block still gets
	// them cleaned up in the finally block rather than leaking a row/object.
	const extraExportIds = [];
	// Story scope (Gaylon, 2026-07-23) — a directly-seeded adhoc_narratives
	// row + its pdf_export job_runs row. storyExportId's pdf_exports row/
	// object is cleaned up via extraExportIds (pushed below, same generic
	// loop as the content-mode exports); storyId/storyJobId need their own
	// cleanup since nothing else deletes an adhoc_narratives or job_runs row.
	let storyId = null;
	let storyJobId = null;

	try {
		try {
			await fetch(`${BASE_URL}/api/health`);
		} catch (err) {
			console.error(`ERROR: could not reach ${BASE_URL} — start the dev server first:`);
			console.error('  npx vite dev --host 127.0.0.1 --port 5177 --strictPort --mode test');
			throw err;
		}

		ids = await provisionUsers(pool);
		await provisionFixture(pool);
		fixtureProvisioned = true;
		await provisionNarrative(pool);

		const adminCookie = await login(ADMIN_USERNAME, TEST_PASSWORD);
		const viewerCookie = await login(VIEWER_USERNAME, TEST_PASSWORD);

		// ── /admin/exports auth matrix ──────────────────────────────────────
		{
			const res = await fetchNoRedirect(`${BASE_URL}/admin/exports`);
			record('GET /admin/exports [unauthenticated]', res.status === 303, `expected 303, got ${res.status}`);
		}
		{
			const res = await fetchNoRedirect(`${BASE_URL}/admin/exports`, { headers: { Cookie: viewerCookie } });
			record('GET /admin/exports [viewer]', res.status === 403, `expected 403, got ${res.status}`);
		}
		{
			const res = await fetchNoRedirect(`${BASE_URL}/admin/exports`, { headers: { Cookie: adminCookie } });
			record('GET /admin/exports [admin]', res.status === 200, `expected 200, got ${res.status}`);
		}

		// ── generate: enqueue, then dedupe on a second call ─────────────────
		{
			const { status, envelope } = await postAction('/admin/exports?/generate', { year: FIXTURE_YEAR }, adminCookie);
			record('generate enqueues a pdf_export job', status === 200 && envelope?.type === 'success', `status ${status}, ${JSON.stringify(envelope)}`);
		}
		{
			const { status, envelope } = await postAction('/admin/exports?/generate', { year: FIXTURE_YEAR }, adminCookie);
			record(
				'a second generate while one is pending/in_progress is deduped (409)',
				status === 200 && envelope?.type === 'failure' && envelope.status === 409,
				`status ${status}, envelope ${JSON.stringify(envelope)}`
			);
		}

		const jobBefore = await pool.query(
			`SELECT id, status FROM job_runs WHERE job_type = 'pdf_export' AND payload->>'scope_key' = $1 ORDER BY enqueued_at DESC LIMIT 1`,
			[String(FIXTURE_YEAR)]
		);
		record('exactly one pdf_export job_runs row exists before the worker runs', jobBefore.rows.length === 1, `rows: ${JSON.stringify(jobBefore.rows)}`);

		// ── run the real worker once (real Chromium via playwright-core,
		//    rendering the already-running dev server) ─────────────────────
		let workerStdout = '';
		try {
			workerStdout = runWorkerOnce();
			record('enrichment worker ran to completion (pdf_export)', true, 'exit 0');
		} catch (err) {
			record('enrichment worker ran to completion (pdf_export)', false, `${err instanceof Error ? err.message : err}`);
			console.error(
				'Chromium/playwright-core could not complete the render — reporting explicitly, not faking success.'
			);
		}

		const jobAfter = await pool.query(`SELECT id, status, last_error FROM job_runs WHERE id = $1`, [jobBefore.rows[0]?.id]);
		record(
			'job_runs row is status=done after the worker run',
			jobAfter.rows[0]?.status === 'done',
			`got ${JSON.stringify(jobAfter.rows[0])}; worker stdout: ${workerStdout.slice(-800)}`
		);

		const exportRes = await pool.query(
			`SELECT id, object_key, byte_size, day_count FROM pdf_exports WHERE scope = 'year' AND scope_key = $1`,
			[String(FIXTURE_YEAR)]
		);
		record('exactly one pdf_exports row was written', exportRes.rows.length === 1, `rows: ${JSON.stringify(exportRes.rows)}`);
		const exportRow = exportRes.rows[0];
		exportId = exportRow?.id ?? null;

		record('pdf_exports.day_count is 3 (accepted days only, pending excluded)', Number(exportRow?.day_count) === 3, `got ${exportRow?.day_count}`);
		record('pdf_exports.byte_size is >10KB', Number(exportRow?.byte_size) > 10 * 1024, `got ${exportRow?.byte_size}`);

		if (exportRow) {
			const objectPath = path.join(localObjectStoreRoot(), exportRow.object_key);
			const objectExists = existsSync(objectPath);
			record('object file exists in .local/object-store-test', objectExists, objectPath);
			if (objectExists) {
				const { readFile } = await import('node:fs/promises');
				const buf = await readFile(objectPath);
				record('object file starts with the %PDF- magic bytes', buf.subarray(0, 5).toString('latin1') === '%PDF-', buf.subarray(0, 8).toString('latin1'));
				record('object file is >10KB on disk', buf.length > 10 * 1024, `got ${buf.length} bytes`);
			}
		}

		// ── rendered book HTML with a locally-signed render token —
		//    everything the worker's Chromium actually saw, checked directly ──
		const validToken = makeValidRenderToken('year', String(FIXTURE_YEAR));
		{
			const res = await fetchNoRedirect(`${BASE_URL}/app/book/year/${FIXTURE_YEAR}?render=pdf`, {
				headers: { Cookie: `${RENDER_TOKEN_COOKIE_NAME}=${validToken}` }
			});
			const body = await res.text();
			const allMarkersPresent = ACCEPTED_DATES.every((_, i) => body.includes(`${MARKER}_DAY_${i + 1}`));
			record('valid render token: book page renders 200', res.status === 200, `status ${res.status}`);
			record('valid render token: all 3 accepted markers present', allMarkersPresent, `body length ${body.length}`);
			record('valid render token: pending marker absent', !body.includes(PENDING_MARKER), 'checked');
			// Checks the actual rendered element's aria-label text, not the
			// "exit-btn" class NAME — that substring also appears in the
			// component's scoped <style> block (the CSS rule exists regardless
			// of whether the element renders), so asserting against it would
			// pass even if the chrome weren't actually omitted.
			record(
				'valid render token: reader chrome (exit button) omitted in render mode',
				!body.includes('aria-label="Exit book view'),
				'checked'
			);
			record('valid render token: images render eager, not lazy', body.includes('loading="eager"') && !body.includes('loading="lazy"'), 'checked');
		}

		// ── content modes (Gaylon, 2026-07-23): cheap page-level checks via the
		//    same render token — matchesRenderScopePath() only cares about the
		//    path, not the query string, so ?content=... works with the token
		//    already minted above. Confirms the book route's own content-mode
		//    branching (src/routes/app/book/[scope]/[key]/+page.server.ts and
		//    +page.svelte) before the slower worker-driven checks further down
		//    prove the whole export pipeline honors it too. ──
		{
			const res = await fetchNoRedirect(`${BASE_URL}/app/book/year/${FIXTURE_YEAR}?render=pdf&content=narrative`, {
				headers: { Cookie: `${RENDER_TOKEN_COOKIE_NAME}=${validToken}` }
			});
			const body = await res.text();
			record('content=narrative: renders 200', res.status === 200, `status ${res.status}`);
			record('content=narrative: published narrative text present', body.includes(NARRATIVE_MARKER), 'checked');
			const anyDayMarkerPresent = ACCEPTED_DATES.some((_, i) => body.includes(`${MARKER}_DAY_${i + 1}`));
			record('content=narrative: day chapter text excluded', !anyDayMarkerPresent, 'checked');
		}
		{
			const res = await fetchNoRedirect(`${BASE_URL}/app/book/year/${FIXTURE_YEAR}?render=pdf&content=days`, {
				headers: { Cookie: `${RENDER_TOKEN_COOKIE_NAME}=${validToken}` }
			});
			const body = await res.text();
			const allMarkersPresent = ACCEPTED_DATES.every((_, i) => body.includes(`${MARKER}_DAY_${i + 1}`));
			record('content=days: renders 200', res.status === 200, `status ${res.status}`);
			record('content=days: all 3 accepted day markers present', allMarkersPresent, 'checked');
			record('content=days: published narrative text excluded', !body.includes(NARRATIVE_MARKER), 'checked');
		}
		{
			// A normal human visit (no render=pdf) ignores ?content= entirely —
			// per the spec, content-mode filtering is only ever honored in
			// render=pdf mode. Using the admin session here since a plain human
			// GET has no render token at all.
			const res = await fetchNoRedirect(`${BASE_URL}/app/book/year/${FIXTURE_YEAR}?content=narrative`, {
				headers: { Cookie: adminCookie }
			});
			const body = await res.text();
			const anyDayMarkerPresent = ACCEPTED_DATES.some((_, i) => body.includes(`${MARKER}_DAY_${i + 1}`));
			record(
				'content=narrative WITHOUT render=pdf: ignored — day chapters still render for a normal visit',
				res.status === 200 && anyDayMarkerPresent,
				`status ${res.status}, day marker present: ${anyDayMarkerPresent}`
			);
		}

		// ── render-token security matrix ─────────────────────────────────────
		{
			const res = await fetchNoRedirect(`${BASE_URL}/app/book/year/${FIXTURE_YEAR}`, {
				method: 'POST',
				headers: { Cookie: `${RENDER_TOKEN_COOKIE_NAME}=${validToken}`, 'Content-Type': 'application/x-www-form-urlencoded' },
				body: ''
			});
			record('valid render token: POST to its own book page is 401 (GET-only)', res.status === 401, `expected 401, got ${res.status}`);
		}
		{
			const res = await fetchNoRedirect(`${BASE_URL}/app/book/year/${OTHER_YEAR}?render=pdf`, {
				headers: { Cookie: `${RENDER_TOKEN_COOKIE_NAME}=${validToken}` }
			});
			record("valid render token: another year's book page redirects to login, never the content", res.status === 303, `expected 303, got ${res.status}`);
		}
		{
			const res = await fetchNoRedirect(`${BASE_URL}/app/search`, {
				headers: { Cookie: `${RENDER_TOKEN_COOKIE_NAME}=${validToken}` }
			});
			record('valid render token: /app/search redirects to login (not the scoped book page)', res.status === 303, `expected 303, got ${res.status}`);
		}
		{
			const res = await fetchNoRedirect(`${BASE_URL}/correct`, {
				headers: { Cookie: `${RENDER_TOKEN_COOKIE_NAME}=${validToken}` }
			});
			record('valid render token: /correct redirects to login', res.status === 303, `expected 303, got ${res.status}`);
		}
		{
			const res = await fetchNoRedirect(`${BASE_URL}/admin`, {
				headers: { Cookie: `${RENDER_TOKEN_COOKIE_NAME}=${validToken}` }
			});
			record('valid render token: /admin redirects to login', res.status === 303, `expected 303, got ${res.status}`);
		}
		{
			const expiredToken = makeExpiredRenderToken('year', String(FIXTURE_YEAR));
			const res = await fetchNoRedirect(`${BASE_URL}/app/book/year/${FIXTURE_YEAR}?render=pdf`, {
				headers: { Cookie: `${RENDER_TOKEN_COOKIE_NAME}=${expiredToken}` }
			});
			record('expired render token: redirects to login, not the content', res.status === 303, `expected 303, got ${res.status}`);
		}
		{
			const tamperedToken = makeTamperedRenderToken('year', String(FIXTURE_YEAR));
			const res = await fetchNoRedirect(`${BASE_URL}/app/book/year/${FIXTURE_YEAR}?render=pdf`, {
				headers: { Cookie: `${RENDER_TOKEN_COOKIE_NAME}=${tamperedToken}` }
			});
			record('tampered-signature render token: redirects to login, not the content', res.status === 303, `expected 303, got ${res.status}`);
		}
		{
			// SAME-YEAR day images only (tightened per CODEX1 review finding 4,
			// 2026-07-24): a year token opens day-image paths whose date falls
			// in that year — the endpoint still re-applies accepted-only.
			const res = await fetchNoRedirect(`${BASE_URL}/app/day/${ACCEPTED_DATES[0]}/image`, {
				headers: { Cookie: `${RENDER_TOKEN_COOKIE_NAME}=${validToken}` }
			});
			record('valid render token: same-year day image is reachable (200)', res.status === 200, `expected 200, got ${res.status}`);
		}
		{
			// Cross-year images must fail closed — token for FIXTURE_YEAR must
			// NOT open another year's image path (hooks rejects before the
			// endpoint ever runs, so no fixture data is needed for that year).
			const otherYearDate = `${Number(FIXTURE_YEAR) + 1}${ACCEPTED_DATES[0].slice(4)}`;
			const res = await fetchNoRedirect(`${BASE_URL}/app/day/${otherYearDate}/image`, {
				headers: { Cookie: `${RENDER_TOKEN_COOKIE_NAME}=${validToken}` }
			});
			record("year render token: another YEAR's day image fails closed (redirect)", res.status === 303, `expected 303, got ${res.status}`);
		}

		// ── download endpoint ─────────────────────────────────────────────────
		if (exportId) {
			{
				const res = await fetchNoRedirect(`${BASE_URL}/admin/exports/download/${exportId}`);
				record('download [unauthenticated] redirects to login', res.status === 303, `expected 303, got ${res.status}`);
			}
			{
				const res = await fetchNoRedirect(`${BASE_URL}/admin/exports/download/${exportId}`, { headers: { Cookie: viewerCookie } });
				record('download [viewer] is 403', res.status === 403, `expected 403, got ${res.status}`);
			}
			{
				const res = await fetchNoRedirect(`${BASE_URL}/admin/exports/download/${exportId}`, { headers: { Cookie: adminCookie } });
				const contentType = res.headers.get('content-type') ?? '';
				const buf = Buffer.from(await res.arrayBuffer());
				record('download [admin] is 200', res.status === 200, `expected 200, got ${res.status}`);
				record('download [admin] content-type is application/pdf', contentType.includes('application/pdf'), `got ${contentType}`);
				record('download [admin] body starts with %PDF-', buf.subarray(0, 5).toString('latin1') === '%PDF-', 'checked');
				const disposition = res.headers.get('content-disposition') ?? '';
				record(
					'download [admin] Content-Disposition names the file, never the object key',
					disposition.includes(`madonnahist-${FIXTURE_YEAR}.pdf`) && !disposition.includes('exports/'),
					`got ${disposition}`
				);
			}
		}

		// ── viewer-facing PDF download (src/routes/app/year/[year]/pdf,
		//    Gaylon, 2026-07-23): any authenticated role, streamed the same
		//    way as the admin endpoint but reachable from /app. Checked here
		//    while the 'full' export from above still exists, before it's
		//    deleted below. ─────────────────────────────────────────────────
		{
			const res = await fetchNoRedirect(`${BASE_URL}/app/year/${FIXTURE_YEAR}/pdf`, { headers: { Cookie: viewerCookie } });
			const contentType = res.headers.get('content-type') ?? '';
			const buf = Buffer.from(await res.arrayBuffer());
			record('viewer PDF download [viewer] is 200', res.status === 200, `expected 200, got ${res.status}`);
			record('viewer PDF download [viewer] content-type is application/pdf', contentType.includes('application/pdf'), `got ${contentType}`);
			record('viewer PDF download [viewer] body starts with %PDF-', buf.subarray(0, 5).toString('latin1') === '%PDF-', 'checked');
		}
		{
			const res = await fetchNoRedirect(`${BASE_URL}/app/year/${FIXTURE_YEAR}/pdf`);
			record('viewer PDF download [unauthenticated] redirects to login', res.status === 303, `expected 303, got ${res.status}`);
		}
		{
			// A year with zero pdf_exports rows at all — OTHER_YEAR is never
			// given fixture data or an export anywhere in this script.
			const res = await fetchNoRedirect(`${BASE_URL}/app/year/${OTHER_YEAR}/pdf`, { headers: { Cookie: viewerCookie } });
			record('viewer PDF download [viewer, no export for this year] is a friendly 404', res.status === 404, `expected 404, got ${res.status}`);
		}
		{
			// admin's own /admin/exports/download/[id] stays admin-only — the
			// new viewer-facing endpoint is a separate, additive route, not a
			// relaxation of the existing admin download's authorization.
			const res = await fetchNoRedirect(`${BASE_URL}/admin/exports/download/${exportId}`, { headers: { Cookie: viewerCookie } });
			record('admin download endpoint [viewer] is still 403 (unaffected by the new viewer route)', res.status === 403, `expected 403, got ${res.status}`);
		}

		// ── delete ────────────────────────────────────────────────────────────
		if (exportId && exportRow) {
			const { status, envelope } = await postAction('/admin/exports?/delete', { id: exportId }, adminCookie);
			record('delete action succeeds', status === 200 && envelope?.type === 'success', `status ${status}, ${JSON.stringify(envelope)}`);

			const dbRowAfter = await pool.query(`SELECT id FROM pdf_exports WHERE id = $1`, [exportId]);
			record('deleted row is gone from pdf_exports', dbRowAfter.rows.length === 0, `rows left: ${dbRowAfter.rows.length}`);

			const objectPath = path.join(localObjectStoreRoot(), exportRow.object_key);
			record('deleted object file is gone from the local object store', !existsSync(objectPath), objectPath);

			const res = await fetchNoRedirect(`${BASE_URL}/admin/exports/download/${exportId}`, { headers: { Cookie: adminCookie } });
			record('download of a deleted export is 404', res.status === 404, `expected 404, got ${res.status}`);
			exportId = null;
		}

		// ── content-mode end-to-end: run the REAL worker (real Chromium) once
		//    for 'narrative' mode and once for 'days' mode, proving the whole
		//    pipeline (job payload → rendered PDF → pdf_exports.content_mode →
		//    object key → viewer download endpoint) honors the mode, not just
		//    the book route in isolation (already checked above). Two more
		//    Chromium launches, same as the 'full' mode run earlier — kept to
		//    exactly one run per mode to bound runtime. ──────────────────────
		for (const mode of ['narrative', 'days']) {
			const { status: genStatus, envelope: genEnvelope } = await postAction(
				'/admin/exports?/generate',
				{ year: FIXTURE_YEAR, contentMode: mode },
				adminCookie
			);
			record(`content=${mode}: generate enqueues a pdf_export job`, genStatus === 200 && genEnvelope?.type === 'success', `status ${genStatus}, ${JSON.stringify(genEnvelope)}`);

			const jobRow = await pool.query(
				`SELECT id FROM job_runs WHERE job_type = 'pdf_export' AND payload->>'scope_key' = $1 AND payload->>'content_mode' = $2 ORDER BY enqueued_at DESC LIMIT 1`,
				[String(FIXTURE_YEAR), mode]
			);
			const jobId = jobRow.rows[0]?.id ?? null;
			record(`content=${mode}: job_runs row enqueued with the right content_mode`, jobId !== null, `rows: ${JSON.stringify(jobRow.rows)}`);

			let modeWorkerStdout = '';
			try {
				modeWorkerStdout = runWorkerOnce();
				record(`content=${mode}: enrichment worker ran to completion`, true, 'exit 0');
			} catch (err) {
				record(`content=${mode}: enrichment worker ran to completion`, false, `${err instanceof Error ? err.message : err}`);
			}

			const jobAfter = jobId ? await pool.query(`SELECT status FROM job_runs WHERE id = $1`, [jobId]) : { rows: [] };
			record(`content=${mode}: job_runs row is status=done`, jobAfter.rows[0]?.status === 'done', `got ${JSON.stringify(jobAfter.rows[0])}; worker stdout: ${modeWorkerStdout.slice(-500)}`);

			const modeExportRes = await pool.query(
				`SELECT id, object_key, byte_size, content_mode FROM pdf_exports
				  WHERE scope = 'year' AND scope_key = $1 AND content_mode = $2
				  ORDER BY created_at DESC LIMIT 1`,
				[String(FIXTURE_YEAR), mode]
			);
			const modeExportRow = modeExportRes.rows[0];
			if (modeExportRow) extraExportIds.push(modeExportRow.id);
			record(`content=${mode}: a pdf_exports row was written with content_mode=${mode}`, modeExportRow?.content_mode === mode, `got ${JSON.stringify(modeExportRow)}`);
			record(`content=${mode}: object_key includes the mode segment`, !!modeExportRow?.object_key?.includes(`-${mode}-`), `got ${modeExportRow?.object_key}`);

			if (modeExportRow) {
				const objectPath = path.join(localObjectStoreRoot(), modeExportRow.object_key);
				const objectExists = existsSync(objectPath);
				record(`content=${mode}: object file exists in .local/object-store-test`, objectExists, objectPath);
				if (objectExists) {
					const { readFile } = await import('node:fs/promises');
					const buf = await readFile(objectPath);
					record(`content=${mode}: object file starts with the %PDF- magic bytes`, buf.subarray(0, 5).toString('latin1') === '%PDF-', buf.subarray(0, 8).toString('latin1'));
					record(`content=${mode}: object file is a real, non-trivial PDF (>500 bytes)`, buf.length > 500, `got ${buf.length} bytes`);
				}

				// Viewer download of this mode via the new endpoint's ?mode= param.
				const res = await fetchNoRedirect(`${BASE_URL}/app/year/${FIXTURE_YEAR}/pdf?mode=${mode}`, {
					headers: { Cookie: viewerCookie }
				});
				const buf = Buffer.from(await res.arrayBuffer());
				record(`content=${mode}: viewer download via ?mode=${mode} is 200`, res.status === 200, `expected 200, got ${res.status}`);
				record(`content=${mode}: viewer download body starts with %PDF-`, buf.subarray(0, 5).toString('latin1') === '%PDF-', 'checked');
				const disposition = res.headers.get('content-disposition') ?? '';
				record(
					`content=${mode}: viewer download Content-Disposition names the file with a mode suffix`,
					disposition.includes(`madonnahist-${FIXTURE_YEAR}-${mode}.pdf`),
					`got ${disposition}`
				);

				// Clean up this mode's export immediately — same delete-and-verify
				// shape as the 'full' mode flow above.
				const { status: delStatus, envelope: delEnvelope } = await postAction('/admin/exports?/delete', { id: modeExportRow.id }, adminCookie);
				record(`content=${mode}: delete action succeeds`, delStatus === 200 && delEnvelope?.type === 'success', `status ${delStatus}, ${JSON.stringify(delEnvelope)}`);
				const rowAfter = await pool.query(`SELECT id FROM pdf_exports WHERE id = $1`, [modeExportRow.id]);
				record(`content=${mode}: deleted row is gone from pdf_exports`, rowAfter.rows.length === 0, `rows left: ${rowAfter.rows.length}`);
				if (rowAfter.rows.length === 0) {
					extraExportIds.splice(extraExportIds.indexOf(modeExportRow.id), 1);
				}
			}

			await pool.query(`DELETE FROM job_runs WHERE job_type = 'pdf_export' AND payload->>'scope_key' = $1 AND payload->>'content_mode' = $2`, [
				String(FIXTURE_YEAR),
				mode
			]);
		}

		// ── story scope (Gaylon, 2026-07-23): one real worker/chromium run for
		//    a saved "Ask the archive" story's PDF export. The adhoc_narratives
		//    row AND its pdf_export job_runs row are seeded DIRECTLY here
		//    (not via /admin/ask's HTTP save action, which already has its own
		//    job-enqueue assertion in scripts/test-ask.mjs) — this test's job
		//    is the enrichment worker's scope='story' branch in isolation, plus
		//    the story list/detail pages and the new download endpoint. ──────
		const STORY_QUESTION = `${MARKER} STORY test question — what happened in spring?`;
		const STORY_NARRATIVE_MARKER = `${MARKER}_STORY_NARRATIVE distinctive story narrative text.`;
		let storyExportId = null;
		{
			const storyRes = await pool.query(
				`INSERT INTO adhoc_narratives (question, subset_definition, narrative_text, day_count, model_name, created_by)
				 VALUES ($1, $2::jsonb, $3, $4, $5, $6) RETURNING id`,
				[
					STORY_QUESTION,
					JSON.stringify({ subsetSummary: String(FIXTURE_YEAR) }),
					STORY_NARRATIVE_MARKER,
					3,
					'test-stub',
					ids.adminId
				]
			);
			storyId = storyRes.rows[0].id;

			const jobRes = await pool.query(
				`INSERT INTO job_runs (job_type, payload) VALUES ('pdf_export', $1::jsonb) RETURNING id`,
				[JSON.stringify({ scope: 'story', scope_key: String(storyId), requested_by: ids.adminId, content_mode: 'full' })]
			);
			storyJobId = jobRes.rows[0].id;

			let storyWorkerStdout = '';
			try {
				storyWorkerStdout = runWorkerOnce();
				record('story: enrichment worker ran to completion', true, 'exit 0');
			} catch (err) {
				record('story: enrichment worker ran to completion', false, `${err instanceof Error ? err.message : err}`);
			}

			const jobAfter = await pool.query(`SELECT status FROM job_runs WHERE id = $1`, [storyJobId]);
			record(
				'story: job_runs row is status=done',
				jobAfter.rows[0]?.status === 'done',
				`got ${JSON.stringify(jobAfter.rows[0])}; worker stdout: ${storyWorkerStdout.slice(-800)}`
			);

			const storyExportRes = await pool.query(
				`SELECT id, object_key, byte_size, day_count, content_mode FROM pdf_exports WHERE scope = 'story' AND scope_key = $1`,
				[String(storyId)]
			);
			record(
				'story: exactly one pdf_exports row was written',
				storyExportRes.rows.length === 1,
				`rows: ${JSON.stringify(storyExportRes.rows)}`
			);
			const storyExportRow = storyExportRes.rows[0];
			storyExportId = storyExportRow?.id ?? null;
			if (storyExportId) extraExportIds.push(storyExportId);
			record('story: pdf_exports.content_mode is full', storyExportRow?.content_mode === 'full', `got ${storyExportRow?.content_mode}`);
			record(
				'story: pdf_exports.day_count matches the adhoc_narratives row (3)',
				Number(storyExportRow?.day_count) === 3,
				`got ${storyExportRow?.day_count}`
			);
			record(
				"story: object key uses the exports/story-<id>-<jobid>.pdf convention",
				storyExportRow?.object_key === `exports/story-${storyId}-${storyJobId}.pdf`,
				storyExportRow?.object_key
			);

			if (storyExportRow) {
				const objectPath = path.join(localObjectStoreRoot(), storyExportRow.object_key);
				const objectExists = existsSync(objectPath);
				record('story: object file exists in .local/object-store-test', objectExists, objectPath);
				if (objectExists) {
					const { readFile } = await import('node:fs/promises');
					const buf = await readFile(objectPath);
					record(
						'story: object file starts with the %PDF- magic bytes',
						buf.subarray(0, 5).toString('latin1') === '%PDF-',
						buf.subarray(0, 8).toString('latin1')
					);
					record('story: object file is a real, non-trivial PDF (>500 bytes)', buf.length > 500, `got ${buf.length} bytes`);
				}
			}

			// ── story list + detail pages ────────────────────────────────────
			{
				const res = await fetchNoRedirect(`${BASE_URL}/app/stories`, { headers: { Cookie: viewerCookie } });
				const body = await res.text();
				record('story list: renders 200', res.status === 200, `status ${res.status}`);
				record('story list: shows the story question', body.includes(STORY_QUESTION), 'checked');
				record(
					'story list: never shows narrative text (list is title + meta only)',
					!body.includes(STORY_NARRATIVE_MARKER),
					'checked'
				);
			}
			{
				const res = await fetchNoRedirect(`${BASE_URL}/app/stories/${storyId}`, { headers: { Cookie: viewerCookie } });
				const body = await res.text();
				record('story detail: renders 200', res.status === 200, `status ${res.status}`);
				record('story detail: shows the question', body.includes(STORY_QUESTION), 'checked');
				record('story detail: shows the full narrative text', body.includes(STORY_NARRATIVE_MARKER), 'checked');
				record('story detail: shows a "Download PDF" link once the export exists', body.includes('Download PDF'), 'checked');
			}
			{
				// Malformed/nonexistent id: the SAME friendly 200 "not found" page
				// as a real load, never a raw 404/500 — matching the day-page
				// precedent (src/routes/app/day/[date]/+page.server.ts's found:false).
				const res = await fetchNoRedirect(`${BASE_URL}/app/stories/not-a-number`, { headers: { Cookie: viewerCookie } });
				const body = await res.text();
				record(
					'story detail: bad id gets a friendly 200 "not found" page, not a crash',
					res.status === 200 && body.includes('Not found'),
					`status ${res.status}`
				);
			}

			// ── viewer PDF download for the story ────────────────────────────
			{
				const res = await fetchNoRedirect(`${BASE_URL}/app/stories/${storyId}/pdf`, { headers: { Cookie: viewerCookie } });
				const contentType = res.headers.get('content-type') ?? '';
				const buf = Buffer.from(await res.arrayBuffer());
				record('story pdf download [viewer] is 200', res.status === 200, `expected 200, got ${res.status}`);
				record('story pdf download [viewer] content-type is application/pdf', contentType.includes('application/pdf'), `got ${contentType}`);
				record('story pdf download [viewer] body starts with %PDF-', buf.subarray(0, 5).toString('latin1') === '%PDF-', 'checked');
				const disposition = res.headers.get('content-disposition') ?? '';
				record(
					'story pdf download Content-Disposition names the file',
					disposition.includes(`madonnahist-story-${storyId}.pdf`),
					`got ${disposition}`
				);
			}
			{
				const res = await fetchNoRedirect(`${BASE_URL}/app/stories/${storyId}/pdf`);
				record('story pdf download [unauthenticated] redirects to login', res.status === 303, `expected 303, got ${res.status}`);
			}
			{
				const res = await fetchNoRedirect(`${BASE_URL}/app/stories/999999999/pdf`, { headers: { Cookie: viewerCookie } });
				record('story pdf download [nonexistent id] is a friendly 404', res.status === 404, `expected 404, got ${res.status}`);
			}

			// ── render-token security matrix for scope='story' ───────────────
			//    A story token must open ONLY its own story path — not another
			//    story id, not a day image, not a book page — the exact
			//    opposite allowance from a 'year' token (see
			//    src/lib/server/render-token.ts's matchesRenderScopePath()).
			const storyToken = makeValidRenderToken('story', String(storyId));
			{
				const res = await fetchNoRedirect(`${BASE_URL}/app/stories/${storyId}?render=pdf`, {
					headers: { Cookie: `${RENDER_TOKEN_COOKIE_NAME}=${storyToken}` }
				});
				record('story render token: opens its own story page (200)', res.status === 200, `expected 200, got ${res.status}`);
			}
			{
				const otherStoryId = Number(storyId) + 1;
				const res = await fetchNoRedirect(`${BASE_URL}/app/stories/${otherStoryId}?render=pdf`, {
					headers: { Cookie: `${RENDER_TOKEN_COOKIE_NAME}=${storyToken}` }
				});
				record(
					"story render token: does NOT open a different story id",
					res.status === 303,
					`expected 303, got ${res.status}`
				);
			}
			{
				const res = await fetchNoRedirect(`${BASE_URL}/app/day/${ACCEPTED_DATES[0]}/image`, {
					headers: { Cookie: `${RENDER_TOKEN_COOKIE_NAME}=${storyToken}` }
				});
				record(
					'story render token: does NOT open a day image path (unlike a year/book token)',
					res.status === 303,
					`expected 303, got ${res.status}`
				);
			}
			{
				const res = await fetchNoRedirect(`${BASE_URL}/app/book/year/${FIXTURE_YEAR}?render=pdf`, {
					headers: { Cookie: `${RENDER_TOKEN_COOKIE_NAME}=${storyToken}` }
				});
				record('story render token: does NOT open a book page', res.status === 303, `expected 303, got ${res.status}`);
			}
			// Regression guard: a 'year' token must still open SAME-YEAR day
			// images (scope tightened to same-year by CODEX1 finding 4).
			{
				const res = await fetchNoRedirect(`${BASE_URL}/app/day/${ACCEPTED_DATES[0]}/image`, {
					headers: { Cookie: `${RENDER_TOKEN_COOKIE_NAME}=${validToken}` }
				});
				record(
					"regression guard: year-scope render token still opens same-year day images",
					res.status === 200,
					`expected 200, got ${res.status}`
				);
			}
		}

		console.log('\nPDF export results:\n');
		const width = Math.max(...rows.map((r) => r.label.length)) + 2;
		for (const r of rows) {
			const mark = r.ok ? 'PASS' : 'FAIL';
			console.log(`${mark}  ${r.label.padEnd(width)} ${r.detail}`);
		}
		console.log(`\n${pass} passed, ${fail} failed (${rows.length} total)`);

		if (fail > 0) process.exitCode = 1;
	} finally {
		const idsToClean = [exportId, ...extraExportIds].filter(Boolean);
		for (const id of idsToClean) {
			const row = await pool.query(`SELECT object_key FROM pdf_exports WHERE id = $1`, [id]).catch(() => ({ rows: [] }));
			if (row.rows[0]) {
				const { rm } = await import('node:fs/promises');
				await rm(path.join(localObjectStoreRoot(), row.rows[0].object_key), { force: true }).catch(() => {});
			}
			await pool.query(`DELETE FROM pdf_exports WHERE id = $1`, [id]).catch(() => {});
		}
		await pool.query(`DELETE FROM job_runs WHERE job_type = 'pdf_export' AND payload->>'scope_key' = $1`, [String(FIXTURE_YEAR)]).catch(() => {});
		// Story scope fixture cleanup (Gaylon, 2026-07-23) — the pdf_exports
		// row/object for storyId is already handled by the idsToClean loop
		// above (storyExportId was pushed into extraExportIds); this cleans up
		// the two rows that loop doesn't touch: the job_runs row and the
		// adhoc_narratives row itself.
		if (storyJobId) {
			await pool.query(`DELETE FROM job_runs WHERE id = $1`, [storyJobId]).catch(() => {});
		}
		if (storyId) {
			await pool.query(`DELETE FROM adhoc_narratives WHERE id = $1`, [storyId]).catch(() => {});
		}
		await cleanupNarrative(pool).catch(() => {});
		if (fixtureProvisioned) await cleanupFixture(pool);
		await cleanupUsers(pool, ids);
		await pool.end();
	}
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
