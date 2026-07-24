#!/usr/bin/env node
// Correction-editor workflow test for td-b52a49 (auto-save, accept-draft,
// history, session lifecycle) + td-c51cdb (AI tag suggestions).
//
// Runs against a dev server already started on the isolated test stack:
//   npx vite dev --host 127.0.0.1 --port 5177 --strictPort --mode test
//
// Self-provisions one throwaway corrector user plus a dedicated
// calendar_pages row and several calendar_days fixtures directly in
// madonnahist_test (127.0.0.1:15434), drives real HTTP requests against the
// running server, and cleans up in a finally block. Never touches port
// 5433/5435 or PGDATABASE=madonnahist — see requireTestSafety() below.
//
// What this asserts:
//   - ?/autosave inserts an in_progress day_corrections row on a pending day
//   - SAFETY GATE: ?/autosave on an already-'accepted' day inserts NO new
//     day_corrections row and never flips calendar_days.correction_status
//     away from 'accepted' (see backend/db/migrations/0005_triggers.sql's
//     trg_fn_after_correction_insert — it has no such guard itself, so the
//     guard has to live in the ?/autosave action)
//   - ?/autosave still updates day_narrative directly on an accepted day
//     (that column isn't part of the human-truth invariant)
//   - ?/acceptDraft saves the machine draft verbatim as an accepted
//     correction and advances to the next uncorrected day
//   - the history endpoint returns all three run types, newest first
//   - "Done for now" (?/pause) pauses the active correction_sessions row and
//     redirects to /correct/session-done?session=<id>, whose corrected-count
//     matches day_corrections accepted-by-this-user-since-started_at
//   - a paused session is still picked up by getUserResume() (GET /correct
//     shows a resume link) and re-claiming the month flips it back to active
//   - ?/acceptTag flips an AI tag's source to 'human' and it survives a
//     simulated re-extraction DELETE ... WHERE source='ai'
//   - ?/removeTag (used as "Dismiss") deletes an AI tag outright
//
// Usage: node scripts/test-correction-workflow.mjs [baseUrl]
//   (or: npm run test:correction-workflow)

import argon2 from 'argon2';
import pg from 'pg';
import * as devalue from 'devalue';
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
const TEST_PASSWORD = 'CorrectionWorkflowTest!2026';
const USERNAME = '_correctionflow_corrector';
const DISPLAY_NAME = 'Correction Workflow Test';

const ARGON2_OPTS = {
	type: argon2.argon2id,
	memoryCost: 19456,
	timeCost: 2,
	parallelism: 1
};

// Distinctive markers, same convention as scripts/test-viewer-security.mjs.
const MARKER = 'ZQXPLWORKFLOW';
const FIXTURE_YEAR = 1896;
const FIXTURE_MONTH = 4;
const CAPTURE_SESSION = '_correction_workflow_test';

const DAY_AUTOSAVE = '1896-04-05';
const DAY_ACCEPTED = '1896-04-06';
const DAY_DRAFT = '1896-04-07';
const DAY_TAGS = '1896-04-08';
const DAY_SESSION_1 = '1896-04-09';
const DAY_SESSION_2 = '1896-04-10';
// Stays pending/untouched for the whole test — without a pending day after
// DAY_SESSION_2, saving it would make ?/save's nextUncorrectedDate() (which
// is global, not month-scoped) come back null and auto-complete the session
// (see completeSession() in +page.server.ts's ?/save) before the explicit
// ?/pause test below gets to run.
const DAY_TRAILING_PENDING = '1896-04-11';

const TAG_ACCEPT_SLUG = `${MARKER.toLowerCase()}-accept-tag`;
const TAG_ACCEPT_LABEL = `${MARKER} Accept Tag`;
const TAG_DISMISS_SLUG = `${MARKER.toLowerCase()}-dismiss-tag`;
const TAG_DISMISS_LABEL = `${MARKER} Dismiss Tag`;
const TAG_REEXTRACT_SLUG = `${MARKER.toLowerCase()}-reextract-tag`;
const TAG_REEXTRACT_LABEL = `${MARKER} Reextract Tag`;

let pass = 0;
let fail = 0;
const rows = [];

function record(label, ok, detail) {
	if (ok) pass++;
	else fail++;
	rows.push({ label, ok, detail });
}

// Mirrors scripts/test-viewer-security.mjs / test-auth-matrix.mjs.
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

