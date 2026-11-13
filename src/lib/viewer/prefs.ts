/**
 * Per-viewer conveniences kept in browser storage (V3). Storage can be
 * missing or throw (private mode, blocked site data), so every access is
 * wrapped and pages render correctly without it.
 */

export type Order = 'oldest' | 'newest';

/** One oldest/newest choice shared by Timeline and Stories. */
const ORDER_KEY = 'vfh.timeline.order';

export function readOrder(): Order | null {
	try {
		const v = localStorage.getItem(ORDER_KEY);
		return v === 'oldest' || v === 'newest' ? v : null;
	} catch {
		return null;
	}
}

export function writeOrder(order: Order): void {
	try {
		localStorage.setItem(ORDER_KEY, order);
	} catch {
		// Not remembered; the page still works.
	}
}

/** Which decade folds are open, for this tab only (sessionStorage). */
export function readOpenDecades(key: string): Record<number, boolean> | null {
	try {
		const raw = sessionStorage.getItem(key);
		if (!raw) return null;
		const list: unknown = JSON.parse(raw);
		if (!Array.isArray(list)) return null;
		const out: Record<number, boolean> = {};
		for (const d of list) if (typeof d === 'number') out[d] = true;
		return out;
	} catch {
		return null;
	}
}

export function writeOpenDecades(key: string, open: Record<number, boolean>): void {
	const list = Object.entries(open)
		.filter(([, isOpen]) => isOpen)
		.map(([d]) => Number(d));
	try {
		sessionStorage.setItem(key, JSON.stringify(list));
	} catch {
		// Not remembered; the page still works.
	}
}
