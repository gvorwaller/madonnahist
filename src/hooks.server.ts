import '$lib/server/monitoring';
import type { Handle } from '@sveltejs/kit';
import { redirect } from '@sveltejs/kit';
import { SESSION_COOKIE_NAME, validateSession, type SessionUser } from '$server/session';
import { RENDER_TOKEN_COOKIE_NAME, verifyRenderToken, matchesRenderScopePath } from '$server/render-token';
import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';

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

	// Scoped render-token auth (Phase H of
	// docs/2026-07-21-next-phases-search-viewer-narrative-plan.md) — a
	// deliberately narrow addition, checked only when there's no real
	// session. A real logged-in user's session always wins; this path exists
	// solely so the enrichment worker's headless Chromium can fetch one
	// specific book page (plus day images, already gated by the viewer
	// accepted-only predicate at the query level) without minting a real
	// session. GET-only and exact-path-matched: see
	// src/lib/server/render-token.ts's matchesRenderScopePath() for exactly
	// what this can and cannot reach. `id: '0'` is deliberately not a real
	// user id (users.id is SERIAL starting at 1) — unmistakably synthetic if
	// it ever surfaced anywhere it shouldn't (it shouldn't: nothing in the
	// app writes a row keyed on this locals.user).
	if (!event.locals.user && event.request.method === 'GET') {
		const renderToken = event.cookies.get(RENDER_TOKEN_COOKIE_NAME);
		if (renderToken) {
			const verified = verifyRenderToken(renderToken, env.AUTH_SECRET);
			if (verified && matchesRenderScopePath(path, verified.scope, verified.key)) {
				event.locals.user = { id: '0', username: 'pdf-renderer', role: 'viewer', display_name: null };
			}
		}
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