// A plain, non-`use:enhance` POST to a form action — like the real
// ?/autosave fetch() in +page.svelte, this omits any Accept override so
// SvelteKit treats it as a JSON action request (see
// is_action_json_request()) and returns the ActionResult envelope directly,
// no `redirect: 'manual'` dance needed.
async function postAction(pathAndAction, cookie, formFields) {
	const body = new URLSearchParams(formFields ?? {});
	const res = await fetch(`${BASE_URL}${pathAndAction}`, {
		method: 'POST',
		headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
		body: body.toString()
	});
	const text = await res.text();
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error(`non-JSON response from ${pathAndAction}: ${res.status} ${text.slice(0, 300)}`);
	}
	// Mirror $app/forms's deserialize(): the ActionResult envelope's `data`
	// field is devalue-encoded (not plain JSON) so it can carry types JSON
	// can't (Date, Map, etc.) — a bare JSON.parse leaves it as devalue's
	// wire format (an array of [flattened-object, ...values]), not the
	// original object.
	if (parsed.data) parsed.data = devalue.parse(parsed.data);
	return { status: res.status, result: parsed };
}

async function provisionUser(pool) {
	const passwordHash = await argon2.hash(TEST_PASSWORD, ARGON2_OPTS);
	const res = await pool.query(
		`INSERT INTO users (username, display_name, role, password_hash)
		 VALUES ($1, $2, 'corrector', $3)
		 ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, display_name = EXCLUDED.display_name
		 RETURNING id`,
		[USERNAME, DISPLAY_NAME, passwordHash]
	);
	return res.rows[0].id;
}

// Split in two because the FK ordering constraints point in opposite
// directions: correction_sessions.current_day_id -> calendar_days(id) must
// be cleared BEFORE cleanupFixtures deletes calendar_days, but
// calendar_days.corrected_by -> users(id) means the users row can only be
// deleted AFTER those calendar_days rows are gone. See the call site in
// main()'s finally block for the required order.
async function cleanupUserSessions(pool, userId) {
	if (!userId) return;
	await pool.query(`DELETE FROM correction_sessions WHERE user_id = $1`, [userId]);
}

async function cleanupUserAccount(pool, userId) {
	if (!userId) return;
	await pool.query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
	// audit_log.user_id REFERENCES users(id) with no ON DELETE action (see
	// scripts/test-ask.mjs / test-pdf-export.mjs's own cleanup for the same
	// pattern) — the acceptTag/removeTag/addTag actions this test exercises
	// all write an audit_log row, so it must go before the users delete.
	await pool.query(`DELETE FROM audit_log WHERE user_id = $1`, [userId]);
	await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
}

async function provisionFixtures(pool) {
	await pool.query(
		`INSERT INTO calendar_pages (year, month, page_image_path, capture_session)
		 VALUES ($1, $2, $3, $4)
		 ON CONFLICT (year, month) DO NOTHING`,
		[FIXTURE_YEAR, FIXTURE_MONTH, 'fixtures/correction-workflow-test/fake-page.jpg', CAPTURE_SESSION]
	);
	const pageRes = await pool.query(`SELECT id FROM calendar_pages WHERE year = $1 AND month = $2`, [FIXTURE_YEAR, FIXTURE_MONTH]);
	const pageId = pageRes.rows[0].id;

	const allDates = [DAY_AUTOSAVE, DAY_ACCEPTED, DAY_DRAFT, DAY_TAGS, DAY_SESSION_1, DAY_SESSION_2, DAY_TRAILING_PENDING];
	await pool.query(`DELETE FROM calendar_days WHERE entry_date = ANY($1::date[])`, [allDates]);

	const dayIds = {};
	for (const date of allDates) {
		const res = await pool.query(
			`INSERT INTO calendar_days (page_id, entry_date) VALUES ($1, $2) RETURNING id`,
			[pageId, date]
		);
		dayIds[date] = res.rows[0].id;
	}

	// DAY_DRAFT gets an ocr_run + llm_draft_run so ?/acceptDraft and the
	// history endpoint have real machine output to work with. No manual
	// UPDATE of calendar_days.latest_ocr_run_id/latest_llm_draft_run_id here
	// — those columns are in 0004_grants_rls.sql's REVOKE list for
	// madonnahist_app (trigger-only, per the human-truth invariant); the
	// 0005 triggers trg_after_ocr_run_insert / trg_after_llm_draft_insert set
	// them automatically as a side effect of these INSERTs.
	const ocrRes = await pool.query(
		`INSERT INTO ocr_runs (day_id, vendor, source_image_path, raw_text, confidence_score)
		 VALUES ($1, 'claude-vision', 'fixtures/correction-workflow-test/fake.jpg', $2, 0.7)
		 RETURNING id`,
		[dayIds[DAY_DRAFT], `${MARKER} raw OCR text.`]
	);
	await pool.query(
		`INSERT INTO llm_draft_runs (day_id, based_on_ocr_run_id, model_name, prompt_version, draft_text)
		 VALUES ($1, $2, 'claude-test-stub', 'v1', $3)`,
		[dayIds[DAY_DRAFT], ocrRes.rows[0].id, `${MARKER} machine draft text.`]
	);

	// DAY_TAGS gets three AI-sourced tags for the accept/dismiss/re-extraction
	// tests.
	for (const [slug, label] of [
		[TAG_ACCEPT_SLUG, TAG_ACCEPT_LABEL],
		[TAG_DISMISS_SLUG, TAG_DISMISS_LABEL],
		[TAG_REEXTRACT_SLUG, TAG_REEXTRACT_LABEL]
	]) {
		await pool.query(
			`INSERT INTO day_tags (day_id, tag_slug, tag_label, source) VALUES ($1, $2, $3, 'ai')`,
			[dayIds[DAY_TAGS], slug, label]
		);
	}

	return { pageId, dayIds };
}

