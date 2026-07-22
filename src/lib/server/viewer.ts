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

/**
 * Human date label without the year, e.g. "Monday, March 1" — used by the
 * book reader (Phase F) where the year is already the chapter/book title, so
 * repeating it on every day entry would be redundant.
 */
export function formatHumanDateNoYear(entryDate: string): string {
	return new Date(entryDate + 'T00:00:00Z').toLocaleDateString('en-US', {
		weekday: 'long',
		month: 'long',
		day: 'numeric',
		timeZone: 'UTC'
	});
}

/**
 * Published narrative text for a scope/scope_key, or null if none exists /
 * isn't published yet (Phase E). Filters `is_published = true` directly in
 * the SQL — same "every /app query independently applies its own predicate"
 * rule as the accepted-day predicate above: an unpublished draft must never
 * reach a viewer route regardless of any page-level check. Shared by
 * `/app/year/[year]` and the Phase F book reader (`/app/book/year/[key]`),
 * which surfaces the same year narrative as its opening section.
 */
export async function getPublishedNarrative(scope: 'year', scopeKey: string): Promise<string | null> {
	const res = await query<{ summary_text: string }>(
		`SELECT summary_text FROM narrative_summaries
		  WHERE scope = $1 AND scope_key = $2 AND is_published = true`,
		[scope, scopeKey]
	);
	return res.rows[0]?.summary_text ?? null;
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

export interface YearCoverage {
	year: number;
	accepted: number;
	total: number;
	percent: number;
}

/**
 * Per-year accepted/total counts for every year that has at least one
 * ingested day, ascending — feeds the Browse index (decades → years). `total`
 * is an aggregate count (no row content), same non-predicate precedent as
 * `getCoverage()` above.
 */
export async function getYearCoverage(): Promise<YearCoverage[]> {
	const res = await query<{ year: number; accepted: number; total: number }>(`
		SELECT EXTRACT(YEAR FROM entry_date)::int AS year,
		       COUNT(*) FILTER (WHERE correction_status = 'accepted')::int AS accepted,
		       COUNT(*)::int AS total
		  FROM calendar_days
		 GROUP BY year
		 ORDER BY year
	`);
	return res.rows.map((r) => ({
		year: r.year,
		accepted: r.accepted,
		total: r.total,
		percent: r.total > 0 ? Math.round((r.accepted / r.total) * 1000) / 10 : 0
	}));
}

/** Nearest accepted-day year before/after `year` (exclusive), for year-browse chevrons. */
export async function getAdjacentAcceptedYears(year: number): Promise<AdjacentAcceptedYears> {
	const years = await getAcceptedYears();
	const prevYears = years.filter((y) => y < year);
	const nextYears = years.filter((y) => y > year);
	return {
		prev: prevYears.length > 0 ? prevYears[prevYears.length - 1] : null,
		next: nextYears.length > 0 ? nextYears[0] : null
	};
}

export interface AdjacentAcceptedYears {
	prev: number | null;
	next: number | null;
}

/** Accepted days for a single year, as a day-of-month array per month (1-12) — feeds MonthGrid. */
export async function getAcceptedDaysByMonth(year: number): Promise<Map<number, number[]>> {
	const res = await query<{ month: number; day: number }>(
		`SELECT EXTRACT(MONTH FROM entry_date)::int AS month,
		        EXTRACT(DAY FROM entry_date)::int AS day
		   FROM calendar_days
		  WHERE correction_status = 'accepted' AND EXTRACT(YEAR FROM entry_date)::int = $1
		  ORDER BY entry_date`,
		[year]
	);
	const byMonth = new Map<number, number[]>();
	for (const row of res.rows) {
		const list = byMonth.get(row.month);
		if (list) list.push(row.day);
		else byMonth.set(row.month, [row.day]);
	}
	return byMonth;
}

export interface TagOption {
	slug: string;
	label: string;
}

/**
 * Distinct tags that appear on at least one accepted day, ordered by label —
 * feeds the /app/search tag dropdown. A tag that only exists on a
 * pending/in-progress day never appears here (predicate applied directly in
 * this query, per the file header).
 */
export async function getAcceptedTagOptions(): Promise<TagOption[]> {
	const res = await query<{ tag_slug: string; tag_label: string }>(`
		SELECT DISTINCT ON (dt.tag_slug) dt.tag_slug, dt.tag_label
		  FROM day_tags dt
		  JOIN calendar_days cd ON cd.id = dt.day_id
		 WHERE cd.correction_status = 'accepted'
		 ORDER BY dt.tag_slug, dt.tag_label
	`);
	return res.rows
		.map((r) => ({ slug: r.tag_slug, label: r.tag_label }))
		.sort((a, b) => a.label.localeCompare(b.label));
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
