#!/usr/bin/env node
// Invite-link onboarding, sign-in returnTo, About text and "Your name"
// (td-681a6d, Family Viewer V3 Slice 1b;
// docs/2026-11-05-family-viewer-v3-redesign-plan.md §Invite-link onboarding).
//
// Runs against a dev server already started on the isolated test stack:
//   npx vite dev --host 127.0.0.1 --port 5177 --strictPort --mode test
//
// Self-provisions an admin and a viewer in madonnahist_test
// (127.0.0.1:15434), drives the real form actions over HTTP, and cleans up
// in a finally block. Never touches port 5433/5435 or PGDATABASE=madonnahist.
//
// What this asserts:
//   - admin invite creates a viewer, returns a 43-char link once; only its
//     SHA-256 is stored; the link/hash never reach audit_log
//   - /invite/<token> is public only at that exact shape (siblings, extra
//     segments, short tokens stay behind sign-in); no-store + no-referrer
//   - GET never consumes a link; bad password input changes nothing
//   - redeem: sets name/password, signs in (SameSite=Lax cookie), audited,
//     second use refused; concurrent redeems: exactly one succeeds
//   - re-issue cancels the old link; revoke cancels; expired links refused;
//     a password reset cancels an open link
//   - invites refused for non-viewers and already-signed-in viewers;
//     viewers can't call the admin actions
//   - per-link attempt cap answers 429
//   - DB grants: app can't rewrite token/expiry or DELETE; worker sees nothing
//   - returnTo keeps the query; evil returnTo values fall back to landing
//   - About text: default, admin edit, reset; viewer can't edit
//   - "Your name": rename saves + audits; blank refused
//
// Usage: node scripts/test-invites.mjs [baseUrl]   (or: npm run test:invites)

import argon2 from 'argon2';
import pg from 'pg';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
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
const TEST_PASSWORD = 'InviteTest!2026';
const NEW_PASSWORD = 'FamilyPass!2026';
const ADMIN_USERNAME = '_invite_admin';
const VIEWER_USERNAME = '_invite_viewer';
// Usernames the admin invite action creates (cleaned up by name).
const INVITEES = [
	'_inv_jo',
	'_inv_race',
	'_inv_reissue',
	'_inv_expired',
	'_inv_limit',
	'_inv_reset'
];
const ARGON2_OPTS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };
const ABOUT_MARKER = 'QVABOUTMARKER';

let pass = 0;
let fail = 0;
const rows = [];
function record(label, ok, detail = '') {
	if (ok) pass++;
	else fail++;
	rows.push({ label, ok, detail });
}

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

async function req(url, opts = {}) {
	return fetch(`${BASE_URL}${url}`, {
		...opts,
		redirect: 'manual',
		headers: { Accept: 'text/html', ...(opts.headers ?? {}) }
	});
}

function setCookies(res) {
	return typeof res.headers.getSetCookie === 'function'
		? res.headers.getSetCookie()
		: [res.headers.get('set-cookie')].filter(Boolean);
}

