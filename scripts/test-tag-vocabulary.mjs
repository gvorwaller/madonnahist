#!/usr/bin/env node
// Tag approval by tag NAME — /admin/tags + tag_vocabulary (td-3418e6,
// Family Viewer V3 Slice 1T; docs/2026-11-05-family-viewer-v3-redesign-plan.md).
//
// Runs against a dev server already started on the isolated test stack:
//   npx vite dev --host 127.0.0.1 --port 5177 --strictPort --mode test
//
// Self-provisions an admin + a viewer, one calendar page and three days
// (two accepted, one pending) with AI and human tags in madonnahist_test
// (127.0.0.1:15434), drives the real /admin/tags form actions over HTTP, and
// asserts what the family viewer shows. Cleans up in a finally block.
// Never touches port 5433/5435 or PGDATABASE=madonnahist.
//
// What this asserts:
//   - before any decision, AI tags are absent from the viewer; human tags show
//   - approve → shown on accepted days only (never on the pending day)
//   - hide → absent; a human tag on a hidden name still shows
//   - merge sick → illness → day shows "Illness" once; ?tag=sick (old link)
//     still finds both days; the search tag dropdown lists only visible names
//   - rules: merging into a non-approved name, hiding/undoing a merge target
//     with names merged into it → 409 and no change
//   - undo → back to hidden-from-family
//   - every decision writes an audit_log row
//   - viewer can't reach /admin/tags (403); admin example-days endpoint is
//     accepted-only
//   - DB grants: worker can SELECT but never write tag_vocabulary
//
// Usage: node scripts/test-tag-vocabulary.mjs [baseUrl]   (or: npm run test:tags)

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
	return problems;
}

const BASE_URL = process.argv[2] ?? 'http://127.0.0.1:5177';
const SESSION_COOKIE_NAME = 'madonnahist_session';
const TEST_PASSWORD = 'TagVocabularyTest!2026';
const ADMIN_USERNAME = '_tagvocab_admin';
const VIEWER_USERNAME = '_tagvocab_viewer';
const ARGON2_OPTS = {
	type: argon2.argon2id,
	memoryCost: 19456,
	timeCost: 2,
	parallelism: 1
};

const FIXTURE_YEAR = 1903;
const FIXTURE_MONTH = 3;
const D1 = '1903-03-10';
const D2 = '1903-03-11';
const D3 = '1903-03-12'; // pending
const CAPTURE_SESSION = '_tag_vocabulary_test';
const M1 = 'QVTAGDAYONEMARKER';
const M2 = 'QVTAGDAYTWOMARKER';
const M3 = 'QVTAGDAYPENDINGMARKER';

