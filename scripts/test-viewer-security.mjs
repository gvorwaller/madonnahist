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
// What this asserts (per the plan's Phase B verify section, extended for
// Phase C tag UI in docs/2026-07-21-next-phases-search-viewer-narrative-plan.md):
//   - accepted day page renders the real corrected_text
//   - pending day page renders the friendly "not transcribed" state and
//     NEVER leaks its corrected_text
//   - day image endpoint: accepted is 200-or-graceful (a fake local object
//     path means the object store fetch itself may 404/500 — that's fine,
//     the point here is authorization, not object bytes); pending is a hard
//     404 (denied before any object-store fetch is attempted)
//   - search finds accepted-day text and never pending-day text
//   - (Phase C) accepted day's tag chip renders on its day-detail page
//   - (Phase C) /app/search?tag=<accepted-day's tag> finds the accepted day
//     and /app/search?tag=<pending-day's tag> never finds the pending day
//   - (Phase C) the pending day's tag never appears in the /app/search tag
//     dropdown source (accepted-only)
//   - (Phase C) POST ?/addTag and ?/removeTag on /correct/day/[date] as
//     viewer are still 403 — route gating already blocks /correct for
//     viewers; this proves that stays true for the new tag actions too
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

// Same idea for the Phase C tag fixtures — distinctive slug/label pairs that
// can't coincide with anything real.
const ACCEPTED_TAG_SLUG = 'zqxplor-accepted-tag';
const ACCEPTED_TAG_LABEL = 'Zqxplor Accepted Tag';
const PENDING_TAG_SLUG = 'wobblefrim-pending-tag';
const PENDING_TAG_LABEL = 'Wobblefrim Pending Tag';

// Phase D entity fixtures — one person mentioned on the accepted day, one
// place mentioned ONLY on the pending day, so tests can assert
// /app/person/[slug] and /app/place/[slug] (and the day-detail entity
// chips, and the /app/search person/place filters) all honor the same
// accepted-only predicate as everything else in src/lib/server/entities.ts.
const ACCEPTED_ENTITY_SLUG = 'zqxplor-accepted-person';
const ACCEPTED_ENTITY_NAME = 'Zqxplor Accepted Person';
const PENDING_ENTITY_SLUG = 'wobblefrim-pending-place';
const PENDING_ENTITY_NAME = 'Wobblefrim Pending Place';

