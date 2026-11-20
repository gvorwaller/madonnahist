#!/usr/bin/env node
// Year-narrative end-to-end test: Phase E of
// docs/2026-07-21-next-phases-search-viewer-narrative-plan.md, reworked for
// td-f1f49b (docs/2026-11-20-narrative-models-guidance-plan.md: several
// models, saved guidance, every draft kept, "Use this" to promote).
//
// Drives the real admin form actions over HTTP as an admin, runs the real
// enrichment worker with MADONNAHIST_LLM_STUB=1 (and _ECHO=1, so each draft
// contains the exact prompt the model would have seen), and checks the
// family viewer as a viewer.
//
// Requires a dev server already running on the isolated test stack:
//   npx vite dev --host 127.0.0.1 --port 5177 --strictPort --mode test
// The server needs no stub env: the admin page never calls an LLM.
//
// Runs entirely against madonnahist_test (127.0.0.1:15434). Self-provisions
// an admin, a viewer, a calendar page and two accepted days for 1901, and
// cleans up in a finally block through the OWNER role: narrative_drafts is
// append-only for the app and worker roles (migration 0033), so only the
// owner can remove test candidates. The house style in app_state is put
// back to what it was before the run.
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
	if (process.env.MADONNAHIST_ENV !== 'test') problems.push('MADONNAHIST_ENV must be "test"');
	if (process.env.PGPORT === '5433' || process.env.PGPORT === '5435') {
		problems.push(`refusing reserved port ${process.env.PGPORT} (5433=BTC-dashboard, 5435=production tunnel)`);
	}
	if (process.env.PGDATABASE === 'madonnahist') problems.push('refusing production database name "madonnahist"');
	if (process.env.PGDATABASE && !process.env.PGDATABASE.endsWith('_test')) {
		problems.push(`PGDATABASE must be a *_test database, got "${process.env.PGDATABASE}"`);
	}
	if (process.env.PGHOST && !['127.0.0.1', 'localhost', '::1'].includes(process.env.PGHOST)) {
		problems.push(`PGHOST must be local, got "${process.env.PGHOST}"`);
	}
	if (process.env.PGPORT !== '15434') problems.push(`PGPORT must be the isolated test port 15434, got "${process.env.PGPORT}"`);
	if (process.env.MADONNAHIST_OBJECT_STORE !== 'local') problems.push('MADONNAHIST_OBJECT_STORE must be "local"');
	if (!process.env.PGDATABASE || !process.env.PGPASSWORD || !process.env.WORKER_PGPASSWORD) {
		problems.push('PGDATABASE/PGPASSWORD/WORKER_PGPASSWORD must be set (copy .env.test.example to .env.test)');
	}
	if (!process.env.MIGRATION_PGPASSWORD) problems.push('MIGRATION_PGPASSWORD must be set in .env.test');
	return problems;
}

const BASE_URL = process.argv[2] ?? 'http://127.0.0.1:5177';
const SESSION_COOKIE_NAME = 'madonnahist_session';
const TEST_PASSWORD = 'NarrativeTest!2026';
const ADMIN = '_narrative_test_admin';
const VIEWER = '_narrative_test_viewer';
const ARGON2_OPTS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };

const OPUS = 'claude-opus-5-5';
const GEMINI = 'gemini-3.1-pro-preview';

// Distinctive markers so a substring check can only mean "this fixture".
const MARKER = 'ZQXPLNARRATIVE';
// Must be >= 1900: /app/year/[year] rejects earlier years.
const YEAR = '1901';
const FIXTURE_MONTH = 6;
const DAY_1 = '1901-06-01';
const DAY_2 = '1901-06-15';
const STYLE = `${MARKER}STYLE keep it short and plain.`;
const NOTES_1 = `${MARKER}NOTES1 Aunt Ruth is Dad's sister.`;
const NOTES_2 = `${MARKER}NOTES2 Emphasize the garden.`;
const NOTES_3 = `${MARKER}NOTES3 edited after queueing.`;
const HAND_EDIT = `${MARKER}HANDEDIT a narrative edited by hand.`;
// Story-only phrases; the fixture days themselves contain MARKER and show on
// the year page, so leak checks look for these instead.
const STUB_A = 'storyalpha first generated narrative';
const STUB_B = 'storybravo comparison narrative';
const STUB_D = 'storydelta written while published';
const GENERATED_LABEL = 'calendar, reviewed before publishing';

