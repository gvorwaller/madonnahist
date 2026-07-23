/**
 * Scoped render token for headless PDF rendering (Phase H of
 * docs/2026-07-21-next-phases-search-viewer-narrative-plan.md).
 *
 * NOT a minted session — a short-lived, narrowly-scoped credential that the
 * enrichment worker's headless Chromium presents (via a cookie it sets
 * itself through the Playwright API, never through this app's own
 * Set-Cookie response) so it can fetch exactly the one book page it needs
 * to print, plus any day image gated by the existing viewer accepted-only
 * predicate — nothing else. See src/hooks.server.ts for where this is
 * verified and turned into a synthetic, viewer-role `locals.user`.
 *
 * HMAC-SHA256 over `scope:key:expiresAtMs`, keyed by a caller-supplied
 * secret (in practice always AUTH_SECRET), verified with a constant-time
 * comparison. Max/default TTL is 15 minutes.
 *
 * The secret is a REQUIRED PARAMETER, not read internally from any env
 * source — deliberately, after hitting a real bug: this module is imported
 * from two different runtimes — src/hooks.server.ts (via vite, as
 * `$server/render-token`) AND directly by backend/workers/enrichment-worker.ts
 * (run by tsx outside vite, via a relative path). Those two runtimes do NOT
 * agree on how `AUTH_SECRET` reaches `process.env`: in the production
 * adapter-node build (and in the worker, always a plain tsx process),
 * `process.env.AUTH_SECRET` is populated directly by Node's --env-file flag
 * and reading it there works. But under `vite dev` (the local test stack —
 * `npx vite dev --mode test`), SvelteKit's env plumbing is different:
 * `$env/dynamic/private` is served by a vite-internal virtual module that
 * reads `.env`/`.env.[mode]` itself and does NOT mutate the real
 * `process.env` — so a version of this module that read
 * `process.env.AUTH_SECRET` directly worked in production and in the worker,
 * but silently saw `undefined` inside `vite dev`, failing every render-token
 * verification there (caught by scripts/test-pdf-export.mjs's render-token
 * security-matrix assertions, which is exactly what that test is for).
 * Callers now resolve the secret through whichever mechanism is correct for
 * their own runtime and pass it in: src/hooks.server.ts passes
 * `env.AUTH_SECRET` from `$env/dynamic/private` (correct in both `vite dev`
 * and the production build); backend/workers/enrichment-worker.ts passes
 * `process.env.AUTH_SECRET` (correct for a plain tsx process either way).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const RENDER_TOKEN_COOKIE_NAME = 'madonnahist_render_token';
export const RENDER_TOKEN_MAX_TTL_MS = 15 * 60 * 1000;

function sign(payload: string, secret: string): string {
	return createHmac('sha256', secret).update(payload).digest('base64url');
}

export interface RenderTokenParts {
	scope: string;
	key: string;
	expiresAtMs: number;
}

/**
 * Issues a token good for `ttlMs` (default and hard max: RENDER_TOKEN_MAX_TTL_MS,
 * 15 minutes). Throws on a missing/empty secret, an out-of-range ttl, or a
 * scope/key containing the `:` delimiter — callers are worker job code
 * (backend/workers/enrichment-worker.ts's processPdfExport), where a thrown
 * error correctly fails that one job_runs row (caught, written to
 * last_error) rather than silently minting an unsigned or malformed token.
 */
export function issueRenderToken(
	scope: string,
	key: string,
	secret: string | undefined,
	ttlMs: number = RENDER_TOKEN_MAX_TTL_MS
): string {
	if (ttlMs <= 0 || ttlMs > RENDER_TOKEN_MAX_TTL_MS) {
		throw new Error(`render token ttl must be in (0, ${RENDER_TOKEN_MAX_TTL_MS}]ms, got ${ttlMs}`);
	}
	if (scope.includes(':') || key.includes(':')) {
		throw new Error('render token scope/key must not contain ":"');
	}
	if (!secret) throw new Error('AUTH_SECRET is not configured — cannot issue a render token');

	const expiresAtMs = Date.now() + ttlMs;
	const payload = `${scope}:${key}:${expiresAtMs}`;
	return `${payload}:${sign(payload, secret)}`;
}

/**
 * Verifies a token read from the cookie. Never throws — this runs on every
 * unauthenticated GET in src/hooks.server.ts, so a missing/empty secret or a
 * malformed/expired/forged token must fail closed (return null) rather than
 * crash request handling for every visitor.
 */
export function verifyRenderToken(token: string, secret: string | undefined): RenderTokenParts | null {
	try {
		if (!secret) return null;

		const parts = token.split(':');
		if (parts.length !== 4) return null;
		const [scope, key, expStr, sig] = parts;
		if (!scope || !key || !sig) return null;

		const expiresAtMs = Number(expStr);
		if (!Number.isFinite(expiresAtMs)) return null;

		const payload = `${scope}:${key}:${expStr}`;
		const expectedSig = sign(payload, secret);
		const sigBuf = Buffer.from(sig);
		const expectedBuf = Buffer.from(expectedSig);
		// Length check first: timingSafeEqual throws on mismatched lengths
		// rather than returning false, and the length check itself leaks
		// nothing an attacker doesn't already know (signature length is fixed
		// by the algorithm for a well-formed token; a forged token of the
		// wrong length was never going to verify regardless).
		if (sigBuf.length !== expectedBuf.length) return null;
		if (!timingSafeEqual(sigBuf, expectedBuf)) return null;

		if (expiresAtMs <= Date.now()) return null;
		// Defense in depth: a token whose embedded expiry is further out than
		// the max TTL could only exist if the secret leaked or this module's
		// own issueRenderToken() ttl guard was bypassed — reject it rather than
		// honor an over-long expiry at face value.
		if (expiresAtMs - Date.now() > RENDER_TOKEN_MAX_TTL_MS) return null;

		return { scope, key, expiresAtMs };
	} catch {
		return null;
	}
}

/**
 * Path allow-list for a verified token's scope/key (used by
 * src/hooks.server.ts): exactly the book page for that scope/key, or any
 * /app/day/[date]/image path. The image path is intentionally NOT
 * restricted to dates within the token's own year — it doesn't need to be,
 * since that endpoint (src/routes/app/day/[date]/image/+server.ts)
 * independently re-applies the viewer accepted-only predicate regardless of
 * how the request arrived at a viewer-role locals.user. Everything else —
 * /app/search, /app/year/[year], any other /app page, all of /correct and
 * /admin, every non-GET method — is structurally unreachable with only this
 * token: matchesRenderScopePath() returning false for a path means
 * hooks.server.ts never sets locals.user for it, so the request falls
 * through to the normal unauthenticated path (redirect on GET, 401 on
 * everything else).
 */
export function matchesRenderScopePath(path: string, scope: string, key: string): boolean {
	if (path === `/app/book/${scope}/${key}`) return true;
	return /^\/app\/day\/\d{4}-\d{2}-\d{2}\/image$/.test(path);
}
