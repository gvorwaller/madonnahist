#!/usr/bin/env node
// Writers and memories (migration 0032; plan
// docs/2026-11-16-writers-and-memories-plan.md).
//
// Runs against a dev server already started on the isolated test stack:
//   npx vite dev --host 127.0.0.1 --port 5177 --strictPort --mode test
//
// Self-provisions writers, a viewer, a corrector and an admin in
// madonnahist_test (127.0.0.1:15434), plus a captured February 1901 with one
// accepted and one pending day. Drives the real pages and form actions over
// HTTP and cleans up in a finally block. Never touches port 5433/5435 or
// PGDATABASE=madonnahist.
//
// What this asserts:
//   - only a writer with adds_memories may open /app/memories or save; a
//     viewer, a disabled writer and signed-out visitors can't; the menu link
//     follows the same rule
//   - posted writer_id / created_by are ignored
//   - a draft is visible only to its author; share shows it to the family,
//     unshare hides it again
//   - a second writer gets 404 on someone else's memory for every action
//   - a stale save, share, unshare or delete is refused (409) and changes
//     nothing; Save on a shared memory keeps it shared
//   - date rules: precision, 1900 onward, not after today in UTC+14, Feb 30,
//     non-leap Feb 29 refused, a real leap day accepted; month/year moved to
//     the 1st; blank and over-long text refused; the DB CHECKs hold too
//   - a memory-only Day page shows the memory but never the pending day's
//     text or memory, has no Share and no handwriting panel, keeps Prev/Next
//   - an uncaptured Month shows its memories without requesting a page
//     image; Year memories show
//   - text never reaches audit_log; memory_revisions keeps it; workers can't
//     read memories, revisions or writers; the app can't change revisions
//   - delete: gone, recoverable from memory_revisions, audited
//   - an account that wrote a memory ("(memories)"), or is only linked to a
//     writer ("set up to write memories"), can't be deleted permanently
//
// Usage: node scripts/test-memories.mjs [baseUrl]   (or: npm run test:memories)

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
	if (process.env.MADONNAHIST_ENV !== 'test') problems.push('MADONNAHIST_ENV must be "test"');
	if (process.env.PGPORT === '5433' || process.env.PGPORT === '5435') {
		problems.push(
			`refusing reserved port ${process.env.PGPORT} (5433=BTC-dashboard, 5435=production tunnel)`
		);
	}
	if (process.env.PGDATABASE === 'madonnahist')
		problems.push('refusing production database name "madonnahist"');
	if (!process.env.PGDATABASE || !process.env.PGPASSWORD) {
		problems.push('PGDATABASE/PGPASSWORD must be set (copy .env.test.example to .env.test)');
	}
	if (!process.env.MIGRATION_PGPASSWORD || !process.env.WORKER_PGPASSWORD) {
		problems.push('MIGRATION_PGPASSWORD and WORKER_PGPASSWORD must be set in .env.test');
	}
	return problems;
}

const BASE_URL = process.argv[2] ?? 'http://127.0.0.1:5177';
const SESSION_COOKIE_NAME = 'madonnahist_session';
const TEST_PASSWORD = 'MemoryTest!2026';
const WRITER = '_mem_writer';
const WRITER2 = '_mem_writer2';
const VIEWER = '_mem_viewer';
const CORRECTOR = '_mem_corr';
const ADMIN = '_mem_admin';
const EVERYONE = [WRITER, WRITER2, VIEWER, CORRECTOR, ADMIN];
const WRITER_NAME = 'Memtester';
const FIX_YEAR = 1901;
const FIX_SESSION = '_mem_fixture';
const ACCEPTED = '1901-02-10';
const PENDING = '1901-02-11';
const ARGON2_OPTS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };

let pass = 0;
let fail = 0;
const rows = [];
function record(label, ok, detail = '') {
	if (ok) pass++;
	else fail++;
	rows.push({ label, ok, detail });
}

async function req(url, opts = {}) {
	return fetch(`${BASE_URL}${url}`, {
		...opts,
		redirect: 'manual',
		headers: { Accept: 'text/html', ...(opts.headers ?? {}) }
	});
}