let pass = 0;
let fail = 0;
const rows = [];
function record(label, ok, detail = '') {
	if (ok) pass++;
	else fail++;
	rows.push({ label, ok, detail });
}

/**
 * Run the real worker (stubbed LLM) on this suite's own jobs only
 * (--job-ids), until none of the fixture year's jobs is left pending.
 * Other suites' jobs are never claimed or deleted. extraIds adds jobs that
 * the fixture-year query can't see (e.g. a null payload).
 */
async function runWorker(owner, stubText, { extraIds = [], dryRun = false } = {}) {
	for (let i = 0; i < 6; i++) {
		const mine = (await jobs(owner)).filter((j) => j.status === 'pending' || j.status === 'in_progress').map((j) => j.id);
		const ids = [...new Set([...mine, ...extraIds.map(String)])];
		if (ids.length === 0) return;
		const args = ['tsx', 'backend/workers/enrichment-worker.ts', `--job-ids=${ids.join(',')}`];
		if (dryRun) args.push('--dry-run');
		const result = spawnSync('npx', args, {
			cwd: REPO_ROOT,
			encoding: 'utf8',
			env: { ...process.env, MADONNAHIST_LLM_STUB: '1', MADONNAHIST_LLM_STUB_ECHO: '1', MADONNAHIST_LLM_STUB_TEXT: stubText }
		});
		if (result.status !== 0) {
			console.error('Worker stdout:', result.stdout);
			console.error('Worker stderr:', result.stderr);
			throw new Error(`worker exited with status ${result.status}`);
		}
		if (dryRun) return;
		extraIds = [];
	}
	const left = (await jobs(owner)).filter((j) => j.status === 'pending' || j.status === 'in_progress');
	if (left.length > 0) throw new Error(`worker did not finish the fixture year's narrative jobs: ${JSON.stringify(left.map((j) => j.id))}`);
}

async function req(url, opts = {}) {
	return fetch(`${BASE_URL}${url}`, { ...opts, redirect: 'manual', headers: { Accept: 'text/html', ...(opts.headers ?? {}) } });
}

function sessionCookie(res) {
	const all = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
	for (const c of all) {
		const m = c.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`));
		if (m && m[1]) return `${SESSION_COOKIE_NAME}=${m[1]}`;
	}
	return null;
}

async function login(username) {
	const res = await req('/login?/login', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: BASE_URL },
		body: new URLSearchParams({ username, password: TEST_PASSWORD }).toString()
	});
	const cookie = sessionCookie(res);
	if (res.status !== 303 || !cookie) throw new Error(`login for ${username} failed: ${res.status}`);
	return cookie;
}

/** POST a form action the way use:enhance does; fields may repeat ([k, v] pairs). */
async function action(name, fields, cookie) {
	const res = await req(`/admin/narratives?/${name}`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
			Origin: BASE_URL,
			'x-sveltekit-action': 'true',
			Accept: 'application/json',
			Cookie: cookie
		},
		body: new URLSearchParams(fields).toString()
	});
	const text = await res.text();
	let json = null;
	try {
		json = JSON.parse(text);
	} catch {
		// not JSON
	}
	const status = json?.status ?? res.status;
	let error = null;
	if (json?.type === 'failure' && typeof json.data === 'string') {
		// devalue-encoded {error}; good enough to surface the message
		const m = json.data.match(/"([^"]{8,})"/);
		error = m ? m[1] : json.data;
	}
	return { status, type: json?.type ?? null, error, text };
}

async function cleanup(owner, styleBefore) {
	const users = await owner.query(`SELECT id FROM users WHERE username = ANY($1)`, [[ADMIN, VIEWER]]);
	const ids = users.rows.map((r) => r.id);
	await owner.query(`DELETE FROM job_runs WHERE job_type = 'narrative_summary' AND payload->>'scope_key' = $1`, [YEAR]);
	await owner.query(`DELETE FROM narrative_summaries WHERE scope = 'year' AND scope_key = $1`, [YEAR]);
	await owner.query(`DELETE FROM narrative_drafts WHERE scope = 'year' AND scope_key = $1`, [YEAR]);
	await owner.query(`DELETE FROM narrative_guidance WHERE scope = 'year' AND scope_key = $1`, [YEAR]);
	if (styleBefore !== undefined) {
		if (styleBefore === null) await owner.query(`DELETE FROM app_state WHERE key = 'narrative_style_guidance'`);
		else
			await owner.query(
				`INSERT INTO app_state (key, value) VALUES ('narrative_style_guidance', $1::jsonb)
				 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
				[JSON.stringify(styleBefore)]
			);
	}
	await owner.query(`DELETE FROM calendar_days WHERE entry_date = ANY($1::date[])`, [[DAY_1, DAY_2]]);
	await owner.query(`DELETE FROM calendar_pages WHERE year = $1 AND month = $2 AND capture_session = '_narrative_test'`, [
		Number(YEAR),
		FIXTURE_MONTH
	]);
	if (ids.length > 0) {
		await owner.query(`DELETE FROM sessions WHERE user_id = ANY($1)`, [ids]);
		await owner.query(`DELETE FROM audit_log WHERE user_id = ANY($1)`, [ids]);
		await owner.query(`DELETE FROM users WHERE id = ANY($1)`, [ids]);
	}
}

