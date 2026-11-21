/**
 * The waiting rule behind refreshWhenSettled (src/lib/viewer/refresh.ts),
 * kept free of SvelteKit imports so scripts/test-refresh.ts can drive it
 * with a fake clock.
 *
 * Refresh exactly once, only when no navigation is in progress. There is no
 * time limit: a navigation always ends (it completes or is cancelled), and
 * giving up would leave a page showing memories the reader just hid
 * (CODEX round 4). A navigation that replaces another simply keeps it
 * waiting.
 */
export async function refreshAfterNavigation(
	isNavigating: () => boolean,
	refresh: () => Promise<void>,
	sleep: (ms: number) => Promise<void>,
	pollMs = 50
): Promise<void> {
	while (isNavigating()) await sleep(pollMs);
	await refresh();
}
