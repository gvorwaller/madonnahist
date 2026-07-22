import { query } from '$lib/db';
import { formatHumanDate, getAcceptedTagOptions, getAcceptedYears, getCoverage } from '$lib/server/viewer';
import { isValidTagSlug } from '$lib/server/tags';
import type { PageServerLoad } from './$types';

const MAX_QUERY_LENGTH = 200;
const PAGE_SIZE = 25;

// Sentinels for ts_headline: a single character used as BOTH StartSel and
// StopSel. Splitting the headline on this character alternates plain/highlight
// segments by index parity, so no HTML parsing is ever needed downstream —
// the Svelte component renders segments as plain text nodes with <mark>
// wrappers, never {@html}. To make the guarantee ("cannot appear in text")
// actually hold — a bare "/" legitimately shows up in dates like "5/3/72" —
// any literal occurrence in the source text is swapped for a lookalike
// (U+2044 FRACTION SLASH) before ts_headline ever sees it. That substitution
// is display-only for this snippet computation; it never touches the stored
// corrected_text/day_narrative columns.
const SENTINEL = '/';
const SENTINEL_LOOKALIKE = '⁄';

export interface SearchSegment {
	text: string;
	highlight: boolean;
}

function buildSegments(headline: string): SearchSegment[] {
	return headline
		.split(SENTINEL)
		.map((text, i) => ({ text, highlight: i % 2 === 1 }))
		.filter((seg) => seg.text !== '');
}

function fallbackSnippet(text: string, maxChars = 160): string {
	const trimmed = text.trim();
	if (trimmed.length <= maxChars) return trimmed;
	return trimmed.slice(0, maxChars).trim() + '…';
}

