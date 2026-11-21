import { invalidateAll } from '$app/navigation';
import { navigating } from '$app/state';
import { refreshAfterNavigation } from './refresh-core';

/**
 * Reload the current page's data once any navigation in progress has
 * finished (td-76a40f, CODEX re-review). Used when a hide/show choice is
 * saved after the reader has already moved on: the page they're going to
 * may have loaded (or preloaded) its memories before the save landed.
 * Refreshing mid-navigation would cancel it, so wait first, however long
 * it takes and across navigations that replace each other.
 */
export function refreshWhenSettled(): Promise<void> {
	return refreshAfterNavigation(
		() => navigating.to !== null,
		() => invalidateAll(),
		(ms) => new Promise((r) => setTimeout(r, ms))
	);
}
