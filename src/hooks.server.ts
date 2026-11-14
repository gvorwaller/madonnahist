import '$lib/server/monitoring';
import type { Handle, HandleServerError, ServerInit } from '@sveltejs/kit';
import { redirect } from '@sveltejs/kit';
import { SESSION_COOKIE_NAME, validateSession, type SessionUser } from '$server/session';
import { RENDER_TOKEN_COOKIE_NAME, verifyRenderToken, matchesRenderScopePath } from '$server/render-token';
import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import { startPlaceLookupTimer } from '$lib/server/places';

// SameSite=Lax (V3 Slice 1b; cs.md "Auth"): a family member tapping a link
// in Messages or Mail is a cross-site top-level navigation, which Strict
// would send without the session, so every shared link showed the login
// page. Lax still withholds the cookie from cross-site POSTs, iframes and
// subresources, and SvelteKit's csrf.checkOrigin also rejects cross-site
// form POSTs. GET handlers must stay free of meaningful side effects.
export const SESSION_COOKIE_OPTS = {
	path: '/',
	httpOnly: true,
	sameSite: 'lax' as const,
	secure: !dev,
	maxAge: 60 * 60 * 24 * 30
};

const PUBLIC_PATHS = [
	'/login',
	'/api/health',
	// Home-screen install files (iOS fetches these without the session).
	// adapter-node serves static/ before hooks run in production; these
	// exact entries keep dev and any future hook-first setup the same.
	'/manifest.webmanifest',
	'/favicon.svg',
	'/apple-touch-icon.png',
	'/icon-192.png',
	'/icon-512.png'
];

// /invite/<token>: exactly one segment with the exact token shape
// (src/lib/server/invites.ts INVITE_TOKEN_RE), plus an optional trailing
// slash that SvelteKit then strips. No prefix match, so /invite,
// /invite/x/y and /invitee/... stay behind sign-in.
const INVITE_PATH = /^\/invite\/[A-Za-z0-9_-]{43}\/?$/;

function isPublic(path: string): boolean {
	return PUBLIC_PATHS.includes(path) || INVITE_PATH.test(path);
}

/** Paths as they may appear in logs: an invite link is a credential. */
export function redactPath(path: string): string {
	return path.startsWith('/invite/') ? '/invite/[redacted]' : path;
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

/** Once per server start: the hourly lookup of new places (td-085e19). */
export const init: ServerInit = async () => {
	startPlaceLookupTimer();
};

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

	if (INVITE_PATH.test(path)) {
		const response = await resolve(event);
		// The URL carries a bearer token: never cache it, never send it on
		// as a Referer.
		try {
			response.headers.set('Cache-Control', 'no-store');
			response.headers.set('Referrer-Policy', 'no-referrer');
		} catch {
			// Immutable headers (e.g. a redirect Response): nothing cached there.
		}
		return response;
	}

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
			// A malformed invite path may still hold a token: never copy it
			// into the login URL (and so into logs and history).
			if (matchesPrefix(path, '/invite')) throw redirect(303, '/login');
			// Keep the query, so a shared search or ?date= link survives sign-in.
			const returnTo = encodeURIComponent(path + event.url.search);
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

// Same output as SvelteKit's default error logger, except the path goes
// through redactPath() so an invite token never lands in the PM2 logs.
export const handleError: HandleServerError = ({ error, event, status }) => {
	const line = `\n[${status}] ${event.request.method} ${redactPath(event.url.pathname)}`;
	if (status === 404) {
		console.error(line);
		return;
	}
	const stack = error instanceof Error ? error.stack : String(error);
	console.error(`${line}\n${stack}`);
};
