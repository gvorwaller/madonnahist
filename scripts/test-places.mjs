#!/usr/bin/env node
// Place map locations test (td-085e19): lookup rules, admin review actions,
// and what viewers see on place pages.
//
// Runs against a dev server on the isolated test stack, started with the
// geocoding stub so Google is never called:
//   MADONNAHIST_GEOCODE_STUB=1 npx vite dev --host 127.0.0.1 --port 5177 --strictPort --mode test
//
// Self-provisions an admin, a viewer, fixture days (1907 = Florida years,
// 1985 = Utah years) and place entities named after the stub entries in
// src/lib/server/geocode.ts, and cleans up in a finally block. Rows the run
// creates for other test-DB places are removed too.
//
// Asserts:
//   - viewers can't open /admin/places; signed-out visitors are redirected;
//     the worker role has no access to place_locations
//   - only places with an accepted mention are looked up; generic and
//     possessive names are never searched
//   - auto (near home; far away only towns/states/countries), several,
//     needs_review, not_found, and the Utah/Florida choice by date
//     (the rule's edge cases are in scripts/test-place-rules.ts)
//   - rows decided by an older rule version are re-decided from their
//     stored results on the next run, unless an admin decided them
//   - place pages show Map / Apple Maps / Directions only for auto and
//     confirmed locations
//   - Use this, Search again, Looks right, Wrong place, Don't show a map
//     and Undo work and write audit rows
//   - the map picker: its lookups are admin-only (search, dropped pin,
//     tapped business), and "Save this location" sets a confirmed point,
//     refusing bad input
//   - a renamed place is looked up again, unless an admin decided it
//
// Usage: node scripts/test-places.mjs [baseUrl]   (or: npm run test:places)

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
		problems.push(`refusing reserved port ${process.env.PGPORT} (5433=BTC-dashboard, 5435=production tunnel)`);
	}
	if (process.env.PGDATABASE === 'madonnahist') problems.push('refusing production database name "madonnahist"');
	if (!process.env.PGDATABASE || !process.env.PGPASSWORD) {
		problems.push('PGDATABASE/PGPASSWORD must be set (copy .env.test.example to .env.test)');
	}
	return problems;
}

const BASE_URL = process.argv[2] ?? 'http://127.0.0.1:5177';
const SESSION_COOKIE_NAME = 'madonnahist_session';
const TEST_PASSWORD = 'PlacesTest!2026';
const ADMIN_USERNAME = '_places_admin';
const VIEWER_USERNAME = '_places_viewer';
const CAPTURE_SESSION = '_places_test';
const ARGON2_OPTS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };

// [slug, display name, which day: 'fl' (1907), 'ut' (1985), 'pending']
const P = {
	riverside: ['zqxmap-riverside-park', 'Zqxmap Riverside Park', 'fl'],
	canyon: ['zqxmap-canyon', 'Zqxmap Canyon', 'ut'],
	burger: ['zqxmap-burgerbarn', 'Zqxmap Burgerbarn', 'fl'],
	cove: ['zqxmap-cove-landing', 'Zqxmap Cove Landing', 'fl'],
	outlet: ['zqxmap-outlet', 'Zqxmap Outlet', 'fl'],
	falls: ['zqxmap-falls', 'Zqxmap Falls', 'fl'],
	nowhere: ['zqxmap-nowhere', 'Zqxmap Nowhere', 'fl'],
	possessive: ['zqxmap-s-place', "Zqxmap's Place", 'fl'],
	generic: ['zqxmap-the-mall', 'The Mall', 'fl'],
	rename: ['zqxmap-old-name', 'Zqxmap Old Name', 'fl'],
	oneword: ['zqxmapone', 'Zqxmapone', 'fl'],
	trip: ['zqxmap-twin-city', 'Zqxmap Twin City', 'fl'],
	stale: ['zqxmap-stale-chain', 'Zqxmap Stale Chain', 'fl'],
	staleKept: ['zqxmap-stale-kept', 'Zqxmap Stale Kept', 'fl'],
	staleOrphan: ['zqxmap-stale-orphan', 'Zqxmap Stale Orphan', 'fl'],
	pending: ['zqxmap-pending-place', 'Zqxmap Riverside Park Pending', 'pending']
};
const DAYS = { fl: '1907-04-10', ut: '1985-03-10', pending: '1907-04-11' };

