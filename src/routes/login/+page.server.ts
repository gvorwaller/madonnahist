import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { findUserByUsername, recordLogin, verifyPassword } from '$server/auth';
import { createSession, destroySession, SESSION_COOKIE_NAME } from '$server/session';
import { SESSION_COOKIE_OPTS } from '../../hooks.server';
import { query } from '$lib/db';

const DUMMY_HASH =
	'$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function landingFor(role: string): string {
	if (role === 'admin') return '/admin';
	if (role === 'corrector') return '/correct';
	return '/app';
}

/**
 * Same-site path (with its query) to go back to after signing in, or null.
 * Rejects anything that could leave the site or loop: protocol-relative
 * "//", backslashes (browsers read "/\\evil" as "//evil"), control
 * characters, over-long values, and the login page itself.
 */
function safeReturnTo(value: string | null | undefined): string | null {
	if (!value || value.length > 1000) return null;
	if (!value.startsWith('/') || value.startsWith('//')) return null;
	// eslint-disable-next-line no-control-regex
	if (/[\\\u0000-\u001f\u007f]/.test(value)) return null;
	const pathOnly = value.split(/[?#]/, 1)[0];
	if (pathOnly === '/login' || pathOnly.startsWith('/login/')) return null;
	return value;
}

export const load: PageServerLoad = ({ locals, url }) => {
	const returnTo = safeReturnTo(url.searchParams.get('returnTo'));
	if (locals.user) {
		throw redirect(303, returnTo ?? landingFor(locals.user.role));
	}
	// The form posts to the absolute /login?/login (Safari bfcache can
	// mis-resolve a relative ?/login), so returnTo rides in a hidden field.
	return { returnTo };
};

export const actions: Actions = {
	login: async ({ cookies, request, url }) => {
		const form = await request.formData();
		const username = (form.get('username') ?? '').toString().trim().toLowerCase();
		const password = (form.get('password') ?? '').toString();
		const returnTo = safeReturnTo(
			(form.get('returnTo') ?? '').toString() || url.searchParams.get('returnTo')
		);

		if (!username || !password) {
			return fail(400, { username, error: 'Enter a username and password.', returnTo });
		}

		const user = await findUserByUsername(username);
		if (!user) {
			await verifyPassword(DUMMY_HASH, password);
			return fail(401, { username, error: 'Username or password is incorrect.', returnTo });
		}

		const ok = await verifyPassword(user.password_hash, password);
		if (!ok) {
			return fail(401, { username, error: 'Username or password is incorrect.', returnTo });
		}

		await recordLogin(user.id);
		// td-310bf7: audit trail for accountability — failed attempts are
		// deliberately NOT logged in v1 (avoids credential-adjacent noise from
		// recording attempted usernames), so this only fires on success.
		await query(
			`INSERT INTO audit_log (user_id, action, entity_type, entity_id, description)
			 VALUES ($1, 'login', 'users', $1, 'Signed in')`,
			[user.id]
		);
		const sessionId = await createSession(user.id);
		cookies.set(SESSION_COOKIE_NAME, sessionId, SESSION_COOKIE_OPTS);

		throw redirect(303, returnTo ?? landingFor(user.role));
	},

	logout: async ({ cookies }) => {
		const token = cookies.get(SESSION_COOKIE_NAME);
		if (token) {
			await destroySession(token);
			cookies.delete(SESSION_COOKIE_NAME, { path: '/' });
		}
		throw redirect(303, '/login');
	}
};
