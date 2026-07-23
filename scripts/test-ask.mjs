#!/usr/bin/env node
// "Ask the archive" end-to-end test (Phase G of
// docs/2026-07-21-next-phases-search-viewer-narrative-plan.md, td-84c7fa).
//
// Requires a dev server already running on the isolated test stack, AND
// STARTED WITH MADONNAHIST_LLM_STUB=1 in its own process environment:
//
//   MADONNAHIST_LLM_STUB=1 npx vite dev --host 127.0.0.1 --port 5177 --strictPort --mode test
//
// This is unlike scripts/test-enrichment.mjs and scripts/test-narratives.mjs,
// which spawn the worker as a fresh child process per run and can set
// MADONNAHIST_LLM_STUB/MADONNAHIST_LLM_STUB_TEXT per invocation. Phase G's
// `ask` action runs synchronously inside the SAME long-lived server process
// that is already running (src/lib/server/llm.ts), so there is no per-request
// way to inject the stub env var from this script — it must already be set
// when the server started. Without it, completeText() would try a real
// Anthropic call using private_data.api_credentials / ANTHROPIC_API_KEY,
// which is deliberately blanked in the Claude Code Bash environment (see
// ~/.claude/CLAUDE.md), and every "ask" scenario below would 500.
//
// Because of that constraint, this test does NOT assert exact narrative
// text (unlike test-narratives.mjs, which controls the stub text per
// worker child-process run) — there is no scenario-specific stub text
// available here. Correctness is instead verified via day_count, subset
// summary, and audit-row assertions, which are independent of whatever
// fixed stub string the already-running server happens to return.
//
// Self-provisions an admin user, a viewer user, fixture calendar_pages/days
// (accepted + pending/in_progress/flagged, an entity alias pair, a tag),
// and a bulk over-365-day fixture range for the hard-cap test — all
// against madonnahist_test (127.0.0.1:15434) — and cleans up in a finally
// block. Never touches port 5433/5435 or PGDATABASE=madonnahist — see
// requireTestSafety() below.
//
// What this asserts (per the plan's Phase G deliverable 4):
//   - subset by year range only includes accepted days in range
//   - pending/in_progress/flagged days are never included in day_count
//   - the entity filter is alias-resolved (a day linked to an alias entity
//     appears when the canonical entity is selected)
//   - a tag filter narrows the subset correctly
//   - an over-365-day subset returns the narrow-please failure WITHOUT
//     calling the LLM (no adhoc_ask audit row is written for that request —
//     audit only happens after a successful generation)
//   - a 0-day subset returns a friendly failure
//   - save -> appears in the saved list (DB row + rendered page) -> delete
//     -> removed from both
//   - GET and POST /admin/ask are both 403 for a viewer and require auth
//     for an unauthenticated caller (extending test-auth-matrix.mjs's
//     /admin coverage, which only exercises the bare /admin prefix)
//
// Usage: node scripts/test-ask.mjs [baseUrl] (or: npm run test:ask)

import argon2 from 'argon2';
import pg from 'pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { parse as devalueParse } from 'devalue';

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
const TEST_PASSWORD = 'AskArchiveTest!2026';
const ADMIN_USERNAME = '_ask_test_admin';
const VIEWER_USERNAME = '_ask_test_viewer';
const CAPTURE_SESSION = '_ask_test';

const ARGON2_OPTS = {
	type: argon2.argon2id,
	memoryCost: 19456,
	timeCost: 2,
	parallelism: 1
};

const MARKER = 'ZQXPLNASKARCHIVE';

// Main fixture: year 1904, month 6 — accepted x2 + pending/in_progress/flagged
// x3 (year-range + pending-exclusion test). The alias/tag fixture days live
// in a DIFFERENT year (1906) deliberately — they are also `accepted`, so if
// they shared MAIN_YEAR they would silently inflate the plain year-range
// test's expected count of 2.
const MAIN_YEAR = 1904;
const MAIN_MONTH = 6;
const D_ACCEPTED_1 = '1904-06-01';
const D_ACCEPTED_2 = '1904-06-02';
const D_PENDING = '1904-06-03';
const D_IN_PROGRESS = '1904-06-04';
const D_FLAGGED = '1904-06-05';

