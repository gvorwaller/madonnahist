import '$lib/server/monitoring';
import type { Handle } from '@sveltejs/kit';
import { redirect } from '@sveltejs/kit';
import { SESSION_COOKIE_NAME, validateSession, type SessionUser } from '$server/session';
import { dev } from '$app/environment';

export const SESSION_COOKIE_OPTS = {
	path: '/',
	httpOnly: true,
	sameSite: 'strict' as const,
	secure: !dev,
	maxAge: 60 * 60 * 24 * 30
};

const PUBLIC_PATHS = ['/login', '/api/health'];

function isPublic(path: string): boolean {
	return PUBLIC_PATHS.some(p => path === p);
}

// Segment-boundary match: `/app` matches `/app` and `/app/...` but never
// `/application` — a plain startsWith() would wrongly let the latter inherit
// the former's rule.
function matchesPrefix(path: string, prefix: string): boolean {
	return path === prefix || path.startsWith(prefix + '/');
}

// Explicit allow-list. Anything not covered below is denied (403) — no more
// default-allow fallthrough. Public paths never reach this function; see
// the `isPublic` bypass in `handle` below.
function roleAllowed(path: string, role: string): boolean {
	if (matchesPrefix(path, '/admin')) return role === 'admin';
	if (matchesPrefix(path, '/correct')) return role === 'admin' || role === 'corrector';
	if (matchesPrefix(path, '/app')) return true; // any authenticated role
	if (path === '/') return true; // exact landing page only
	return false;
}

export const handle: Handle = async ({ event, resolve }) => {
	const token = event.cookies.get(SESSION_COOKIE_NAME);

	if (token) {
		const user = await validateSession(token);
		if (user) {
			event.locals.user = user;
		} else {
			event.cookies.delete(SESSION_COOKIE_NAME, { path: '/' });
		}
	}

	const path = event.url.pathname;

	if (isPublic(path)) {
		return resolve(event);
	}

	if (!event.locals.user) {
		if (event.request.method === 'GET') {
			const returnTo = encodeURIComponent(path);
			throw redirect(303, `/login?returnTo=${returnTo}`);
		}
		return new Response(JSON.stringify({ error: 'Unauthorized' }), {
			status: 401,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	if (!roleAllowed(path, event.locals.user.role)) {
		return new Response('Forbidden', { status: 403 });
	}

	return resolve(event);
};