async function cleanupFixtures(pool, pageId) {
	if (!pageId) return;
	await pool.query(`DELETE FROM job_runs WHERE (payload->>'day_id')::int IN (SELECT id FROM calendar_days WHERE page_id = $1)`, [pageId]);
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

	let userId;
	let pageId;
	try {
		try {
			await fetch(`${BASE_URL}/api/health`);
		} catch (err) {
			console.error(`ERROR: could not reach ${BASE_URL} — start the dev server first:`);
			console.error('  npx vite dev --host 127.0.0.1 --port 5177 --strictPort --mode test');
			throw err;
		}

		userId = await provisionUser(pool);
		// Test hygiene, isolated-DB-only: clear any stray correction_sessions
		// rows left behind by a previous crashed run of this same fixture user
		// before the session-lifecycle checks below, matching the same
		// defensive cleanup scripts/test-enrichment.mjs does for job_runs.
		await pool.query(`DELETE FROM correction_sessions WHERE user_id = $1`, [userId]);
		const fixtures = await provisionFixtures(pool);
		pageId = fixtures.pageId;
		const { dayIds } = fixtures;

		const cookie = await login(USERNAME, TEST_PASSWORD);

		// ── Autosave: pending day inserts an in_progress day_corrections row ──
		{
			const beforeCount = await pool.query(`SELECT COUNT(*)::int AS n FROM day_corrections WHERE day_id = $1`, [dayIds[DAY_AUTOSAVE]]);
			const { status, result } = await postAction(`/correct/day/${DAY_AUTOSAVE}?/autosave`, cookie, {
				correctedText: `${MARKER} autosave draft text.`
			});
			const afterCount = await pool.query(`SELECT COUNT(*)::int AS n FROM day_corrections WHERE day_id = $1`, [dayIds[DAY_AUTOSAVE]]);
			const statusRes = await pool.query(`SELECT correction_status FROM calendar_days WHERE id = $1`, [dayIds[DAY_AUTOSAVE]]);
			const inserted = afterCount.rows[0].n === beforeCount.rows[0].n + 1;
			const statusFlipped = statusRes.rows[0].correction_status === 'in_progress';
			record('?/autosave on a pending day inserts one in_progress day_corrections row', status === 200 && result.type === 'success' && inserted,
				`status ${status}, type ${result.type}, before ${beforeCount.rows[0].n}, after ${afterCount.rows[0].n}`);
			record('?/autosave on a pending day sets correction_status=in_progress (per 0005 trigger, expected)', statusFlipped,
				`got ${statusRes.rows[0].correction_status}`);
		}

		// ── SAFETY GATE: autosave must never knock an accepted day back ────
		{
			// Accept the day for real first via ?/save.
			await postAction(`/correct/day/${DAY_ACCEPTED}?/save`, cookie, {
				correctedText: `${MARKER} originally accepted text.`,
				dayNarrative: '',
				pageLoadedAt: new Date().toISOString()
			});
			const acceptedCheck = await pool.query(`SELECT correction_status, corrected_text FROM calendar_days WHERE id = $1`, [dayIds[DAY_ACCEPTED]]);
			record('fixture setup: DAY_ACCEPTED really is accepted before the safety-gate check', acceptedCheck.rows[0].correction_status === 'accepted',
				`got ${JSON.stringify(acceptedCheck.rows[0])}`);

			const beforeCount = await pool.query(`SELECT COUNT(*)::int AS n FROM day_corrections WHERE day_id = $1`, [dayIds[DAY_ACCEPTED]]);

			const { status, result } = await postAction(`/correct/day/${DAY_ACCEPTED}?/autosave`, cookie, {
				correctedText: `${MARKER} an autosave attempt that must be suppressed.`
			});

			const afterCount = await pool.query(`SELECT COUNT(*)::int AS n FROM day_corrections WHERE day_id = $1`, [dayIds[DAY_ACCEPTED]]);
			const afterStatus = await pool.query(`SELECT correction_status, corrected_text FROM calendar_days WHERE id = $1`, [dayIds[DAY_ACCEPTED]]);

			const noNewRow = afterCount.rows[0].n === beforeCount.rows[0].n;
			const stillAccepted = afterStatus.rows[0].correction_status === 'accepted';
			const textUnchanged = afterStatus.rows[0].corrected_text === acceptedCheck.rows[0].corrected_text;

			record('SAFETY GATE: ?/autosave on an already-accepted day inserts NO new day_corrections row', status === 200 && noNewRow,
				`status ${status}, day_corrections count before ${beforeCount.rows[0].n} after ${afterCount.rows[0].n}`);
			record('SAFETY GATE: ?/autosave on an already-accepted day never flips correction_status away from accepted', stillAccepted,
				`got correction_status=${afterStatus.rows[0].correction_status}`);
			record('SAFETY GATE: ?/autosave on an already-accepted day leaves corrected_text untouched', textUnchanged,
				`got ${JSON.stringify(afterStatus.rows[0].corrected_text)}`);
			record('?/autosave response reports suppressed:true on an already-accepted day', result.data?.suppressed === true,
				`got ${JSON.stringify(result.data)}`);

			// Narrative-only autosave must still work on an accepted day — that
			// column isn't part of the human-truth invariant.
			const { status: narrStatus, result: narrResult } = await postAction(`/correct/day/${DAY_ACCEPTED}?/autosave`, cookie, {
				dayNarrative: `${MARKER} narrative autosave on an accepted day.`
			});
			const narrCheck = await pool.query(`SELECT day_narrative, correction_status FROM calendar_days WHERE id = $1`, [dayIds[DAY_ACCEPTED]]);
			record('?/autosave still updates day_narrative directly on an accepted day', narrStatus === 200 && narrResult.type === 'success' &&
				narrCheck.rows[0].day_narrative === `${MARKER} narrative autosave on an accepted day.` && narrCheck.rows[0].correction_status === 'accepted',
				`got ${JSON.stringify(narrCheck.rows[0])}`);
		}

		// ── Accept Draft ─────────────────────────────────────────────────────
		{
			const res = await fetchNoRedirect(`${BASE_URL}/correct/day/${DAY_DRAFT}?/acceptDraft`, {
				method: 'POST',
				headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
				body: ''
			});
			const isRedirect = res.status === 303;
			const dayCheck = await pool.query(`SELECT correction_status, corrected_text FROM calendar_days WHERE id = $1`, [dayIds[DAY_DRAFT]]);
			const correctionCheck = await pool.query(
				`SELECT status_after, corrected_text, source_llm_draft_run_id FROM day_corrections
				  WHERE day_id = $1 ORDER BY created_at DESC LIMIT 1`, [dayIds[DAY_DRAFT]]
			);
			record('?/acceptDraft redirects (303)', isRedirect, `expected 303, got ${res.status}`);
			record('?/acceptDraft saves the machine draft verbatim as accepted', dayCheck.rows[0].correction_status === 'accepted' &&
				dayCheck.rows[0].corrected_text === `${MARKER} machine draft text.`,
				`got ${JSON.stringify(dayCheck.rows[0])}`);
			record('?/acceptDraft records source_llm_draft_run_id on the day_corrections row', correctionCheck.rows[0].status_after === 'accepted' &&
				correctionCheck.rows[0].source_llm_draft_run_id !== null,
				`got ${JSON.stringify(correctionCheck.rows[0])}`);
		}

		// ── History endpoint ─────────────────────────────────────────────────
		{
			const res = await fetch(`${BASE_URL}/correct/day/${DAY_DRAFT}/history`, { headers: { Cookie: cookie } });
			const body = await res.json();
			const hasOcr = body.ocrRuns?.length === 1 && body.ocrRuns[0].raw_text === `${MARKER} raw OCR text.`;
			const hasLlm = body.llmDraftRuns?.length === 1 && body.llmDraftRuns[0].draft_text === `${MARKER} machine draft text.`;
			const hasCorrection = body.corrections?.length === 1 && body.corrections[0].status_after === 'accepted' &&
				body.corrections[0].display_name === DISPLAY_NAME;
			record('GET history endpoint returns ocr_runs', res.status === 200 && hasOcr, `got ${JSON.stringify(body.ocrRuns)}`);
			record('GET history endpoint returns llm_draft_runs', hasLlm, `got ${JSON.stringify(body.llmDraftRuns)}`);
			record('GET history endpoint returns day_corrections with editor display_name', hasCorrection, `got ${JSON.stringify(body.corrections)}`);
		}

		// ── Tag accept / dismiss / simulated re-extraction ──────────────────
		{
			const dayId = dayIds[DAY_TAGS];

			const acceptRes = await postAction(`/correct/day/${DAY_TAGS}?/acceptTag`, cookie, { tagSlug: TAG_ACCEPT_SLUG });
			const afterAccept = await pool.query(`SELECT source FROM day_tags WHERE day_id = $1 AND tag_slug = $2`, [dayId, TAG_ACCEPT_SLUG]);
			record('?/acceptTag flips an AI tag to source=human', acceptRes.status === 200 && afterAccept.rows[0]?.source === 'human',
				`status ${acceptRes.status}, got ${JSON.stringify(afterAccept.rows[0])}`);

			const dismissRes = await postAction(`/correct/day/${DAY_TAGS}?/removeTag`, cookie, { tagSlug: TAG_DISMISS_SLUG });
			const afterDismiss = await pool.query(`SELECT 1 FROM day_tags WHERE day_id = $1 AND tag_slug = $2`, [dayId, TAG_DISMISS_SLUG]);
			record('?/removeTag ("Dismiss") deletes an AI tag outright', dismissRes.status === 200 && afterDismiss.rows.length === 0,
				`status ${dismissRes.status}, rows remaining ${afterDismiss.rows.length}`);

			// Simulate the enrichment worker's re-extraction wholesale replace:
			// DELETE FROM day_tags WHERE day_id = ... AND source = 'ai'.
			// TAG_REEXTRACT_SLUG is still source='ai' at this point (never
			// touched) — it must be deleted by this, proving the DELETE is a
			// real, effective simulation and not a no-op.
			await pool.query(`DELETE FROM day_tags WHERE day_id = $1 AND source = 'ai'`, [dayId]);

			const afterReextract = await pool.query(`SELECT tag_slug, source FROM day_tags WHERE day_id = $1 ORDER BY tag_slug`, [dayId]);
			const acceptedSurvived = afterReextract.rows.some((r) => r.tag_slug === TAG_ACCEPT_SLUG && r.source === 'human');
			const reextractGone = !afterReextract.rows.some((r) => r.tag_slug === TAG_REEXTRACT_SLUG);
			record('accepted (now human) tag survives a simulated re-extraction DELETE source=\'ai\'', acceptedSurvived,
				`got ${JSON.stringify(afterReextract.rows)}`);
			record('an untouched AI tag IS removed by the simulated re-extraction (proves the DELETE is real)', reextractGone,
				`got ${JSON.stringify(afterReextract.rows)}`);
		}

		// ── Session lifecycle: pause -> summary -> resume ───────────────────
		{
			const monthKey = `${FIXTURE_YEAR}-${String(FIXTURE_MONTH).padStart(2, '0')}`;

			// Claim the month (GET auto-claims for this user).
			await fetchNoRedirect(`${BASE_URL}/correct/month/${monthKey}`, { headers: { Cookie: cookie } });
			const claimCheck = await pool.query(
				`SELECT id, status, started_at FROM correction_sessions WHERE user_id = $1 AND status = 'active' ORDER BY id DESC LIMIT 1`,
				[userId]
			);
			record('GET /correct/month/<key> auto-claims an active session', claimCheck.rows.length === 1, `got ${JSON.stringify(claimCheck.rows)}`);
			const sessionStartedAt = claimCheck.rows[0].started_at;

			// Accept two days in this sitting.
			await postAction(`/correct/day/${DAY_SESSION_1}?/save`, cookie, {
				correctedText: `${MARKER} session day 1.`, dayNarrative: '', pageLoadedAt: new Date().toISOString()
			});
			await postAction(`/correct/day/${DAY_SESSION_2}?/save`, cookie, {
				correctedText: `${MARKER} session day 2.`, dayNarrative: '', pageLoadedAt: new Date().toISOString()
			});
			const acceptedSinceStart = await pool.query(
				`SELECT COUNT(*)::int AS n FROM day_corrections WHERE editor_user_id = $1 AND status_after = 'accepted' AND created_at >= $2`,
				[userId, sessionStartedAt]
			);

			// "Done for now" — pause via the day editor's ?/pause action.
			const pauseRes = await fetchNoRedirect(`${BASE_URL}/correct/day/${DAY_SESSION_2}?/pause`, {
				method: 'POST',
				headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
				body: ''
			});
			const location = pauseRes.headers.get('location') ?? '';
			const pausedSessionId = Number(new URL(location, BASE_URL).searchParams.get('session'));
			record('?/pause redirects to /correct/session-done?session=<id>', pauseRes.status === 303 && Number.isInteger(pausedSessionId) && pausedSessionId > 0,
				`status ${pauseRes.status}, location ${location}`);

			const pausedCheck = await pool.query(`SELECT status FROM correction_sessions WHERE id = $1 AND user_id = $2`, [pausedSessionId, userId]);
			record('?/pause sets the session status to paused', pausedCheck.rows[0]?.status === 'paused', `got ${JSON.stringify(pausedCheck.rows[0])}`);

			// Session summary page shows the right corrected count.
			const summaryRes = await fetchNoRedirect(`${BASE_URL}${location}`, { headers: { Cookie: cookie } });
			const summaryBody = await summaryRes.text();
			const expectedCount = acceptedSinceStart.rows[0].n;
			const hasCorrectCount = summaryBody.includes(`${expectedCount} day`) || summaryBody.includes(`${expectedCount} days`);
			record('GET /correct/session-done shows the correct corrected-day count', summaryRes.status === 200 && hasCorrectCount,
				`expected count ${expectedCount} to appear in body, status ${summaryRes.status}`);

			// A paused session must still be resumable (getUserResume fix).
			const homeRes = await fetchNoRedirect(`${BASE_URL}/correct`, { headers: { Cookie: cookie } });
			const homeBody = await homeRes.text();
			const hasResumeLink = /href="\/correct\/day\//.test(homeBody);
			record('GET /correct still offers a resume link while the session is paused', homeRes.status === 200 && hasResumeLink,
				`status ${homeRes.status}, resume link present: ${hasResumeLink}`);

			// Re-claiming the month flips the paused session back to active.
			await fetchNoRedirect(`${BASE_URL}/correct/month/${monthKey}`, { headers: { Cookie: cookie } });
			const reclaimedCheck = await pool.query(`SELECT status FROM correction_sessions WHERE id = $1`, [pausedSessionId]);
			record('re-visiting the month page flips the paused session back to active (resume works)',
				reclaimedCheck.rows[0]?.status === 'active', `got ${JSON.stringify(reclaimedCheck.rows[0])}`);
		}

		console.log('\nCorrection workflow results:\n');
		const width = Math.max(...rows.map((r) => r.label.length)) + 2;
		for (const r of rows) {
			const mark = r.ok ? 'PASS' : 'FAIL';
			console.log(`${mark}  ${r.label.padEnd(width)} ${r.detail}`);
		}
		console.log(`\n${pass} passed, ${fail} failed (${rows.length} total)`);

		if (fail > 0) process.exitCode = 1;
	} finally {
		// Order matters both ways: correction_sessions.current_day_id ->
		// calendar_days(id) has no ON DELETE action, so sessions must be
		// cleared before calendar_days; but calendar_days.corrected_by ->
		// users(id) means the users row can't go until AFTER calendar_days is
		// gone. Sessions -> fixtures -> account is the only order that works.
		await cleanupUserSessions(pool, userId);
		await cleanupFixtures(pool, pageId);
		await cleanupUserAccount(pool, userId);
		await pool.end();
	}
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
