/**
 * Small in-memory fixed-window rate limiter (single PM2 web process).
 *
 * Used by the public invite route (V3 Slice 1b) to bound token lookups and
 * argon2 password hashing. Behind nginx + Cloudflare the client address is
 * not trustworthy (adapter-node sees the proxy), so callers key on what they
 * can trust: a global bucket, and the token hash for per-link limits. A
 * restart clears the windows, which is fine for a ceiling on work.
 */

interface Window {
	count: number;
	resetAt: number;
}

const windows = new Map<string, Window>();
const MAX_KEYS = 5000;

/** True when this hit is allowed; false once `limit` hits land inside `windowMs`. */
export function allow(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
	let w = windows.get(key);
	if (!w || w.resetAt <= now) {
		if (windows.size >= MAX_KEYS) prune(now);
		w = { count: 0, resetAt: now + windowMs };
		windows.set(key, w);
	}
	w.count++;
	return w.count <= limit;
}

function prune(now: number): void {
	for (const [k, w] of windows) if (w.resetAt <= now) windows.delete(k);
	// Still full of live windows: drop the oldest-inserted to stay bounded.
	while (windows.size >= MAX_KEYS) {
		const first = windows.keys().next().value;
		if (first === undefined) break;
		windows.delete(first);
	}
}

/** Test hook: forget every window. */
export function resetRateLimits(): void {
	windows.clear();
}