// Phase F book-view fixtures — a dedicated year/page/days, distinct from
// FIXTURE_YEAR above (1899, which predates the book route's MIN_YEAR=1900
// validation — matching src/routes/app/year/[year]/+page.server.ts's own
// range check). One published and one unpublished narrative marker so the
// book page can be checked the same way /app/year/[year] already is.
const BOOK_FIXTURE_YEAR = 1902;
const BOOK_FIXTURE_MONTH = 6;
const BOOK_ACCEPTED_DATE = '1902-06-10';
const BOOK_PENDING_DATE = '1902-06-11';
const PUBLISHED_NARRATIVE_MARKER = 'ZQXPLBOOKPUBLISHED narrative text for the book-view test.';
const UNPUBLISHED_NARRATIVE_MARKER = 'WOBBLEFRIMBOOKDRAFT narrative text that must never leak.';

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

	const acceptedRes = await pool.query(
		`INSERT INTO calendar_days (page_id, entry_date, day_image_path, corrected_text, correction_status)
		 VALUES ($1, $2, $3, $4, 'accepted')
		 RETURNING id`,
		[pageId, ACCEPTED_DATE, 'fixtures/viewer-security-test/fake-accepted.jpg',
			`Distinctive fixture entry for viewer security test: ${ACCEPTED_MARKER} happened here. A second sentence follows for preview purposes.`]
	);
	const acceptedDayId = acceptedRes.rows[0].id;

	const pendingRes = await pool.query(
		`INSERT INTO calendar_days (page_id, entry_date, day_image_path, corrected_text, correction_status)
		 VALUES ($1, $2, $3, $4, 'pending')
		 RETURNING id`,
		[pageId, PENDING_DATE, 'fixtures/viewer-security-test/fake-pending.jpg',
			`Distinctive fixture entry for viewer security test: ${PENDING_MARKER} happened here — this must never leak.`]
	);
	const pendingDayId = pendingRes.rows[0].id;

	// Phase C tag fixtures — one tag on the accepted day, one on the pending
	// day, so tests can assert the tag chip/dropdown/filter all honor the
	// same accepted-only predicate as the rest of /app.
	await pool.query(
		`INSERT INTO day_tags (day_id, tag_slug, tag_label, source) VALUES ($1, $2, $3, 'human')`,
		[acceptedDayId, ACCEPTED_TAG_SLUG, ACCEPTED_TAG_LABEL]
	);
	await pool.query(
		`INSERT INTO day_tags (day_id, tag_slug, tag_label, source) VALUES ($1, $2, $3, 'human')`,
		[pendingDayId, PENDING_TAG_SLUG, PENDING_TAG_LABEL]
	);

	// Phase D entity fixtures. Cleaned up (and re-created idempotently) the
	// same way as the day rows above — delete any leftover fixture entities
	// by slug first, then insert fresh ones and link them via day_entities.
	await pool.query(`DELETE FROM entities WHERE slug = ANY($1)`, [[ACCEPTED_ENTITY_SLUG, PENDING_ENTITY_SLUG]]);
	const acceptedEntityRes = await pool.query(
		`INSERT INTO entities (slug, display_name, entity_type) VALUES ($1, $2, 'person') RETURNING id`,
		[ACCEPTED_ENTITY_SLUG, ACCEPTED_ENTITY_NAME]
	);
	const acceptedEntityId = acceptedEntityRes.rows[0].id;
	const pendingEntityRes = await pool.query(
		`INSERT INTO entities (slug, display_name, entity_type) VALUES ($1, $2, 'place') RETURNING id`,
		[PENDING_ENTITY_SLUG, PENDING_ENTITY_NAME]
	);
	const pendingEntityId = pendingEntityRes.rows[0].id;

	await pool.query(
		`INSERT INTO day_entities (day_id, entity_id, source) VALUES ($1, $2, 'human')`,
		[acceptedDayId, acceptedEntityId]
	);
	await pool.query(
		`INSERT INTO day_entities (day_id, entity_id, source) VALUES ($1, $2, 'human')`,
		[pendingDayId, pendingEntityId]
	);

	return pageId;
}

// Phase F: a dedicated page + accepted/pending day pair for BOOK_FIXTURE_YEAR
// (see the constant comment above for why this can't reuse FIXTURE_YEAR), so
// /app/book/year/[key] can be checked against the same accepted-only
// predicate as the rest of /app. Idempotency follows the same
// delete-then-insert shape as provisionFixtureDays above.
async function provisionBookFixtureDays(pool) {
	await pool.query(
		`INSERT INTO calendar_pages (year, month, page_image_path, capture_session)
		 VALUES ($1, $2, $3, $4)
		 ON CONFLICT (year, month) DO NOTHING`,
		[BOOK_FIXTURE_YEAR, BOOK_FIXTURE_MONTH, 'fixtures/viewer-security-test/fake-book-page.jpg', FIXTURE_CAPTURE_SESSION]
	);
	const pageRes = await pool.query(
		`SELECT id FROM calendar_pages WHERE year = $1 AND month = $2`,
		[BOOK_FIXTURE_YEAR, BOOK_FIXTURE_MONTH]
	);
	const bookPageId = pageRes.rows[0].id;

	await pool.query(`DELETE FROM calendar_days WHERE entry_date = ANY($1::date[])`, [
		[BOOK_ACCEPTED_DATE, BOOK_PENDING_DATE]
	]);

	await pool.query(
		`INSERT INTO calendar_days (page_id, entry_date, day_image_path, corrected_text, correction_status)
		 VALUES ($1, $2, $3, $4, 'accepted')`,
		[bookPageId, BOOK_ACCEPTED_DATE, 'fixtures/viewer-security-test/fake-book-accepted.jpg',
			`Distinctive book-view fixture entry: ${ACCEPTED_MARKER} happened here.`]
	);
	await pool.query(
		`INSERT INTO calendar_days (page_id, entry_date, day_image_path, corrected_text, correction_status)
		 VALUES ($1, $2, $3, $4, 'pending')`,
		[bookPageId, BOOK_PENDING_DATE, 'fixtures/viewer-security-test/fake-book-pending.jpg',
			`Distinctive book-view fixture entry: ${PENDING_MARKER} happened here — this must never leak.`]
	);

	return bookPageId;
}