let pass = 0;
let fail = 0;
const rows = [];
function record(label, ok, detail = '') {
	if (ok) pass++;
	else fail++;
	rows.push({ label, ok, detail });
}

async function fetchNoRedirect(url, opts) {
	return fetch(url, { ...opts, redirect: 'manual', headers: { Accept: 'text/html', ...(opts?.headers ?? {}) } });
}

function extractSessionCookie(res) {
	const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
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
		`INSERT INTO users (username, display_name, role, password_hash) VALUES ($1, $2, $3, $4)
		 ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role
		 RETURNING id`,
		[username, `Places test ${role}`, role, hash]
	);
	return res.rows[0].id;
}

async function cleanupUsers(pool, ids) {
	for (const id of ids.filter(Boolean)) {
		await pool.query(`DELETE FROM sessions WHERE user_id = $1`, [id]);
		await pool.query(`DELETE FROM audit_log WHERE user_id = $1`, [id]);
		await pool.query(`DELETE FROM users WHERE id = $1`, [id]);
	}
}

const slugs = () => Object.values(P).map(([s]) => s);

async function cleanupFixtures(pool) {
	await pool.query(`DELETE FROM entities WHERE entity_type = 'place' AND slug = ANY($1)`, [slugs()]);
	await pool.query(`DELETE FROM calendar_days WHERE page_id IN (SELECT id FROM calendar_pages WHERE capture_session = $1)`, [CAPTURE_SESSION]);
	await pool.query(`DELETE FROM calendar_pages WHERE capture_session = $1`, [CAPTURE_SESSION]);
}

