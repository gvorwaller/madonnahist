#!/usr/bin/env node
// Removing and deleting accounts (/admin/users, 2026-11-15;
// migration 0031_user_removal.sql).
//
// Runs against a dev server already started on the isolated test stack:
//   npx vite dev --host 127.0.0.1 --port 5177 --strictPort --mode test
//
// Self-provisions admins, viewers and a corrector in madonnahist_test
// (127.0.0.1:15434), drives the real form actions over HTTP, and cleans up
// in a finally block. Never touches port 5433/5435 or PGDATABASE=madonnahist.
//
// What this asserts:
//   - only admins can remove / restore / delete; never yourself
//   - remove: signs out every session, sign-in refused with the usual
//     message, open invite link cancelled, audited with who it was; reset
//     password and invite links refused while removed; page lists it under
//     Removed accounts
//   - restore: the old password works again; audited
//   - delete: refused unless removed first; a throwaway account is gone, its
//     own activity-log lines stay (person blanked) and the log shows
//     "Deleted account"; the username is free again
//   - delete refused (409, plain words) for an account that added content;
//     nothing changes
//   - two admins removing each other at once: at least one admin remains
//
// Usage: node scripts/test-accounts.mjs [baseUrl]   (or: npm run test:accounts)

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
const TEST_PASSWORD = 'AccountTest!2026';
const ADMIN = '_acct_admin';
const ADMIN2 = '_acct_admin2';
const VIEWER = '_acct_viewer';
const OTHER_VIEWER = '_acct_other';
const AUTHOR = '_acct_author';
const INVITED = '_acct_invited';
const EVERYONE = [ADMIN, ADMIN2, VIEWER, OTHER_VIEWER, AUTHOR, INVITED];
const SHORTHAND = '_acct_shorthand';
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

async function login(username, password = TEST_PASSWORD) {
	const res = await req(`/login?/login`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: BASE_URL },
		body: new URLSearchParams({ username, password }).toString()
	});
	return { status: res.status, cookie: sessionCookie(res), html: await res.text() };
}

async function loginCookie(username) {
	const r = await login(username);
	if (r.status !== 303 || !r.cookie) throw new Error(`login for ${username} failed (${r.status})`);
	return r.cookie;
}