async function provision(owner) {
	const hash = await argon2.hash(TEST_PASSWORD, ARGON2_OPTS);
	for (const [username, role] of [
		[ADMIN, 'admin'],
		[VIEWER, 'viewer']
	]) {
		await owner.query(
			`INSERT INTO users (username, display_name, role, password_hash) VALUES ($1, $1, $2, $3)`,
			[username, role, hash]
		);
	}
	await owner.query(
		`INSERT INTO calendar_pages (year, month, page_image_path, capture_session)
		 VALUES ($1, $2, 'fixtures/narrative-test/fake-page.jpg', '_narrative_test')
		 ON CONFLICT (year, month) DO NOTHING`,
		[Number(YEAR), FIXTURE_MONTH]
	);
	const page = await owner.query(`SELECT id FROM calendar_pages WHERE year = $1 AND month = $2`, [Number(YEAR), FIXTURE_MONTH]);
	for (const [d, t] of [
		[DAY_1, `${MARKER} fixture day one text.`],
		[DAY_2, `${MARKER} fixture day two text.`]
	]) {
		await owner.query(
			`INSERT INTO calendar_days (page_id, entry_date, corrected_text, correction_status) VALUES ($1, $2, $3, 'accepted')`,
			[page.rows[0].id, d, t]
		);
	}
}

const drafts = (owner) =>
	owner
		.query(
			`SELECT id::text AS id, model_name, provider, mode, base_text, style_guidance, year_guidance, draft_text,
			        day_count, input_tokens, output_tokens, requested_by
			   FROM narrative_drafts WHERE scope = 'year' AND scope_key = $1 ORDER BY narrative_drafts.id`,
			[YEAR]
		)
		.then((r) => r.rows);
const summary = (owner) =>
	owner
		.query(
			`SELECT summary_text, generated_by, is_published, source_draft_id::text AS source_draft_id
			   FROM narrative_summaries WHERE scope = 'year' AND scope_key = $1`,
			[YEAR]
		)
		.then((r) => r.rows[0] ?? null);
const jobs = (owner) =>
	owner
		.query(
			`SELECT id, status, payload, last_error FROM job_runs
			  WHERE job_type = 'narrative_summary' AND payload->>'scope_key' = $1 ORDER BY id`,
			[YEAR]
		)
		.then((r) => r.rows);

async function yearPage(cookie) {
	const res = await req(`/app/year/${YEAR}`, { headers: { Cookie: cookie } });
	return { status: res.status, html: await res.text() };
}

