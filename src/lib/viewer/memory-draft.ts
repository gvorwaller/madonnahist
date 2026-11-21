import type { MemoryFields } from './memories';

/**
 * A memory that couldn't be saved because the writer had been signed out
 * (td-46337c). It's kept in this tab's sessionStorage, keyed by the editor
 * page, and put back into the form when they come back signed in.
 *
 * - Only for the same account: on a shared iPad, the next person to sign in
 *   never sees it.
 * - Dropped after a day, and as soon as the server answers a save (saved or
 *   refused; a refusal keeps the text on screen as it always has). Also
 *   kept when a save gets no trustworthy answer (network failure, server
 *   error), since Kit then replaces the editor with the error page.
 * - `version` is the memory version the text was based on, so a restored
 *   edit still can't overwrite a change made in another window.
 */
/**
 * signed-out: the hook refused the save (401). error: no trustworthy answer
 * (network, server error); it may have been saved. refused: the action
 * turned it down (e.g. no year, changed in another window); not saved.
 */
export type KeptReason = 'signed-out' | 'error' | 'refused';

export interface KeptDraft {
	/** New on every write: a save retires only the copy it sent, never a newer one. */
	id: string;
	userId: string;
	fields: MemoryFields;
	version: string;
	at: number;
	reason: KeptReason;
	/** For `refused`: the server's reason (e.g. "Please choose the year."). */
	detail?: string;
}

const PREFIX = 'memory-draft:';
export const DRAFT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Validates what came out of storage; null if it can't be used here. */
export function parseDraft(raw: string | null, userId: string, now: number): KeptDraft | null {
	if (!raw || !userId) return null;
	let d: unknown;
	try {
		d = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!d || typeof d !== 'object') return null;
	const o = d as Record<string, unknown>;
	const f = o.fields as Record<string, unknown> | undefined;
	if (o.userId !== userId || typeof o.at !== 'number' || typeof o.version !== 'string') return null;
	if (o.reason !== 'signed-out' && o.reason !== 'error' && o.reason !== 'refused') return null;
	if (o.detail !== undefined && typeof o.detail !== 'string') return null;
	if (typeof o.id !== 'string' || !o.id) return null;
	if (now - o.at > DRAFT_MAX_AGE_MS || o.at > now + 60_000) return null;
	if (!f || typeof f !== 'object') return null;
	if (f.precision !== 'day' && f.precision !== 'month' && f.precision !== 'year') return null;
	for (const k of ['year', 'month', 'day', 'body'] as const) {
		if (typeof f[k] !== 'string') return null;
	}
	return {
		id: o.id,
		userId,
		version: o.version,
		at: o.at,
		reason: o.reason,
		...(typeof o.detail === 'string' && o.detail ? { detail: o.detail.slice(0, 300) } : {}),
		fields: {
			precision: f.precision,
			year: f.year as string,
			month: f.month as string,
			day: f.day as string,
			body: f.body as string
		}
	};
}

/** Storage can be missing or throw (private browsing, blocked site data). */
function store(): Storage | null {
	try {
		return typeof sessionStorage === 'undefined' ? null : sessionStorage;
	} catch {
		return null;
	}
}

export function keepDraft(path: string, draft: KeptDraft): boolean {
	try {
		const s = store();
		if (!s) return false;
		s.setItem(PREFIX + path, JSON.stringify(draft));
		return true;
	} catch {
		return false;
	}
}

/** The kept draft for this page and account, if any; unusable ones are removed. */
export function readDraft(path: string, userId: string, now = Date.now()): KeptDraft | null {
	try {
		const s = store();
		if (!s) return null;
		const raw = s.getItem(PREFIX + path);
		const d = parseDraft(raw, userId, now);
		if (raw !== null && !d) s.removeItem(PREFIX + path);
		return d;
	} catch {
		return null;
	}
}

export function dropDraft(path: string): void {
	try {
		store()?.removeItem(PREFIX + path);
	} catch {
		// nothing kept, nothing to drop
	}
}

const savedListeners = new Set<(path: string, id: string) => void>();
const outcomeListeners = new Set<
	(path: string, id: string, reason: KeptReason, detail: string) => void
>();

/**
 * A save of this copy ended without saving it for sure, after its editor
 * had gone: `error` = no trustworthy answer (it may have been saved),
 * `signed-out` = refused, not saved. The stored copy (if it is still that
 * one) and any editor showing it take that reason and its wording (CODEX
 * round 7 #2, round 8 #1).
 */
export function markOutcomeIf(
	path: string,
	id: string | null,
	reason: KeptReason,
	detail = ''
): void {
	if (!id) return;
	for (const fn of outcomeListeners) fn(path, id, reason, detail);
	try {
		const s = store();
		const raw = s?.getItem(PREFIX + path);
		if (!s || !raw) return;
		const o = JSON.parse(raw) as { id?: unknown };
		if (o?.id === id) s.setItem(PREFIX + path, JSON.stringify({ ...o, reason, detail }));
	} catch {
		// can't rewrite it: the editor (if any) still says so
	}
}

/** Hear when a kept copy's save ended unsaved or with an unknown outcome. Returns unsubscribe. */
export function onKeptCopyOutcome(
	fn: (path: string, id: string, reason: KeptReason, detail: string) => void
): () => void {
	outcomeListeners.add(fn);
	return () => outcomeListeners.delete(fn);
}

/** Hear when a save the server accepted retires a kept copy (path, id). Returns unsubscribe. */
export function onKeptCopySaved(fn: (path: string, id: string) => void): () => void {
	savedListeners.add(fn);
	return () => savedListeners.delete(fn);
}

/** A fresh id for a kept copy. */
export function newDraftId(): string {
	try {
		return crypto.randomUUID();
	} catch {
		return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
	}
}

/**
 * Drop the kept copy only if it is still the one with this id: a save that
 * the server accepted retires the copy it sent, even when the editor has
 * gone, but never a newer copy written since (CODEX td-46337c round 4).
 */
export function dropDraftIf(path: string, id: string | null): void {
	if (!id) return;
	// An editor still showing that copy (e.g. reached with Back while this
	// save was pending) must learn it's saved (CODEX td-46337c round 5).
	for (const fn of savedListeners) fn(path, id);
	try {
		const s = store();
		const raw = s?.getItem(PREFIX + path);
		if (!s || !raw) return;
		if ((JSON.parse(raw) as { id?: unknown })?.id === id) s.removeItem(PREFIX + path);
	} catch {
		// unreadable: leave it; readDraft removes junk on the next visit
	}
}

// Kept copies whose save is still waiting for an answer, in this document.
// An editor reached with Back must not let the same copy be sent twice
// (CODEX td-46337c round 6).
const pending = new Set<string>();
const pendingListeners = new Set<() => void>();

export function markPending(id: string): void {
	pending.add(id);
	for (const fn of pendingListeners) fn();
}

export function clearPending(id: string): void {
	if (!pending.delete(id)) return;
	for (const fn of pendingListeners) fn();
}

export function isPending(id: string): boolean {
	return pending.has(id);
}

/** Hear when a kept copy starts or stops being saved. Returns unsubscribe. */
export function onPendingChange(fn: () => void): () => void {
	pendingListeners.add(fn);
	return () => pendingListeners.delete(fn);
}