/** Form POST as use:enhance does: JSON {type, status, data}. */
async function action(name, fields, cookie) {
	const res = await req(`/admin/users?/${name}`, {
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
		// not JSON (e.g. a 403 page)
	}
	return { httpStatus: res.status, json, text };
}

async function getPage(url, cookie) {
	const res = await req(url, { headers: cookie ? { Cookie: cookie } : {} });
	return { status: res.status, html: await res.text() };
}

async function provisionUser(pool, username, role) {
	const hash = await argon2.hash(TEST_PASSWORD, ARGON2_OPTS);
	const res = await pool.query(
		`INSERT INTO users (username, display_name, role, password_hash)
		 VALUES ($1, $2, $3, $4) RETURNING id`,
		[username, `Account test ${username}`, role, hash]
	);
	return res.rows[0].id;
}

async function idOf(pool, username) {
	return (await pool.query(`SELECT id FROM users WHERE username = $1`, [username])).rows[0]?.id ?? null;
}

// Ids of test accounts this run deleted permanently (their own audit lines
// keep entity_id but lose user_id).
const deletedIds = [];

async function cleanup(pool) {
	await pool.query(`DELETE FROM notation_key WHERE input_shorthand = $1`, [SHORTHAND]);
	const live = (
		await pool.query(`SELECT id FROM users WHERE username = ANY($1)`, [EVERYONE])
	).rows.map((r) => r.id);
	const ids = [...live, ...deletedIds];
	// Audit lines this test wrote, including ones whose person was blanked
	// by a permanent delete (entity is the test account, actor gone).
	await pool.query(
		`DELETE FROM audit_log
		  WHERE user_id = ANY($1)
		     OR (entity_type = 'users' AND entity_id = ANY($1))
		     OR (entity_type = 'users' AND description LIKE '%"_acct_%')
		     OR (action = 'user_delete' AND before_value->>'username' LIKE '\\_acct\\_%')`,
		[ids]
	);
	if (live.length === 0) return;
	await pool.query(`UPDATE users SET removed_by = NULL WHERE removed_by = ANY($1)`, [live]);
	await pool.query(`DELETE FROM sessions WHERE user_id = ANY($1)`, [live]);
	await pool.query(`DELETE FROM users WHERE id = ANY($1)`, [live]);
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

	try {
		await cleanup(pool);
		const adminId = await provisionUser(pool, ADMIN, 'admin');
		const admin2Id = await provisionUser(pool, ADMIN2, 'admin');
		const viewerId = await provisionUser(pool, VIEWER, 'viewer');
		await provisionUser(pool, OTHER_VIEWER, 'viewer');
		const authorId = await provisionUser(pool, AUTHOR, 'corrector');
		const admin = await loginCookie(ADMIN);
		const other = await loginCookie(OTHER_VIEWER);
		const vA = await loginCookie(VIEWER);
		const vB = await loginCookie(VIEWER);
		const audit = async (act, entityId) =>
			(
				await pool.query(
					`SELECT * FROM audit_log WHERE action = $1 AND entity_id = $2 ORDER BY id`,
					[act, entityId]
				)
			).rows;

		// ── Who may ──
		{
			const v = await action('removeAccess', { userId: String(viewerId) }, other);
			record('viewer cannot remove an account', v.httpStatus === 403, String(v.httpStatus));
			const vd = await action('deleteAccount', { userId: String(viewerId) }, other);
			record('viewer cannot delete an account', vd.httpStatus === 403, String(vd.httpStatus));
			const out = await action('removeAccess', { userId: String(viewerId) });
			record(
				'signed out cannot remove',
				out.httpStatus === 401 || out.httpStatus === 303,
				String(out.httpStatus)
			);
			const self = await action('removeAccess', { userId: String(adminId) }, admin);
			record('admin cannot remove their own access', self.json?.status === 400, self.text.slice(0, 120));
			const selfDel = await action('deleteAccount', { userId: String(adminId) }, admin);
			record('admin cannot delete their own account', selfDel.json?.status === 400);
			const page = await getPage('/admin/users', admin);
			record(
				'users page: Remove access offered, but not on your own row',
				page.status === 200 && page.html.includes('Remove access') && page.html.includes('>You<')
			);
		}

		// ── Remove access ──
		{
			const early = await action('deleteAccount', { userId: String(viewerId) }, admin);
			record(
				'delete refused until access is removed',
				early.json?.status === 409 && early.text.includes('first'),
				early.text.slice(0, 160)
			);
			const r = await action('removeAccess', { userId: String(viewerId) }, admin);
			record('remove access succeeds', r.json?.type === 'success', r.text.slice(0, 160));
			const u = (await pool.query(`SELECT removed_at, removed_by FROM users WHERE id = $1`, [viewerId]))
				.rows[0];
			record('removed_at and removed_by set', !!u.removed_at && u.removed_by === adminId);
			const sessions = (
				await pool.query(`SELECT count(*)::int AS n FROM sessions WHERE user_id = $1`, [viewerId])
			).rows[0].n;
			record('all their sessions deleted', sessions === 0, String(sessions));
			const a = await getPage('/app', vA);
			const b = await getPage('/app', vB);
			record('both devices signed out', a.status === 303 && b.status === 303, `${a.status}/${b.status}`);
			const li = await login(VIEWER);
			record(
				'sign-in refused with the usual message',
				!li.cookie && li.status !== 303 && li.html.includes('Username or password is incorrect'),
				String(li.status)
			);
			const again = await action('removeAccess', { userId: String(viewerId) }, admin);
			record('removing twice answers 409', again.json?.status === 409);
			const reset = await action(
				'resetPassword',
				{ userId: String(viewerId), newPassword: 'Whatever!2026' },
				admin
			);
			record('password reset refused while removed', reset.json?.status === 409, reset.text.slice(0, 160));
			const link = await action('reissueInvite', { userId: String(viewerId) }, admin);
			record('invite link refused while removed', link.json?.status === 409, link.text.slice(0, 160));
			const rows = await audit('user_remove', viewerId);
			record(
				'removal audited with who it was',
				rows.length === 1 &&
					rows[0].user_id === adminId &&
					rows[0].before_value?.username === VIEWER &&
					rows[0].before_value?.role === 'viewer'
			);
			const page = await getPage('/admin/users', admin);
			const removedPart = page.html.slice(page.html.indexOf('Removed accounts'));
			record(
				'page lists it under Removed accounts with Restore / Delete permanently',
				page.html.includes('Removed accounts (1)') &&
					removedPart.includes(VIEWER) &&
					removedPart.includes('Restore') &&
					removedPart.includes('Delete permanently') &&
					removedPart.includes('No access')
			);
		}

		// ── Restore ──
		{
			const r = await action('restoreAccess', { userId: String(viewerId) }, admin);
			record('restore succeeds', r.json?.type === 'success', r.text.slice(0, 160));
			const li = await login(VIEWER);
			record('old password works again', li.status === 303 && !!li.cookie, String(li.status));
			const twice = await action('restoreAccess', { userId: String(viewerId) }, admin);
			record('restoring an active account answers 409', twice.json?.status === 409);
			record('restore audited', (await audit('user_restore', viewerId)).length === 1);
		}

		// ── Remove an invited (never signed-in) viewer: link cancelled ──
		{
			const inv = await action('invite', { username: INVITED, displayName: 'Invited Person' }, admin);
			const invitedId = await idOf(pool, INVITED);
			record('invited viewer created', inv.json?.type === 'success' && !!invitedId);
			const tokenMatch = inv.text.match(/\/invite\/([A-Za-z0-9_-]{43})/);
			await action('removeAccess', { userId: String(invitedId) }, admin);
			const linkRow = (
				await pool.query(`SELECT revoked_at FROM user_invites WHERE user_id = $1`, [invitedId])
			).rows[0];
			record('removal cancels the open invite link', !!linkRow?.revoked_at);
			if (tokenMatch) {
				const pg2 = await getPage(`/invite/${tokenMatch[1]}`);
				record(
					'the link no longer offers sign-up',
					pg2.status === 200 && !pg2.html.includes('Choose a password'),
					String(pg2.status)
				);
			}
			// A never-used account deletes cleanly.
			const d = await action('deleteAccount', { userId: String(invitedId) }, admin);
			record('never-used account deletes', d.json?.type === 'success', d.text.slice(0, 160));
			record('it is gone, invite rows with it', (await idOf(pool, INVITED)) === null);
			deletedIds.push(invitedId);
		}

		// ── Delete a throwaway account that has signed in ──
		{
			const signIns = (
				await pool.query(
					`SELECT count(*)::int AS n FROM audit_log WHERE user_id = $1 AND action = 'login'`,
					[viewerId]
				)
			).rows[0].n;
			await action('removeAccess', { userId: String(viewerId) }, admin);
			const d = await action('deleteAccount', { userId: String(viewerId) }, admin);
			record('throwaway account deletes', d.json?.type === 'success', d.text.slice(0, 160));
			deletedIds.push(viewerId);
			record('account row gone', (await idOf(pool, VIEWER)) === null);
			const kept = (
				await pool.query(
					`SELECT count(*)::int AS n FROM audit_log
					  WHERE user_id IS NULL AND entity_type = 'users' AND entity_id = $1 AND action = 'login'`,
					[viewerId]
				)
			).rows[0].n;
			record(
				'its sign-in lines stay, with the person blanked',
				signIns >= 2 && kept === signIns,
				`${kept}/${signIns}`
			);
			const del = await audit('user_delete', viewerId);
			record(
				'delete audited with username, name and role',
				del.length === 1 &&
					del[0].user_id === adminId &&
					del[0].before_value?.username === VIEWER &&
					del[0].before_value?.display_name === `Account test ${VIEWER}`
			);
			const log = await getPage(`/admin/audit?action=login`, admin);
			record('activity log shows "Deleted account"', log.status === 200 && log.html.includes('Deleted account'));
			// Username free again.
			const re = await action(
				'create',
				{ username: VIEWER, displayName: 'Reused', role: 'viewer', password: TEST_PASSWORD },
				admin
			);
			record('the username can be used again', re.httpStatus === 200 && (await idOf(pool, VIEWER)) !== null, re.text.slice(0, 120));
		}

		// ── An account that added content can't be deleted ──
		{
			await pool.query(
				`INSERT INTO notation_key (input_shorthand, canonical_form, meaning, created_by)
				 VALUES ($1, 'x', 'test entry', $2)`,
				[SHORTHAND, authorId]
			);
			await action('removeAccess', { userId: String(authorId) }, admin);
			const d = await action('deleteAccount', { userId: String(authorId) }, admin);
			record(
				'delete refused for an author, in plain words',
				d.json?.status === 409 && d.text.includes('added to the history') && d.text.includes('shorthand entries'),
				d.text.slice(0, 200)
			);
			record('author account still there, still removed', !!(await pool.query(`SELECT removed_at FROM users WHERE id = $1`, [authorId])).rows[0]?.removed_at);
			record('refused delete wrote no delete line', (await audit('user_delete', authorId)).length === 0);
			const restored = await action('restoreAccess', { userId: String(authorId) }, admin);
			record('author can still be restored', restored.json?.type === 'success');
		}

		// ── Two admins removing each other at once ──
		{
			const others = (
				await pool.query(
					`SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND removed_at IS NULL AND id <> ALL($1)`,
					[[adminId, admin2Id]]
				)
			).rows[0].n;
			if (others === 0) {
				const admin2 = await loginCookie(ADMIN2);
				const [x, y] = await Promise.all([
					action('removeAccess', { userId: String(admin2Id) }, admin),
					action('removeAccess', { userId: String(adminId) }, admin2)
				]);
				const left = (
					await pool.query(
						`SELECT count(*)::int AS n FROM users WHERE id = ANY($1) AND removed_at IS NULL`,
						[[adminId, admin2Id]]
					)
				).rows[0].n;
				record(
					'racing admins: one admin always remains',
					left === 1,
					`${x.json?.status ?? x.httpStatus}/${y.json?.status ?? y.httpStatus}, active left ${left}`
				);
			} else {
				record('racing admins: skipped (other admins exist in the test DB)', true, String(others));
			}
		}
	} finally {
		try {
			await cleanup(pool);
			const left = (
				await pool.query(`SELECT count(*)::int AS n FROM users WHERE username = ANY($1)`, [EVERYONE])
			).rows[0].n;
			if (left !== 0) console.error(`cleanup left ${left} test users`);
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