function sessionCookie(res) {
	const all =
		typeof res.headers.getSetCookie === 'function'
			? res.headers.getSetCookie()
			: [res.headers.get('set-cookie')].filter(Boolean);
	for (const c of all) {
		const m = c.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`));
		if (m && m[1]) return `${SESSION_COOKIE_NAME}=${m[1]}`;
	}
	return null;
}

async function loginCookie(username) {
	const res = await req(`/login?/login`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: BASE_URL },
		body: new URLSearchParams({ username, password: TEST_PASSWORD }).toString()
	});
	const cookie = sessionCookie(res);
	if (res.status !== 303 || !cookie) throw new Error(`login for ${username} failed (${res.status})`);
	return cookie;
}

/** Form POST as use:enhance does: JSON {type, status, data | location}. */
async function action(pathAndAction, fields, cookie) {
	const res = await req(pathAndAction, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
			Origin: BASE_URL,
			'x-sveltekit-action': 'true',
			Accept: 'application/json',
			...(cookie ? { Cookie: cookie } : {})
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
	/** Status as the browser sees it: the HTTP status, or the action's own. */
	const status = json?.status ?? res.status;
	return { httpStatus: res.status, status, json, text };
}

async function getPage(url, cookie) {
	const res = await req(url, { headers: cookie ? { Cookie: cookie } : {} });
	return { status: res.status, html: await res.text(), location: res.headers.get('location') };
}

function latestToday() {
	return new Date(Date.now() + 14 * 3_600_000).toISOString().slice(0, 10);
}
function addDays(date, n) {
	const d = new Date(date + 'T00:00:00Z');
	d.setUTCDate(d.getUTCDate() + n);
	return d.toISOString().slice(0, 10);
}

/** Fields for a day memory on YYYY-MM-DD. */
function dayFields(date, body, intent = 'keep', extra = {}) {
	return {
		precision: 'day',
		year: date.slice(0, 4),
		month: String(Number(date.slice(5, 7))),
		day: String(Number(date.slice(8, 10))),
		body,
		intent,
		...extra
	};
}

/** Id from a "redirect" action result's #m-<id>. */
function savedId(r) {
	const m = /#m-(\d+)$/.exec(r.json?.location ?? '');
	return m ? Number(m[1]) : null;
}

async function provisionUser(pool, username, role) {
	const hash = await argon2.hash(TEST_PASSWORD, ARGON2_OPTS);
	const res = await pool.query(
		`INSERT INTO users (username, display_name, role, password_hash)
		 VALUES ($1, $2, $3, $4) RETURNING id`,
		[username, `Memory test ${username}`, role, hash]
	);
	return res.rows[0].id;
}

async function cleanup(owner) {
	const ids = (
		await owner.query(`SELECT id FROM users WHERE username = ANY($1)`, [EVERYONE])
	).rows.map((r) => r.id);
	if (ids.length > 0) {
		const memIds = (
			await owner.query(
				`SELECT DISTINCT memory_id AS id FROM memory_revisions WHERE revised_by = ANY($1)
				 UNION SELECT id FROM memories WHERE created_by = ANY($1)`,
				[ids]
			)
		).rows.map((r) => r.id);
		await owner.query(`DELETE FROM memories WHERE created_by = ANY($1)`, [ids]);
		await owner.query(`DELETE FROM memory_revisions WHERE revised_by = ANY($1)`, [ids]);
		await owner.query(
			`DELETE FROM audit_log
			  WHERE user_id = ANY($1)
			     OR (entity_type = 'memories' AND entity_id = ANY($2))
			     OR (entity_type = 'users' AND entity_id = ANY($1))`,
			[ids, memIds]
		);
		await owner.query(`DELETE FROM writers WHERE user_id = ANY($1)`, [ids]);
		await owner.query(`UPDATE users SET removed_by = NULL WHERE removed_by = ANY($1)`, [ids]);
		await owner.query(`DELETE FROM sessions WHERE user_id = ANY($1)`, [ids]);
		await owner.query(`DELETE FROM users WHERE id = ANY($1)`, [ids]);
	}
	await owner.query(
		`DELETE FROM calendar_days WHERE page_id IN
		   (SELECT id FROM calendar_pages WHERE capture_session = $1)`,
		[FIX_SESSION]
	);
	await owner.query(`DELETE FROM calendar_pages WHERE capture_session = $1`, [FIX_SESSION]);
}

async function main() {
	const problems = requireTestSafety();
	if (problems.length) {
		console.error('Refusing to run:\n  ' + problems.join('\n  '));
		process.exitCode = 1;
		return;
	}
	const base = {
		host: process.env.PGHOST ?? '127.0.0.1',
		port: Number(process.env.PGPORT),
		database: process.env.PGDATABASE
	};
	const app = new pg.Pool({ ...base, user: process.env.PGUSER, password: process.env.PGPASSWORD });
	const owner = new pg.Pool({
		...base,
		user: process.env.MIGRATION_PGUSER,
		password: process.env.MIGRATION_PGPASSWORD
	});
	const worker = new pg.Pool({
		...base,
		user: process.env.WORKER_PGUSER,
		password: process.env.WORKER_PGPASSWORD
	});

	try {
		await cleanup(owner);

		// ── Fixtures ──
		const writerId = await provisionUser(owner, WRITER, 'viewer');
		const writer2Id = await provisionUser(owner, WRITER2, 'viewer');
		await provisionUser(owner, VIEWER, 'viewer');
		const corrId = await provisionUser(owner, CORRECTOR, 'corrector');
		await provisionUser(owner, ADMIN, 'admin');
		const w1 = (
			await owner.query(
				`INSERT INTO writers (slug, display_name, user_id, adds_memories)
				 VALUES ('mem-test-1', $1, $2, TRUE) RETURNING id`,
				[WRITER_NAME, writerId]
			)
		).rows[0].id;
		const w2 = (
			await owner.query(
				`INSERT INTO writers (slug, display_name, user_id, adds_memories)
				 VALUES ('mem-test-2', 'Memtester Two', $1, TRUE) RETURNING id`,
				[writer2Id]
			)
		).rows[0].id;
		await owner.query(
			`INSERT INTO writers (slug, display_name, user_id, adds_memories)
			 VALUES ('mem-test-off', 'Memtester Off', $1, FALSE)`,
			[corrId]
		);
		const pageId = (
			await owner.query(
				`INSERT INTO calendar_pages (year, month, page_image_path, capture_session)
				 VALUES ($1, 2, 'fixtures/mem-test/page.jpg', $2) RETURNING id`,
				[FIX_YEAR, FIX_SESSION]
			)
		).rows[0].id;
		await owner.query(
			`INSERT INTO calendar_days (page_id, entry_date, corrected_text, day_narrative, correction_status, corrected_at)
			 VALUES ($1, $2, 'MEMTEST-ACCEPTED-TEXT', 'MEMTEST-MADONNA-MEMORY', 'accepted', NOW()),
			        ($1, $3, 'MEMTEST-PENDING-LEAK', 'MEMTEST-PENDING-NARR', 'pending', NULL)`,
			[pageId, ACCEPTED, PENDING]
		);

		const cW = await loginCookie(WRITER);
		const cW2 = await loginCookie(WRITER2);
		const cV = await loginCookie(VIEWER);
		const cC = await loginCookie(CORRECTOR);
		const cA = await loginCookie(ADMIN);
		const mem = async (id) =>
			(await owner.query(`SELECT *, memory_date::text AS d FROM memories WHERE id = $1`, [id])).rows[0];
		const version = async (id) =>
			(await owner.query(`SELECT updated_at::text AS v FROM memories WHERE id = $1`, [id])).rows[0]?.v;

		// ── Who may write ──
		{
			const w = await getPage('/app/memories', cW);
			record('writer opens My memories', w.status === 200 && w.html.includes('My memories'), String(w.status));
			const v = await getPage('/app/memories', cV);
			record('viewer gets 403 on My memories', v.status === 403, String(v.status));
			const c = await getPage('/app/memories/new', cC);
			record('disabled writer (corrector) gets 403 on Add', c.status === 403, String(c.status));
			const out = await getPage('/app/memories');
			record('signed out is sent to sign in', out.status === 303 || out.status === 302, String(out.status));
			const vs = await action('/app/memories/new?/save', dayFields(PENDING, 'MEMTEST-VIEWER'), cV);
			record('viewer cannot save a memory', vs.status === 403, String(vs.status));
			const cs = await action('/app/memories/new?/save', dayFields(PENDING, 'MEMTEST-CORR'), cC);
			record('disabled writer cannot save a memory', cs.status === 403, String(cs.status));
			const n = await owner.query(`SELECT count(*)::int AS n FROM memories WHERE body LIKE 'MEMTEST-VIEWER%' OR body LIKE 'MEMTEST-CORR%'`);
			record('…and nothing was stored', n.rows[0].n === 0);
			const menuW = await getPage('/app', cW);
			const menuV = await getPage('/app', cV);
			record(
				'menu shows My memories to writers only',
				menuW.html.includes('href="/app/memories"') && !menuV.html.includes('href="/app/memories"')
			);
		}

		// ── Draft on a pending (not transcribed) day ──
		let draftId;
		{
			const r = await action(
				'/app/memories/new?/save',
				dayFields(PENDING, 'MEMTEST-DRAFT <script>alert(1)</script>', 'keep', {
					writer_id: String(w2),
					created_by: String(writer2Id)
				}),
				cW
			);
			draftId = savedId(r);
			record(
				'save draft lands on the day page',
				r.json?.type === 'redirect' && r.json.location === `/app/day/${PENDING}#m-${draftId}`,
				r.text.slice(0, 160)
			);
			const row = await mem(draftId);
			record('draft: not shared', row && row.shared_at === null);
			record(
				'posted writer_id / created_by ignored',
				row && row.writer_id === w1 && row.created_by === writerId,
				JSON.stringify({ w: row?.writer_id, c: row?.created_by })
			);
			const asV = await getPage(`/app/day/${PENDING}`, cV);
			record(
				'viewer: draft invisible, plain "not transcribed" page',
				asV.status === 200 && !asV.html.includes('MEMTEST-DRAFT') && asV.html.includes('Not transcribed yet')
			);
			const asW = await getPage(`/app/day/${PENDING}`, cW);
			record(
				'author sees own draft with Draft badge',
				asW.html.includes('MEMTEST-DRAFT') && asW.html.includes('Draft — only you')
			);
			record(
				'memory text is escaped',
				asW.html.includes('MEMTEST-DRAFT &lt;script>alert(1)&lt;/script>') &&
					!asW.html.includes('<script>alert(1)')
			);
			record(
				"memory-only day never shows the pending day's text or memory",
				!asW.html.includes('MEMTEST-PENDING-LEAK') && !asW.html.includes('MEMTEST-PENDING-NARR')
			);
			record(
				'memory-only day: no Share, no handwriting panel, Prev/Next present',
				!asW.html.includes('Share this day') &&
					!asW.html.includes("photo of this day's handwriting") &&
					asW.html.includes('Nearby days') &&
					asW.html.includes(`/app/day/${ACCEPTED}`)
			);
		}

		// ── Share, then the family sees it ──
		{
			const r = await action(
				`/app/memories/${draftId}?/save`,
				dayFields(PENDING, 'MEMTEST-DRAFT shared now', 'share', { version: await version(draftId) }),
				cW
			);
			record('Save and share', r.json?.type === 'redirect', r.text.slice(0, 160));
			const row = await mem(draftId);
			record('shared_at set', row.shared_at !== null);
			const asV = await getPage(`/app/day/${PENDING}`, cV);
			record(
				'viewer now sees the shared memory, labeled with the writer',
				asV.html.includes('MEMTEST-DRAFT shared now') &&
					asV.html.includes(`${WRITER_NAME} remembers`) &&
					!asV.html.includes('Draft — only you') &&
					!asV.html.includes('MEMTEST-PENDING-LEAK')
			);
		}

		// ── Accepted day: Madonna's memory and the writer's, together ──
		{
			const r = await action('/app/memories/new?/save', dayFields(ACCEPTED, 'MEMTEST-ACCEPTED-MEMORY', 'share'), cW);
			const asV = await getPage(`/app/day/${ACCEPTED}`, cV);
			const iM = asV.html.indexOf('MEMTEST-MADONNA-MEMORY');
			const iW = asV.html.indexOf('MEMTEST-ACCEPTED-MEMORY');
			record(
				'accepted day: calendar text, then Madonna remembers, then the writer',
				r.json?.type === 'redirect' && asV.html.includes('MEMTEST-ACCEPTED-TEXT') && iM > 0 && iW > iM
			);
			record('accepted day keeps Share', asV.html.includes('Share this day'));
		}

		// ── Someone else's memory: 404 everywhere ──
		{
			const before = await mem(draftId);
			const g = await getPage(`/app/memories/${draftId}`, cW2);
			record('other writer: GET edit is 404', g.status === 404, String(g.status));
			const s = await action(
				`/app/memories/${draftId}?/save`,
				dayFields(PENDING, 'MEMTEST-HIJACK', 'keep', { version: await version(draftId) }),
				cW2
			);
			record('other writer: save is 404', s.status === 404, String(s.status));
			for (const act of ['share', 'unshare', 'delete']) {
				const x = await action(`/app/memories/${draftId}?/${act}`, { version: await version(draftId) }, cW2);
				record(`other writer: ${act} is 404`, x.status === 404, String(x.status));
			}
			const after = await mem(draftId);
			record(
				'…and the memory is unchanged',
				after && after.body === before.body && String(after.shared_at) === String(before.shared_at)
			);
			const v = await action(`/app/memories/${draftId}?/unshare`, { version: await version(draftId) }, cV);
			record('viewer: unshare is 403', v.status === 403, String(v.status));
		}

		// ── Stale edits; Save keeps sharing ──
		{
			const v1 = await version(draftId);
			const a = await action(
				`/app/memories/${draftId}?/save`,
				dayFields(PENDING, 'MEMTEST-EDIT-ONE', 'keep', { version: v1 }),
				cW
			);
			const b = await action(
				`/app/memories/${draftId}?/save`,
				dayFields(PENDING, 'MEMTEST-EDIT-STALE', 'keep', { version: v1 }),
				cW
			);
			const row = await mem(draftId);
			record('first save from a loaded version succeeds', a.json?.type === 'redirect', a.text.slice(0, 120));
			record(
				'second save from the same (stale) version: 409, nothing changed',
				b.status === 409 && row.body === 'MEMTEST-EDIT-ONE',
				`${b.status} ${row.body}`
			);
			record('Save on a shared memory keeps it shared', row.shared_at !== null);
			// Without JS a refused save re-renders the whole page: it must keep
			// the stale version beside the stale text, so a second Save is
			// refused again rather than overwriting (CODEX code review #2).
			const noJs = await req(`/app/memories/${draftId}?/save`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: BASE_URL, Cookie: cW },
				body: new URLSearchParams(dayFields(PENDING, 'MEMTEST-EDIT-STALE', 'keep', { version: v1 })).toString()
			});
			const noJsHtml = await noJs.text();
			const shownVersion = /name="version" value="([^"]+)"/.exec(noJsHtml)?.[1] ?? '';
			const dec = (x) => x.replace(/&#43;/g, '+').replace(/&amp;/g, '&');
			record(
				'no-JS refused save: 409 page keeps the stale version with the stale text',
				noJs.status === 409 && noJsHtml.includes('MEMTEST-EDIT-STALE') && dec(shownVersion) === v1,
				`${noJs.status} shown=${shownVersion} v1=${v1}`
			);
			const retry = await action(
				`/app/memories/${draftId}?/save`,
				dayFields(PENDING, 'MEMTEST-EDIT-STALE', 'keep', { version: dec(shownVersion) }),
				cW
			);
			record(
				'…and saving again from that page is still refused',
				retry.status === 409 && (await mem(draftId)).body === 'MEMTEST-EDIT-ONE'
			);
			const page = await getPage(`/app/memories/${draftId}`, cW);
			record('edit page loads for the author', page.status === 200 && page.html.includes('MEMTEST-EDIT-ONE'));
		}

		// ── Stale share / unshare / delete (CODEX code review #1) ──
		{
			// A tab that loaded an older version must not unshare, share or
			// delete text it never saw.
			const stale = (await owner.query(`SELECT updated_at - interval '1 second' AS v FROM memories WHERE id = $1`, [draftId])).rows[0];
			const staleV = (await owner.query(`SELECT $1::timestamptz::text AS v`, [stale.v])).rows[0].v;
			const before = await mem(draftId);
			for (const act of ['unshare', 'share', 'delete']) {
				const x = await action(`/app/memories/${draftId}?/${act}`, { version: staleV }, cW);
				record(`stale ${act}: 409`, x.status === 409, `${x.status} ${x.text.slice(0, 100)}`);
			}
			const after = await mem(draftId);
			record(
				'…and nothing changed',
				after && String(after.shared_at) === String(before.shared_at) && String(after.updated_at) === String(before.updated_at)
			);
			const none = await action(`/app/memories/${draftId}?/unshare`, {}, cW);
			record('unshare with no version: 409', none.status === 409, String(none.status));
		}

		// ── Unshare ──
		{
			const r = await action(`/app/memories/${draftId}?/unshare`, { version: await version(draftId) }, cW);
			const row = await mem(draftId);
			const asV = await getPage(`/app/day/${PENDING}`, cV);
			record(
				'unshare: private again, gone from the family page',
				r.json?.type === 'success' && row.shared_at === null && !asV.html.includes('MEMTEST-EDIT-ONE')
			);
			record('unshare returns the new version', r.text.includes(await version(draftId)));
		}

		// ── Dates and text ──
		{
			const bad = [
				['unknown precision', { ...dayFields('1950-05-05', 'x'), precision: 'week' }],
				['1899', dayFields('1899-12-31', 'MEMTEST-BAD')],
				['day after today in UTC+14', dayFields(addDays(latestToday(), 1), 'MEMTEST-BAD')],
				['Feb 30', { ...dayFields('1981-02-01', 'MEMTEST-BAD'), day: '30' }],
				['Feb 29 in a non-leap year', { ...dayFields('1981-02-01', 'MEMTEST-BAD'), day: '29' }],
				['malformed year', { ...dayFields('1981-02-01', 'MEMTEST-BAD'), year: '19x1' }],
				['blank text', dayFields('1950-05-05', '   \n  ')],
				['10,001 characters', dayFields('1950-05-05', 'M'.repeat(10_001))]
			];
			for (const [label, fields] of bad) {
				const r = await action('/app/memories/new?/save', fields, cW);
				record(`refused: ${label}`, r.status === 400, `${r.status} ${r.text.slice(0, 100)}`);
			}
			const leap = await action('/app/memories/new?/save', dayFields('1980-02-29', 'MEMTEST-LEAP'), cW);
			record('accepted: real leap day 1980-02-29', leap.json?.type === 'redirect', leap.text.slice(0, 120));
			const today = await action('/app/memories/new?/save', dayFields(latestToday(), 'MEMTEST-TODAY'), cW);
			record('accepted: today in UTC+14', today.json?.type === 'redirect', today.text.slice(0, 120));
			const max = await action('/app/memories/new?/save', dayFields('1950-05-05', 'M'.repeat(10_000)), cW);
			record('accepted: exactly 10,000 characters', max.json?.type === 'redirect');

			const monthR = await action(
				'/app/memories/new?/save',
				{ precision: 'month', year: String(FIX_YEAR), month: '3', day: '15', body: 'MEMTEST-MONTH', intent: 'share' },
				cW
			);
			const monthRow = await mem(savedId(monthR));
			record(
				'month memory is stored on the 1st and lands on the month page',
				monthRow?.d === '1901-03-01' &&
					monthRow.date_precision === 'month' &&
					monthR.json.location === `/app/month/1901-03#m-${monthRow.id}`
			);
			const yearR = await action(
				'/app/memories/new?/save',
				{ precision: 'year', year: String(FIX_YEAR), month: '7', day: '4', body: 'MEMTEST-YEAR', intent: 'share' },
				cW
			);
			const yearRow = await mem(savedId(yearR));
			record('year memory is stored on January 1', yearRow?.d === '1901-01-01' && yearRow.date_precision === 'year');

			const fromList = await action(
				'/app/memories/new?/save',
				{ ...dayFields('1950-06-06', 'MEMTEST-FROM-LIST'), from: '/app/memories' },
				cW
			);
			record(
				'saved from My memories: Back returns there',
				(fromList.json?.location ?? '').startsWith('/app/day/1950-06-06?from=%2Fapp%2Fmemories#m-')
			);

			for (const [label, sql, params] of [
				['DB refuses a month memory not on the 1st', `INSERT INTO memories (writer_id, created_by, memory_date, date_precision, body) VALUES ($1, $2, '1950-05-15', 'month', 'x')`, [w1, writerId]],
				['DB refuses a year memory not on Jan 1', `INSERT INTO memories (writer_id, created_by, memory_date, date_precision, body) VALUES ($1, $2, '1950-05-01', 'year', 'x')`, [w1, writerId]],
				['DB refuses blank text', `INSERT INTO memories (writer_id, created_by, memory_date, date_precision, body) VALUES ($1, $2, '1950-05-15', 'day', '  ')`, [w1, writerId]]
			]) {
				let refused = false;
				try {
					await app.query(sql, params);
				} catch {
					refused = true;
				}
				record(label, refused);
			}
		}

		// ── Month and Year pages ──
		{
			const m = await getPage('/app/month/1901-03', cV);
			record(
				'uncaptured month shows its shared memory, no page image',
				m.status === 200 &&
					m.html.includes('MEMTEST-MONTH') &&
					m.html.includes("hasn't been photographed yet") &&
					!m.html.includes('/page-image')
			);
			await action(
				'/app/memories/new?/save',
				{ precision: 'month', year: String(FIX_YEAR), month: '4', body: 'MEMTEST-MONTH-DRAFT', intent: 'keep' },
				cW
			);
			const dv = await getPage('/app/month/1901-04', cV);
			const dw = await getPage('/app/month/1901-04', cW);
			record(
				'month with only a draft: plain empty state for others, the draft for its author',
				!dv.html.includes('MEMTEST-MONTH-DRAFT') &&
					dv.html.includes('Not captured yet') &&
					dw.html.includes('MEMTEST-MONTH-DRAFT')
			);
			const cap = await getPage('/app/month/1901-02', cW);
			record(
				'captured month offers the writer "Add a memory of this month"',
				cap.html.includes('Add a memory of this month') && cap.html.includes('/page-image')
			);
			const y = await getPage(`/app/year/${FIX_YEAR}`, cV);
			record('year page shows its shared memory', y.html.includes('MEMTEST-YEAR'));
			const ey = await getPage('/app/year/1903', cW);
			record(
				'empty year offers the writer "Add a memory of this year"',
				ey.html.includes('No days from 1903 yet') && ey.html.includes('Add a memory of this year')
			);
			const list = await getPage('/app/memories', cW);
			const iDraft = list.html.indexOf('MEMTEST-MONTH-DRAFT');
			const iShared = list.html.indexOf('MEMTEST-YEAR');
			record('My memories lists drafts first', iDraft > 0 && iShared > iDraft);
		}

		// ── Private text stays private ──
		{
			const leaked = await owner.query(
				`SELECT count(*)::int AS n FROM audit_log
				  WHERE entity_type = 'memories'
				    AND (coalesce(before_value::text, '') || coalesce(after_value::text, '') || description) LIKE '%MEMTEST%'`
			);
			record('no audit_log row contains memory text', leaked.rows[0].n === 0);
			const audited = await owner.query(
				`SELECT action FROM audit_log WHERE entity_type = 'memories' AND entity_id = $1 ORDER BY id`,
				[draftId]
			);
			const acts = audited.rows.map((r) => r.action).join(',');
			record(
				'draft history audited (create, share, edit, unshare)',
				acts === 'memory_create,memory_share,memory_edit,memory_unshare',
				acts
			);
			const revs = await owner.query(
				`SELECT action, body FROM memory_revisions WHERE memory_id = $1 ORDER BY id`,
				[draftId]
			);
			record(
				'memory_revisions keeps the text of each step',
				revs.rows.length === 4 && revs.rows[2].body === 'MEMTEST-EDIT-ONE',
				revs.rows.map((r) => r.action).join(',')
			);
			for (const t of ['memories', 'memory_revisions', 'writers']) {
				let denied = false;
				try {
					await worker.query(`SELECT 1 FROM ${t} LIMIT 1`);
				} catch (e) {
					denied = /permission denied/.test(String(e));
				}
				record(`worker cannot read ${t}`, denied);
			}
			for (const [label, sql] of [
				['app cannot UPDATE memory_revisions', `UPDATE memory_revisions SET body = 'x' WHERE memory_id = ${draftId}`],
				['app cannot DELETE memory_revisions', `DELETE FROM memory_revisions WHERE memory_id = ${draftId}`],
				['app cannot write writers', `UPDATE writers SET adds_memories = TRUE WHERE id = ${w1}`]
			]) {
				let denied = false;
				try {
					await app.query(sql);
				} catch (e) {
					denied = /permission denied/.test(String(e));
				}
				record(label, denied);
			}
		}

		// ── Delete ──
		{
			const r = await action(`/app/memories/${draftId}?/delete`, { version: await version(draftId) }, cW);
			const gone = !(await mem(draftId));
			const rev = await owner.query(
				`SELECT body FROM memory_revisions WHERE memory_id = $1 AND action = 'delete'`,
				[draftId]
			);
			const aud = await owner.query(
				`SELECT before_value, after_value FROM audit_log WHERE entity_id = $1 AND action = 'memory_delete'`,
				[draftId]
			);
			record(
				'delete: redirects to My memories, row gone',
				r.json?.location === '/app/memories?deleted=1' && gone,
				r.text.slice(0, 120)
			);
			record('delete: text recoverable from memory_revisions', rev.rows[0]?.body === 'MEMTEST-EDIT-ONE');
			record(
				'delete: audited with metadata only',
				aud.rows.length === 1 && aud.rows[0].after_value === null && aud.rows[0].before_value?.length === 16
			);
			const again = await getPage(`/app/memories/${draftId}`, cW);
			record('deleted memory: edit page is 404', again.status === 404);
		}

		// ── Accounts that wrote, or are writers, can't be deleted ──
		{
			for (const [label, uid, word] of [
				['wrote memories', writerId, '(memories)'],
				['is a writer with no memories', writer2Id, 'is set up to write memories']
			]) {
				await action('/admin/users?/removeAccess', { userId: String(uid) }, cA);
				const d = await action('/admin/users?/deleteAccount', { userId: String(uid) }, cA);
				const still = await owner.query(`SELECT 1 FROM users WHERE id = $1`, [uid]);
				record(
					`delete refused for an account that ${label}`,
					d.status === 409 && d.text.includes(word) && still.rows.length === 1,
					`${d.status} ${d.text.slice(0, 160)}`
				);
				await action('/admin/users?/restoreAccess', { userId: String(uid) }, cA);
			}
		}
	} catch (e) {
		record('test run threw', false, String(e?.stack ?? e));
	} finally {
		try {
			await cleanup(owner);
		} catch (e) {
			record('cleanup', false, String(e));
		}
		await Promise.all([app.end(), owner.end(), worker.end()]);
	}

	for (const r of rows) {
		console.log(`${r.ok ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✖\x1b[0m'} ${r.label}${r.ok || !r.detail ? '' : `\n    ${r.detail}`}`);
	}
	console.log(`\nPASS: ${pass}\nFAIL: ${fail}`);
	if (fail > 0) process.exitCode = 1;
}

main();