export const load: PageServerLoad = async ({ url }) => {
	const rawQ = (url.searchParams.get('q') ?? '').slice(0, MAX_QUERY_LENGTH);
	const q = rawQ.trim();

	const yearParam = url.searchParams.get('year');
	const year = yearParam && /^\d{4}$/.test(yearParam) ? Number(yearParam) : null;

	const tagParam = url.searchParams.get('tag');
	const tag = tagParam && isValidTagSlug(tagParam) ? tagParam : null;

	const pageParam = Number(url.searchParams.get('page') ?? '1');
	const pageNum = Number.isFinite(pageParam) && pageParam >= 1 ? Math.floor(pageParam) : 1;

	const [coverage, years, tagOptions] = await Promise.all([
		getCoverage(),
		getAcceptedYears(),
		getAcceptedTagOptions()
	]);

	const searched = q !== '' || tag !== null;

	if (!searched) {
		return {
			q: '',
			year,
			tag,
			page: pageNum,
			pageSize: PAGE_SIZE,
			total: 0,
			totalPages: 0,
			results: [] as Array<{ entryDate: string; dateLabel: string; segments: SearchSegment[] }>,
			coverage,
			years,
			tagOptions,
			searched: false
		};
	}

	const offset = (pageNum - 1) * PAGE_SIZE;

	// Tag filter with no search text: a plain chronological (not ranked)
	// listing of the tag's accepted days, newest first — no FTS involved.
	// Per Phase C deliverable 4 ("search with a tag filter and no q returns
	// that tag's accepted days, ordered by entry_date DESC, paged").
	if (q === '') {
		const countRes = await query<{ total: number }>(
			`SELECT COUNT(*)::int AS total
			   FROM calendar_days cd
			  WHERE cd.correction_status = 'accepted'
			    AND EXISTS (SELECT 1 FROM day_tags dt WHERE dt.day_id = cd.id AND dt.tag_slug = $1)
			    AND ($2::int IS NULL OR EXTRACT(YEAR FROM cd.entry_date)::int = $2)`,
			[tag, year]
		);
		const total = countRes.rows[0]?.total ?? 0;
		const totalPages = Math.ceil(total / PAGE_SIZE);

		const rowsRes = await query<{ entry_date: string; corrected_text: string | null }>(
			`SELECT cd.entry_date::text AS entry_date, cd.corrected_text
			   FROM calendar_days cd
			  WHERE cd.correction_status = 'accepted'
			    AND EXISTS (SELECT 1 FROM day_tags dt WHERE dt.day_id = cd.id AND dt.tag_slug = $1)
			    AND ($2::int IS NULL OR EXTRACT(YEAR FROM cd.entry_date)::int = $2)
			  ORDER BY cd.entry_date DESC
			  LIMIT $3 OFFSET $4`,
			[tag, year, PAGE_SIZE, offset]
		);

		const results = rowsRes.rows.map((row) => ({
			entryDate: row.entry_date,
			dateLabel: formatHumanDate(row.entry_date),
			segments: [{ text: fallbackSnippet(row.corrected_text ?? ''), highlight: false }] as SearchSegment[]
		}));

		return {
			q: '',
			year,
			tag,
			page: pageNum,
			pageSize: PAGE_SIZE,
			total,
			totalPages,
			results,
			coverage,
			years,
			tagOptions,
			searched: true
		};
	}

	// The tsquery is parsed exactly once per query call, in a CTE, and reused
	// by both the count and the ranked/highlighted result set below —
	// per Phase B of docs/2026-07-21-next-phases-search-viewer-narrative-plan.md.
	// The accepted-day predicate is applied directly in both queries. The
	// optional tag filter (Phase C) is an EXISTS clause, same pattern as the
	// year filter, so a null tag is a no-op.
	const countRes = await query<{ total: number }>(
		`WITH parsed AS (
		   SELECT websearch_to_tsquery('english', $1) AS tsq
		 )
		 SELECT COUNT(*)::int AS total
		   FROM calendar_days cd, parsed p
		  WHERE cd.correction_status = 'accepted'
		    AND cd.fts @@ p.tsq
		    AND ($2::int IS NULL OR EXTRACT(YEAR FROM cd.entry_date)::int = $2)
		    AND ($3::text IS NULL OR EXISTS (SELECT 1 FROM day_tags dt WHERE dt.day_id = cd.id AND dt.tag_slug = $3))`,
		[q, year, tag]
	);
	const total = countRes.rows[0]?.total ?? 0;
	const totalPages = Math.ceil(total / PAGE_SIZE);

	const rowsRes = await query<{
		entry_date: string;
		corrected_text: string | null;
		headline: string;
	}>(
		`WITH parsed AS (
		   SELECT websearch_to_tsquery('english', $1) AS tsq
		 ),
		 matched AS (
		   SELECT cd.entry_date, cd.corrected_text,
		          ts_rank(cd.fts, p.tsq) AS rank,
		          ts_headline(
		            'english',
		            replace(coalesce(cd.corrected_text, '') || ' ' || coalesce(cd.day_narrative, ''), $6, $7),
		            p.tsq,
		            'StartSel=' || $6 || ', StopSel=' || $6 || ', MaxFragments=2, MinWords=10, MaxWords=30, ShortWord=3, HighlightAll=false'
		          ) AS headline
		     FROM calendar_days cd, parsed p
		    WHERE cd.correction_status = 'accepted'
		      AND cd.fts @@ p.tsq
		      AND ($2::int IS NULL OR EXTRACT(YEAR FROM cd.entry_date)::int = $2)
		      AND ($3::text IS NULL OR EXISTS (SELECT 1 FROM day_tags dt WHERE dt.day_id = cd.id AND dt.tag_slug = $3))
		 )
		 SELECT entry_date::text AS entry_date, corrected_text, headline
		   FROM matched
		  ORDER BY rank DESC, entry_date ASC
		  LIMIT $4 OFFSET $5`,
		[q, year, tag, PAGE_SIZE, offset, SENTINEL, SENTINEL_LOOKALIKE]
	);

	const results = rowsRes.rows.map((row) => {
		const segments = buildSegments(row.headline);
		const hasHighlight = segments.some((s) => s.highlight);
		const finalSegments = hasHighlight
			? segments
			: [{ text: fallbackSnippet(row.corrected_text ?? ''), highlight: false }];
		return {
			entryDate: row.entry_date,
			dateLabel: formatHumanDate(row.entry_date),
			segments: finalSegments
		};
	});

	return {
		q,
		year,
		tag,
		page: pageNum,
		pageSize: PAGE_SIZE,
		total,
		totalPages,
		results,
		coverage,
		years,
		tagOptions,
		searched: true
	};
};
