/**
 * Memories (td-bc2c29 / td-76a40f, first slice): types and labels shared by
 * the server module and the viewer pages. Plan:
 * docs/2026-11-16-writers-and-memories-plan.md.
 */
import { MONTHS } from './nav';

export type Precision = 'day' | 'month' | 'year';
export const PRECISIONS: readonly Precision[] = ['day', 'month', 'year'];

/** Longest memory, matching the CHECK in migration 0032. */
export const MEMORY_MAX = 10_000;

/** A memory as a page shows it. */
export interface MemoryView {
	id: number;
	writerId: number;
	writerName: string;
	/** YYYY-MM-DD, the first day of the period for month and year memories. */
	date: string;
	precision: Precision;
	body: string;
	shared: boolean;
	/** The viewer typed it, so they may edit it. */
	mine: boolean;
	/** Exact updated_at text, sent back with an edit to catch stale tabs. */
	version: string;
	/**
	 * The viewer may hide this writer's memories (td-76a40f): someone else's,
	 * never Madonna's, never their own.
	 */
	canHide: boolean;
}

/** Madonna's writer id. Her memories can never be hidden (migration 0035). */
export const MADONNA_WRITER_ID = 1;

/** Memories on a page that the viewer chose not to see, per writer (td-76a40f). */
export interface HiddenMemories {
	writerId: number;
	writerName: string;
	count: number;
}

/** What a Day, Month or Year page gets: the memories shown, plus what's hidden. */
export interface PageMemories {
	memories: MemoryView[];
	hidden: HiddenMemories[];
}

/** "Gaylon's", or "James'" for a name ending in s. */
export function possessive(name: string): string {
	return /s$/i.test(name) ? `${name}'` : `${name}'s`;
}

/** What the add/edit form holds (selects carry strings; month/day unpadded). */
export interface MemoryFields {
	precision: Precision;
	year: string;
	month: string;
	day: string;
	body: string;
}

/** Form fields for a stored memory. */
export function fieldsOf(m: { date: string; precision: Precision; body: string }): MemoryFields {
	return {
		precision: m.precision,
		year: m.date.slice(0, 4),
		month: m.precision === 'year' ? '' : String(Number(m.date.slice(5, 7))),
		day: m.precision === 'day' ? String(Number(m.date.slice(8, 10))) : '',
		body: m.body
	};
}

/** "Mon, May 2, 1983", "June 1978" or "1978". */
export function memoryDateLabel(date: string, precision: Precision): string {
	if (precision === 'year') return date.slice(0, 4);
	if (precision === 'month') return `${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
	return new Date(date + 'T00:00:00Z').toLocaleDateString('en-US', {
		weekday: 'short',
		month: 'short',
		day: 'numeric',
		year: 'numeric',
		timeZone: 'UTC'
	});
}

/** The page a memory shows on. */
export function memoryPageHref(date: string, precision: Precision): string {
	if (precision === 'year') return `/app/year/${date.slice(0, 4)}`;
	if (precision === 'month') return `/app/month/${date.slice(0, 7)}`;
	return `/app/day/${date}`;
}
