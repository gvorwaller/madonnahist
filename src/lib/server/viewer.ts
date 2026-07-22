/**
 * Shared helpers for the family viewer (`/app/*`).
 *
 * Every viewer-facing query must independently filter on
 * `correction_status = 'accepted'` in its own SQL — this is the
 * "publishable day" predicate. It cannot be enforced by a page-level check
 * alone: all web traffic (viewer, corrector, admin) runs as the same
 * `madonnahist_app` DB role, so a query that omits the predicate would leak
 * pending/in-progress/flagged/illegible days to anyone who can reach the
 * route or hit the endpoint directly. See
 * docs/2026-07-21-next-phases-search-viewer-narrative-plan.md, Phase B.
 */
import { query } from '$lib/db';

/** The literal predicate every /app query must include verbatim. */
export const ACCEPTED_PREDICATE = `correction_status = 'accepted'`;

/** Validate a `[date]` route param as a real calendar date in YYYY-MM-DD form. */
export function isValidEntryDate(s: string | undefined | null): s is string {
	if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
	const d = new Date(s + 'T00:00:00Z');
	if (isNaN(d.getTime())) return false;
	// Reject dates that round-trip differently (e.g. 2024-02-30).
	return d.toISOString().slice(0, 10) === s;
}

export interface CoverageCounts {
	accepted: number;
	total: number;
	percent: number;
}

/** Accepted vs total ingested days, for the coverage banners on every viewer surface. */
export async function getCoverage(): Promise<CoverageCounts> {
	const res = await query<{ accepted: number; total: number }>(`
		SELECT COUNT(*) FILTER (WHERE correction_status = 'accepted')::int AS accepted,
		       COUNT(*)::int AS total
		  FROM calendar_days
	`);
	const accepted = res.rows[0]?.accepted ?? 0;
	const total = res.rows[0]?.total ?? 0;
	const percent = total > 0 ? Math.round((accepted / total) * 1000) / 10 : 0;
	return { accepted, total, percent };
}

export interface AdjacentAcceptedDates {
	prev: string | null;
	next: string | null;
}

/** Nearest accepted day before/after `entryDate` (exclusive), for prev/next day-detail nav. */
export async function getAdjacentAcceptedDates(entryDate: string): Promise<AdjacentAcceptedDates> {
	const [prevRes, nextRes] = await Promise.all([
		query<{ entry_date: string }>(
			`SELECT entry_date::text AS entry_date FROM calendar_days
			  WHERE entry_date < $1 AND correction_status = 'accepted'
			  ORDER BY entry_date DESC LIMIT 1`,
			[entryDate]
		),
		query<{ entry_date: string }>(
			`SELECT entry_date::text AS entry_date FROM calendar_days
			  WHERE entry_date > $1 AND correction_status = 'accepted'
			  ORDER BY entry_date LIMIT 1`,
			[entryDate]
		)
	]);
	return {
		prev: prevRes.rows[0]?.entry_date ?? null,
		next: nextRes.rows[0]?.entry_date ?? null
	};
}

/** Human date label, e.g. "Tuesday, May 3, 1972" — shared formatting for viewer surfaces. */
export function formatHumanDate(entryDate: string): string {
	return new Date(entryDate + 'T00:00:00Z').toLocaleDateString('en-US', {
		weekday: 'long',
		month: 'long',
		day: 'numeric',
		year: 'numeric',
		timeZone: 'UTC'
	});
}

/** Distinct years that have at least one accepted day, ascending — used for search/browse year filters. */
export async function getAcceptedYears(): Promise<number[]> {
	const res = await query<{ year: number }>(`
		SELECT DISTINCT EXTRACT(YEAR FROM entry_date)::int AS year
		  FROM calendar_days
		 WHERE correction_status = 'accepted'
		 ORDER BY year
	`);
	return res.rows.map((r) => r.year);
}

/** First ~N sentences of a text block, for card previews. Falls back to a char cap if no sentence boundary is found. */
export function firstSentences(text: string, count = 2, maxChars = 220): string {
	const trimmed = text.trim();
	if (trimmed === '') return '';
	const matches = trimmed.match(/[^.!?]+[.!?]+(\s+|$)/g);
	if (matches && matches.length > 0) {
		const snippet = matches.slice(0, count).join('').trim();
		if (snippet.length > 0) {
			return snippet.length > maxChars ? snippet.slice(0, maxChars).trim() + '…' : snippet;
		}
	}
	return trimmed.length > maxChars ? trimmed.slice(0, maxChars).trim() + '…' : trimmed;
}