async function provisionFixtures(pool) {
	await cleanupFixtures(pool);
	const dayIds = {};
	for (const [key, date, status] of [
		['fl', DAYS.fl, 'accepted'],
		['ut', DAYS.ut, 'accepted'],
		['pending', DAYS.pending, 'pending']
	]) {
		const [y, m] = date.split('-').map(Number);
		let page = (await pool.query(`SELECT id FROM calendar_pages WHERE year = $1 AND month = $2`, [y, m])).rows[0];
		if (!page) {
			page = (
				await pool.query(
					`INSERT INTO calendar_pages (year, month, page_image_path, capture_session) VALUES ($1, $2, 'fixtures/places-test/p.jpg', $3) RETURNING id`,
					[y, m, CAPTURE_SESSION]
				)
			).rows[0];
		}
		dayIds[key] = (
			await pool.query(
				`INSERT INTO calendar_days (page_id, entry_date, corrected_text, correction_status) VALUES ($1, $2, $3, $4) RETURNING id`,
				[page.id, date, `Places fixture ${key} day.`, status]
			)
		).rows[0].id;
	}
	const ids = {};
	for (const [key, [slug, name, day]] of Object.entries(P)) {
		ids[key] = (
			await pool.query(`INSERT INTO entities (slug, display_name, entity_type) VALUES ($1, $2, 'place') RETURNING id`, [slug, name])
		).rows[0].id;
		await pool.query(`INSERT INTO day_entities (day_id, entity_id, source) VALUES ($1, $2, 'human')`, [dayIds[day], ids[key]]);
	}
	return ids;
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

	let adminId;
	let viewerId;
	let before = [];
	try {
		try {
			await fetch(`${BASE_URL}/api/health`);
		} catch (err) {
			console.error(`ERROR: could not reach ${BASE_URL}. Start the dev server with the geocoding stub:`);
			console.error('  MADONNAHIST_GEOCODE_STUB=1 npx vite dev --host 127.0.0.1 --port 5177 --strictPort --mode test');
			throw err;
		}
		before = (await pool.query(`SELECT entity_id FROM place_locations`)).rows.map((r) => Number(r.entity_id));
		adminId = await provisionUser(pool, ADMIN_USERNAME, 'admin');
		viewerId = await provisionUser(pool, VIEWER_USERNAME, 'viewer');
		const ids = await provisionFixtures(pool);
		const admin = await login(ADMIN_USERNAME);
		const viewer = await login(VIEWER_USERNAME);

		// Rows decided by rule v1 (before 2026-11-14): a chain shown by mistake,
		// the same mistake that an admin has since confirmed, and one confirmed
		// by an admin whose account was later removed (decided_by nulled,
		// decided_at kept: still a human decision, CODEX9 td-c6e871 #6).
		const JAX = { lat: 30.3322, lon: -81.6557 };
		const chain = (name) => [
			{ name, address: '1 A St, Jacksonville, FL', lat: JAX.lat + 0.02, lon: JAX.lon, placeId: 'stub-stale-1', types: ['restaurant'], score: 1 },
			{ name, address: '2 B St, Jacksonville, FL', lat: JAX.lat + 0.021, lon: JAX.lon + 0.001, placeId: 'stub-stale-2', types: ['restaurant'], score: 1 }
		];
		for (const [key, decidedBy, decided] of [['stale', null, false], ['staleKept', adminId, true], ['staleOrphan', null, true]]) {
			const c = chain(P[key][1]);
			await pool.query(
				`INSERT INTO place_locations (entity_id, status, lat, lon, google_place_id, matched_name, address, region,
				   query, looked_up_name, score, candidates, decided_by, decided_at, rule_version)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, 'florida', $6, $6, 1, $8::jsonb, $9, CASE WHEN $10 THEN NOW() ELSE NULL END, 1)`,
				[ids[key], decided ? 'confirmed' : 'auto', c[0].lat, c[0].lon, c[0].placeId, P[key][1], c[0].address, JSON.stringify(c), decidedBy, decided]
			);
		}

		const get = async (cookie, url) => {
			const res = await fetchNoRedirect(`${BASE_URL}${url}`, { headers: cookie ? { Cookie: cookie } : {} });
			return { status: res.status, html: await res.text() };
		};
		const act = async (action, fields) => {
			const res = await fetchNoRedirect(`${BASE_URL}/admin/places?/${action}`, {
				method: 'POST',
				headers: { Cookie: admin, 'Content-Type': 'application/x-www-form-urlencoded', Origin: BASE_URL, Accept: 'application/json' },
				body: new URLSearchParams(fields).toString()
			});
			const text = await res.text();
			let type = null;
			try {
				type = JSON.parse(text).type;
			} catch {
				/* not JSON */
			}
			return { status: res.status, type, text };
		};
		const row = async (key) =>
			(await pool.query(`SELECT status, reason, region, google_place_id, query, candidates FROM place_locations WHERE entity_id = $1`, [ids[key]])).rows[0] ?? null;
		const waitForRun = async () => {
			for (let i = 0; i < 100; i++) {
				const r = await get(admin, '/admin/places');
				if (!r.html.includes('Looking up places…')) return true;
				await new Promise((res) => setTimeout(res, 200));
			}
			return false;
		};
		const placePage = async (key) => (await get(viewer, `/app/place/${P[key][0]}`)).html;
		const hasLinks = (html) => html.includes('https://www.google.com/maps/dir/') && html.includes('https://maps.apple.com/');

		// ── Access ──
		record('viewer GET /admin/places is 403', (await get(viewer, '/admin/places')).status === 403);
		record('signed-out GET /admin/places redirects', (await get(null, '/admin/places')).status === 303);
		const viewerPost = await fetchNoRedirect(`${BASE_URL}/admin/places?/run`, {
			method: 'POST',
			headers: { Cookie: viewer, 'Content-Type': 'application/x-www-form-urlencoded', Origin: BASE_URL },
			body: ''
		});
		record('viewer POST ?/run is refused', viewerPost.status === 403, `got ${viewerPost.status}`);
		const grants = (
			await pool.query(
				`SELECT has_table_privilege('madonnahist_worker', 'place_locations', 'SELECT') AS s,
				        has_table_privilege('madonnahist_worker', 'place_locations', 'INSERT') AS i`
			)
		).rows[0];
		record('worker role has no access to place_locations', !grants.s && !grants.i);

		// ── Lookup run ──
		const page0 = await get(admin, '/admin/places');
		record('admin page loads and offers a lookup', page0.status === 200 && /Look up \d+ new place/.test(page0.html), `status ${page0.status}`);
		const run = await act('run', {});
		record('admin ?/run starts', run.status === 200 && run.type === 'success', `${run.status} ${run.text.slice(0, 120)}`);
		record('run finishes', await waitForRun());

		const r = {};
		for (const k of Object.keys(P)) r[k] = await row(k);
		record('near-home strong match is shown automatically', r.riverside?.status === 'auto' && r.riverside?.region === 'florida', JSON.stringify(r.riverside?.status));
		record('Utah-years place gets the Utah region and an auto match', r.canyon?.status === 'auto' && r.canyon?.region === 'utah', `${r.canyon?.status} ${r.canyon?.region}`);
		record('chain / common name → no map (several)', r.burger?.status === 'no_location' && r.burger?.reason === 'several');
		record('weaker match → needs a look', r.cove?.status === 'needs_review');
		record('strong but far, ordinary kind → needs a look', r.outlet?.status === 'needs_review');
		record('strong, far natural feature → needs a look (only towns/states/countries far away)', r.falls?.status === 'needs_review');
		record('far town with a two-word name (a trip) → auto', r.trip?.status === 'auto' && r.trip?.google_place_id === 'stub-twin');
		record('one-word name matching part of a business name → needs a look', r.oneword?.status === 'needs_review');
		const stale = await pool.query(`SELECT status, reason, rule_version, lat FROM place_locations WHERE entity_id = $1`, [ids.stale]);
		record(
			'old-rule automatic row is re-decided from stored results (chain → no map)',
			stale.rows[0]?.status === 'no_location' && stale.rows[0]?.reason === 'several' && stale.rows[0]?.rule_version >= 2 && stale.rows[0]?.lat === null,
			JSON.stringify(stale.rows[0])
		);
		const kept = await pool.query(`SELECT status, rule_version FROM place_locations WHERE entity_id = $1`, [ids.staleKept]);
		record('old-rule row an admin decided is never re-decided', kept.rows[0]?.status === 'confirmed' && kept.rows[0]?.rule_version === 1, JSON.stringify(kept.rows[0]));
		const orphan = await pool.query(`SELECT status, rule_version FROM place_locations WHERE entity_id = $1`, [ids.staleOrphan]);
		record(
			"…nor is one whose deciding account was removed (decided_at, not decided_by, is the provenance)",
			orphan.rows[0]?.status === 'confirmed' && orphan.rows[0]?.rule_version === 1,
			JSON.stringify(orphan.rows[0])
		);
		record('nothing found → no map (not_found)', r.nowhere?.status === 'no_location' && r.nowhere?.reason === 'not_found');
		record('possessive name never searched → no map (general)', r.possessive?.status === 'no_location' && r.possessive?.reason === 'general' && r.possessive?.query === null);
		record('generic word never searched → no map (general)', r.generic?.status === 'no_location' && r.generic?.reason === 'general' && r.generic?.query === null);
		record('pending-only place is never looked up', r.pending === null);

		// ── What viewers see ──
		const riverHtml = await placePage('riverside');
		record('auto place page shows Map / Apple Maps / Directions', hasLinks(riverHtml) && riverHtml.includes('query_place_id=stub-riverside'));
		record('needs-a-look place page shows no map links', !hasLinks(await placePage('cove')));
		record('several-matches place page shows no map links', !hasLinks(await placePage('burger')));
		record('no-map place page shows no map links', !hasLinks(await placePage('nowhere')));

		// ── Admin actions ──
		const id = (k) => String(ids[k]);
		let a = await act('search', { entity_id: id('cove'), q: 'Zqxmap Cove Landing, Jacksonville FL' });
		const coveAfterSearch = await row('cove');
		record('Search again stores fresh candidates', a.type === 'success' && coveAfterSearch.candidates.length === 1 && coveAfterSearch.status === 'needs_review', a.text.slice(0, 100));
		a = await act('choose', { entity_id: id('cove'), index: '0' });
		record('Use this confirms the chosen match', a.type === 'success' && (await row('cove')).status === 'confirmed');
		record('confirmed place page shows the chosen place', (await placePage('cove')).includes('query_place_id=stub-cove-2'));
		a = await act('choose', { entity_id: id('cove'), index: '7' });
		record('Use this with a missing match is refused', a.type === 'failure');

		a = await act('wrong', { entity_id: id('riverside') });
		record('Wrong place hides it and moves it to Needs a look', a.type === 'success' && (await row('riverside')).status === 'needs_review' && !hasLinks(await placePage('riverside')));
		a = await act('again', { entity_id: id('riverside') });
		record('Undo looks it up again (auto, shown)', a.type === 'success' && (await row('riverside')).status === 'auto' && hasLinks(await placePage('riverside')));

		a = await act('confirm', { entity_id: id('canyon') });
		record('Looks right confirms an automatic match', a.type === 'success' && (await row('canyon')).status === 'confirmed');
		a = await act('confirm', { entity_id: id('outlet') });
		record('Looks right on a non-automatic match is refused', a.type === 'failure');

		a = await act('nomap', { entity_id: id('outlet') });
		const outlet = await row('outlet');
		record('No map hides a place (admin reason)', a.type === 'success' && outlet.status === 'no_location' && outlet.reason === 'admin');
		a = await act('nomap', { entity_id: id('pending') });
		record('actions on a place with no accepted day are refused', a.type === 'failure');

		// ── Map picker ──
		const locate = async (cookie, body) => {
			const res = await fetchNoRedirect(`${BASE_URL}/admin/places/locate`, {
				method: 'POST',
				headers: { ...(cookie ? { Cookie: cookie } : {}), 'Content-Type': 'application/json', Origin: BASE_URL },
				body: JSON.stringify(body)
			});
			let json = null;
			try {
				json = await res.json();
			} catch {
				/* not JSON */
			}
			return { status: res.status, json };
		};
		record('viewer cannot use the map lookups', (await locate(viewer, { entity_id: ids.riverside, q: 'zqxmap riverside park' })).status === 403);
		let l = await locate(admin, { entity_id: ids.riverside, q: 'Zqxmap Riverside Park' });
		record('picker search returns results', l.status === 200 && l.json?.results?.length === 1 && l.json.results[0].placeId === 'stub-riverside', JSON.stringify(l.json).slice(0, 120));
		l = await locate(admin, { lat: 30.3, lon: -81.6 });
		record('picker: dropped pin gets the nearest address', l.status === 200 && l.json?.spot?.address?.includes('Pin Rd'), JSON.stringify(l.json).slice(0, 120));
		l = await locate(admin, { place_id: 'stub-tap_1' });
		record('picker: tapped business is looked up by id', l.status === 200 && l.json?.spot?.name === 'Zqxmap Tapped Place');
		l = await locate(admin, { place_id: 'bad id!' });
		record('picker: malformed place id is refused', l.status === 400);
		l = await locate(admin, { entity_id: ids.pending, q: 'anything' });
		record('picker: search for a place with no accepted day is refused', l.status === 404);

		a = await act('pin', { entity_id: id('nowhere'), lat: '30.35', lon: '-81.61', place_id: 'stub-pin', name: 'Zqxmap Pinned Spot', address: '2 Pin Rd, Jacksonville, FL, USA' });
		const pinned = (await pool.query(`SELECT status, reason, lat, lon, google_place_id, matched_name, decided_by FROM place_locations WHERE entity_id = $1`, [ids.nowhere])).rows[0];
		record(
			'Save this location sets a confirmed point (from no map)',
			a.type === 'success' && pinned?.status === 'confirmed' && pinned.reason === null && pinned.lat === 30.35 && pinned.google_place_id === 'stub-pin' && Number(pinned.decided_by) === adminId,
			JSON.stringify(pinned)
		);
		record('pinned place page shows the map links', (await placePage('nowhere')).includes('query_place_id=stub-pin'));
		a = await act('pin', { entity_id: id('riverside'), lat: '30.4', lon: '-81.5', place_id: '', name: '', address: '' });
		const moved = (await pool.query(`SELECT status, lat, google_place_id, matched_name FROM place_locations WHERE entity_id = $1`, [ids.riverside])).rows[0];
		record(
			'a dropped pin with no Google id moves an automatic match',
			a.type === 'success' && moved.status === 'confirmed' && moved.lat === 30.4 && moved.google_place_id === null && moved.matched_name === P.riverside[1],
			JSON.stringify(moved)
		);
		a = await act('pin', { entity_id: id('generic'), lat: '30.31', lon: '-81.62', place_id: '', name: 'Zqxmap Mall Pin', address: '' });
		record('a never-searched general name can still be pinned', a.type === 'success' && (await row('generic')).status === 'confirmed');
		a = await act('pin', { entity_id: id('cove'), lat: '95', lon: '-81.6' });
		record('a point off the map is refused', a.type === 'failure');
		a = await act('pin', { entity_id: id('cove'), lat: '', lon: '' });
		record('saving with no point is refused', a.type === 'failure');
		a = await act('pin', { entity_id: id('cove'), lat: '30.3', lon: '-81.6', place_id: 'x"><script>' });
		record('a malformed Google id is refused', a.type === 'failure');
		a = await act('pin', { entity_id: id('pending'), lat: '30.3', lon: '-81.6' });
		record('pinning a place with no accepted day is refused', a.type === 'failure');

		const audits = (
			await pool.query(`SELECT action FROM audit_log WHERE user_id = $1 AND entity_type = 'place_locations' ORDER BY id`, [adminId])
		).rows.map((x) => x.action);
		const want = ['place_lookup_run', 'place_location_search', 'place_location_choose', 'place_location_wrong', 'place_location_undo', 'place_location_confirm', 'place_location_no_map', 'place_location_pin'];
		record('each admin action writes an audit row', want.every((w) => audits.includes(w)), audits.join(','));

		// ── Renames ──
		await pool.query(`UPDATE entities SET display_name = 'Zqxmap Renamed Spot' WHERE id = $1`, [ids.rename]);
		await pool.query(`UPDATE entities SET display_name = 'Zqxmap Outlet Store' WHERE id = $1`, [ids.outlet]);
		a = await act('run', {});
		await waitForRun();
		const renamed = await row('rename');
		record('renamed place is looked up again under its new name', renamed?.status === 'auto' && renamed?.google_place_id === 'stub-renamed', JSON.stringify(renamed?.status));
		const outlet2 = await row('outlet');
		record('renaming never overwrites an admin decision', outlet2.status === 'no_location' && outlet2.reason === 'admin');

		console.log('\nPlace map results:\n');
		const width = Math.max(...rows.map((x) => x.label.length)) + 2;
		for (const x of rows) console.log(`${x.ok ? 'PASS' : 'FAIL'}  ${x.label.padEnd(width)} ${x.detail}`);
		console.log(`\n${pass} passed, ${fail} failed (${rows.length} total)`);
		if (fail > 0) process.exitCode = 1;
	} finally {
		await cleanupFixtures(pool);
		// Rows the run made for other test-DB places.
		await pool.query(`DELETE FROM place_locations WHERE NOT (entity_id = ANY($1::bigint[]))`, [before]);
		await cleanupUsers(pool, [adminId, viewerId]);
		await pool.end();
	}
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