// Boundary fixtures just outside the MAIN_YEAR range.
const D_BEFORE = '1903-12-31';
const D_BEFORE_YEAR = 1903;
const D_BEFORE_MONTH = 12;
const D_AFTER = '1905-01-01';
const D_AFTER_YEAR = 1905;
const D_AFTER_MONTH = 1;

// Alias-resolution + tag-filter fixtures — a separate year so they never
// contaminate the plain year-range count above.
const ALIAS_TAG_YEAR = 1906;
const ALIAS_TAG_MONTH = 6;
const D_ALIAS = '1906-06-15';
const D_TAG = '1906-06-20';

// Over-cap fixture: all of 1907 (365 days, non-leap) + the first 6 days of
// 1908 = 371 accepted days, well over the 365-day hard cap.
const CAP_YEAR_FROM = 1907;
const CAP_YEAR_TO = 1908;
const CAP_RANGE_START = '1907-01-01';
const CAP_RANGE_END = '1908-01-06';

// Zero-day fixture: a year with no fixture data at all.
const ZERO_YEAR = 1909;

const TAG_SLUG = 'asktesttag';
const TAG_LABEL = 'Ask Test Tag';

const SAVE_QUESTION = `${MARKER} what happened in early June 1904?`;

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

// Posts a form action with Accept: application/json — the same negotiation
// SvelteKit's client-side use:enhance uses — so a non-redirect response
// comes back as a `{type, status, data}` envelope with `data` devalue-encoded
// (see @sveltejs/kit's src/runtime/app/forms.js `deserialize()`, which this
// mirrors without needing a browser/client runtime).
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
		const parsed = JSON.parse(text);
		if (parsed && typeof parsed === 'object' && typeof parsed.data === 'string') {
			parsed.data = devalueParse(parsed.data);
		}
		envelope = parsed;
	} catch {
		envelope = null;
	}
	return { status, envelope, rawText: text };
}

async function provisionUsers(pool) {
	const passwordHash = await argon2.hash(TEST_PASSWORD, ARGON2_OPTS);
	const adminRes = await pool.query(
		`INSERT INTO users (username, display_name, role, password_hash)
		 VALUES ($1, $2, 'admin', $3)
		 ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = 'admin'
		 RETURNING id`,
		[ADMIN_USERNAME, 'Ask Test Admin', passwordHash]
	);
	const viewerRes = await pool.query(
		`INSERT INTO users (username, display_name, role, password_hash)
		 VALUES ($1, $2, 'viewer', $3)
		 ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = 'viewer'
		 RETURNING id`,
		[VIEWER_USERNAME, 'Ask Test Viewer', passwordHash]
	);
	return { adminId: adminRes.rows[0].id, viewerId: viewerRes.rows[0].id };
}

async function cleanupUsers(pool, ids) {
	const idList = Object.values(ids).filter(Boolean);
	if (idList.length === 0) return;
	await pool.query(`DELETE FROM sessions WHERE user_id = ANY($1::int[])`, [idList]);
	// The ask/save/delete actions each write an audit_log row with user_id set
	// to the acting admin — audit_log.user_id REFERENCES users(id), so those
	// rows must go before the user row can be deleted.
	await pool.query(`DELETE FROM audit_log WHERE user_id = ANY($1::int[])`, [idList]);
	await pool.query(`DELETE FROM users WHERE id = ANY($1::int[])`, [idList]);
}

async function upsertPage(pool, year, month) {
	await pool.query(
		`INSERT INTO calendar_pages (year, month, page_image_path, capture_session)
		 VALUES ($1, $2, $3, $4)
		 ON CONFLICT (year, month) DO NOTHING`,
		[year, month, `fixtures/ask-test/page-${year}-${month}.jpg`, CAPTURE_SESSION]
	);
	const res = await pool.query(`SELECT id FROM calendar_pages WHERE year = $1 AND month = $2`, [year, month]);
	return res.rows[0].id;
}