function sessionCookie(res) {
	for (const c of setCookies(res)) {
		const m = c.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`));
		if (m && m[1]) return { cookie: `${SESSION_COOKIE_NAME}=${m[1]}`, raw: c };
	}
	return null;
}

async function login(username, password = TEST_PASSWORD, extra = {}) {
	return req(`/login?/login`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: BASE_URL },
		body: new URLSearchParams({ username, password, ...extra }).toString()
	});
}

async function loginCookie(username) {
	const res = await login(username);
	const c = sessionCookie(res);
	if (res.status !== 303 || !c) throw new Error(`login for ${username} failed (${res.status})`);
	return c.cookie;
}

/** Form POST as a no-JS browser would: HTML response with fail() status. */
async function post(url, fields, cookie) {
	const res = await req(url, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
			Origin: BASE_URL,
			...(cookie ? { Cookie: cookie } : {})
		},
		body: new URLSearchParams(fields).toString()
	});
	return { res, status: res.status, html: await res.text() };
}

/** Form POST as use:enhance does: JSON {type, status, data}. */
async function action(url, fields, cookie) {
	const res = await req(url, {
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
		// not JSON (e.g. hooks 403 text)
	}
	return { httpStatus: res.status, json, text };
}

const TOKEN_IN = /\/invite\/([A-Za-z0-9_-]{43})/;

async function adminInvite(adminCookie, username, displayName) {
	const r = await action('/admin/users?/invite', { username, displayName }, adminCookie);
	const m = r.text.match(TOKEN_IN);
	return { ...r, token: m ? m[1] : null };
}

async function getPage(url, cookie) {
	const res = await req(url, { headers: cookie ? { Cookie: cookie } : {} });
	return { res, status: res.status, html: await res.text() };
}

async function provisionUser(pool, username, role) {
	const hash = await argon2.hash(TEST_PASSWORD, ARGON2_OPTS);
	const res = await pool.query(
		`INSERT INTO users (username, display_name, role, password_hash)
		 VALUES ($1, $2, $3, $4)
		 ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role,
		   display_name = EXCLUDED.display_name
		 RETURNING id`,
		[username, `Invite test ${role}`, role, hash]
	);
	return res.rows[0].id;
}

async function cleanupUsers(pool, usernames) {
	const ids = (
		await pool.query(`SELECT id FROM users WHERE username = ANY($1)`, [usernames])
	).rows.map((r) => r.id);
	if (ids.length === 0) return;
	await pool.query(`DELETE FROM sessions WHERE user_id = ANY($1)`, [ids]);
	await pool.query(
		`DELETE FROM audit_log WHERE user_id = ANY($1) OR (entity_type = 'users' AND entity_id = ANY($1))`,
		[ids]
	);
	// user_invites rows go with the user (ON DELETE CASCADE / SET NULL,
	// run as the table owner); the app role itself has no DELETE there.
	await pool.query(`DELETE FROM users WHERE id = ANY($1)`, [ids]);
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
	const everyone = [ADMIN_USERNAME, VIEWER_USERNAME, ...INVITEES];
	const aboutBefore = (await pool.query(`SELECT value FROM app_state WHERE key = 'viewer_about'`))
		.rows[0]?.value;

	try {
		await cleanupUsers(pool, everyone);
		const adminId = await provisionUser(pool, ADMIN_USERNAME, 'admin');
		const viewerId = await provisionUser(pool, VIEWER_USERNAME, 'viewer');
		const admin = await loginCookie(ADMIN_USERNAME);
		const viewer = await loginCookie(VIEWER_USERNAME);

		// ── Cookie ──
		{
			const res = await login(VIEWER_USERNAME);
			const c = sessionCookie(res);
			record(
				'session cookie is SameSite=Lax + HttpOnly',
				!!c && /SameSite=Lax/i.test(c.raw) && /HttpOnly/i.test(c.raw),
				c?.raw ?? 'none'
			);
		}

		// ── Admin creates an invite ──
		const jo = await adminInvite(admin, '_INV_Jo ', 'Grandma Jo');
		record(
			'admin invite returns a 43-char link',
			!!jo.token && jo.json?.type === 'success',
			jo.text.slice(0, 300)
		);
		const joUser = (
			await pool.query(
				`SELECT id, role, display_name, last_login_at FROM users WHERE username = '_inv_jo'`
			)
		).rows[0];
		record(
			'invite creates a never-signed-in viewer (username normalized)',
			joUser?.role === 'viewer' && !joUser.last_login_at && joUser.display_name === 'Grandma Jo'
		);
		const joInvite = (
			await pool.query(`SELECT * FROM user_invites WHERE user_id = $1`, [joUser?.id])
		).rows;
		record(
			'only the SHA-256 of the token is stored',
			joInvite.length === 1 &&
				joInvite[0].token_hash === sha256(jo.token ?? '') &&
				!JSON.stringify(joInvite).includes(jo.token ?? '@@'),
			''
		);
		{
			const days = (new Date(joInvite[0]?.expires_at) - Date.now()) / 86_400_000;
			record('link expires in 30 days', days > 29.9 && days <= 30.01, days.toFixed(3));
		}
		const auditText = JSON.stringify(
			(
				await pool.query(`SELECT * FROM audit_log WHERE entity_type = 'users' AND entity_id = $1`, [
					joUser?.id
				])
			).rows
		);
		record(
			'audit has the invite, never the link or hash',
			auditText.includes('user_invite') &&
				!auditText.includes(jo.token ?? '@@') &&
				!auditText.includes(sha256(jo.token ?? '')),
			''
		);
		{
			const dup = await action(
				'/admin/users?/invite',
				{ username: '_inv_jo', displayName: 'Again' },
				admin
			);
			record(
				'duplicate username refused',
				dup.json?.type === 'failure' && dup.json?.status === 409,
				dup.text.slice(0, 80)
			);
			const bad = await action(
				'/admin/users?/invite',
				{ username: 'a b', displayName: 'X' },
				admin
			);
			record('bad username refused', bad.json?.type === 'failure' && bad.json?.status === 400);
			const asViewer = await action(
				'/admin/users?/invite',
				{ username: '_inv_nope', displayName: 'X' },
				viewer
			);
			const created = (await pool.query(`SELECT 1 FROM users WHERE username = '_inv_nope'`))
				.rowCount;
			record(
				'viewer cannot call the admin invite action',
				asViewer.httpStatus === 403 && created === 0,
				String(asViewer.httpStatus)
			);
		}

		// ── Public route shape ──
		{
			const page = await getPage(`/invite/${jo.token}`);
			record(
				'GET /invite/<token> is public and welcomes them',
				page.status === 200 &&
					page.html.includes('Welcome, Grandma Jo') &&
					page.html.includes('_inv_jo'),
				String(page.status)
			);
			record(
				'invite page sends no-store',
				/no-store/.test(page.res.headers.get('cache-control') ?? ''),
				page.res.headers.get('cache-control') ?? ''
			);
			record(
				'invite page sends Referrer-Policy: no-referrer',
				page.res.headers.get('referrer-policy') === 'no-referrer'
			);
			const again = await getPage(`/invite/${jo.token}`);
			const used = (
				await pool.query(`SELECT used_at FROM user_invites WHERE user_id = $1`, [joUser.id])
			).rows[0].used_at;
			record(
				'GET twice never consumes the link',
				again.html.includes('Welcome, Grandma Jo') && used === null
			);
			const random = await getPage(`/invite/${randomBytes(32).toString('base64url')}`);
			record(
				'unknown well-formed token: 200 "doesn\'t work"',
				random.status === 200 &&
					random.html.includes('This link doesn') &&
					random.html.includes('Gaylon / Dad / Papa')
			);
			for (const p of [
				'/invite',
				'/invite/',
				'/invite/short',
				`/invite/${jo.token}/extra`,
				`/invitee/${jo.token}`,
				`/invite/${jo.token}x`
			]) {
				const r = await getPage(p);
				const loc = r.res.headers.get('location') ?? '';
				record(
					`not public: ${p.replace(jo.token, '<token>')}`,
					r.status === 303 &&
						loc.startsWith('/login') &&
						(p.startsWith('/invitee') || !loc.includes(jo.token)),
					`${r.status} ${loc.replace(jo.token, '<token>')}`
				);
			}
			const slash = await getPage(`/invite/${jo.token}/`);
			const slashLoc = slash.res.headers.get('location') ?? '';
			record(
				'trailing slash redirects to the link itself',
				slash.status >= 300 && slash.status < 400 && slashLoc.endsWith(`/invite/${jo.token}`),
				`${slash.status}`
			);
			const signedIn = await getPage(`/invite/${jo.token}`, viewer);
			record(
				'signed-in browser is told who is signed in',
				signedIn.html.includes('This browser is signed in as') &&
					signedIn.html.includes('Invite test viewer')
			);
		}

		// ── Redeem: bad input changes nothing ──
		{
			const mismatch = await post(`/invite/${jo.token}?/redeem`, {
				displayName: 'Jo',
				password: NEW_PASSWORD,
				confirm: 'different!!'
			});
			const short = await post(`/invite/${jo.token}?/redeem`, {
				displayName: 'Jo',
				password: 'short',
				confirm: 'short'
			});
			const blank = await post(`/invite/${jo.token}?/redeem`, {
				displayName: '   ',
				password: NEW_PASSWORD,
				confirm: NEW_PASSWORD
			});
			const row = (
				await pool.query(`SELECT used_at FROM user_invites WHERE user_id = $1`, [joUser.id])
			).rows[0];
			record(
				'mismatched passwords: 400 with a message',
				mismatch.status === 400 && mismatch.html.includes('passwords don'),
				String(mismatch.status)
			);
			record(
				'short password: 400',
				short.status === 400 && short.html.includes('at least 8'),
				String(short.status)
			);
			record('blank name: 400', blank.status === 400, String(blank.status));
			record('failed attempts leave the link unused', row.used_at === null);
		}

		// ── Redeem: success ──
		let joCookie = null;
		{
			const r = await post(`/invite/${jo.token}?/redeem`, {
				displayName: '  Jo   Vorwaller ',
				password: NEW_PASSWORD,
				confirm: NEW_PASSWORD
			});
			const c = sessionCookie(r.res);
			joCookie = c?.cookie ?? null;
			record(
				'redeem: 200, success screen with username',
				r.status === 200 && r.html.includes("You're all set") && r.html.includes('_inv_jo'),
				String(r.status)
			);
			record(
				'redeem shows home-screen steps',
				r.html.includes('Add to Home Screen') && r.html.includes('Add to Home screen')
			);
			record('redeem sets a Lax session cookie', !!c && /SameSite=Lax/i.test(c.raw));
			const u = (
				await pool.query(`SELECT display_name, last_login_at FROM users WHERE id = $1`, [joUser.id])
			).rows[0];
			record(
				'name saved (trimmed, single-spaced); marked signed in',
				u.display_name === 'Jo Vorwaller' && !!u.last_login_at,
				u.display_name
			);
			const inv = (
				await pool.query(`SELECT used_at FROM user_invites WHERE user_id = $1`, [joUser.id])
			).rows[0];
			record('link marked used', inv.used_at !== null);
			const app = joCookie ? await getPage('/app', joCookie) : { status: 0 };
			record('new session opens /app', app.status === 200, String(app.status));
			const viaLogin = await login('_inv_jo', NEW_PASSWORD);
			record('they can sign in with their new password', viaLogin.status === 303);
			const audits = JSON.stringify(
				(
					await pool.query(
						`SELECT action, after_value, description FROM audit_log WHERE user_id = $1`,
						[joUser.id]
					)
				).rows
			);
			record(
				'redeem audited without link/hash/password',
				audits.includes('invite_redeem') &&
					!audits.includes(jo.token) &&
					!audits.includes(sha256(jo.token)) &&
					!audits.includes(NEW_PASSWORD)
			);
			const second = await post(`/invite/${jo.token}?/redeem`, {
				displayName: 'Hijack',
				password: 'Another!2026',
				confirm: 'Another!2026'
			});
			const after = (await pool.query(`SELECT display_name FROM users WHERE id = $1`, [joUser.id]))
				.rows[0];
			record(
				'second use refused (410, "already been used")',
				second.status === 410 &&
					second.html.includes('already been used') &&
					after.display_name === 'Jo Vorwaller',
				String(second.status)
			);
			const getUsed = await getPage(`/invite/${jo.token}`);
			record(
				'GET a used link: "already been used" + Sign in',
				getUsed.html.includes('already been used') && getUsed.html.includes('href="/login"')
			);
			const reissueSigned = await action(
				'/admin/users?/reissueInvite',
				{ userId: String(joUser.id) },
				admin
			);
			record(
				'no new link for a viewer who has signed in (409)',
				reissueSigned.json?.status === 409
			);
			const reissueAdmin = await action(
				'/admin/users?/reissueInvite',
				{ userId: String(adminId) },
				admin
			);
			record('no invite link for a non-viewer (400)', reissueAdmin.json?.status === 400);
		}

		// ── Concurrent redeem ──
		{
			const race = await adminInvite(admin, '_inv_race', 'Race Test');
			const raceId = (await pool.query(`SELECT id FROM users WHERE username = '_inv_race'`)).rows[0]
				.id;
			const tries = await Promise.all(
				[1, 2, 3].map((i) =>
					post(`/invite/${race.token}?/redeem`, {
						displayName: `Racer ${i}`,
						password: NEW_PASSWORD,
						confirm: NEW_PASSWORD
					})
				)
			);
			const ok = tries.filter((t) => t.status === 200 && t.html.includes("You're all set")).length;
			const sessions = (
				await pool.query(`SELECT count(*)::int AS n FROM sessions WHERE user_id = $1`, [raceId])
			).rows[0].n;
			record(
				'3 concurrent redeems: exactly one succeeds, one session',
				ok === 1 && sessions === 1,
				`ok=${ok} sessions=${sessions} statuses=${tries.map((t) => t.status)}`
			);
		}

		// ── Re-issue and revoke ──
		{
			const first = await adminInvite(admin, '_inv_reissue', 'Reissue Test');
			const uid = (await pool.query(`SELECT id FROM users WHERE username = '_inv_reissue'`)).rows[0]
				.id;
			const second = await action('/admin/users?/reissueInvite', { userId: String(uid) }, admin);
			const secondToken = second.text.match(TOKEN_IN)?.[1];
			const old = await getPage(`/invite/${first.token}`);
			const fresh = await getPage(`/invite/${secondToken}`);
			record(
				're-issue: old link "replaced", new link works',
				old.html.includes('This link was replaced') && fresh.html.includes('Welcome, Reissue Test'),
				''
			);
			const open = (
				await pool.query(
					`SELECT count(*)::int AS n FROM user_invites WHERE user_id = $1 AND used_at IS NULL AND revoked_at IS NULL`,
					[uid]
				)
			).rows[0].n;
			record('only one open link per user', open === 1, String(open));
			const oldPost = await post(`/invite/${first.token}?/redeem`, {
				displayName: 'X',
				password: NEW_PASSWORD,
				confirm: NEW_PASSWORD
			});
			record('redeeming a replaced link: 410', oldPost.status === 410);
			const rv = await action('/admin/users?/revokeInvite', { userId: String(uid) }, admin);
			const afterRevoke = await getPage(`/invite/${secondToken}`);
			record(
				'revoke cancels the link',
				rv.json?.type === 'success' && afterRevoke.html.includes('This link was replaced')
			);
			const rv2 = await action('/admin/users?/revokeInvite', { userId: String(uid) }, admin);
			record('revoke with nothing open: 409', rv2.json?.status === 409);
			const usersPage = await getPage('/admin/users', admin);
			record(
				'admin users page shows "Invite a family member"',
				usersPage.status === 200 && usersPage.html.includes('Invite a family member')
			);
		}

		// ── Password reset cancels an open link ──
		{
			const inv = await adminInvite(admin, '_inv_reset', 'Reset Test');
			const uid = (await pool.query(`SELECT id FROM users WHERE username = '_inv_reset'`)).rows[0]
				.id;
			await action(
				'/admin/users?/resetPassword',
				{ userId: String(uid), newPassword: 'AdminSet!2026' },
				admin
			);
			const page = await getPage(`/invite/${inv.token}`);
			record(
				'admin password reset cancels the open link',
				page.html.includes('This link was replaced')
			);
		}

		// ── Expired ──
		{
			const uid = await provisionUser(pool, '_inv_expired', 'viewer');
			await pool.query(`UPDATE users SET last_login_at = NULL WHERE id = $1`, [uid]);
			const token = randomBytes(32).toString('base64url');
			await pool.query(
				`INSERT INTO user_invites (user_id, token_hash, created_at, expires_at, created_by)
				 VALUES ($1, $2, NOW() - interval '31 days', NOW() - interval '1 day', $3)`,
				[uid, sha256(token), adminId]
			);
			const page = await getPage(`/invite/${token}`);
			const p = await post(`/invite/${token}?/redeem`, {
				displayName: 'X',
				password: NEW_PASSWORD,
				confirm: NEW_PASSWORD
			});
			record(
				'expired link: "has expired" + ask the admin',
				page.html.includes('This link has expired') && page.html.includes('Gaylon / Dad / Papa')
			);
			record('expired link redeem: 410, nothing changed', p.status === 410);
		}

		// ── Per-link attempt cap ──
		{
			const lim = await adminInvite(admin, '_inv_limit', 'Limit Test');
			let last = 0;
			for (let i = 0; i < 11; i++) {
				last = (
					await post(`/invite/${lim.token}?/redeem`, {
						displayName: 'L',
						password: 'x',
						confirm: 'y'
					})
				).status;
			}
			record('11th attempt on one link: 429', last === 429, String(last));
		}

		// ── Grants ──
		{
			let updErr = '';
			try {
				await pool.query(
					`UPDATE user_invites SET expires_at = NOW() + interval '1 year' WHERE false`
				);
			} catch (e) {
				updErr = e.code;
			}
			record('app cannot UPDATE expires_at (42501)', updErr === '42501', updErr);
			let tokErr = '';
			try {
				await pool.query(`UPDATE user_invites SET token_hash = token_hash WHERE false`);
			} catch (e) {
				tokErr = e.code;
			}
			record('app cannot UPDATE token_hash (42501)', tokErr === '42501', tokErr);
			let delErr = '';
			try {
				await pool.query(`DELETE FROM user_invites WHERE false`);
			} catch (e) {
				delErr = e.code;
			}
			record('app cannot DELETE invites (42501)', delErr === '42501', delErr);
			const w = await Promise.all(
				['SELECT', 'INSERT', 'UPDATE', 'DELETE'].map(
					async (p) =>
						(
							await pool.query(
								`SELECT has_table_privilege('madonnahist_worker', 'user_invites', $1) AS ok`,
								[p]
							)
						).rows[0].ok
				)
			);
			record(
				'worker has no access to user_invites',
				w.every((x) => x === false),
				w.join(',')
			);
		}

		// ── returnTo ──
		{
			const r = await getPage('/app/search?q=picnic&year=1976');
			record(
				'signed-out GET keeps the query in returnTo',
				r.status === 303 &&
					r.res.headers.get('location') ===
						'/login?returnTo=%2Fapp%2Fsearch%3Fq%3Dpicnic%26year%3D1976',
				r.res.headers.get('location') ?? ''
			);
			const lp = await getPage('/login?returnTo=%2Fapp%2Fsearch%3Fq%3Dpicnic');
			record(
				'login page carries returnTo in a hidden field',
				lp.html.includes('name="returnTo" value="/app/search?q=picnic"')
			);
			record(
				'login form posts to absolute /login?/login',
				lp.html.includes('action="/login?/login"')
			);
			const ok = await login(VIEWER_USERNAME, TEST_PASSWORD, { returnTo: '/app/search?q=picnic' });
			record(
				'sign-in returns to the shared link, query intact',
				ok.headers.get('location') === '/app/search?q=picnic',
				ok.headers.get('location') ?? ''
			);
			for (const evil of [
				'//evil.example/x',
				'/\\evil.example',
				'https://evil.example',
				'/login?returnTo=/app',
				'/app\nX'
			]) {
				const r2 = await login(VIEWER_USERNAME, TEST_PASSWORD, { returnTo: evil });
				record(
					`evil returnTo ${JSON.stringify(evil)} → landing`,
					r2.headers.get('location') === '/app',
					r2.headers.get('location') ?? ''
				);
			}
			const failed = await post('/login?/login', {
				username: VIEWER_USERNAME,
				password: 'wrong',
				returnTo: '/app/day/1976-03-12'
			});
			record(
				'failed sign-in keeps returnTo',
				failed.status === 401 && failed.html.includes('value="/app/day/1976-03-12"')
			);
			const manifest = await getPage('/manifest.webmanifest');
			record('manifest is public', manifest.status === 200);
		}

		// ── About text ──
		{
			await pool.query(`DELETE FROM app_state WHERE key = 'viewer_about'`);
			const def = await getPage('/app/about', viewer);
			record(
				'About shows the default text',
				def.status === 200 && def.html.includes('sixty years')
			);
			const drawer = await getPage('/app', viewer);
			record(
				'menu links About and Your name',
				drawer.html.includes('href="/app/about"') && drawer.html.includes('href="/app/account"')
			);
			const v = await action('/admin/about?/save', { text: 'nope' }, viewer);
			record('viewer cannot edit About', v.httpStatus === 403);
			const s = await action(
				'/admin/about?/save',
				{ text: `First ${ABOUT_MARKER} para.\r\n\r\nSecond <b>para</b>.` },
				admin
			);
			const shown = await getPage('/app/about', viewer);
			record(
				'admin edit shows to the family as paragraphs',
				s.json?.type === 'success' &&
					new RegExp(`<p[^>]*>First ${ABOUT_MARKER} para\\.</p>`).test(shown.html) &&
					/<p[^>]*>Second &lt;b>para&lt;\/b>\.<\/p>/.test(shown.html),
				''
			);
			const tooLong = await action('/admin/about?/save', { text: 'x'.repeat(6001) }, admin);
			record('over-long About refused', tooLong.json?.status === 400);
			await action('/admin/about?/save', { text: '   ' }, admin);
			const back = await getPage('/app/about', viewer);
			record(
				'saving empty returns to the default',
				back.html.includes('sixty years') && !back.html.includes(ABOUT_MARKER)
			);
			const audits = (
				await pool.query(
					`SELECT count(*)::int AS n FROM audit_log WHERE user_id = $1 AND action = 'about_text_update'`,
					[adminId]
				)
			).rows[0].n;
			record('About edits are audited', audits >= 2, String(audits));
		}

		// ── Your name ──
		{
			const page = await getPage('/app/account', viewer);
			record(
				'Your name page shows the username',
				page.status === 200 && page.html.includes(VIEWER_USERNAME)
			);
			const blank = await action('/app/account?/rename', { displayName: '  ' }, viewer);
			record('blank name refused', blank.json?.status === 400);
			const ok = await action('/app/account?/rename', { displayName: 'Cousin  Sam' }, viewer);
			const u = (await pool.query(`SELECT display_name FROM users WHERE id = $1`, [viewerId]))
				.rows[0];
			record(
				'rename saves',
				ok.json?.type === 'success' && u.display_name === 'Cousin Sam',
				u.display_name
			);
			const shell = await getPage('/app', viewer);
			record('menu shows the new name', shell.html.includes('Signed in as Cousin Sam'));
			const a = (
				await pool.query(
					`SELECT count(*)::int AS n FROM audit_log WHERE user_id = $1 AND action = 'display_name_change'`,
					[viewerId]
				)
			).rows[0].n;
			record('rename audited', a === 1, String(a));
			const noCookie = await action('/app/account?/rename', { displayName: 'X' });
			record(
				'signed out: rename refused',
				noCookie.httpStatus === 401 || noCookie.httpStatus === 303,
				String(noCookie.httpStatus)
			);
		}

		// ── Stories by decade ──
		{
			const st = await getPage('/app/stories', viewer);
			record(
				'Stories renders (decade folds markup when stories exist)',
				st.status === 200 &&
					(st.html.includes('No year stories yet') || st.html.includes('class="v-fold decade'))
			);
		}
		void joCookie;
	} finally {
		try {
			await cleanupUsers(pool, [...everyone, '_inv_nope']);
			if (aboutBefore === undefined)
				await pool.query(`DELETE FROM app_state WHERE key = 'viewer_about'`);
			else
				await pool.query(
					`INSERT INTO app_state (key, value) VALUES ('viewer_about', $1::jsonb)
					 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
					[JSON.stringify(aboutBefore)]
				);
			const left = (
				await pool.query(`SELECT count(*)::int AS n FROM users WHERE username = ANY($1)`, [
					everyone
				])
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