async function main() {
	const problems = requireTestSafety();
	if (problems.length > 0) {
		for (const p of problems) console.error(`ERROR: ${p}`);
		process.exitCode = 1;
		return;
	}

	const owner = new pg.Pool({
		host: process.env.PGHOST ?? '127.0.0.1',
		port: Number(process.env.PGPORT ?? 15434),
		database: process.env.PGDATABASE,
		user: process.env.MIGRATION_PGUSER ?? 'madonnahist_owner',
		password: process.env.MIGRATION_PGPASSWORD
	});

	let styleBefore;
	try {
		try {
			await fetch(`${BASE_URL}/api/health`);
		} catch (err) {
			console.error(`ERROR: could not reach ${BASE_URL} — start the dev server first:`);
			console.error('  npx vite dev --host 127.0.0.1 --port 5177 --strictPort --mode test');
			throw err;
		}

		const st = await owner.query(`SELECT value FROM app_state WHERE key = 'narrative_style_guidance'`);
		styleBefore = st.rows[0]?.value ?? null;
		await cleanup(owner, undefined);
		await provision(owner);
		const admin = await login(ADMIN);
		const viewer = await login(VIEWER);

		// ── Access ───────────────────────────────────────────────────────────
		{
			const res = await req('/admin/narratives', { headers: { Cookie: viewer } });
			record('viewer cannot open /admin/narratives', res.status !== 200, `status ${res.status}`);
			const r = await action('generate', [['year', YEAR], ['model', OPUS]], viewer);
			record('viewer cannot queue a generation', r.status === 403 || r.status === 303 || r.status === 302, `status ${r.status}`);
		}

		// ── Saved guidance ───────────────────────────────────────────────────
		{
			const s = await action('saveStyle', [['style', STYLE]], admin);
			const n = await action('saveNotes', [['year', YEAR], ['notes', NOTES_1]], admin);
			const g = await owner.query(`SELECT guidance_text FROM narrative_guidance WHERE scope_key = $1`, [YEAR]);
			const a = await owner.query(`SELECT value FROM app_state WHERE key = 'narrative_style_guidance'`);
			record('house style saves', s.type === 'success' && a.rows[0]?.value?.text === STYLE, `type ${s.type}`);
			record('year notes save without generating', n.type === 'success' && g.rows[0]?.guidance_text === NOTES_1 && (await jobs(owner)).length === 0, `type ${n.type}`);
		}

		// ── Legacy {scope, scope_key} job still runs (Opus, fresh, saved guidance) ──
		await owner.query(`INSERT INTO job_runs (job_type, payload) VALUES ('narrative_summary', $1::jsonb)`, [
			JSON.stringify({ scope: 'year', scope_key: YEAR })
		]);
		await runWorker(owner, STUB_A);
		{
			const d = await drafts(owner);
			const j = await jobs(owner);
			const first = d[0];
			record(
				'legacy job → one Opus fresh candidate',
				d.length === 1 && first.model_name === OPUS && first.provider === 'anthropic' && first.mode === 'fresh' && first.requested_by === null,
				JSON.stringify(d.map((x) => [x.model_name, x.mode, x.requested_by]))
			);
			record('legacy job uses the saved house style and notes', first?.style_guidance === STYLE && first?.year_guidance === NOTES_1, '');
			record(
				'prompt wraps guidance in <house_style> and <editor_notes year="1901">',
				!!first && first.draft_text.includes(`<house_style>\n${STYLE}`) && first.draft_text.includes(`<editor_notes year="1901">\n${NOTES_1}`),
				''
			);
			record(
				'output rules come last in the system prompt',
				!!first && /Output rules[^\n]*\n\n\[\[USER\]\]/.test(first.draft_text),
				''
			);
			record('candidate records day count and tokens', first?.day_count === 2 && first?.input_tokens > 0 && first?.output_tokens > 0, '');
			record('job note names the draft and model', /^draft #\d+ from 2 accepted day\(s\) via claude-opus-5-5$/.test(j[0]?.last_error ?? ''), j[0]?.last_error);
			record('worker wrote nothing to narrative_summaries', (await summary(owner)) === null, '');
		}

		// ── Malformed modern payload fails before any model call ────────────
		{
			const before = (await drafts(owner)).length;
			const ins = await owner.query(`INSERT INTO job_runs (job_type, payload) VALUES ('narrative_summary', $1::jsonb) RETURNING id`, [
				JSON.stringify({ scope: 'year', scope_key: YEAR, model: OPUS })
			]);
			await runWorker(owner, STUB_A);
			const j = (await jobs(owner)).find((x) => x.id === ins.rows[0].id);
			record(
				'a half-formed modern payload fails instead of running as a legacy job',
				j?.status === 'failed' && /invalid mode/.test(j.last_error ?? '') && (await drafts(owner)).length === before,
				`${j?.status} ${j?.last_error}`
			);
		}

		// ── A JSON null payload fails cleanly (no crash, nothing stranded) ──
		{
			const ins = await owner.query(`INSERT INTO job_runs (job_type, payload) VALUES ('narrative_summary', 'null'::jsonb) RETURNING id`);
			const id = ins.rows[0].id;
			try {
				await runWorker(owner, STUB_A, { extraIds: [id] });
				const j = (await owner.query(`SELECT status, last_error FROM job_runs WHERE id = $1`, [id])).rows[0];
				record('a null payload fails as a normal job failure', j.status === 'failed' && /JSON object/.test(j.last_error ?? ''), `${j.status} ${j.last_error}`);
			} finally {
				await owner.query(`DELETE FROM job_runs WHERE id = $1`, [id]);
			}
		}

		// ── A dry run hands the job back untouched ─────────────────────────
		{
			const adminId = (await owner.query(`SELECT id FROM users WHERE username = $1`, [ADMIN])).rows[0].id;
			const ins = await owner.query(`INSERT INTO job_runs (job_type, payload) VALUES ('narrative_summary', $1::jsonb) RETURNING id`, [
				JSON.stringify({ scope: 'year', scope_key: YEAR, model: OPUS, mode: 'fresh', style_guidance: '', year_guidance: '', requested_by: adminId })
			]);
			const id = ins.rows[0].id;
			await runWorker(owner, STUB_A, { dryRun: true });
			const j = (await owner.query(`SELECT status, attempts FROM job_runs WHERE id = $1`, [id])).rows[0];
			record('dry run leaves the job pending with no attempt used', j.status === 'pending' && j.attempts === 0, JSON.stringify(j));
			await owner.query(`DELETE FROM job_runs WHERE id = $1`, [id]);
		}

		// ── A job whose last attempt went stale is marked failed ────────────
		{
			const adminId = (await owner.query(`SELECT id FROM users WHERE username = $1`, [ADMIN])).rows[0].id;
			const ins = await owner.query(
				`INSERT INTO job_runs (job_type, payload, status, attempts, started_at)
				 VALUES ('narrative_summary', $1::jsonb, 'in_progress', 3, NOW() - INTERVAL '2 hours') RETURNING id`,
				[JSON.stringify({ scope: 'year', scope_key: YEAR, model: OPUS, mode: 'fresh', style_guidance: '', year_guidance: '', requested_by: adminId })]
			);
			await runWorker(owner, STUB_A);
			const j = (await jobs(owner)).find((x) => x.id === ins.rows[0].id);
			record('an exhausted stale job is marked failed, not left "in progress"', j?.status === 'failed' && /gave up after 3 attempts/.test(j.last_error ?? ''), `${j?.status} ${j?.last_error}`);
		}

		// ── A requester deleted while the job ran: draft kept, unattributed ──
		{
			const ins = await owner.query(`INSERT INTO job_runs (job_type, payload) VALUES ('narrative_summary', $1::jsonb) RETURNING id`, [
				JSON.stringify({ scope: 'year', scope_key: YEAR, model: OPUS, mode: 'fresh', style_guidance: '', year_guidance: '', requested_by: 2147480000 })
			]);
			await runWorker(owner, STUB_A);
			const j = (await jobs(owner)).find((x) => x.id === ins.rows[0].id);
			const d = (await owner.query(`SELECT requested_by FROM narrative_drafts WHERE job_run_id = $1`, [ins.rows[0].id])).rows;
			record('missing requester → draft saved with no requester', j?.status === 'done' && d.length === 1 && d[0].requested_by === null, `${j?.status} ${j?.last_error}`);
		}

		// ── A stale in-progress job is reclaimed and makes exactly one draft ──
		{
			const before = (await drafts(owner)).length;
			const adminId = (await owner.query(`SELECT id FROM users WHERE username = $1`, [ADMIN])).rows[0].id;
			const ins = await owner.query(
				`INSERT INTO job_runs (job_type, payload, status, attempts, started_at)
				 VALUES ('narrative_summary', $1::jsonb, 'in_progress', 1, NOW() - INTERVAL '2 hours') RETURNING id`,
				[JSON.stringify({ scope: 'year', scope_key: YEAR, model: OPUS, mode: 'fresh', style_guidance: '', year_guidance: '', requested_by: adminId })]
			);
			await runWorker(owner, STUB_A);
			const jobId = ins.rows[0].id;
			const j = (await jobs(owner)).find((x) => x.id === jobId);
			const mine = (await owner.query(`SELECT id FROM narrative_drafts WHERE job_run_id = $1`, [jobId])).rows;
			record(
				'stale job reclaimed: done, one draft linked by job_run_id',
				j?.status === 'done' && mine.length === 1 && (await drafts(owner)).length === before + 1,
				`${j?.status} drafts=${mine.length}`
			);
		}

		// ── Revise needs current text ────────────────────────────────────────
		{
			const rev = await action('generate', [['year', YEAR], ['model', OPUS], ['mode', 'revise'], ['notes', NOTES_1]], admin);
			record('revise with no current text → 400', rev.status === 400 && (await jobs(owner)).every((x) => x.status !== 'pending'), `status ${rev.status}`);
		}

		// ── Two models at once; duplicate rejected; guidance copied at queue time ──
		{
			const idsBefore = new Set((await drafts(owner)).map((x) => x.id));
			const g = await action('generate', [['year', YEAR], ['model', OPUS], ['model', GEMINI], ['mode', 'fresh'], ['notes', NOTES_2]], admin);
			record('generate with two models succeeds', g.type === 'success', `type ${g.type} ${g.error ?? ''}`);
			const dup = await action('generate', [['year', YEAR], ['model', OPUS], ['notes', NOTES_2]], admin);
			record('a second Opus run while one is queued → 409', dup.status === 409, `status ${dup.status}`);
			const bad = await action('generate', [['year', YEAR], ['model', 'gpt-9'], ['notes', NOTES_2]], admin);
			record('an unknown model → 400', bad.status === 400, `status ${bad.status}`);
			const none = await action('generate', [['year', YEAR], ['notes', NOTES_2]], admin);
			record('no model ticked → 400', none.status === 400, `status ${none.status}`);

			await action('saveNotes', [['year', YEAR], ['notes', NOTES_3]], admin);
			const pending = (await jobs(owner)).filter((x) => x.status === 'pending');
			record(
				'queued jobs carry model, notes copy and requester',
				pending.length === 2 &&
					pending.every((x) => x.payload.year_guidance === NOTES_2 && x.payload.style_guidance === STYLE && Number.isInteger(x.payload.requested_by)) &&
					new Set(pending.map((x) => x.payload.model)).size === 2,
				JSON.stringify(pending.map((x) => x.payload.model))
			);

			await runWorker(owner, STUB_B);
			const d = await drafts(owner);
			const fresh = d.filter((x) => !idsBefore.has(x.id));
			record('two new candidates, one per model', fresh.length === 2 && new Set(fresh.map((x) => x.model_name)).size === 2, JSON.stringify(fresh.map((x) => x.model_name)));
			record('notes edited after queueing did not change the queued jobs', fresh.every((x) => x.year_guidance === NOTES_2), '');
			const gem = fresh.find((x) => x.model_name === GEMINI);
			record('Gemini candidate is tagged provider=google', gem?.provider === 'google' && gem.draft_text.includes(`[model=${GEMINI}]`), '');
		}

		// ── Admin page shows the open year's candidates ──────────────────────
		{
			const d = await drafts(owner);
			const res = await req(`/admin/narratives?open=${YEAR}`, { headers: { Cookie: admin } });
			const html = await res.text();
			record('admin page lists every candidate for the open year', res.status === 200 && d.every((x) => html.includes(`#${x.id}`)), `status ${res.status}`);
		}

		// ── Use this ────────────────────────────────────────────────────────
		let gemId;
		{
			const d = await drafts(owner);
			gemId = d.find((x) => x.model_name === GEMINI).id;
			const cross = await action('useDraft', [['year', '1902'], ['draftId', gemId]], admin);
			record('useDraft with another year → rejected', cross.status === 404, `status ${cross.status}`);
			record('…and no 1902 narrative was created', (await owner.query(`SELECT 1 FROM narrative_summaries WHERE scope_key = '1902'`)).rowCount === 0, '');

			const u = await action('useDraft', [['year', YEAR], ['draftId', gemId]], admin);
			const s = await summary(owner);
			const gem = d.find((x) => x.id === gemId);
			record(
				'"Use this" copies the candidate into an unpublished narrative',
				u.type === 'success' && s?.summary_text === gem.draft_text && s.source_draft_id === gemId && s.generated_by === GEMINI && s.is_published === false,
				`type ${u.type} ${u.error ?? ''}`
			);
			const audit = await owner.query(`SELECT 1 FROM audit_log WHERE action = 'narrative_use_draft' AND description LIKE $1`, [`%#${gemId}%`]);
			record('"Use this" is audited', audit.rowCount === 1, '');
			const v = await yearPage(viewer);
			record('viewer does not see an unpublished narrative', v.status === 200 && !v.html.includes(STUB_B) && !v.html.includes(GENERATED_LABEL), `status ${v.status}`);
		}

		// ── Hand edit, then revise starts from the hand-edited text ──────────
		{
			const e = await action('saveEdit', [['year', YEAR], ['summaryText', HAND_EDIT]], admin);
			const s = await summary(owner);
			const editDraft = (await drafts(owner)).find((x) => x.id === s?.source_draft_id);
			record(
				'hand edit is saved as a draft of its own and becomes the source',
				e.type === 'success' &&
					s?.summary_text === HAND_EDIT &&
					editDraft?.provider === 'human' &&
					editDraft.mode === 'edit' &&
					editDraft.draft_text === HAND_EDIT &&
					s.generated_by === 'hand-edit',
				`type ${e.type} source ${s?.source_draft_id}`
			);
			const staleEdit = await action('saveEdit', [['year', YEAR], ['summaryText', 'stale tab edit'], ['expectedDraftId', gemId]], admin);
			record(
				'an edit started before the text changed → 409, text untouched',
				staleEdit.status === 409 && (await summary(owner))?.summary_text === HAND_EDIT,
				`status ${staleEdit.status}`
			);
			const tooLong = await action('saveEdit', [['year', YEAR], ['summaryText', 'x'.repeat(50_001)]], admin);
			record('a hand edit over 50,000 characters → 400', tooLong.status === 400, `status ${tooLong.status}`);

			const r = await action('generate', [['year', YEAR], ['model', OPUS], ['mode', 'revise'], ['notes', NOTES_3]], admin);
			record('revise queues', r.type === 'success', `type ${r.type} ${r.error ?? ''}`);
			const pending = (await jobs(owner)).filter((x) => x.status === 'pending');
			record('revise job carries the hand-edited text as base_text', pending.length === 1 && pending[0].payload.base_text === HAND_EDIT, '');
			await runWorker(owner, STUB_A);
			const d = await drafts(owner);
			const last = d[d.length - 1];
			record(
				'revision candidate records its base text and shows it to the model',
				last.mode === 'revise' && last.base_text === HAND_EDIT && last.draft_text.includes(`<current_narrative>\n${HAND_EDIT}\n</current_narrative>`),
				`${last.mode}`
			);
			record('revision prompt includes the revise instruction', last.draft_text.includes('You are revising an existing narrative'), '');
		}

		// ── Publish; a new draft never touches the published text ───────────
		{
			const cur = await summary(owner);
			const stale = await action('publish', [['year', YEAR], ['expectedDraftId', gemId]], admin);
			record(
				'Publish confirmed on text that has since changed → 409, not published',
				stale.status === 409 && (await summary(owner))?.is_published === false,
				`status ${stale.status}`
			);
			const p = await action('publish', [['year', YEAR], ['expectedDraftId', cur.source_draft_id]], admin);
			const v = await yearPage(viewer);
			record('published hand-edited text is visible to the viewer', p.type === 'success' && v.html.includes('HANDEDIT') && v.html.includes(GENERATED_LABEL), `type ${p.type}`);

			// Notes untouched in this tab (equal to notesBase) but stale: the
			// job must use what's saved (NOTES_3), not write NOTES_1 back.
			const g = await action('generate', [['year', YEAR], ['model', OPUS], ['notes', NOTES_1], ['notesBase', NOTES_1]], admin);
			record('generating on a published year is allowed (no unpublish needed)', g.type === 'success', `type ${g.type} ${g.error ?? ''}`);
			const queued = (await jobs(owner)).filter((x) => x.status === 'pending');
			const saved = (await owner.query(`SELECT guidance_text FROM narrative_guidance WHERE scope_key = $1`, [YEAR])).rows[0]?.guidance_text;
			record(
				'untouched stale notes do not overwrite the saved notes',
				queued.length === 1 && queued[0].payload.year_guidance === NOTES_3 && saved === NOTES_3,
				`job ${queued[0]?.payload.year_guidance} saved ${saved}`
			);
			await runWorker(owner, STUB_D);
			const s = await summary(owner);
			record('published text unchanged after a new draft', s?.summary_text === HAND_EDIT && s.is_published === true, '');
			const v2 = await yearPage(viewer);
			record('the new draft is not visible to the viewer', !v2.html.includes(STUB_D), '');

			const d = await drafts(owner);
			const newest = d[d.length - 1];
			const noConfirm = await action('useDraft', [['year', YEAR], ['draftId', newest.id]], admin);
			const s2 = await summary(owner);
			record('"Use this" on a published year without confirmation → 409', noConfirm.status === 409 && s2?.summary_text === HAND_EDIT, `status ${noConfirm.status}`);
			const yes = await action('useDraft', [['year', YEAR], ['draftId', newest.id], ['confirmPublished', '1']], admin);
			const s3 = await summary(owner);
			record(
				'with confirmation it replaces the text and stays published',
				yes.type === 'success' && s3?.summary_text === newest.draft_text && s3.is_published === true && s3.source_draft_id === newest.id,
				`type ${yes.type}`
			);
			const v3 = await yearPage(viewer);
			record('viewer now sees the replacement', v3.html.includes(STUB_D), `newest #${newest.id} ${newest.model_name}/${newest.mode}; jobs ${JSON.stringify((await jobs(owner)).map((x) => [x.id, x.status, x.last_error]))}`);

			// The replaced hand edit is still a draft, so it can be switched back.
			const editDraft = (await drafts(owner)).find((x) => x.provider === 'human');
			const back = await action('useDraft', [['year', YEAR], ['draftId', editDraft.id], ['confirmPublished', '1']], admin);
			const s4 = await summary(owner);
			record('the replaced hand edit can be restored', back.type === 'success' && s4?.summary_text === HAND_EDIT && s4.is_published === true, `type ${back.type}`);
		}

		// ── Revising text longer than the worker accepts is refused up front ──
		{
			const before = await summary(owner);
			await owner.query(`UPDATE narrative_summaries SET summary_text = $2 WHERE scope = 'year' AND scope_key = $1`, [YEAR, 'y'.repeat(50_001)]);
			const r = await action('generate', [['year', YEAR], ['model', OPUS], ['mode', 'revise']], admin);
			record('revise of over-long current text → 400 at queue time', r.status === 400 && /too long/.test(r.error ?? ''), `status ${r.status} ${r.error}`);
			await owner.query(`UPDATE narrative_summaries SET summary_text = $2 WHERE scope = 'year' AND scope_key = $1`, [YEAR, before.summary_text]);
		}

		// ── A year whose accepted days are reopened stays on the desk ───────
		{
			await owner.query(`UPDATE calendar_days SET correction_status = 'in_progress' WHERE entry_date = ANY($1::date[])`, [[DAY_1, DAY_2]]);
			const res = await req(`/admin/narratives?open=${YEAR}`, { headers: { Cookie: admin } });
			const html = await res.text();
			record(
				'published year with no accepted days is still listed and openable',
				res.status === 200 && html.includes('Unpublish') && html.includes('has no accepted days right now'),
				`status ${res.status}`
			);
			const g = await action('generate', [['year', YEAR], ['model', OPUS]], admin);
			record('…and generating for it → 400', g.status === 400, `status ${g.status}`);
			const u = await action('unpublish', [['year', YEAR]], admin);
			record('…and it can be unpublished', u.type === 'success' && (await summary(owner))?.is_published === false, `type ${u.type}`);
		}

		// ── The removed action is gone ──────────────────────────────────────
		{
			const r = await action('unpublishAndRegenerate', [['year', YEAR]], admin);
			record('unpublishAndRegenerate no longer exists', r.status === 404 || r.status === 405 || r.type === 'error', `status ${r.status} type ${r.type}`);
		}

		console.log('\nNarrative results:\n');
		const width = Math.max(...rows.map((r) => r.label.length)) + 2;
		for (const r of rows) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.label.padEnd(width)} ${r.detail ?? ''}`);
		console.log(`\n${pass} passed, ${fail} failed (${rows.length} total)`);
		if (fail > 0) process.exitCode = 1;
	} finally {
		await cleanup(owner, styleBefore);
		await owner.end();
	}
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