async function provisionMainFixture(pool) {
	const pageMain = await upsertPage(pool, MAIN_YEAR, MAIN_MONTH);
	const pageBefore = await upsertPage(pool, D_BEFORE_YEAR, D_BEFORE_MONTH);
	const pageAfter = await upsertPage(pool, D_AFTER_YEAR, D_AFTER_MONTH);
	const pageAliasTag = await upsertPage(pool, ALIAS_TAG_YEAR, ALIAS_TAG_MONTH);

	const allDates = [D_ACCEPTED_1, D_ACCEPTED_2, D_PENDING, D_IN_PROGRESS, D_FLAGGED, D_ALIAS, D_TAG, D_BEFORE, D_AFTER];
	await pool.query(`DELETE FROM day_entities WHERE day_id IN (SELECT id FROM calendar_days WHERE entry_date = ANY($1::date[]))`, [allDates]);
	await pool.query(`DELETE FROM day_tags WHERE day_id IN (SELECT id FROM calendar_days WHERE entry_date = ANY($1::date[]))`, [allDates]);
	await pool.query(`DELETE FROM calendar_days WHERE entry_date = ANY($1::date[])`, [allDates]);

	async function insertDay(pageId, entryDate, status) {
		await pool.query(
			`INSERT INTO calendar_days (page_id, entry_date, corrected_text, correction_status)
			 VALUES ($1, $2, $3, $4)`,
			[pageId, entryDate, `${MARKER} fixture text for ${entryDate}`, status]
		);
	}

	await insertDay(pageMain, D_ACCEPTED_1, 'accepted');
	await insertDay(pageMain, D_ACCEPTED_2, 'accepted');
	await insertDay(pageMain, D_PENDING, 'pending');
	await insertDay(pageMain, D_IN_PROGRESS, 'in_progress');
	await insertDay(pageMain, D_FLAGGED, 'flagged');
	await insertDay(pageAliasTag, D_ALIAS, 'accepted');
	await insertDay(pageAliasTag, D_TAG, 'accepted');
	await insertDay(pageBefore, D_BEFORE, 'accepted');
	await insertDay(pageAfter, D_AFTER, 'accepted');

	// Entity alias pair: canonical "Ask Test Canonical" <- alias "Ask Test Alias".
	await pool.query(`DELETE FROM entities WHERE slug LIKE 'ask-test-%' AND entity_type = 'person'`);
	const canonRes = await pool.query(
		`INSERT INTO entities (entity_type, slug, display_name) VALUES ('person', 'ask-test-canonical', 'Ask Test Canonical') RETURNING id`
	);
	const canonicalId = canonRes.rows[0].id;
	const aliasRes = await pool.query(
		`INSERT INTO entities (entity_type, slug, display_name, alias_of_entity_id)
		 VALUES ('person', 'ask-test-alias', 'Ask Test Alias', $1) RETURNING id`,
		[canonicalId]
	);
	const aliasId = aliasRes.rows[0].id;

	const aliasDayRes = await pool.query(`SELECT id FROM calendar_days WHERE entry_date = $1`, [D_ALIAS]);
	await pool.query(
		`INSERT INTO day_entities (day_id, entity_id, source, confidence_score) VALUES ($1, $2, 'ai', 0.9)`,
		[aliasDayRes.rows[0].id, aliasId]
	);

	const tagDayRes = await pool.query(`SELECT id FROM calendar_days WHERE entry_date = $1`, [D_TAG]);
	await pool.query(
		`INSERT INTO day_tags (day_id, tag_slug, tag_label, source) VALUES ($1, $2, $3, 'human')`,
		[tagDayRes.rows[0].id, TAG_SLUG, TAG_LABEL]
	);

	return { pageMain, pageBefore, pageAfter, pageAliasTag, canonicalId, aliasId };
}

async function cleanupMainFixture(pool, fx) {
	const allDates = [D_ACCEPTED_1, D_ACCEPTED_2, D_PENDING, D_IN_PROGRESS, D_FLAGGED, D_ALIAS, D_TAG, D_BEFORE, D_AFTER];
	await pool.query(`DELETE FROM day_entities WHERE day_id IN (SELECT id FROM calendar_days WHERE entry_date = ANY($1::date[]))`, [allDates]);
	await pool.query(`DELETE FROM day_tags WHERE day_id IN (SELECT id FROM calendar_days WHERE entry_date = ANY($1::date[]))`, [allDates]);
	await pool.query(`DELETE FROM calendar_days WHERE entry_date = ANY($1::date[])`, [allDates]);
	if (fx) {
		await pool.query(`DELETE FROM entities WHERE id = ANY($1::int[])`, [[fx.canonicalId, fx.aliasId]]);
		await pool.query(`DELETE FROM calendar_pages WHERE id = ANY($1::int[])`, [
			[fx.pageMain, fx.pageBefore, fx.pageAfter, fx.pageAliasTag]
		]);
	}
}