async function cleanupBookFixtureDays(pool, bookPageId) {
	if (!bookPageId) return;
	await pool.query(`DELETE FROM calendar_days WHERE page_id = $1`, [bookPageId]);
	await pool.query(`DELETE FROM calendar_pages WHERE id = $1`, [bookPageId]);
}

// Phase F: an unpublished draft + a published narrative for BOOK_FIXTURE_YEAR,
// so the book route's narrative predicate (is_published = true, same rule as
// /app/year/[year]) can be asserted the same way test-narratives.mjs does.
async function provisionBookNarrative(pool) {
	await pool.query(`DELETE FROM narrative_summaries WHERE scope = 'year' AND scope_key = $1`, [
		String(BOOK_FIXTURE_YEAR)
	]);
	// Starts unpublished — the first assertion is that a draft never leaks;
	// the test then flips it to published in place and re-checks.
	await pool.query(
		`INSERT INTO narrative_summaries (scope, scope_key, summary_text, generated_by, is_published)
		 VALUES ('year', $1, $2, '_viewer_security_test', false)`,
		[String(BOOK_FIXTURE_YEAR), UNPUBLISHED_NARRATIVE_MARKER]
	);
}

async function publishBookNarrative(pool) {
	await pool.query(
		`UPDATE narrative_summaries SET summary_text = $2, is_published = true
		  WHERE scope = 'year' AND scope_key = $1`,
		[String(BOOK_FIXTURE_YEAR), PUBLISHED_NARRATIVE_MARKER]
	);
}

async function cleanupBookNarrative(pool) {
	await pool.query(`DELETE FROM narrative_summaries WHERE scope = 'year' AND scope_key = $1`, [
		String(FIXTURE_YEAR)
	]);
}