const T = {
	undecided: ['qvtag-undecided', 'Qvtag Undecided'],
	approve: ['qvtag-approve', 'Qvtag Approve'],
	hide: ['qvtag-hide', 'Qvtag Hide'],
	humanHidden: ['qvtag-human-hidden', 'Qvtag Human Hidden'],
	sick: ['qvtag-sick', 'Qvtag Sick'],
	illness: ['qvtag-illness', 'Qvtag Illness']
};

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
	const raw =
		typeof res.headers.getSetCookie === 'function'
			? res.headers.getSetCookie()
			: [res.headers.get('set-cookie')].filter(Boolean);
	for (const c of raw) {
		const m = c.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`));
		if (m) return `${SESSION_COOKIE_NAME}=${m[1]}`;
	}
	return null;
}

async function login(username) {
	const res = await fetchNoRedirect(`${BASE_URL}/login?/login`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ username, password: TEST_PASSWORD }).toString()
	});
	if (res.status !== 303) throw new Error(`login for ${username} expected 303, got ${res.status}`);
	const cookie = extractSessionCookie(res);
	if (!cookie) throw new Error(`login for ${username} set no session cookie`);
	return cookie;
}

async function provisionUser(pool, username, role) {
	const hash = await argon2.hash(TEST_PASSWORD, ARGON2_OPTS);
	const res = await pool.query(
		`INSERT INTO users (username, display_name, role, password_hash)
		 VALUES ($1, $2, $3, $4)
		 ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role
		 RETURNING id`,
		[username, `Tag test ${role}`, role, hash]
	);
	return res.rows[0].id;
}

async function cleanupFixtures(pool) {
	const slugs = Object.values(T).map(([s]) => s);
	await pool.query(
		`DELETE FROM tag_vocabulary WHERE tag_slug = ANY($1) AND merged_into_slug IS NOT NULL`,
		[slugs]
	);
	await pool.query(`DELETE FROM tag_vocabulary WHERE tag_slug = ANY($1)`, [slugs]);
	await pool.query(`DELETE FROM calendar_days WHERE entry_date = ANY($1::date[])`, [[D1, D2, D3]]);
	await pool.query(
		`DELETE FROM calendar_pages WHERE year = $1 AND month = $2 AND capture_session = $3`,
		[FIXTURE_YEAR, FIXTURE_MONTH, CAPTURE_SESSION]
	);
}

async function cleanupUsers(pool, ids) {
	for (const id of ids.filter(Boolean)) {
		await pool.query(`DELETE FROM sessions WHERE user_id = $1`, [id]);
		await pool.query(`DELETE FROM audit_log WHERE user_id = $1`, [id]);
		await pool.query(`DELETE FROM users WHERE id = $1`, [id]);
	}
}

async function provisionFixtures(pool) {
	await cleanupFixtures(pool);
	await pool.query(
		`INSERT INTO calendar_pages (year, month, page_image_path, capture_session) VALUES ($1, $2, $3, $4)
		 ON CONFLICT (year, month) DO NOTHING`,
		[FIXTURE_YEAR, FIXTURE_MONTH, 'fixtures/tag-vocabulary-test/fake-page.jpg', CAPTURE_SESSION]
	);
	const pageId = (
		await pool.query(`SELECT id FROM calendar_pages WHERE year = $1 AND month = $2`, [
			FIXTURE_YEAR,
			FIXTURE_MONTH
		])
	).rows[0].id;
	const day = async (date, status, marker) =>
		(
			await pool.query(
				`INSERT INTO calendar_days (page_id, entry_date, corrected_text, correction_status) VALUES ($1, $2, $3, $4) RETURNING id`,
				[pageId, date, `Tag vocabulary fixture ${marker} entry. A second sentence follows.`, status]
			)
		).rows[0].id;
	const d1 = await day(D1, 'accepted', M1);
	const d2 = await day(D2, 'accepted', M2);
	const d3 = await day(D3, 'pending', M3);
	const tag = (dayId, [slug, label], source) =>
		pool.query(
			`INSERT INTO day_tags (day_id, tag_slug, tag_label, source) VALUES ($1, $2, $3, $4)`,
			[dayId, slug, label, source]
		);
	await tag(d1, T.undecided, 'ai');
	await tag(d1, T.approve, 'ai');
	await tag(d1, T.hide, 'ai');
	await tag(d1, T.humanHidden, 'human');
	await tag(d1, T.sick, 'ai');
	await tag(d2, T.illness, 'ai');
	await tag(d2, T.sick, 'ai');
	await tag(d3, T.approve, 'ai');
}

async function getHtml(cookie, url) {
	const res = await fetchNoRedirect(`${BASE_URL}${url}`, {
		headers: { Cookie: cookie }
	});
	return { status: res.status, html: await res.text() };
}

async function adminAction(cookie, action, fields) {
	const body = new URLSearchParams();
	for (const [k, v] of fields) body.append(k, v);
	const res = await fetchNoRedirect(`${BASE_URL}/admin/tags?/${action}`, {
		method: 'POST',
		headers: {
			Cookie: cookie,
			'Content-Type': 'application/x-www-form-urlencoded',
			Origin: BASE_URL
		},
		body: body.toString()
	});
	return res.status;
}

const count = (html, s) => html.split(s).length - 1;

async function vocab(pool, slug) {
	return (
		(
			await pool.query(`SELECT status, merged_into_slug FROM tag_vocabulary WHERE tag_slug = $1`, [
				slug
			])
		).rows[0] ?? null
	);
}

async function main() {
	const problems = requireTestSafety();
	if (problems.length) {
		console.error('Refusing to run:\n  ' + problems.join('\n  '));
		process.exitCode = 1;
		return;
	}
	const pool = new pg.Pool({
		host: process.env.PGHOST ?? '127.0.0.1',
		port: Number(process.env.PGPORT),
		user: process.env.PGUSER,
		password: process.env.PGPASSWORD,
		database: process.env.PGDATABASE
	});
	let adminId;
	let viewerId;
	try {
		adminId = await provisionUser(pool, ADMIN_USERNAME, 'admin');
		viewerId = await provisionUser(pool, VIEWER_USERNAME, 'viewer');
		await provisionFixtures(pool);
		const admin = await login(ADMIN_USERNAME);
		const viewer = await login(VIEWER_USERNAME);

		// ── Before any decision ──
		let d1 = (await getHtml(viewer, `/app/day/${D1}`)).html;
		record(
			'undecided: AI tags absent on day page',
			!d1.includes(T.undecided[1]) && !d1.includes(T.approve[1]) && !d1.includes(T.sick[1]),
			''
		);
		record('undecided: human tag shows on day page', d1.includes(T.humanHidden[1]), '');

		// ── Access control ──
		const vStatus = await adminAction(viewer, 'approve', [['slug', T.approve[0]]]);
		record('viewer POST /admin/tags?/approve → 403', vStatus === 403, `got ${vStatus}`);
		record('viewer POST changed nothing', (await vocab(pool, T.approve[0])) === null, '');
		const vGet = await getHtml(viewer, '/admin/tags');
		record('viewer GET /admin/tags → 403', vGet.status === 403, `got ${vGet.status}`);

		// ── Decisions ──
		let s = await adminAction(admin, 'approve', [
			['slug', T.approve[0]],
			['slug', T.illness[0]]
		]);
		record('approve (bulk of 2) → 200', s === 200, `got ${s}`);
		s = await adminAction(admin, 'hide', [
			['slug', T.hide[0]],
			['slug', T.humanHidden[0]]
		]);
		record('hide (bulk of 2) → 200', s === 200, `got ${s}`);
		s = await adminAction(admin, 'merge', [
			['slug', T.sick[0]],
			['target', T.illness[0]]
		]);
		record('merge sick → illness → 200', s === 200, `got ${s}`);
		const sickRow = await vocab(pool, T.sick[0]);
		record(
			'merge stored',
			sickRow?.status === 'merged' && sickRow?.merged_into_slug === T.illness[0],
			JSON.stringify(sickRow)
		);

		d1 = (await getHtml(viewer, `/app/day/${D1}`)).html;
		record('approved tag shows on accepted day', d1.includes(T.approve[1]), '');
		record('undecided tag still absent', !d1.includes(T.undecided[1]), '');
		record('hidden AI tag absent', !d1.includes(T.hide[1]), '');
		record('human tag on a hidden name still shows', d1.includes(T.humanHidden[1]), '');
		record(
			'merged name shows as its target',
			d1.includes(T.illness[1]) && !d1.includes(T.sick[1]),
			''
		);
		const d2 = (await getHtml(viewer, `/app/day/${D2}`)).html;
		record(
			'merged pair shows target once on a day carrying both',
			count(d2, `>${T.illness[1]}<`) === 1,
			`count=${count(d2, `>${T.illness[1]}<`)}`
		);

		// ── Search ──
		let sr = (await getHtml(viewer, `/app/search?tag=${T.sick[0]}`)).html;
		record('old ?tag=<merged name> link finds both days', sr.includes(M1) && sr.includes(M2), '');
		sr = (await getHtml(viewer, `/app/search?tag=${T.approve[0]}`)).html;
		record('?tag=<approved> finds the accepted day', sr.includes(M1), '');
		record('?tag=<approved> never finds the pending day', !sr.includes(M3), '');
		sr = (await getHtml(viewer, `/app/search?tag=${T.undecided[0]}`)).html;
		record('?tag=<undecided> finds nothing', !sr.includes(M1), '');
		sr = (await getHtml(viewer, `/app/search?tag=${T.hide[0]}`)).html;
		record('?tag=<hidden AI> finds nothing', !sr.includes(M1), '');
		// Slice 4: the tag list comes from the typeahead, not a dropdown.
		const dropdown = (await getHtml(viewer, '/app/search/suggest?q=qvtag')).html;
		const has = (slug) => dropdown.includes(`"slug":"${slug}"`);
		record(
			'typeahead lists approved + human names',
			has(T.approve[0]) && has(T.illness[0]) && has(T.humanHidden[0]),
			dropdown.slice(0, 200)
		);
		record(
			'typeahead omits undecided, hidden and merged names',
			!has(T.undecided[0]) && !has(T.hide[0]) && !has(T.sick[0]),
			''
		);

		// ── Rules ──
		s = await adminAction(admin, 'merge', [
			['slug', T.undecided[0]],
			['target', T.hide[0]]
		]);
		record('merge into a hidden name → 409', s === 409, `got ${s}`);
		record('…and nothing stored', (await vocab(pool, T.undecided[0])) === null, '');
		s = await adminAction(admin, 'hide', [['slug', T.illness[0]]]);
		record('hide a name that has merges into it → 409', s === 409, `got ${s}`);
		record('…and it stays approved', (await vocab(pool, T.illness[0]))?.status === 'approved', '');
		s = await adminAction(admin, 'undo', [['slug', T.illness[0]]]);
		record('undo a name that has merges into it → 409', s === 409, `got ${s}`);
		s = await adminAction(admin, 'approve', [['slug', 'Not A Slug!']]);
		record('malformed slug → 400', s === 400, `got ${s}`);

		// ── Admin page + example-days endpoint ──
		const page = await getHtml(admin, '/admin/tags');
		record(
			'admin GET /admin/tags → 200 lists fixture tags',
			page.status === 200 && page.html.includes(T.undecided[1]),
			`status ${page.status}`
		);
		const exRes = await fetch(`${BASE_URL}/admin/tags/${T.approve[0]}/days`, {
			headers: { Cookie: admin }
		});
		const ex = exRes.ok ? await exRes.json() : { days: [] };
		const exDates = ex.days.map((d) => d.entryDate);
		record(
			'example days are accepted-only',
			exDates.includes(D1) && !exDates.includes(D3),
			JSON.stringify(exDates)
		);

		// ── Undo ──
		s = await adminAction(admin, 'undo', [['slug', T.sick[0]]]);
		record('undo merge → 200', s === 200, `got ${s}`);
		d1 = (await getHtml(viewer, `/app/day/${D1}`)).html;
		record(
			'after undo, the formerly merged AI tag is hidden again',
			!d1.includes(T.illness[1]) && !d1.includes(T.sick[1]),
			''
		);

		// ── Audit ──
		const audits = (
			await pool.query(
				`SELECT action FROM audit_log WHERE user_id = $1 AND entity_type = 'tag_vocabulary'`,
				[adminId]
			)
		).rows.map((r) => r.action);
		const want = ['tag_approve', 'tag_hide', 'tag_merge', 'tag_undo'];
		record(
			'every decision kind is audited',
			want.every((a) => audits.includes(a)),
			audits.join(',')
		);

		// ── Grants ──
		const priv = async (role, p) =>
			(await pool.query(`SELECT has_table_privilege($1, 'tag_vocabulary', $2) AS ok`, [role, p]))
				.rows[0].ok;
		record('worker can SELECT tag_vocabulary', await priv('madonnahist_worker', 'SELECT'), '');
		const workerWrites = await Promise.all(
			['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'].map((p) => priv('madonnahist_worker', p))
		);
		record(
			'worker cannot write tag_vocabulary',
			workerWrites.every((x) => x === false),
			workerWrites.join(',')
		);
	} finally {
		try {
			await cleanupFixtures(pool);
			await cleanupUsers(pool, [adminId, viewerId]);
		} finally {
			await pool.end();
		}
	}

	const w = Math.max(...rows.map((r) => r.label.length));
	for (const r of rows) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.label.padEnd(w)}  ${r.detail}`);
	console.log(`\n${pass} passed, ${fail} failed (${pass + fail} total)`);
	if (fail > 0) process.exitCode = 1;
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