async function provisionCapFixture(pool) {
	await pool.query(
		`INSERT INTO calendar_pages (year, month, page_image_path, capture_session)
		 SELECT DISTINCT EXTRACT(YEAR FROM d)::int, EXTRACT(MONTH FROM d)::int,
		        'fixtures/ask-test/cap-page.jpg', $3
		   FROM generate_series($1::date, $2::date, '1 day'::interval) d
		 ON CONFLICT (year, month) DO NOTHING`,
		[CAP_RANGE_START, CAP_RANGE_END, CAPTURE_SESSION]
	);
	await pool.query(
		`INSERT INTO calendar_days (page_id, entry_date, corrected_text, correction_status)
		 SELECT cp.id, d::date, $3, 'accepted'
		   FROM generate_series($1::date, $2::date, '1 day'::interval) d
		   JOIN calendar_pages cp
		     ON cp.year = EXTRACT(YEAR FROM d)::int AND cp.month = EXTRACT(MONTH FROM d)::int
		 ON CONFLICT (entry_date) DO NOTHING`,
		[CAP_RANGE_START, CAP_RANGE_END, `${MARKER} cap test day`]
	);
	const countRes = await pool.query(
		`SELECT COUNT(*)::int AS total FROM calendar_days WHERE entry_date BETWEEN $1::date AND $2::date`,
		[CAP_RANGE_START, CAP_RANGE_END]
	);
	return countRes.rows[0].total;
}

async function cleanupCapFixture(pool) {
	await pool.query(`DELETE FROM calendar_days WHERE entry_date BETWEEN $1::date AND $2::date`, [
		CAP_RANGE_START,
		CAP_RANGE_END
	]);
	await pool.query(`DELETE FROM calendar_pages WHERE page_image_path = 'fixtures/ask-test/cap-page.jpg'`);
}