async function cleanupFixtureDays(pool, pageId) {
	if (!pageId) return;
	await pool.query(`DELETE FROM calendar_days WHERE page_id = $1`, [pageId]);
	await pool.query(`DELETE FROM calendar_pages WHERE id = $1`, [pageId]);
	await pool.query(`DELETE FROM entities WHERE slug = ANY($1)`, [[ACCEPTED_ENTITY_SLUG, PENDING_ENTITY_SLUG]]);
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
	let bookPageId;
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
		bookPageId = await provisionBookFixtureDays(pool);
		await provisionBookNarrative(pool);

		const viewerCookie = await login(VIEWER_USERNAME, TEST_PASSWORD);

		// ── Landing page cards filtered by role (Gaylon, 2026-07-23) ────────
		// src/routes/+page.svelte only renders the cards a role can actually
		// reach (mirrors src/hooks.server.ts's roleAllowed()) — a viewer's
		// landing page must never link to /admin (they'd just get a 403 on
		// click), but must still show the Family Viewer card.
		{
			const res = await fetchNoRedirect(`${BASE_URL}/`, { headers: { Cookie: viewerCookie } });
			const body = await res.text();
			const hasAdminLink = body.includes('href="/admin"');
			const hasAppLink = body.includes('href="/app"');
			record('GET / [viewer] landing page does NOT link to /admin', !hasAdminLink,
				hasAdminLink ? 'ADMIN CARD LEAKED INTO VIEWER LANDING PAGE' : 'no /admin link, as required');
			record('GET / [viewer] landing page links to /app', hasAppLink,
				hasAppLink ? '/app link present' : '/app link missing');
		}

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

		// ── Tag chip: accepted day's tag renders on its day-detail page ─────
		{
			const res = await fetchNoRedirect(`${BASE_URL}/app/day/${ACCEPTED_DATE}`, {
				headers: { Cookie: viewerCookie }
			});
			const body = await res.text();
			const hasChip = body.includes(`/app/search?tag=${ACCEPTED_TAG_SLUG}`) && body.includes(ACCEPTED_TAG_LABEL);
			record('GET /app/day/<accepted> [viewer] shows its tag chip', hasChip,
				hasChip ? 'tag chip link + label present' : 'tag chip missing from body');
		}

		// ── Tag filter: accepted day's tag finds the accepted day ──────────
		{
			const url = `${BASE_URL}/app/search?${new URLSearchParams({ tag: ACCEPTED_TAG_SLUG })}`;
			const res = await fetchNoRedirect(url, { headers: { Cookie: viewerCookie } });
			const body = await res.text();
			const found = res.status === 200 && body.includes(`/app/day/${ACCEPTED_DATE}`);
			record('GET /app/search?tag=<accepted tag> [viewer] finds the accepted day', found,
				found ? 'result card links to the accepted day' : `status ${res.status}, day-link present: ${body.includes(`/app/day/${ACCEPTED_DATE}`)}`);
		}

		// ── Tag filter: pending day's tag never finds the pending day ──────
		{
			const url = `${BASE_URL}/app/search?${new URLSearchParams({ tag: PENDING_TAG_SLUG })}`;
			const res = await fetchNoRedirect(url, { headers: { Cookie: viewerCookie } });
			const body = await res.text();
			const leaked = body.includes(`/app/day/${PENDING_DATE}`);
			record('GET /app/search?tag=<pending tag> [viewer] never finds the pending day', !leaked,
				leaked ? 'PENDING DAY LEAKED INTO TAG-FILTERED SEARCH RESULTS' : 'no result card for the pending day, as required');
		}

		// ── Tag dropdown source: pending day's tag never appears at all ────
		{
			const res = await fetchNoRedirect(`${BASE_URL}/app/search`, { headers: { Cookie: viewerCookie } });
			const body = await res.text();
			const acceptedTagPresent = body.includes(ACCEPTED_TAG_SLUG);
			const pendingTagLeaked = body.includes(PENDING_TAG_SLUG) || body.includes(PENDING_TAG_LABEL);
			record('GET /app/search [viewer] tag dropdown includes the accepted tag', acceptedTagPresent,
				acceptedTagPresent ? 'accepted tag slug present in dropdown source' : 'accepted tag slug missing');
			record('GET /app/search [viewer] tag dropdown never includes the pending tag', !pendingTagLeaked,
				pendingTagLeaked ? 'PENDING TAG LEAKED INTO DROPDOWN SOURCE' : 'pending tag slug/label absent, as required');
		}

		// ── Correction-editor tag actions stay gated for viewers ────────────
		// /correct is already role-gated to admin|corrector in
		// src/hooks.server.ts; this proves the new addTag/removeTag actions
		// (Phase C) didn't accidentally carve out an exception.
		{
			const res = await fetchNoRedirect(`${BASE_URL}/correct/day/${ACCEPTED_DATE}?/addTag`, {
				method: 'POST',
				headers: { Cookie: viewerCookie, 'Content-Type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({ tagLabel: 'should not be added' }).toString()
			});
			const ok = res.status === 403;
			record('POST /correct/day/<date>?/addTag [viewer] is 403', ok, `expected 403, got ${res.status}`);
		}
		{
			const res = await fetchNoRedirect(`${BASE_URL}/correct/day/${ACCEPTED_DATE}?/removeTag`, {
				method: 'POST',
				headers: { Cookie: viewerCookie, 'Content-Type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({ tagSlug: ACCEPTED_TAG_SLUG }).toString()
			});
			const ok = res.status === 403;
			record('POST /correct/day/<date>?/removeTag [viewer] is 403', ok, `expected 403, got ${res.status}`);
		}

		// ── Phase D: entity chip on accepted day links to its person page ──
		{
			const res = await fetchNoRedirect(`${BASE_URL}/app/day/${ACCEPTED_DATE}`, {
				headers: { Cookie: viewerCookie }
			});
			const body = await res.text();
			const hasChip = body.includes(`/app/person/${ACCEPTED_ENTITY_SLUG}`) && body.includes(ACCEPTED_ENTITY_NAME);
			record('GET /app/day/<accepted> [viewer] shows its entity chip linking to /app/person/…', hasChip,
				hasChip ? 'entity chip link + name present' : 'entity chip missing from body');
		}

		// ── Phase D: entity chip absent on the pending day's page ──────────
		{
			const res = await fetchNoRedirect(`${BASE_URL}/app/day/${PENDING_DATE}`, {
				headers: { Cookie: viewerCookie }
			});
			const body = await res.text();
			const leaked = body.includes(`/app/place/${PENDING_ENTITY_SLUG}`) || body.includes(PENDING_ENTITY_NAME);
			record('GET /app/day/<pending> [viewer] never shows an entity chip', !leaked,
				leaked ? 'PENDING-DAY ENTITY CHIP LEAKED INTO RESPONSE BODY' : 'no entity chip, as required');
		}

		// ── Phase D: person page for an entity mentioned on an accepted day ─
		{
			const res = await fetchNoRedirect(`${BASE_URL}/app/person/${ACCEPTED_ENTITY_SLUG}`, {
				headers: { Cookie: viewerCookie }
			});
			const body = await res.text();
			const rendersProfile = res.status === 200 && body.includes(ACCEPTED_ENTITY_NAME) && body.includes(`/app/day/${ACCEPTED_DATE}`);
			record('GET /app/person/<accepted entity slug> [viewer] renders with its accepted day linked', rendersProfile,
				rendersProfile ? 'profile rendered with day link' : `status ${res.status}, name present: ${body.includes(ACCEPTED_ENTITY_NAME)}, day link present: ${body.includes(`/app/day/${ACCEPTED_DATE}`)}`);
		}

		// ── Phase D: entity mentioned ONLY on a pending day → its profile
		//    page shows zero accepted days and never leaks the pending day ──
		{
			const res = await fetchNoRedirect(`${BASE_URL}/app/place/${PENDING_ENTITY_SLUG}`, {
				headers: { Cookie: viewerCookie }
			});
			const body = await res.text();
			const leaked = body.includes(`/app/day/${PENDING_DATE}`) || body.includes(PENDING_MARKER);
			record('GET /app/place/<pending-only entity slug> [viewer] never shows the pending day', !leaked,
				leaked ? 'PENDING DAY LEAKED INTO ENTITY PROFILE PAGE' : 'no pending-day content, as required');
		}

		// ── Phase D: person/place filter on /app/search ─────────────────────
		{
			const url = `${BASE_URL}/app/search?${new URLSearchParams({ person: ACCEPTED_ENTITY_SLUG })}`;
			const res = await fetchNoRedirect(url, { headers: { Cookie: viewerCookie } });
			const body = await res.text();
			const found = res.status === 200 && body.includes(`/app/day/${ACCEPTED_DATE}`);
			record('GET /app/search?person=<accepted entity slug> [viewer] finds the accepted day', found,
				found ? 'result card links to the accepted day' : `status ${res.status}, day-link present: ${body.includes(`/app/day/${ACCEPTED_DATE}`)}`);
		}
		{
			const url = `${BASE_URL}/app/search?${new URLSearchParams({ place: PENDING_ENTITY_SLUG })}`;
			const res = await fetchNoRedirect(url, { headers: { Cookie: viewerCookie } });
			const body = await res.text();
			const leaked = body.includes(`/app/day/${PENDING_DATE}`);
			record('GET /app/search?place=<pending-only entity slug> [viewer] never finds the pending day', !leaked,
				leaked ? 'PENDING DAY LEAKED INTO ENTITY-FILTERED SEARCH RESULTS' : 'no result card for the pending day, as required');
		}
		{
			const res = await fetchNoRedirect(`${BASE_URL}/app/search`, { headers: { Cookie: viewerCookie } });
			const body = await res.text();
			const acceptedPersonPresent = body.includes(ACCEPTED_ENTITY_SLUG);
			const pendingPlaceLeaked = body.includes(PENDING_ENTITY_SLUG) || body.includes(PENDING_ENTITY_NAME);
			record('GET /app/search [viewer] person dropdown includes the accepted-day person', acceptedPersonPresent,
				acceptedPersonPresent ? 'accepted entity slug present in dropdown source' : 'accepted entity slug missing');
			record('GET /app/search [viewer] place dropdown never includes the pending-only place', !pendingPlaceLeaked,
				pendingPlaceLeaked ? 'PENDING-ONLY ENTITY LEAKED INTO DROPDOWN SOURCE' : 'pending entity slug/name absent, as required');
		}

		// ── Phase F: book view for the fixture year shows accepted-day text,
		//    never pending-day text ─────────────────────────────────────────
		{
			const res = await fetchNoRedirect(`${BASE_URL}/app/book/year/${BOOK_FIXTURE_YEAR}`, {
				headers: { Cookie: viewerCookie }
			});
			const body = await res.text();
			const okStatus = res.status === 200;
			record('GET /app/book/year/<fixture year> [viewer] status', okStatus, `expected 200, got ${res.status}`);
			const hasAccepted = body.includes(ACCEPTED_MARKER);
			record('GET /app/book/year/<fixture year> [viewer] shows accepted day text', hasAccepted,
				hasAccepted ? 'marker present' : 'marker missing from body');
			const leakedPending = body.includes(PENDING_MARKER) || body.includes(`/app/day/${BOOK_PENDING_DATE}`);
			record('GET /app/book/year/<fixture year> [viewer] never shows pending day text', !leakedPending,
				leakedPending ? 'PENDING MARKER/DAY LEAKED INTO BOOK VIEW' : 'pending marker/day absent, as required');
		}

		// ── Phase F: unpublished narrative absent, published narrative present ─
		{
			const res = await fetchNoRedirect(`${BASE_URL}/app/book/year/${BOOK_FIXTURE_YEAR}`, {
				headers: { Cookie: viewerCookie }
			});
			const body = await res.text();
			const leaked = body.includes(UNPUBLISHED_NARRATIVE_MARKER);
			record('GET /app/book/year/<fixture year> [viewer] unpublished narrative absent', !leaked,
				leaked ? 'UNPUBLISHED NARRATIVE DRAFT LEAKED INTO BOOK VIEW' : 'draft absent, as required');
		}
		{
			await publishBookNarrative(pool);
			const res = await fetchNoRedirect(`${BASE_URL}/app/book/year/${BOOK_FIXTURE_YEAR}`, {
				headers: { Cookie: viewerCookie }
			});
			const body = await res.text();
			const hasPublished = body.includes(PUBLISHED_NARRATIVE_MARKER);
			const hasLabel = body.includes('AI-generated year summary');
			record('GET /app/book/year/<fixture year> [viewer] published narrative present with AI label', hasPublished && hasLabel,
				`text present: ${hasPublished}, label present: ${hasLabel}`);
		}

		// ── Phase F: invalid scope/key → friendly page, never a crash ──────
		{
			const res = await fetchNoRedirect(`${BASE_URL}/app/book/month/${BOOK_FIXTURE_YEAR}`, {
				headers: { Cookie: viewerCookie }
			});
			const body = await res.text();
			const ok = res.status === 200 && !/internal error|stack trace/i.test(body);
			record('GET /app/book/<invalid scope>/<year> [viewer] friendly page, not a crash', ok,
				`status ${res.status}`);
		}
		{
			const res = await fetchNoRedirect(`${BASE_URL}/app/book/year/not-a-year`, {
				headers: { Cookie: viewerCookie }
			});
			const body = await res.text();
			const ok = res.status === 200 && !/internal error|stack trace/i.test(body);
			record('GET /app/book/year/<invalid key> [viewer] friendly page, not a crash', ok,
				`status ${res.status}`);
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
		await cleanupBookNarrative(pool);
		await cleanupBookFixtureDays(pool, bookPageId);
		await cleanupFixtureDays(pool, pageId);
		await cleanupViewer(pool, viewerId);
		await pool.end();
	}
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
