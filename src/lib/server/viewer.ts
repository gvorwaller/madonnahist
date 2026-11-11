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
 *
 * Tags: viewer queries never read `day_tags` directly — they go through
 * VISIBLE_DAY_TAGS / visibleTagExistsClause() below. A tag reaches the
 * family only if a person added or confirmed it on that day
 * (`source = 'human'`), or an admin approved its tag name in
 * `tag_vocabulary` (/admin/tags). Merged names display as their canonical
 * name. Undecided and hidden AI tags never show. See
 * docs/2026-11-05-family-viewer-v3-redesign-plan.md §Slice 1T.
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
 * this query, per the file header). Human-confirmed tags only, unless the
 * caller is an admin surface (`/admin/ask`) passing `includeAi: true`.
 */
export async function getAcceptedTagOptions(
	opts: { includeAi?: boolean } = {}
): Promise<TagOption[]> {
	// Admin surface (/admin/ask): every raw slug on an accepted day,
	// unchanged from before tag approval existed.
	if (opts.includeAi === true) {
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
	const res = await query<{ tag_slug: string; tag_label: string }>(`
		SELECT DISTINCT ON (vt.tag_slug) vt.tag_slug, vt.tag_label
		  FROM ${VISIBLE_DAY_TAGS} vt
		  JOIN calendar_days cd ON cd.id = vt.day_id
		 WHERE cd.correction_status = 'accepted'
		 ORDER BY vt.tag_slug, vt.tag_label
	`);
	return res.rows
		.map((r) => ({ slug: r.tag_slug, label: r.tag_label }))
		.sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * The family-visible tags, as a derived table with one row per
 * (day_id, canonical tag_slug) and columns day_id, tag_slug, tag_label.
 *
 * A day_tags row is visible when a person added/confirmed it
 * (source = 'human') OR its canonical name is approved in tag_vocabulary.
 * The canonical name is the merge target when the row's own name is
 * merged, else the name itself; its label comes from tag_vocabulary when
 * decided, else from the day_tags row. Does NOT apply the accepted-day
 * predicate — callers join calendar_days and apply it themselves, per the
 * file header.
 */
export const VISIBLE_DAY_TAGS = `(
	SELECT DISTINCT ON (dt.day_id, COALESCE(tv.merged_into_slug, dt.tag_slug))
	       dt.day_id,
	       COALESCE(tv.merged_into_slug, dt.tag_slug) AS tag_slug,
	       COALESCE(canon.label, dt.tag_label) AS tag_label
	  FROM day_tags dt
	  LEFT JOIN tag_vocabulary tv ON tv.tag_slug = dt.tag_slug
	  LEFT JOIN tag_vocabulary canon ON canon.tag_slug = COALESCE(tv.merged_into_slug, dt.tag_slug)
	 WHERE dt.source = 'human' OR canon.status = 'approved'
	 ORDER BY dt.day_id, COALESCE(tv.merged_into_slug, dt.tag_slug), (dt.source = 'human') DESC
)`;

/**
 * EXISTS filter for "this day carries visible canonical tag $n" — the
 * search tag filter. Same visibility rule as VISIBLE_DAY_TAGS, written as a
 * plain correlated EXISTS so the planner can drive it from the day row.
 * `slugParam` must already be canonical (see resolveCanonicalTagSlug).
 */
export function visibleTagExistsClause(dayIdExpr: string, slugParam: string): string {
	return `EXISTS (
		SELECT 1
		  FROM day_tags dt
		  LEFT JOIN tag_vocabulary tv ON tv.tag_slug = dt.tag_slug
		  LEFT JOIN tag_vocabulary canon ON canon.tag_slug = COALESCE(tv.merged_into_slug, dt.tag_slug)
		 WHERE dt.day_id = ${dayIdExpr}
		   AND COALESCE(tv.merged_into_slug, dt.tag_slug) = ${slugParam}
		   AND (dt.source = 'human' OR canon.status = 'approved')
	)`;
}

/**
 * Map a tag slug (e.g. from an old /app/search?tag= link) to its canonical
 * slug: a merged name resolves to its merge target, anything else to itself.
 */
export async function resolveCanonicalTagSlug(slug: string): Promise<string> {
	const res = await query<{ merged_into_slug: string }>(
		`SELECT merged_into_slug FROM tag_vocabulary WHERE tag_slug = $1 AND status = 'merged'`,
		[slug]
	);
	return res.rows[0]?.merged_into_slug ?? slug;
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

// ── V3 Slice 1: Today, Stories ──────────────────────────────────────────

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]; // Feb 29 allowed

export interface MonthDay {
	month: number;
	day: number;
}

/**
 * Parse Today's `?date=` param. Accepts `MM-DD` (the app's own links) or a
 * full `YYYY-MM-DD` (what a native date picker submits; the year is
 * ignored). Feb 29 is valid. Anything else returns null.
 */
export function parseMonthDay(s: string | null | undefined): MonthDay | null {
	if (!s) return null;
	const m = /^(?:\d{4}-)?(\d{2})-(\d{2})$/.exec(s);
	if (!m) return null;
	const month = Number(m[1]);
	const day = Number(m[2]);
	if (month < 1 || month > 12 || day < 1 || day > DAYS_IN_MONTH[month - 1]) return null;
	return { month, day };
}

/** The calendar day before/after (wrapping Dec 31 ↔ Jan 1, Feb 29 included). */
export function shiftMonthDay({ month, day }: MonthDay, delta: 1 | -1): MonthDay {
	if (delta === 1) {
		if (day < DAYS_IN_MONTH[month - 1]) return { month, day: day + 1 };
		return { month: month === 12 ? 1 : month + 1, day: 1 };
	}
	if (day > 1) return { month, day: day - 1 };
	const pm = month === 1 ? 12 : month - 1;
	return { month: pm, day: DAYS_IN_MONTH[pm - 1] };
}

export function monthDayKey({ month, day }: MonthDay): string {
	return `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function dayOfYear({ month, day }: MonthDay): number {
	let n = day;
	for (let i = 0; i < month - 1; i++) n += DAYS_IN_MONTH[i];
	return n; // 1..366 on a leap-year calendar
}

export interface MonthDayCount extends MonthDay {
	count: number;
}

/**
 * The calendar date (month/day, any year) nearest to `target` that has at
 * least one accepted day, with its entry count — Today's empty-date
 * fallback (Gaylon, mockup review 2026-11-07). Distance wraps around the
 * year; ties go to the later date. Returns null when nothing is accepted.
 */
export async function getNearestMonthDayWithEntries(target: MonthDay): Promise<MonthDayCount | null> {
	const res = await query<{ month: number; day: number; count: number }>(
		`SELECT EXTRACT(MONTH FROM entry_date)::int AS month,
		        EXTRACT(DAY FROM entry_date)::int AS day,
		        COUNT(*)::int AS count
		   FROM calendar_days
		  WHERE correction_status = 'accepted'
		  GROUP BY 1, 2`
	);
	const t = dayOfYear(target);
	let best: MonthDayCount | null = null;
	let bestDist = Infinity;
	let bestAfter = false;
	for (const r of res.rows) {
		const d = dayOfYear(r);
		const forward = (d - t + 366) % 366;
		const backward = (t - d + 366) % 366;
		const dist = Math.min(forward, backward);
		const after = forward <= backward;
		if (dist < bestDist || (dist === bestDist && after && !bestAfter)) {
			best = { month: r.month, day: r.day, count: r.count };
			bestDist = dist;
			bestAfter = after;
		}
	}
	return best;
}

export interface YearStory {
	year: number;
	text: string;
	generatedAt: string;
}

/** Every published year narrative, newest year first (Stories tab, Today's lead story). */
export async function getPublishedYearStories(): Promise<YearStory[]> {
	const res = await query<{ scope_key: string; summary_text: string; generated_at: string }>(
		`SELECT scope_key, summary_text, generated_at::text AS generated_at
		   FROM narrative_summaries
		  WHERE scope = 'year' AND is_published = true AND scope_key ~ '^[0-9]{4}$'
		  ORDER BY scope_key DESC`
	);
	return res.rows.map((r) => ({
		year: Number(r.scope_key),
		text: r.summary_text,
		generatedAt: r.generated_at
	}));
}

/**
 * Today's lead year story: prefer a published year that has an entry on
 * this date, else any published year. Rotates with the date so the lead
 * changes day to day but is stable within a day.
 */
export function pickLeadYearStory(
	stories: YearStory[],
	date: MonthDay,
	yearsOnThisDate: number[]
): YearStory | null {
	if (stories.length === 0) return null;
	const onDate = stories.filter((s) => yearsOnThisDate.includes(s.year));
	const pool = onDate.length > 0 ? onDate : stories;
	return pool[dayOfYear(date) % pool.length];
}

export interface SavedStorySummary {
	id: number;
	question: string;
	dayCount: number;
	createdAt: string;
}

/** Most recently saved family story (adhoc_narratives; saving on /admin/ask is the curation act). */
export async function getLatestSavedStory(): Promise<SavedStorySummary | null> {
	const res = await query<{ id: number; question: string; day_count: number; created_at: string }>(
		`SELECT id, question, day_count, created_at::text AS created_at
		   FROM adhoc_narratives
		  ORDER BY created_at DESC
		  LIMIT 1`
	);
	const r = res.rows[0];
	return r ? { id: r.id, question: r.question, dayCount: r.day_count, createdAt: r.created_at } : null;
}