async function countAuditAskRows(pool, question) {
	const res = await pool.query(
		`SELECT COUNT(*)::int AS total FROM audit_log WHERE action = 'adhoc_ask' AND description LIKE $1`,
		[`%${question.slice(0, 40)}%`]
	);
	return res.rows[0].total;
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
	let mainFx = null;
	let capProvisioned = false;
	let savedNarrativeId = null;
	try {
		try {
			await fetch(`${BASE_URL}/api/health`);
		} catch (err) {
			console.error(`ERROR: could not reach ${BASE_URL} — start the dev server first:`);
			console.error('  MADONNAHIST_LLM_STUB=1 npx vite dev --host 127.0.0.1 --port 5177 --strictPort --mode test');
			throw err;
		}

		ids = await provisionUsers(pool);
		mainFx = await provisionMainFixture(pool);
		const capTotal = await provisionCapFixture(pool);
		capProvisioned = true;

		const adminCookie = await login(ADMIN_USERNAME, TEST_PASSWORD);
		const viewerCookie = await login(VIEWER_USERNAME, TEST_PASSWORD);

		// ── Auth matrix: /admin/ask GET+POST across roles ───────────────────
		{
			const res = await fetchNoRedirect(`${BASE_URL}/admin/ask`);
			record('GET /admin/ask [unauthenticated]', res.status === 303, `expected 303, got ${res.status}`);
		}
		{
			const res = await fetchNoRedirect(`${BASE_URL}/admin/ask?/ask`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: ''
			});
			record('POST /admin/ask?/ask [unauthenticated]', res.status === 401, `expected 401, got ${res.status}`);
		}
		{
			const res = await fetchNoRedirect(`${BASE_URL}/admin/ask`, { headers: { Cookie: viewerCookie } });
			record('GET /admin/ask [viewer]', res.status === 403, `expected 403, got ${res.status}`);
		}
		{
			const res = await fetchNoRedirect(`${BASE_URL}/admin/ask?/ask`, {
				method: 'POST',
				headers: { Cookie: viewerCookie, 'Content-Type': 'application/x-www-form-urlencoded' },
				body: 'question=test'
			});
			record('POST /admin/ask?/ask [viewer]', res.status === 403, `expected 403, got ${res.status}`);
		}
		{
			const res = await fetchNoRedirect(`${BASE_URL}/admin/ask`, { headers: { Cookie: adminCookie } });
			record('GET /admin/ask [admin]', res.status === 200, `expected 200, got ${res.status}`);
		}

		// ── Year range only includes accepted days in range; pending/
		//    in_progress/flagged are never included ──────────────────────────
		{
			const { status, envelope } = await postAction(
				'/admin/ask?/ask',
				{ question: `${MARKER} year range test`, yearFrom: MAIN_YEAR, yearTo: MAIN_YEAR },
				adminCookie
			);
			const askResult = envelope?.type === 'success' ? envelope.data?.askResult : null;
			record(
				'year-range ask succeeds (stub mode reachable)',
				status === 200 && envelope?.type === 'success' && askResult,
				`status ${status}, envelope type ${envelope?.type}, error ${JSON.stringify(envelope?.data)}`
			);
			record(
				'year-range subset excludes pending/in_progress/flagged and out-of-range accepted days (dayCount=2)',
				askResult?.dayCount === 2,
				`got dayCount=${askResult?.dayCount}`
			);
		}

		// ── Entity filter is alias-resolved ──────────────────────────────────
		// (D_ALIAS lives in ALIAS_TAG_YEAR, not MAIN_YEAR — no year filter here
		// so this test is independent of the year-range test's fixture.)
		{
			const { status, envelope } = await postAction(
				'/admin/ask?/ask',
				{
					question: `${MARKER} entity alias test`,
					entityId: mainFx.canonicalId
				},
				adminCookie
			);
			const askResult = envelope?.type === 'success' ? envelope.data?.askResult : null;
			record(
				'entity filter (canonical id) matches a day linked only to its alias',
				status === 200 && askResult?.dayCount === 1,
				`status ${status}, dayCount=${askResult?.dayCount}, data=${JSON.stringify(envelope?.data)}`
			);
		}

		// ── Tag filter narrows correctly ──────────────────────────────────────
		{
			const { status, envelope } = await postAction(
				'/admin/ask?/ask',
				{ question: `${MARKER} tag filter test`, tagSlug: TAG_SLUG },
				adminCookie
			);
			const askResult = envelope?.type === 'success' ? envelope.data?.askResult : null;
			record(
				'tag filter matches exactly the tagged day',
				status === 200 && askResult?.dayCount === 1,
				`status ${status}, dayCount=${askResult?.dayCount}`
			);
		}

		// ── Over-365-day subset: narrow-please failure, LLM never called ────
		{
			const capQuestion = `${MARKER} over cap test`;
			const auditBefore = await countAuditAskRows(pool, capQuestion);
			const { status, envelope } = await postAction(
				'/admin/ask?/ask',
				{ question: capQuestion, yearFrom: CAP_YEAR_FROM, yearTo: CAP_YEAR_TO },
				adminCookie
			);
			// Note: SvelteKit's JSON action protocol (Accept: application/json,
			// what use:enhance sends) always responds with a real HTTP 200 for a
			// fail()'d action — the intended status (413 here) travels inside the
			// parsed envelope as envelope.status, not as the transport-level HTTP
			// status. Confirmed against @sveltejs/kit's
			// src/runtime/server/page/actions.js: action_json() is called with no
			// {status} init for the ActionFailure branch, only for the thrown-error
			// branch (e.g. requireAdmin()'s error(403, ...), which DOES get a real
			// HTTP 403 — see the viewer/unauthenticated checks above, which rely on
			// exactly that and use Accept: text/html besides).
			const errorMsg = envelope?.type === 'failure' ? envelope.data?.error : null;
			record(
				'over-cap subset returns a failure naming the day count, not a narrative',
				status === 200 &&
					envelope?.type === 'failure' &&
					envelope.status === 413 &&
					typeof errorMsg === 'string' &&
					errorMsg.includes(String(capTotal)),
				`status ${status}, envelope.status ${envelope?.status}, type ${envelope?.type}, error ${JSON.stringify(errorMsg)}, expected count ${capTotal}`
			);
			const auditAfter = await countAuditAskRows(pool, capQuestion);
			record(
				'over-cap subset never reaches the LLM/audit step (no adhoc_ask audit row written)',
				auditAfter === auditBefore,
				`before=${auditBefore}, after=${auditAfter}`
			);
		}

		// ── 0-day subset: friendly failure ───────────────────────────────────
		{
			const { status, envelope } = await postAction(
				'/admin/ask?/ask',
				{ question: `${MARKER} zero day test`, yearFrom: ZERO_YEAR, yearTo: ZERO_YEAR },
				adminCookie
			);
			record(
				'0-day subset returns a friendly failure',
				status === 200 &&
					envelope?.type === 'failure' &&
					envelope.status === 404 &&
					typeof envelope.data?.error === 'string',
				`status ${status}, envelope.status ${envelope?.status}, type ${envelope?.type}, error ${JSON.stringify(envelope?.data)}`
			);
		}

		// ── save -> list -> delete round trip ────────────────────────────────
		let saveFields = null;
		{
			const { status, envelope } = await postAction(
				'/admin/ask?/ask',
				{ question: SAVE_QUESTION, yearFrom: MAIN_YEAR, yearTo: MAIN_YEAR },
				adminCookie
			);
			const askResult = envelope?.type === 'success' ? envelope.data?.askResult : null;
			record('ask for save-flow succeeds', status === 200 && askResult, `status ${status}`);
			if (askResult) {
				saveFields = {
					question: askResult.question,
					narrativeText: askResult.narrativeText,
					modelName: askResult.modelName,
					dayCount: askResult.dayCount,
					subsetDefinition: JSON.stringify(askResult.subsetDefinition)
				};
			}
		}
		if (saveFields) {
			const { status, envelope } = await postAction('/admin/ask?/save', saveFields, adminCookie);
			record('save action succeeds', status === 200 && envelope?.type === 'success', `status ${status}, ${JSON.stringify(envelope)}`);

			const dbRow = await pool.query(
				`SELECT id, question, day_count, model_name FROM adhoc_narratives WHERE question = $1`,
				[SAVE_QUESTION]
			);
			record(
				'saved row exists in adhoc_narratives with correct fields',
				dbRow.rows.length === 1 && dbRow.rows[0].day_count === saveFields.dayCount,
				`got ${JSON.stringify(dbRow.rows[0])}`
			);
			savedNarrativeId = dbRow.rows[0]?.id ?? null;

			const listRes = await fetchNoRedirect(`${BASE_URL}/admin/ask`, { headers: { Cookie: adminCookie } });
			const listBody = await listRes.text();
			record(
				'saved answer appears in the rendered saved-answers list',
				listRes.status === 200 && listBody.includes(SAVE_QUESTION),
				`status ${listRes.status}, present=${listBody.includes(SAVE_QUESTION)}`
			);

			if (savedNarrativeId) {
				const { status: delStatus, envelope: delEnvelope } = await postAction(
					'/admin/ask?/delete',
					{ id: savedNarrativeId },
					adminCookie
				);
				record('delete action succeeds', delStatus === 200 && delEnvelope?.type === 'success', `status ${delStatus}`);

				const dbRowAfter = await pool.query(`SELECT id FROM adhoc_narratives WHERE id = $1`, [savedNarrativeId]);
				record('deleted row is gone from adhoc_narratives', dbRowAfter.rows.length === 0, `rows left: ${dbRowAfter.rows.length}`);

				const listAfterRes = await fetchNoRedirect(`${BASE_URL}/admin/ask`, { headers: { Cookie: adminCookie } });
				const listAfterBody = await listAfterRes.text();
				record(
					'deleted answer no longer appears in the rendered list',
					listAfterRes.status === 200 && !listAfterBody.includes(SAVE_QUESTION),
					`present after delete=${listAfterBody.includes(SAVE_QUESTION)}`
				);
				savedNarrativeId = null;
			}
		}

		console.log('\nAsk the archive results:\n');
		const width = Math.max(...rows.map((r) => r.label.length)) + 2;
		for (const r of rows) {
			const mark = r.ok ? 'PASS' : 'FAIL';
			console.log(`${mark}  ${r.label.padEnd(width)} ${r.detail}`);
		}
		console.log(`\n${pass} passed, ${fail} failed (${rows.length} total)`);

		if (fail > 0) process.exitCode = 1;
	} finally {
		if (savedNarrativeId) {
			await pool.query(`DELETE FROM adhoc_narratives WHERE id = $1`, [savedNarrativeId]).catch(() => {});
		}
		await pool.query(`DELETE FROM adhoc_narratives WHERE question = $1`, [SAVE_QUESTION]).catch(() => {});
		if (capProvisioned) await cleanupCapFixture(pool);
		await cleanupMainFixture(pool, mainFx);
		await cleanupUsers(pool, ids);
		await pool.end();
	}
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
