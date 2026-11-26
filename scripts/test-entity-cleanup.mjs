#!/usr/bin/env node
// Entities cleanup test (td-c6e871, docs/2026-11-23-entity-cleanup-plan.md).
//
// Runs against a dev server on the isolated test stack, started with the LLM
// stub and a stub delay (so two Claude checks really overlap):
//   MADONNAHIST_LLM_STUB=1 MADONNAHIST_LLM_STUB_DELAY_MS=800 \
//     npx vite dev --host 127.0.0.1 --port 5177 --strictPort --mode test
// and spawns the real enrichment worker (stubbed) for re-extraction.
//
// Self-provisions an admin, a viewer, fixture days in 1913 and entities whose
// slugs start with "zqxdup", and removes them in a finally block.
//
// Asserts:
//   - viewers are refused on the new page, its actions and the check endpoint
//   - multi-merge: links move, sources become aliases, one audit row each;
//     a stale source rolls the whole merge back; a pair marked "not the
//     same" inside the set is refused; not-same pairs carry to the survivor
//   - human beats AI on merge in both orders, and survives a re-extraction
//     that omits the name
//   - move a day: every family link removed, a human link added, a block
//     left; re-extraction of the same spelling, of another alias spelling,
//     and after the blocked name is merged all stay blocked; moving back
//     clears the block; delete is refused while a block exists
//   - places: a lone map decision moves to the survivor; two different human
//     decisions refuse the merge; a human "no map" beats a machine one
//   - mentions: family scope, day 16+ by cursor, a note-only mention labelled
//   - locks: two moves of one day give one 409; a move waits for the day
//     lock and then sees the change made meanwhile; the worker waits for it
//   - Claude check (stub): stored, then cached; two overlapping checks pay
//     once; a changed family is asked again; a candidate outside the group
//     is refused
//   - alias, not-same and undo write audit rows; ids that sort differently
//     as strings (900001 vs 1000001) keep their numeric order
//
// Usage: node scripts/test-entity-cleanup.mjs [baseUrl]   (or: npm run test:entity-cleanup)

import argon2 from 'argon2';
import pg from 'pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import * as devalue from 'devalue';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

for (const line of readFileSync(path.join(REPO_ROOT, '.env.test'), 'utf8').split('\n')) {
	const t = line.trim();
	if (!t || t.startsWith('#') || !t.includes('=')) continue;
	const k = t.slice(0, t.indexOf('=')).trim();
	if (process.env[k] === undefined) process.env[k] = t.slice(t.indexOf('=') + 1).trim();
}
const BASE = process.argv[2] ?? 'http://127.0.0.1:5177';
// Exactly the repo's isolated test stack (CLAUDE.md, docs/local-test-environment.md),
// not merely something that looks like one (CODEX9 td-c6e871 #4).
const stackProblems = [
	process.env.MADONNAHIST_ENV !== 'test' && 'MADONNAHIST_ENV is not test',
	!['127.0.0.1', 'localhost'].includes(process.env.PGHOST ?? '') && 'PGHOST is not local',
	process.env.PGPORT !== '15434' && 'PGPORT is not 15434',
	process.env.PGDATABASE !== 'madonnahist_test' && 'PGDATABASE is not madonnahist_test',
	process.env.MADONNAHIST_OBJECT_STORE !== 'local' && 'MADONNAHIST_OBJECT_STORE is not local',
	!/^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(BASE) && 'the server URL is not local'
].filter(Boolean);
if (stackProblems.length > 0) {
	console.error(`refusing: not the isolated test stack (${stackProblems.join('; ')})`);
	process.exit(1);
}
const COOKIE = 'madonnahist_session';
const PASS = 'DupTest!2026';
const ADMIN = '_dup_admin';
const VIEWER = '_dup_viewer';
const SESSION = '_dup_test';
const YEAR = 1913;
const LOCK_DAY = 81011;

const owner = new pg.Pool({
	host: process.env.PGHOST,
	port: Number(process.env.PGPORT),
	database: process.env.PGDATABASE,
	user: process.env.MIGRATION_PGUSER,
	password: process.env.MIGRATION_PGPASSWORD
});
const q = (sql, params) => owner.query(sql, params);

let pass = 0;
let fail = 0;
function check(label, ok, detail = '') {
	if (ok) pass++;
	else fail++;
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `  (${detail})`}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── HTTP ──
async function login(username) {
	const res = await fetch(`${BASE}/login?/login`, {
		method: 'POST',
		redirect: 'manual',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: BASE },
		body: new URLSearchParams({ username, password: PASS })
	});
	const set = res.headers.getSetCookie?.() ?? [];
	const m = set.map((c) => c.match(new RegExp(`${COOKIE}=([^;]+)`))).find(Boolean);
	if (!m) throw new Error(`login ${username}: ${res.status}`);
	return `${COOKIE}=${m[1]}`;
}
/** POST a form action; returns {status, type, data} from the action JSON. */
async function act(cookie, route, action, fields) {
	const body = new URLSearchParams();
	for (const [k, v] of Object.entries(fields)) for (const x of [v].flat()) body.append(k, String(x));
	const res = await fetch(`${BASE}${route}?/${action}`, {
		method: 'POST',
		headers: { cookie, Origin: BASE, Accept: 'application/json', 'x-sveltekit-action': 'true', 'Content-Type': 'application/x-www-form-urlencoded' },
		body
	});
	const text = await res.text();
	let j = {};
	try {
		j = JSON.parse(text);
	} catch {
		/* html */
	}
	let data = null;
	try {
		data = j.data ? JSON.parse(j.data) : null;
	} catch {
		/* devalue */
	}
	// devalue: [ {key: idx...}, values... ] — pull "error"/"done" strings out simply.
	const flat = Array.isArray(data) ? data : [];
	const str = flat.filter((x) => typeof x === 'string');
	return { status: res.status, type: j.type, text: str.join(' | '), raw: text };
}
/** Current evidence fingerprints of (mainId, each id), as the page would have them. */
async function fingerprints(cookie, mainId, ids) {
	const res = await fetch(`${BASE}/admin/entities/cleanup/check?mainId=${mainId}&candidateIds=${ids.join(',')}`, { headers: { cookie } });
	return (await res.json().catch(() => ({}))).fingerprints ?? {};
}
/**
 * A cleanup-page action. A mergeGroup without a mainId is sent the way the
 * page sends it: the kept name as the main name, with the current
 * fingerprint of every other name. Pass mainId to control it exactly.
 */
async function cleanupAct(cookie, action, fields) {
	if (action === 'mergeGroup' && !('mainId' in fields)) {
		const others = [fields.id].flat().map(Number).filter((x) => x !== Number(fields.keepId));
		const fps = await fingerprints(cookie, fields.keepId, others);
		fields = { ...fields, mainId: fields.keepId, ...Object.fromEntries(Object.entries(fps).map(([k, v]) => [`fp:${k}`, v])) };
		for (const x of others) if (!(String(x) in fps)) fields[`fp:${x}`] = '0'.repeat(32); // not canonical: let the server say why
	}
	return act(cookie, '/admin/entities/cleanup', action, fields);
}
async function checkApi(cookie, mainId, candidateIds, fingerprints) {
	const res = await fetch(`${BASE}/admin/entities/cleanup/check`, {
		method: 'POST',
		headers: { cookie, Origin: BASE, 'Content-Type': 'application/json' },
		body: JSON.stringify({ mainId, candidateIds, ...(fingerprints ? { fingerprints } : {}) })
	});
	return { status: res.status, body: await res.json().catch(() => ({})) };
}
async function mentions(cookie, id, qs = '') {
	const res = await fetch(`${BASE}/admin/entities/${id}/mentions${qs}`, { headers: { cookie } });
	return { status: res.status, body: await res.json().catch(() => ({})) };
}

/** A page's load data, as the browser gets it (SvelteKit __data.json). */
async function pageData(cookie, route) {
	const res = await fetch(`${BASE}${route}/__data.json`, { headers: { cookie } });
	const j = await res.json();
	return (j.nodes ?? []).filter((n) => n?.type === 'data').map((n) => devalue.unflatten(n.data));
}

