/**
 * Signed out while a page was open (td-76a40f, CODEX review).
 *
 * src/hooks.server.ts answers a signed-out POST with a plain 401
 * `{"error":"Unauthorized"}`, not a SvelteKit ActionResult, so use:enhance
 * hands the callback an object with no known `type`. The default update()
 * then does nothing at all; a form that cares says so and offers sign-in.
 * (Deliberately not a redirect from the hook: the memory editor would lose
 * what was typed.)
 */
const ACTION_RESULT_TYPES = new Set(['success', 'failure', 'redirect', 'error']);

export function isSignedOutResult(result: { type?: unknown }): boolean {
	return !ACTION_RESULT_TYPES.has(String(result?.type));
}

/** Sign in, then come back to this page (path and query). */
export function signInHref(url: URL): string {
	return `/login?returnTo=${encodeURIComponent(url.pathname + url.search)}`;
}