// ── Fixtures ──
let adminId;
let viewerId;
const day = {}; // date → id
// Every fixture day, whichever page it landed on: mkDay reuses a month page
// that already exists, which cleanup-by-page would miss (CODEX9 re-review
// #6). Fixture text or note always contains "Zqxdup", so a rerun after a
// crash finds them too.
const fixtureDayIds = [];
async function mkUser(username, role) {
	const hash = await argon2.hash(PASS, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
	return (
		await q(
			`INSERT INTO users (username, display_name, role, password_hash) VALUES ($1, $1, $2, $3)
			 ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role RETURNING id`,
			[username, role, hash]
		)
	).rows[0].id;
}
async function mkDay(date, text, note = null) {
	const [y, m] = date.split('-').map(Number);
	let page = (await q(`SELECT id FROM calendar_pages WHERE year = $1 AND month = $2`, [y, m])).rows[0];
	if (!page) {
		page = (
			await q(`INSERT INTO calendar_pages (year, month, page_image_path, capture_session) VALUES ($1, $2, 'fixtures/dup/p.jpg', $3) RETURNING id`, [y, m, SESSION])
		).rows[0];
	}
	const id = (
		await q(
			`INSERT INTO calendar_days (page_id, entry_date, corrected_text, day_narrative, correction_status) VALUES ($1, $2, $3, $4, 'accepted') RETURNING id`,
			[page.id, date, text, note]
		)
	).rows[0].id;
	day[date] = id;
	fixtureDayIds.push(Number(id));
	return id;
}
async function mkEnt(name, type = 'person', id = null) {
	const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
	if (id) return Number((await q(`INSERT INTO entities (id, slug, display_name, entity_type) VALUES ($1, $2, $3, $4) RETURNING id`, [id, slug, name, type])).rows[0].id);
	return Number((await q(`INSERT INTO entities (slug, display_name, entity_type) VALUES ($1, $2, $3) RETURNING id`, [slug, name, type])).rows[0].id);
}
const link = (dayId, entityId, source = 'ai', conf = 0.8) =>
	q(`INSERT INTO day_entities (day_id, entity_id, source, confidence_score) VALUES ($1, $2, $3, $4)`, [dayId, entityId, source, source === 'ai' ? conf : null]);
const ent = async (id) => (await q(`SELECT id, display_name, alias_of_entity_id FROM entities WHERE id = $1`, [id])).rows[0];
const links = async (dayId) =>
	(await q(`SELECT entity_id::int AS e, source, confidence_score AS c FROM day_entities WHERE day_id = $1 ORDER BY entity_id`, [dayId])).rows;
const audits = async (action, entityId) =>
	Number((await q(`SELECT count(*)::int n FROM audit_log WHERE action = $1 AND entity_id = $2 AND user_id = $3`, [action, entityId, adminId])).rows[0].n);

async function dropBarrier() {
	await q(`DROP TRIGGER IF EXISTS zqxdup_barrier ON day_entities`);
	await q(`DROP FUNCTION IF EXISTS zqxdup_barrier()`);
}

async function cleanup() {
	await dropBarrier();
	const ids = (await q(`SELECT id FROM users WHERE username = ANY($1)`, [[ADMIN, VIEWER]])).rows.map((r) => r.id);
	const ours = `SELECT id FROM calendar_days
	               WHERE id = ANY($1::int[])
	                  OR (entry_date BETWEEN '${YEAR}-01-01' AND '${YEAR}-12-31'
	                      AND (corrected_text ILIKE '%zqxdup%' OR day_narrative ILIKE '%zqxdup%'))`;
	await q(`DELETE FROM job_runs WHERE (payload->>'day_id')::int IN (${ours})`, [fixtureDayIds]);
	await q(`DELETE FROM calendar_days WHERE id IN (${ours})`, [fixtureDayIds]);
	await q(`DELETE FROM job_runs WHERE (payload->>'day_id')::int IN (SELECT d.id FROM calendar_days d JOIN calendar_pages p ON p.id = d.page_id WHERE p.capture_session = $1)`, [SESSION]);
	await q(`DELETE FROM calendar_days WHERE page_id IN (SELECT id FROM calendar_pages WHERE capture_session = $1)`, [SESSION]);
	await q(`DELETE FROM calendar_pages WHERE capture_session = $1`, [SESSION]);
	await q(`DELETE FROM day_entity_blocks WHERE entity_id IN (SELECT id FROM entities WHERE slug LIKE 'zqxdup%')`);
	await q(`UPDATE entities SET alias_of_entity_id = NULL WHERE slug LIKE 'zqxdup%'`);
	await q(`DELETE FROM entities WHERE slug LIKE 'zqxdup%'`);
	if (ids.length) {
		await q(`DELETE FROM day_corrections WHERE editor_user_id = ANY($1)`, [ids]);
		await q(`DELETE FROM sessions WHERE user_id = ANY($1)`, [ids]);
		await q(`DELETE FROM audit_log WHERE user_id = ANY($1)`, [ids]);
		await q(`DELETE FROM users WHERE id = ANY($1)`, [ids]);
	}
}

/**
 * Accept a fixture day again (which enqueues its extraction job) and return
 * that job's id. Only this fixture day's jobs are touched: other local work
 * on the test stack keeps its queue (CODEX9 #4).
 */
async function enqueueFixture(dayId, text = null) {
	await q(`DELETE FROM job_runs WHERE job_type = 'entity_extract' AND (payload->>'day_id')::int = $1 AND status IN ('pending', 'in_progress')`, [dayId]);
	await q(
		`INSERT INTO day_corrections (day_id, corrected_text, status_after, editor_user_id)
		 VALUES ($1, COALESCE($3, (SELECT coalesce(corrected_text, 'x') FROM calendar_days WHERE id = $1)), 'accepted', $2)`,
		[dayId, adminId, text]
	);
	const job = await q(
		`SELECT id FROM job_runs WHERE job_type = 'entity_extract' AND (payload->>'day_id')::int = $1 AND status = 'pending' ORDER BY id DESC LIMIT 1`,
		[dayId]
	);
	if (!job.rows[0]) throw new Error(`no extraction job was queued for fixture day ${dayId}`);
	return Number(job.rows[0].id);
}

/** Accept the day again and run the stubbed worker on exactly that day's job. */
async function reextract(dayId, entities) {
	const jobId = await enqueueFixture(dayId);
	const r = spawnSync('npx', ['tsx', 'backend/workers/enrichment-worker.ts', `--job-ids=${jobId}`], {
		cwd: REPO_ROOT,
		encoding: 'utf8',
		env: { ...process.env, MADONNAHIST_LLM_STUB: '1', MADONNAHIST_LLM_STUB_JSON: JSON.stringify({ entities, tags: [] }) }
	});
	if (r.status !== 0) throw new Error(`worker failed: ${r.stderr}`);
}
const P = (name, confidence = 0.9) => ({ type: 'person', name, confidence });

async function main() {
	await cleanup();
	adminId = await mkUser(ADMIN, 'admin');
	viewerId = await mkUser(VIEWER, 'viewer');
	const admin = await login(ADMIN);
	const viewer = await login(VIEWER);

	// ── Access ──
	const vPage = await fetch(`${BASE}/admin/entities/cleanup`, { headers: { cookie: viewer }, redirect: 'manual' });
	check('viewer can\'t open Find duplicates', vPage.status >= 300 && vPage.status !== 200, String(vPage.status));
	const vAct = await cleanupAct(viewer, 'notSame', { a: 1, b: 2 });
	check('viewer can\'t use its actions', vAct.status >= 300 || vAct.type === 'error' || vAct.type === 'redirect', `${vAct.status} ${vAct.type}`);
	const vChk = await checkApi(viewer, 1, [2]);
	check('viewer can\'t use the Claude check', vChk.status === 403 || vChk.status >= 300, String(vChk.status));

	// ── Multi-merge ──
	const d1 = await mkDay('1913-01-01', 'Zqxdupgaylon came home.');
	const d2 = await mkDay('1913-01-02', 'Zqxdupgayon fixed the car.');
	const d3 = await mkDay('1913-01-03', 'Zqxdup Gaylon and kids.');
	const K = await mkEnt('Zqxdupgaylon', 'person', 1000001);
	const S1 = await mkEnt('Zqxdupgayon', 'person', 900001);
	const S2 = await mkEnt('Zqxdup Gaylon');
	await link(d1, K);
	await link(d2, S1);
	await link(d3, S2);
	let r = await cleanupAct(admin, 'mergeGroup', { keepId: K, id: [S1, S2] });
	check('multi-merge succeeds', r.type === 'success', r.raw.slice(0, 200));
	check('sources become aliases of the survivor (ids 900001 < 1000001 handled)', (await ent(S1)).alias_of_entity_id == K && (await ent(S2)).alias_of_entity_id == K);
	check('their days move to the survivor', (await links(d2)).some((l) => l.e === K) && (await links(d3)).some((l) => l.e === K) && !(await links(d2)).some((l) => l.e === S1));
	check('one audit row per merged name', (await audits('entity_merge', S1)) === 1 && (await audits('entity_merge', S2)) === 1);

	// Stale source: the whole merge rolls back.
	const A = await mkEnt('Zqxdupalpha');
	const B = await mkEnt('Zqxdupalpho');
	r = await cleanupAct(admin, 'mergeGroup', { keepId: A, id: [B, S1] }); // S1 is already an alias
	check('a stale source refuses the merge (409)', r.status === 409 || r.type === 'failure', `${r.status} ${r.type} ${r.text}`);
	check('…and nothing else merged', (await ent(B)).alias_of_entity_id === null);

	// Not-the-same inside the set is refused; carry-over to the survivor.
	const C = await mkEnt('Zqxdupalphe');
	r = await cleanupAct(admin, 'notSame', { a: B, b: C });
	check('not-same is recorded and audited', r.type === 'success' && (await audits('entity_not_same', Math.min(B, C))) === 1, r.text);
	r = await cleanupAct(admin, 'mergeGroup', { keepId: A, id: [B, C] });
	check('merging two names marked not-same is refused and names them', (r.status === 409 || r.type === 'failure') && r.text.includes('Zqxdupalpho') && r.text.includes('Zqxdupalphe'), r.text);
	r = await cleanupAct(admin, 'mergeGroup', { keepId: A, id: [B] });
	const carried = await q(`SELECT 1 FROM entity_not_same WHERE entity_a = LEAST($1::bigint, $2::bigint) AND entity_b = GREATEST($1::bigint, $2::bigint)`, [A, C]);
	const gone = await q(`SELECT 1 FROM entity_not_same WHERE $1 IN (entity_a, entity_b)`, [B]);
	check('merging B into A carries "B ≠ C" to "A ≠ C"', r.type === 'success' && carried.rowCount === 1 && gone.rowCount === 0, r.text);
	r = await cleanupAct(admin, 'undoNotSame', { a: C, b: A });
	check('undo not-same removes it and is audited', r.type === 'success' && (await audits('entity_not_same_undo', Math.min(A, C))) === 1, r.text);

	// ── Human beats AI ──
	const h1 = await mkDay('1913-02-01', 'Zqxduprae and Zqxdupraee at the park.');
	const h2 = await mkDay('1913-02-02', 'Zqxduprae again, Zqxdupraee too.');
	const RK = await mkEnt('Zqxduprae');
	const RS = await mkEnt('Zqxdupraee');
	await link(h1, RS, 'human');
	await link(h1, RK, 'ai', 0.4);
	await link(h2, RS, 'ai', 0.5);
	await link(h2, RK, 'human');
	r = await cleanupAct(admin, 'mergeGroup', { keepId: RK, id: [RS] });
	const l1 = (await links(h1)).find((l) => l.e === RK);
	const l2 = (await links(h2)).find((l) => l.e === RK);
	check('human source onto AI survivor → human, confidence cleared', l1?.source === 'human' && l1.c === null, JSON.stringify(l1));
	check('AI source onto human survivor → stays human', l2?.source === 'human', JSON.stringify(l2));
	await reextract(h1, []);
	check('a re-extraction that omits the name keeps the human link', (await links(h1)).some((l) => l.e === RK && l.source === 'human'));

	// ── Move a day ──
	const m1 = await mkDay('1913-03-01', 'Zqxdupbecky rolled over.');
	const m2 = await mkDay('1913-03-02', 'Zqxdupbecky and Mark at the beach.');
	const BECKY = await mkEnt('Zqxdupbecky');
	const BECKIE = await mkEnt('Zqxdupbeckie');
	const REB = await mkEnt('Zqxduprebekah');
	await q(`UPDATE entities SET alias_of_entity_id = $1 WHERE id = $2`, [BECKY, BECKIE]);
	await link(m1, BECKY);
	await link(m1, BECKIE);
	await link(m2, BECKY);
	r = await act(admin, '/admin/entities', 'moveDay', { dayId: m1, fromId: BECKY, toId: REB });
	const after = await links(m1);
	check('move: every family link on the day is removed', !after.some((l) => l.e === BECKY || l.e === BECKIE), JSON.stringify(after));
	check('move: the destination gets a human link', after.some((l) => l.e === REB && l.source === 'human'), JSON.stringify(after));
	check('move: a block is left, and audited', (await q(`SELECT 1 FROM day_entity_blocks WHERE day_id = $1 AND entity_id = $2`, [m1, BECKY])).rowCount === 1 && (await audits('entity_move_day', BECKY)) === 1);
	await reextract(m1, [P('Zqxdupbecky'), P('Zqxdupbeckie'), P('Zqxduprebekah')]);
	const re = await links(m1);
	check('re-extraction (same spelling and an alias spelling) stays moved', !re.some((l) => l.e === BECKY || l.e === BECKIE) && re.some((l) => l.e === REB), JSON.stringify(re));
	r = await act(admin, '/admin/entities', 'moveDay', { dayId: m1, fromId: BECKY, toId: REB });
	check('moving the same day again is refused as stale (409)', r.status === 409 || r.type === 'failure', `${r.status} ${r.text}`);
	// Merge the blocked name; the block follows it.
	const BECKY2 = await mkEnt('Zqxdupbeckyy');
	r = await cleanupAct(admin, 'mergeGroup', { keepId: BECKY2, id: [BECKY] });
	check('the block follows a merge to the survivor', (await q(`SELECT 1 FROM day_entity_blocks WHERE day_id = $1 AND entity_id = $2`, [m1, BECKY2])).rowCount === 1);
	await reextract(m1, [P('Zqxdupbecky'), P('Zqxduprebekah')]);
	check('after the merge, re-extracting the old spelling stays moved', !(await links(m1)).some((l) => [BECKY, BECKIE, BECKY2].includes(l.e)));
	// Move back clears the block.
	r = await act(admin, '/admin/entities', 'moveDay', { dayId: m1, fromId: REB, toId: BECKY2 });
	const back = await q(`SELECT entity_id::int e FROM day_entity_blocks WHERE day_id = $1 ORDER BY 1`, [m1]);
	check('moving back clears the old block and blocks the other side', r.type === 'success' && back.rows.length === 1 && back.rows[0].e === REB, JSON.stringify(back.rows));
	// Delete refused while a block exists.
	const ONLY = await mkEnt('Zqxdupblockonly');
	const o1 = await mkDay('1913-03-05', 'Zqxdupblockonly visited.');
	await link(o1, ONLY);
	await act(admin, '/admin/entities', 'moveDay', { dayId: o1, fromId: ONLY, toId: REB });
	r = await act(admin, '/admin/entities', 'delete', { id: ONLY });
	check('delete is refused while a moved-day record names it', (r.status === 409 || r.type === 'failure') && (await ent(ONLY)) !== undefined, r.text);

	// ── Places ──
	const PK = await mkEnt('Zqxdupkmart', 'place');
	const PS = await mkEnt('Zqxdup K-Mart', 'place');
	await q(`INSERT INTO place_locations (entity_id, status, lat, lon, looked_up_name, decided_by, decided_at) VALUES ($1, 'confirmed', 30.1, -81.5, 'x', $2, NOW())`, [PS, adminId]);
	r = await cleanupAct(admin, 'mergeGroup', { keepId: PK, id: [PS] });
	const moved = (await q(`SELECT entity_id::int e, status FROM place_locations WHERE entity_id IN ($1, $2)`, [PK, PS])).rows;
	check('a lone map decision moves to the survivor', moved.length === 1 && moved[0].e === PK && moved[0].status === 'confirmed', JSON.stringify(moved));
	const PA = await mkEnt('Zqxdupwendys', 'place');
	const PB = await mkEnt("Zqxdupwendy's", 'place');
	await q(`INSERT INTO place_locations (entity_id, status, lat, lon, looked_up_name, decided_at) VALUES ($1, 'confirmed', 30.1, -81.5, 'x', NOW()), ($2, 'confirmed', 40.7, -111.9, 'x', NOW())`, [PA, PB]);
	r = await cleanupAct(admin, 'mergeGroup', { keepId: PA, id: [PB] });
	check('two different human map decisions refuse the merge', (r.status === 409 || r.type === 'failure') && (await ent(PB)).alias_of_entity_id === null, r.text);
	const PC = await mkEnt('Zqxduppark', 'place');
	const PD = await mkEnt('Zqxdup Park', 'place');
	await q(`INSERT INTO place_locations (entity_id, status, reason, looked_up_name, decided_at) VALUES ($1, 'no_location', 'admin', 'x', NOW())`, [PD]);
	await q(`INSERT INTO place_locations (entity_id, status, lat, lon, looked_up_name) VALUES ($1, 'auto', 30.2, -81.6, 'x')`, [PC]);
	r = await cleanupAct(admin, 'mergeGroup', { keepId: PC, id: [PD] });
	const nm = (await q(`SELECT status, reason FROM place_locations WHERE entity_id = $1`, [PC])).rows[0];
	check('a human "no map" beats a machine pin', r.type === 'success' && nm?.status === 'no_location' && nm.reason === 'admin', JSON.stringify(nm));

	// ── Mentions ──
	const MANY = await mkEnt('Zqxdupmany');
	const MANYA = await mkEnt('Zqxdupmanyy');
	await q(`UPDATE entities SET alias_of_entity_id = $1 WHERE id = $2`, [MANY, MANYA]);
	for (let i = 1; i <= 20; i++) {
		const dd = await mkDay(`1913-04-${String(i).padStart(2, '0')}`, i === 20 ? 'A quiet day.' : `Saw Zqxdupmany today (${i}).`, i === 20 ? 'Note: Zqxdupmany called.' : null);
		await link(dd, i === 7 ? MANYA : MANY);
	}
	let mres = await mentions(admin, MANY, '?limit=15');
	check('mentions: first page of 15 with a cursor', mres.body.mentions?.length === 15 && typeof mres.body.next === 'string', JSON.stringify(mres.body).slice(0, 200));
	check('mentions: family scope includes the alias\'s day', mres.body.mentions?.some((m) => m.via?.includes('Zqxdupmanyy')));
	const page2 = await mentions(admin, MANY, `?limit=15&after=${encodeURIComponent(mres.body.next)}`);
	check('mentions: day 16+ reachable by cursor', page2.body.mentions?.length === 5 && page2.body.next === null, JSON.stringify(page2.body).slice(0, 200));
	check('mentions: a note-only mention is labelled', page2.body.mentions?.some((m) => m.entryDate === '1913-04-20' && m.snippet.where === 'note'));
	check('mentions: dayId and familyId are given', typeof mres.body.mentions?.[0]?.dayId === 'number' && mres.body.familyId === MANY);

	// ── Locks ──
	const lk = await mkDay('1913-05-01', 'Zqxduplocky ran.');
	const LOCKY = await mkEnt('Zqxduplocky');
	await link(lk, LOCKY);
	const [x, y] = await Promise.all([
		act(admin, '/admin/entities', 'moveDay', { dayId: lk, fromId: LOCKY, toId: REB }),
		act(admin, '/admin/entities', 'moveDay', { dayId: lk, fromId: LOCKY, toId: BECKY2 })
	]);
	const outcomes = [x, y].map((o) => (o.type === 'success' ? 'ok' : o.status === 409 || o.type === 'failure' ? 'stale' : `?${o.status}`)).sort();
	check('two moves of one day at once: one succeeds, one is stale', outcomes.join() === 'ok,stale', outcomes.join());
	check('…leaving exactly one human destination', (await links(lk)).filter((l) => l.source === 'human').length === 1, JSON.stringify(await links(lk)));

	const lk2 = await mkDay('1913-05-02', 'Zqxduplocky2 ran.');
	const LOCKY2 = await mkEnt('Zqxduplockyy');
	await link(lk2, LOCKY2);
	const holder = await owner.connect();
	await holder.query('BEGIN');
	await holder.query('SELECT pg_advisory_xact_lock($1, $2)', [LOCK_DAY, lk2]);
	let settled = false;
	const pending = act(admin, '/admin/entities', 'moveDay', { dayId: lk2, fromId: LOCKY2, toId: REB }).then((o) => {
		settled = true;
		return o;
	});
	await sleep(700);
	check('a move waits while the day is locked', !settled);
	await q(`DELETE FROM day_entities WHERE day_id = $1 AND entity_id = $2`, [lk2, LOCKY2]); // changed meanwhile
	await holder.query('COMMIT');
	holder.release();
	const late = await pending;
	check('…then sees the change and refuses (409)', late.status === 409 || late.type === 'failure', `${late.status} ${late.text}`);

	// The worker waits for the day lock too.
	const wk = await mkDay('1913-05-03', 'Zqxdupworker came.');
	const wkJob = await enqueueFixture(wk, 'Zqxdupworker came.');
	const holder2 = await owner.connect();
	await holder2.query('BEGIN');
	await holder2.query('SELECT pg_advisory_xact_lock($1, $2)', [LOCK_DAY, wk]);
	const child = spawn('npx', ['tsx', 'backend/workers/enrichment-worker.ts', `--job-ids=${wkJob}`], {
		cwd: REPO_ROOT,
		env: { ...process.env, MADONNAHIST_LLM_STUB: '1', MADONNAHIST_LLM_STUB_JSON: JSON.stringify({ entities: [P('Zqxdupworker')], tags: [] }) },
		stdio: 'ignore'
	});
	const exited = new Promise((res) => child.on('exit', res));
	// Wait until the worker has claimed the job (it then calls the stub and
	// reaches the write transaction), give it time to hit the lock, and
	// check it's still stuck there.
	let claimed = false;
	for (let i = 0; i < 60 && !claimed; i++) {
		await sleep(250);
		claimed = (await q(`SELECT 1 FROM job_runs WHERE job_type = 'entity_extract' AND (payload->>'day_id')::int = $1 AND status = 'in_progress'`, [wk])).rowCount === 1;
	}
	await sleep(1500);
	const during = (await links(wk)).length;
	const stillRunning = (await q(`SELECT status FROM job_runs WHERE job_type = 'entity_extract' AND (payload->>'day_id')::int = $1`, [wk])).rows[0]?.status;
	const waiting = (await q(`SELECT count(*)::int n FROM pg_locks WHERE locktype = 'advisory' AND classid = $1 AND objid = $2 AND NOT granted`, [LOCK_DAY, wk])).rows[0].n;
	await holder2.query('COMMIT');
	holder2.release();
	await exited;
	check(
		'the extractor waits for a day lock held by a move',
		claimed && during === 0 && stillRunning === 'in_progress' && waiting === 1 && (await links(wk)).length === 1,
		`claimed=${claimed} during=${during} status=${stillRunning} waiting=${waiting}`
	);

	// ── Claude check (stub) ──
	const c1 = await mkDay('1913-06-01', 'Zqxdupdana and the kids.');
	const c2 = await mkDay('1913-06-02', 'Zqxdupdana at church.');
	const c3 = await mkDay('1913-06-03', 'Zqxdupdada came by.');
	const DANA = await mkEnt('Zqxdupdana');
	const DADA = await mkEnt('Zqxdupdada');
	const OUT = await mkEnt('Zqxdupunrelated');
	for (const d of [c1, c2]) await link(d, DANA);
	await link(c3, DADA);
	let ck = await checkApi(admin, DANA, [DADA]);
	const first = ck.body.results?.[0];
	check('check: answer stored', ck.status === 200 && first?.state === 'done' && first.verdict === 'same', JSON.stringify(ck.body));
	const row = (await q(`SELECT status, verdict, model FROM entity_cleanup_checks WHERE main_id = $1 AND candidate_id = $2`, [DANA, DADA])).rows[0];
	check('check: row is done with the model', row?.status === 'done' && row.verdict === 'same' && row.model === 'claude-sonnet-5-5', JSON.stringify(row));
	ck = await checkApi(admin, DANA, [DADA]);
	check('check: asked again with the same evidence → cached', ck.body.results?.[0]?.state === 'cached', JSON.stringify(ck.body));
	await link(c1, DADA);
	const [p1, p2] = await Promise.all([checkApi(admin, DANA, [DADA]), checkApi(admin, DANA, [DADA])]);
	const states = [p1.body.results?.[0]?.state, p2.body.results?.[0]?.state].sort();
	check('check: changed evidence is asked again, and two overlapping checks pay once', states.join() === 'busy,done', states.join());
	ck = await checkApi(admin, DANA, [OUT]);
	check('check: a candidate outside the group is refused (409)', ck.status === 409, `${ck.status} ${JSON.stringify(ck.body)}`);

	// ── Alias (set on /admin/entities; same entity-graph code) ──
	const AL = await mkEnt('Zqxdupdanaa');
	r = await act(admin, '/admin/entities', 'setAlias', { id: AL, targetId: DANA });
	check('alias is set and audited', r.type === 'success' && (await ent(AL)).alias_of_entity_id == DANA && (await audits('entity_set_alias', AL)) === 1, r.text);

	// ── CODEX code review round 1 ──
	// #1 An alias is a kept spelling: never deletable, so a moved day can't come back as a new entity.
	const s1 = await mkDay('1913-07-01', 'Zqxdupspella was here.');
	const SA = await mkEnt('Zqxdupspella');
	const SB = await mkEnt('Zqxdupspellb');
	await link(s1, SA);
	await act(admin, '/admin/entities', 'moveDay', { dayId: s1, fromId: SA, toId: REB });
	await cleanupAct(admin, 'mergeGroup', { keepId: SB, id: [SA] });
	r = await act(admin, '/admin/entities', 'delete', { id: SA });
	check('#1 deleting an empty alias is refused (it is a kept spelling)', (r.status === 409 || r.type === 'failure') && (await ent(SA)) !== undefined, r.text);
	await reextract(s1, [P('Zqxdupspella')]);
	check('#1 …so re-extracting that spelling stays moved', !(await links(s1)).some((l) => l.e === SA || l.e === SB));

	// #4 Alias carries "not the same" like merge does.
	const NA = await mkEnt('Zqxdupnsa');
	const NB = await mkEnt('Zqxdupnsb');
	const NX = await mkEnt('Zqxdupnsx');
	await cleanupAct(admin, 'notSame', { a: NA, b: NX });
	r = await act(admin, '/admin/entities', 'setAlias', { id: NA, targetId: NB });
	const nsCarried = await q(`SELECT 1 FROM entity_not_same WHERE entity_a = LEAST($1::bigint, $2::bigint) AND entity_b = GREATEST($1::bigint, $2::bigint)`, [NB, NX]);
	check('#4 alias carries "A ≠ X" to "B ≠ X"', r.type === 'success' && nsCarried.rowCount === 1, r.text);
	r = await cleanupAct(admin, 'mergeGroup', { keepId: NB, id: [NX] });
	check('#4 …and B and X can no longer be merged', r.status === 409 || r.type === 'failure', r.text);

	// #5 A day both linked and blocked after a merge: human link wins; otherwise the block wins and AI links go.
	const b1 = await mkDay('1913-07-10', 'Zqxdupjoa and Zqxdupjob.');
	const JA = await mkEnt('Zqxdupjoa');
	const JB = await mkEnt('Zqxdupjob');
	await link(b1, JA);
	await act(admin, '/admin/entities', 'moveDay', { dayId: b1, fromId: JA, toId: JB }); // human JB, block JA
	await cleanupAct(admin, 'mergeGroup', { keepId: JB, id: [JA] });
	const bl = await q(`SELECT 1 FROM day_entity_blocks WHERE day_id = $1`, [b1]);
	check('#5 merged into the family it was moved to: human link kept, block cleared', bl.rowCount === 0 && (await links(b1)).some((l) => l.e === JB && l.source === 'human'));
	const b2 = await mkDay('1913-07-11', 'Zqxdupkoa met Zqxdupkoc.');
	const KA = await mkEnt('Zqxdupkoa');
	const KC = await mkEnt('Zqxdupkoc');
	const KD = await mkEnt('Zqxdupkod');
	await link(b2, KA);
	await act(admin, '/admin/entities', 'moveDay', { dayId: b2, fromId: KA, toId: KD }); // block KA
	await link(b2, KC); // an AI link on the other side
	await cleanupAct(admin, 'mergeGroup', { keepId: KC, id: [KA] });
	check('#5 merged into a family with only an AI link that day: block kept, AI link removed', (await q(`SELECT 1 FROM day_entity_blocks WHERE day_id = $1 AND entity_id = $2`, [b2, KC])).rowCount === 1 && !(await links(b2)).some((l) => l.e === KC));

	// #3 "Wrong" and a custom search are admin decisions, beating an automatic pin.
	const W1 = await mkEnt('Zqxdupwrong', 'place');
	const W2 = await mkEnt('Zqxdupwrongg', 'place');
	await q(`INSERT INTO place_locations (entity_id, status, looked_up_name, candidates, decided_by, decided_at) VALUES ($1, 'needs_review', 'x', '[]', $2, NOW())`, [W2, adminId]);
	await q(`INSERT INTO place_locations (entity_id, status, lat, lon, looked_up_name) VALUES ($1, 'auto', 30.2, -81.6, 'x')`, [W1]);
	r = await cleanupAct(admin, 'mergeGroup', { keepId: W1, id: [W2] });
	const wr = (await q(`SELECT status, decided_at IS NOT NULL AS human FROM place_locations WHERE entity_id = $1`, [W1])).rows[0];
	check('#3 an admin "Wrong" beats an automatic pin on merge', r.type === 'success' && wr?.status === 'needs_review' && wr.human, JSON.stringify(wr));
	const X1 = await mkEnt('Zqxdupsearch', 'place');
	const X2 = await mkEnt('Zqxdupsearchh', 'place');
	await q(`INSERT INTO place_locations (entity_id, status, query, looked_up_name, candidates, decided_at) VALUES ($1, 'needs_review', 'my words', 'x', '[]', NOW())`, [X1]);
	await q(`INSERT INTO place_locations (entity_id, status, lat, lon, looked_up_name) VALUES ($1, 'auto', 30.2, -81.6, 'x')`, [X2]);
	r = await cleanupAct(admin, 'mergeGroup', { keepId: X1, id: [X2] });
	const xr = (await q(`SELECT status, query FROM place_locations WHERE entity_id = $1`, [X1])).rows[0];
	check('#3 an admin search (account removed or not) survives an automatic pin', r.type === 'success' && xr?.query === 'my words', JSON.stringify(xr));
	const X3 = await mkEnt('Zqxdupusedmap', 'place');
	await q(`INSERT INTO place_locations (entity_id, status, query, looked_up_name, candidates, decided_at) VALUES ($1, 'needs_review', 'q', 'x', '[]', NOW())`, [X3]);
	r = await cleanupAct(admin, 'deleteUnused', { id: X3 });
	check('#3 a name with any admin map decision is not "unused"', r.status === 409 || r.type === 'failure', r.text);

	// #2 A map write that waits behind a merge sees the alias and writes nothing.
	const g1 = await mkDay('1913-07-20', 'Zqxduppinme visit.');
	const PIN = await mkEnt('Zqxduppinme', 'place');
	const PINK = await mkEnt('Zqxduppinmee', 'place');
	await link(g1, PIN);
	const hold = await owner.connect();
	await hold.query('BEGIN');
	await hold.query('SELECT pg_advisory_xact_lock(81010, 0)');
	const pinReq = act(admin, '/admin/places', 'pin', { entity_id: PIN, lat: 30.3, lon: -81.6, name: 'Somewhere', address: '' });
	await sleep(700);
	await hold.query(`UPDATE entities SET alias_of_entity_id = $2 WHERE id = $1`, [PIN, PINK]); // a merge that won the race
	await hold.query('COMMIT');
	hold.release();
	r = await pinReq;
	const pinRows = (await q(`SELECT entity_id::int e FROM place_locations WHERE entity_id IN ($1, $2)`, [PIN, PINK])).rows;
	check('#2 a pin that waited behind a merge is refused, nothing left on the old name', (r.status === 409 || r.type === 'failure') && pinRows.length === 0, `${r.status} ${r.text} ${JSON.stringify(pinRows)}`);

	// #6 Claims are fenced by token; a dismissal during the call stores nothing.
	const k1 = await mkDay('1913-08-01', 'Zqxdupfence here.');
	const k2 = await mkDay('1913-08-02', 'Zqxdupfence again.');
	const k3 = await mkDay('1913-08-03', 'Zqxdupfense once.');
	const k4 = await mkDay('1913-08-04', 'Zqxdupfencee once.');
	const FM = await mkEnt('Zqxdupfence');
	const FC = await mkEnt('Zqxdupfense');
	const FD = await mkEnt('Zqxdupfencee');
	for (const d of [k1, k2]) await link(d, FM);
	await link(k3, FC);
	await link(k4, FD);
	// Expired and re-taken: the first request (delay 800 ms) finds its claim taken over.
	const firstReq = checkApi(admin, FM, [FC]);
	await sleep(250);
	await q(`UPDATE entity_cleanup_checks SET claimed_at = NOW() - interval '5 minutes' WHERE main_id = $1 AND candidate_id = $2`, [FM, FC]);
	const second = await checkApi(admin, FM, [FC]);
	const firstRes = await firstReq;
	const fr = (await q(`SELECT status, claim_token FROM entity_cleanup_checks WHERE main_id = $1 AND candidate_id = $2`, [FM, FC])).rows[0];
	check('#6 an expired, re-taken claim: the old request stores nothing, the new one stores its answer',
		firstRes.body.results?.[0]?.state === 'changed' && second.body.results?.[0]?.state === 'done' && fr?.status === 'done',
		`${JSON.stringify(firstRes.body)} ${JSON.stringify(second.body)} ${JSON.stringify(fr)}`);
	// Dismissed while Claude is answering.
	const inflight = checkApi(admin, FM, [FD]);
	await sleep(250);
	await cleanupAct(admin, 'notSame', { a: FM, b: FD });
	const infl = await inflight;
	const left = (await q(`SELECT 1 FROM entity_cleanup_checks WHERE main_id = $1 AND candidate_id = $2`, [FM, FD])).rowCount;
	check('#6 a pair marked not-the-same during the call stores no answer', infl.body.results?.[0]?.state === 'changed' && left === 0, JSON.stringify(infl.body));
	await cleanupAct(admin, 'undoNotSame', { a: FM, b: FD });
	// Mixed batch: one cached, one new.
	const mixed = await checkApi(admin, FM, [FC, FD]);
	const st = Object.fromEntries((mixed.body.results ?? []).map((x) => [x.candidateId, x.state]));
	check('#6 a mixed batch: cached answers reused, only the new one asked', st[FC] === 'cached' && st[FD] === 'done', JSON.stringify(mixed.body));

	// ── CODEX9 review ──
	// #1 A merge waiting for a day the extractor holds holds no entity row
	// locks yet, so the extractor's link insert (a foreign-key share lock on
	// the name) goes straight through instead of deadlocking with it.
	const ka = await mkDay('1913-09-01', 'Zqxdupkeepa came.');
	const kb = await mkDay('1913-09-02', 'Zqxdupkeepb came.');
	const kc = await mkDay('1913-09-03', 'Zqxdupkeepb again.');
	const KEEPA = await mkEnt('Zqxdupkeepa');
	const SRCB = await mkEnt('Zqxdupkeepb');
	await link(ka, KEEPA);
	await link(kb, SRCB);
	const ex = await owner.connect();
	await ex.query('BEGIN');
	await ex.query('SELECT pg_advisory_xact_lock($1, $2)', [LOCK_DAY, kb]); // the extractor is rebuilding kb
	const mergeP = cleanupAct(admin, 'mergeGroup', { keepId: KEEPA, id: [SRCB] });
	await sleep(500); // the merge is now waiting for kb's lock
	const t0 = Date.now();
	let exErr = null;
	try {
		await ex.query(`SET LOCAL lock_timeout = '3s'`);
		await ex.query(`INSERT INTO day_entities (day_id, entity_id, source, confidence_score) VALUES ($1, $2, 'ai', 0.8)`, [kc, SRCB]);
		await ex.query('COMMIT');
	} catch (e) {
		exErr = e.message;
		await ex.query('ROLLBACK').catch(() => {});
	}
	const exMs = Date.now() - t0;
	ex.release();
	const mr = await mergeP;
	// The merge then sees entries that changed while it waited, so it refuses
	// cleanly (final #1) rather than deadlocking or merging on stale evidence.
	check('#1 the extractor links a day to a name while a merge of it waits: no block, no deadlock', !exErr && exMs < 900 && mr.type === 'failure' && /changed since this page loaded/.test(mr.text), `${exErr} ${exMs}ms ${mr.text}`);
	check('#1 …and that new link is intact, still on its own name', (await links(kc)).some((l) => l.e === SRCB) && (await ent(SRCB)).alias_of_entity_id === null, JSON.stringify(await links(kc)));

	// #2 A stale "alias of" form can't repoint a name that is already an alias.
	const XA = await mkEnt('Zqxdupstalea');
	const XB = await mkEnt('Zqxdupstaleb');
	const XC = await mkEnt('Zqxdupstalec');
	await act(admin, '/admin/entities', 'setAlias', { id: XA, targetId: XB });
	r = await act(admin, '/admin/entities', 'setAlias', { id: XA, targetId: XC });
	check('#2 a stale alias request is refused and the alias stays put', r.type === 'failure' && Number((await ent(XA)).alias_of_entity_id) === XB, r.text);

	// #3 Deleting an "unused" name while the extractor is linking a day to it
	// waits for that link to commit, then refuses: the link isn't cascaded away.
	const UR = await mkEnt('Zqxdupracer');
	const ud = await mkDay('1913-09-10', 'Zqxdupracer was here.');
	const ex3 = await owner.connect();
	await ex3.query('BEGIN');
	await ex3.query(`INSERT INTO day_entities (day_id, entity_id, source, confidence_score) VALUES ($1, $2, 'ai', 0.8)`, [ud, UR]);
	const delP = cleanupAct(admin, 'deleteUnused', { id: UR });
	await sleep(500);
	await ex3.query('COMMIT');
	ex3.release();
	const dr = await delP;
	check('#3 delete waits for a link being made, then refuses; the name and link survive', dr.type === 'failure' && Boolean(await ent(UR)) && (await links(ud)).length === 1, `${dr.type} ${dr.text}`);

	// #5 A name marked "not the same" isn't unused: deleting it would cascade the decision away.
	const NS1 = await mkEnt('Zqxdupnsone');
	const NS2 = await mkEnt('Zqxdupnstwo');
	await cleanupAct(admin, 'notSame', { a: NS1, b: NS2 });
	r = await cleanupAct(admin, 'deleteUnused', { id: NS1 });
	const nsLeft = (await q(`SELECT 1 FROM entity_not_same WHERE entity_a = $1 AND entity_b = $2`, [Math.min(NS1, NS2), Math.max(NS1, NS2)])).rowCount;
	check('#5 a name marked "not the same" can\'t be deleted as unused; the mark stays', r.type === 'failure' && Boolean(await ent(NS1)) && nsLeft === 1, r.text);
	const pd = await pageData(admin, '/admin/entities/cleanup');
	const unusedIds = (pd.find((n) => n.unused)?.unused ?? []).map((u) => u.id);
	check('#5 …and isn\'t listed as Unused', !unusedIds.includes(NS1) && !unusedIds.includes(NS2), JSON.stringify(unusedIds));

	// #8 A stored answer goes stale when the text Claude read, or the alias names, change.
	const w1 = await mkDay('1913-10-01', 'Zqxdupwilma baked bread.');
	const w2 = await mkDay('1913-10-02', 'Zqxdupwilma at the lake.');
	const w3 = await mkDay('1913-10-03', 'Zqxdupwilmb came by.');
	const WM = await mkEnt('Zqxdupwilma');
	const WC = await mkEnt('Zqxdupwilmb');
	for (const d of [w1, w2]) await link(d, WM);
	await link(w3, WC);
	ck = await checkApi(admin, WM, [WC]);
	const wFirst = ck.body.results?.[0]?.state;
	ck = await checkApi(admin, WM, [WC]);
	const wCached = ck.body.results?.[0]?.state;
	await enqueueFixture(w3, 'Zqxdupwilmb, the neighbour from Ohio, came by.');
	await q(`DELETE FROM job_runs WHERE job_type = 'entity_extract' AND (payload->>'day_id')::int = $1`, [w3]);
	ck = await checkApi(admin, WM, [WC]);
	const wAfterText = ck.body.results?.[0]?.state;
	const WAL = await mkEnt('Zqxdupwilmbb');
	await q(`UPDATE entities SET alias_of_entity_id = $2 WHERE id = $1`, [WAL, WC]);
	ck = await checkApi(admin, WM, [WC]);
	const wAfterAlias = ck.body.results?.[0]?.state;
	check(
		'#8 a corrected passage or a new alias name means asking again, not the cached answer',
		wFirst === 'done' && wCached === 'cached' && wAfterText === 'done' && wAfterAlias === 'done',
		[wFirst, wCached, wAfterText, wAfterAlias].join()
	);

	// #12 /admin/entities counts a main name's whole family; an alias its own days.
	const FAMC = await mkEnt('Zqxdupfamcanon');
	const FAMA = await mkEnt('Zqxdupfamalias');
	await q(`UPDATE entities SET alias_of_entity_id = $2 WHERE id = $1`, [FAMA, FAMC]);
	const f1 = await mkDay('1913-10-10', 'Zqxdup x');
	const f2 = await mkDay('1913-10-11', 'Zqxdup y');
	await link(f1, FAMA);
	await link(f2, FAMA);
	await link(f1, FAMC);
	const ed = await pageData(admin, '/admin/entities');
	const erows = ed.find((n) => n.entities)?.entities ?? [];
	const rc = erows.find((x) => Number(x.id) === FAMC);
	const ra = erows.find((x) => Number(x.id) === FAMA);
	check('#12 a main name shows its family\'s distinct days (2), an alias its own (2)', rc?.mention_count === 2 && ra?.mention_count === 2, JSON.stringify([rc, ra]));

	// ── CODEX9 re-review ──
	// #1 A link the extractor commits while a merge is moving links isn't
	// lost. A test-only trigger holds the merge inside its move (on inserting
	// the source's link onto the survivor) while a new source link commits.
	const bk = await mkDay('1913-11-01', 'Zqxdupbarkeep came.');
	const bs = await mkDay('1913-11-02', 'Zqxdupbarsrc came.');
	const bz = await mkDay('1913-11-03', 'Zqxdupbarsrc again.');
	const BK = await mkEnt('Zqxdupbarkeep');
	const BS = await mkEnt('Zqxdupbarsrc');
	await link(bk, BK);
	await link(bs, BS);
	await q(`CREATE FUNCTION zqxdup_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
	         BEGIN IF NEW.entity_id = ${Number(BK)} AND NEW.day_id = ${Number(bs)} THEN PERFORM pg_advisory_xact_lock(81099, 1); PERFORM pg_advisory_xact_lock(81099, 2); END IF; RETURN NEW; END $$`);
	await q(`CREATE TRIGGER zqxdup_barrier BEFORE INSERT ON day_entities FOR EACH ROW EXECUTE FUNCTION zqxdup_barrier()`);
	// The gate: held by this test, waited on by the trigger, released only
	// after the late link has committed. No timing involved.
	const gate = await owner.connect();
	await gate.query('SELECT pg_advisory_lock(81099, 2)');
	try {
		const mp = cleanupAct(admin, 'mergeGroup', { keepId: BK, id: [BS] });
		// Wait until the merge is really inside its move: the trigger takes a
		// marker lock (visible in pg_locks to any role), then waits at the gate.
		let inside = false;
		for (let i = 0; i < 60 && !inside; i++) {
			inside = (await q(`SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND classid = 81099 AND objid = 1 AND granted`)).rowCount > 0;
			if (!inside) await sleep(50);
		}
		await link(bz, BS); // committed now, mid-move, on a day outside the merge's locked set
		await gate.query('SELECT pg_advisory_unlock(81099, 2)'); // let the merge finish
		const res = await mp;
		const zl = await links(bz);
		check('re #1 a link committed mid-merge survives, still on the source (an alias that reads as the survivor)', inside && res.type === 'success' && zl.length === 1 && zl[0].e === Number(BS), `inside=${inside} ${res.text} ${JSON.stringify(zl)}`);
	} finally {
		await gate.query('SELECT pg_advisory_unlock_all()').catch(() => {});
		gate.release();
		await dropBarrier();
	}

	// #2 Two tabs checking overlapping candidates in opposite orders don't deadlock.
	let deadlocked = 0;
	for (let i = 0; i < 3; i++) {
		const od = await mkDay(`1913-11-${10 + i}`, `Zqxdupordmain${i} here.`);
		const oa = await mkDay(`1913-11-${20 + i}`, `Zqxdupordmaim${i} here.`);
		const ob = await mkDay(`1913-12-${10 + i}`, `Zqxdupordmaix${i} here.`);
		const OM = await mkEnt(`Zqxdupordmain${i}`);
		const OA = await mkEnt(`Zqxdupordmaim${i}`);
		const OB = await mkEnt(`Zqxdupordmaix${i}`);
		await link(od, OM);
		await link(await mkDay(`1913-12-${20 + i}`, `Zqxdupordmain${i} again.`), OM);
		await link(oa, OA);
		await link(ob, OB);
		const [x, y] = await Promise.all([checkApi(admin, OM, [OA, OB]), checkApi(admin, OM, [OB, OA])]);
		if (x.status !== 200 || y.status !== 200) deadlocked++;
	}
	check('re #2 overlapping checks in opposite orders both succeed', deadlocked === 0, String(deadlocked));

	// #3 A check sent with the fingerprint the page showed: stale → 'changed', nothing asked or stored.
	const sm = await mkDay('1913-12-01', 'Zqxdupfpmain here.');
	const sc = await mkDay('1913-12-02', 'Zqxdupfpmaim here.');
	const SM = await mkEnt('Zqxdupfpmain');
	const SC = await mkEnt('Zqxdupfpmaim');
	await link(sm, SM);
	await link(await mkDay('1913-12-03', 'Zqxdupfpmain again.'), SM);
	await link(sc, SC);
	const cd = await pageData(admin, '/admin/entities/cleanup');
	const shownFp = (cd.find((n) => n.groups)?.groups ?? []).find((g) => g.main.id === SM)?.candidates.find((c) => c.id === SC)?.fp;
	ck = await checkApi(admin, SM, [SC], { [SC]: 'f'.repeat(32) });
	const staleRows = (await q(`SELECT 1 FROM entity_cleanup_checks WHERE main_id = $1 AND candidate_id = $2`, [SM, SC])).rowCount;
	check('re #3 a check for evidence the page no longer shows is "changed", nothing stored', ck.body.results?.[0]?.state === 'changed' && staleRows === 0, JSON.stringify(ck.body));
	ck = await checkApi(admin, SM, [SC], { [SM]: 'f'.repeat(32) });
	check('re #3 a fingerprint map that leaves out a requested name is refused (400)', ck.status === 400, `${ck.status} ${JSON.stringify(ck.body)}`);
	const nullBody = await fetch(`${BASE}/admin/entities/cleanup/check`, {
		method: 'POST',
		headers: { cookie: admin, Origin: BASE, 'Content-Type': 'application/json' },
		body: 'null'
	});
	check('a JSON null body is a 400, not a 500', nullBody.status === 400, String(nullBody.status));
	ck = await checkApi(admin, SM, [SC], { [SC]: shownFp });
	check('re #3 …and with the fingerprint it shows, it is asked', typeof shownFp === 'string' && ck.body.results?.[0]?.state === 'done', `${shownFp} ${JSON.stringify(ck.body)}`);

	// ── CODEX9 final review ──
	// #1 A merge from a group card carries the fingerprints the page showed;
	// if the entries changed since (another tab, the extractor), it's refused.
	const gm1 = await mkDay('1913-02-21', 'Zqxdupgatemain here.');
	const gm2 = await mkDay('1913-02-22', 'Zqxdupgatemain again.');
	const gc1 = await mkDay('1913-02-23', 'Zqxdupgatemaim here.');
	const GM = await mkEnt('Zqxdupgatemain');
	const GC = await mkEnt('Zqxdupgatemaim');
	await link(gm1, GM);
	await link(gm2, GM);
	await link(gc1, GC);
	const fpOf = async (mainId, candId) =>
		((await pageData(admin, '/admin/entities/cleanup')).find((n) => n.groups)?.groups ?? [])
			.find((g) => g.main.id === mainId)
			?.candidates.find((c) => c.id === candId)?.fp;
	const oldFp = await fpOf(GM, GC);
	await link(await mkDay('1913-02-24', 'Zqxdupgatemaim, someone else, in Ohio.'), GC); // the entries change after the page loaded
	r = await cleanupAct(admin, 'mergeGroup', { keepId: GM, id: [GC], mainId: GM, [`fp:${GC}`]: oldFp });
	check('final #1 a merge on entries that changed since the page loaded is refused (409), nothing merged', r.type === 'failure' && /changed since this page loaded/.test(r.text) && (await ent(GC)).alias_of_entity_id === null, `${oldFp} ${r.text}`);
	r = await cleanupAct(admin, 'mergeGroup', { keepId: GM, id: [GC], mainId: GM });
	check('final #1 …as is one that leaves out a name\'s fingerprint', r.type === 'failure' && (await ent(GC)).alias_of_entity_id === null, r.text);
	const newFp = await fpOf(GM, GC);
	r = await cleanupAct(admin, 'mergeGroup', { keepId: GC, id: [GM], mainId: GM, [`fp:${GC}`]: newFp });
	check('final #1 …and with the current fingerprint it merges (keeping the candidate)', r.type === 'success' && Number((await ent(GM)).alias_of_entity_id) === GC, `${newFp} ${r.text}`);

	// final #2 The old form shape (no main name or fingerprints) is refused.
	const OF1 = await mkEnt('Zqxdupoldforma');
	const OF2 = await mkEnt('Zqxdupoldformb');
	r = await act(admin, '/admin/entities/cleanup', 'mergeGroup', { keepId: OF1, id: [OF2] });
	check('final #2 a merge without the main name and fingerprints is refused (400)', r.type === 'failure' && (await ent(OF2)).alias_of_entity_id === null, r.text);

	// final #1 (re) The evidence is checked once the merge holds its day
	// locks: an extraction that held one of those days and changed the
	// entries while the merge waited makes the merge refuse.
	const wm = await mkDay('1913-02-25', 'Zqxdupwaitmain here.');
	const wm2 = await mkDay('1913-02-26', 'Zqxdupwaitmain again.');
	const wc = await mkDay('1913-02-27', 'Zqxdupwaitmaim here.');
	const WTM = await mkEnt('Zqxdupwaitmain');
	const WTC = await mkEnt('Zqxdupwaitmaim');
	await link(wm, WTM);
	await link(wm2, WTM);
	await link(wc, WTC);
	const wfp = (await fingerprints(admin, WTM, [WTC]))[WTC];
	const wx = await owner.connect();
	await wx.query('BEGIN');
	await wx.query('SELECT pg_advisory_xact_lock($1, $2)', [LOCK_DAY, wc]); // an extraction is rebuilding wc
	const wmerge = cleanupAct(admin, 'mergeGroup', { keepId: WTM, id: [WTC], mainId: WTM, [`fp:${WTC}`]: wfp });
	let waitingMerge = false;
	for (let i = 0; i < 60 && !waitingMerge; i++) {
		waitingMerge = (await q(`SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND classid = $1 AND objid = $2 AND NOT granted`, [LOCK_DAY, wc])).rowCount > 0;
		if (!waitingMerge) await sleep(50);
	}
	// …and links the name to a new day before it commits.
	const wnew = await mkDay('1913-02-28', 'Zqxdupwaitmaim, the one from Ohio.');
	await wx.query(`INSERT INTO day_entities (day_id, entity_id, source, confidence_score) VALUES ($1, $2, 'ai', 0.8)`, [wnew, WTC]);
	await wx.query('COMMIT');
	wx.release();
	const wres = await wmerge;
	check(
		'final #1 entries changed by an extraction the merge waited for: refused (409), no merge, no audit row',
		waitingMerge && wres.type === 'failure' && /changed since this page loaded/.test(wres.text) && (await ent(WTC)).alias_of_entity_id === null && (await audits('entity_merge', WTC)) === 0,
		`waiting=${waitingMerge} ${wres.text}`
	);

	// ── Page renders ──
	const page = async () => {
		const h = await (await fetch(`${BASE}/admin/entities/cleanup?type=person`, { headers: { cookie: admin } })).text();
		const u = h.indexOf('id="sec-unused"');
		const n = h.indexOf('id="sec-notsame"');
		return { html: h, dups: h.slice(h.indexOf('id="sec-dups"'), u), unused: h.slice(u, n) };
	};
	let pg = await page();
	check('the page lists a fixture group', pg.html.includes('Zqxdupdana') && pg.html.includes('Find duplicates'));
	check('the page has the three sections and jump links', pg.dups.length > 0 && pg.unused.length > 0 && /href="#sec-unused"/.test(pg.html) && /href="#sec-notsame"/.test(pg.html));

	// ── td-a7920d: a correction removes a name's last day ("J S Paige") ──
	// It stops being suggested and is offered under Unused instead.
	const jm = await mkEnt('Zqxdupjspaige');
	const jc = await mkEnt('Zqxdup J S Paige');
	for (const d of ['1914-03-01', '1914-03-02', '1914-03-03']) await link(await mkDay(d, 'Zqxdupjspaige came by.'), jm);
	const jday = await mkDay('1914-03-04', 'Zqxdup J S Paige.');
	await link(jday, jc);
	pg = await page();
	check('td-a7920d before: the name with a day is suggested, not unused', pg.dups.includes('Zqxdup J S Paige') && !pg.unused.includes('Zqxdup J S Paige'));
	// The corrected day now names only the main person; re-extraction drops the stray link.
	await reextract(jday, [P('Zqxdupjspaige')]);
	pg = await page();
	check(
		'td-a7920d after the correction: no longer suggested, listed under Unused with Delete',
		(await links(jday)).every((l) => l.e !== jc) && !pg.dups.includes('Zqxdup J S Paige') && pg.unused.includes('Zqxdup J S Paige') && /Delete…/.test(pg.unused)
	);
}

// One suite at a time: every run shares the fixture users and the zqxdup
// names, and its start and end cleanups delete them, so two overlapping runs
// break each other (CODEX9 re-review). A session advisory lock on its own
// connection is held from before the first cleanup until after the last.
const SUITE_LOCK = [81098, 1];
const suiteLock = await owner.connect();
let gotLock = false;
for (let waited = 0; !gotLock; waited += 2) {
	gotLock = (await suiteLock.query('SELECT pg_try_advisory_lock($1, $2) AS ok', SUITE_LOCK)).rows[0].ok;
	if (gotLock) break;
	if (waited === 0) console.log('Another run of this suite is going; waiting for it to finish…');
	if (waited >= 900) {
		console.error('refusing: another run of this suite has held the lock for 15 minutes');
		suiteLock.release();
		await owner.end();
		process.exit(1);
	}
	await sleep(2000);
}

try {
	await main();
} catch (e) {
	console.error('ERROR', e);
	fail++;
} finally {
	await cleanup().catch((e) => {
		console.error('cleanup failed', e);
		fail++;
	});
	await suiteLock.query('SELECT pg_advisory_unlock($1, $2)', SUITE_LOCK).catch(() => {});
	suiteLock.release();
	await owner.end();
	console.log(`\n${pass}/${pass + fail} passed`);
	if (fail) process.exitCode = 1;
}
