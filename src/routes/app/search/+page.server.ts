import { query } from '$lib/db';
import {
	formatHumanDate,
	getAcceptedYears,
	resolveCanonicalTagSlug,
	visibleTagExistsClause
} from '$lib/server/viewer';
import { getEntityFilterLabel, getResultChips, getTagFilterLabel, type ResultChip } from '$lib/server/search';
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

const MIN_YEAR = 1800; // sanity bound only; the year menus list the archive's real years
const MAX_YEAR = 2100;

function parseYear(v: string | null): number | null {
	if (!v || !/^\d{4}$/.test(v)) return null;
	const n = Number(v);
	return n >= MIN_YEAR && n <= MAX_YEAR ? n : null;
}

export interface SearchResult {
	entryDate: string;
	dateLabel: string;
	segments: SearchSegment[];
	hasMemory: boolean;
	chips: ResultChip[];
}

/**
 * Search (V3 Slice 4). One box with typeahead (./suggest), active filters
 * as removable chips, and a year range.
 *
 * Params: q, tag, person, place, from_year, to_year (inclusive, validated,
 * swapped when reversed), page. The old `year=` param still works as a
 * one-year range, so shared links keep working. A year range alone counts
 * as a search (plan: CODEX #4). Filter option lists are no longer loaded
 * here; the typeahead asks for matches as the reader types (GROK #8).
 */
export const load: PageServerLoad = async ({ url }) => {
	const rawQ = (url.searchParams.get('q') ?? '').slice(0, MAX_QUERY_LENGTH);
	const q = rawQ.trim();

	const legacyYear = parseYear(url.searchParams.get('year'));
	let fromYear = parseYear(url.searchParams.get('from_year')) ?? legacyYear;
	let toYear = parseYear(url.searchParams.get('to_year')) ?? legacyYear;
	if (fromYear !== null && toYear !== null && fromYear > toYear) [fromYear, toYear] = [toYear, fromYear];

	const tagParam = url.searchParams.get('tag');
	// Canonicalized so an old link to a since-merged tag name (e.g.
	// ?tag=sick after sick → illness) still finds its days.
	const tag = tagParam && isValidTagSlug(tagParam) ? await resolveCanonicalTagSlug(tagParam) : null;

	// Person/place filters — same slug validation as tags (identical
	// character rules; see src/lib/server/tags.ts). Distinct query params
	// because entity slugs are only unique per entity_type as of migration
	// 0020 (a person and a place can share a slug), so "person" and "place"
	// must be independently selectable/combinable, not one shared param.
	const personParam = url.searchParams.get('person');
	const person = personParam && isValidTagSlug(personParam) ? personParam : null;

	const placeParam = url.searchParams.get('place');
	const place = placeParam && isValidTagSlug(placeParam) ? placeParam : null;

	const pageParam = Number(url.searchParams.get('page') ?? '1');
	const pageNum = Number.isFinite(pageParam) && pageParam >= 1 ? Math.floor(pageParam) : 1;

	const [years, tagLabel, personLabel, placeLabel] = await Promise.all([
		getAcceptedYears(),
		tag ? getTagFilterLabel(tag) : null,
		person ? getEntityFilterLabel('person', person) : null,
		place ? getEntityFilterLabel('place', place) : null
	]);

	const base = {
		q,
		fromYear,
		toYear,
		tag,
		person,
		place,
		labels: { tag: tagLabel, person: personLabel, place: placeLabel },
		page: pageNum,
		pageSize: PAGE_SIZE,
		years
	};

	const searched =
		q !== '' || tag !== null || person !== null || place !== null || fromYear !== null || toYear !== null;

	if (!searched) {
		return { ...base, total: 0, totalPages: 0, results: [] as SearchResult[], searched: false };
	}

	const offset = (pageNum - 1) * PAGE_SIZE;

	// Entity EXISTS clause — alias-resolves both sides via
	// COALESCE(alias_of_entity_id, id) so a mention recorded against an alias
	// entity still matches a filter selected by its canonical slug (or vice
	// versa, for a stale/direct URL).
	const entityExistsClause = (paramIndex: number, entityType: 'person' | 'place') => `(
		$${paramIndex}::text IS NULL OR EXISTS (
			SELECT 1
			  FROM day_entities de2
			  JOIN entities e2 ON e2.id = de2.entity_id
			 WHERE de2.day_id = cd.id
			   AND COALESCE(e2.alias_of_entity_id, e2.id) = (
			     SELECT COALESCE(alias_of_entity_id, id) FROM entities
			      WHERE entity_type = '${entityType}' AND slug = $${paramIndex}
			   )
		)
	)`;

	// Shared filters, params $1..$5: tag, from_year, to_year, person, place.
	// The accepted-day predicate is applied directly in every query.
	const filters = `cd.correction_status = 'accepted'
		AND ($2::int IS NULL OR cd.entry_date >= make_date($2::int, 1, 1))
		AND ($3::int IS NULL OR cd.entry_date < make_date($3::int + 1, 1, 1))
		AND ($1::text IS NULL OR ${visibleTagExistsClause('cd.id', '$1')})
		AND ${entityExistsClause(4, 'person')}
		AND ${entityExistsClause(5, 'place')}`;
	const filterParams = [tag, fromYear, toYear, person, place];

	let total: number;
	let rows: Array<{ entry_date: string; corrected_text: string | null; has_memory: boolean; headline: string | null }>;

	if (q === '') {
		// Filters only: a plain chronological listing, newest first.
		const countRes = await query<{ total: number }>(
			`SELECT COUNT(*)::int AS total FROM calendar_days cd WHERE ${filters}`,
			filterParams
		);
		total = countRes.rows[0]?.total ?? 0;
		const rowsRes = await query<{
			entry_date: string;
			corrected_text: string | null;
			has_memory: boolean;
			headline: null;
		}>(
			`SELECT cd.entry_date::text AS entry_date, cd.corrected_text,
			        (cd.day_narrative IS NOT NULL AND btrim(cd.day_narrative) <> '') AS has_memory,
			        NULL AS headline
			   FROM calendar_days cd
			  WHERE ${filters}
			  ORDER BY cd.entry_date DESC
			  LIMIT $6 OFFSET $7`,
			[...filterParams, PAGE_SIZE, offset]
		);
		rows = rowsRes.rows;
	} else {
		// Best match first (Gaylon, mockup review 2026-11-07). The tsquery is
		// parsed once per query, in a CTE (Phase B).
		const countRes = await query<{ total: number }>(
			`WITH parsed AS (SELECT websearch_to_tsquery('english', $6) AS tsq)
			 SELECT COUNT(*)::int AS total
			   FROM calendar_days cd, parsed p
			  WHERE ${filters} AND cd.fts @@ p.tsq`,
			[...filterParams, q]
		);
		total = countRes.rows[0]?.total ?? 0;
		const rowsRes = await query<{
			entry_date: string;
			corrected_text: string | null;
			has_memory: boolean;
			headline: string;
		}>(
			`WITH parsed AS (SELECT websearch_to_tsquery('english', $6) AS tsq),
			 matched AS (
			   SELECT cd.entry_date, cd.corrected_text,
			          (cd.day_narrative IS NOT NULL AND btrim(cd.day_narrative) <> '') AS has_memory,
			          ts_rank(cd.fts, p.tsq) AS rank,
			          ts_headline(
			            'english',
			            replace(coalesce(cd.corrected_text, '') || ' ' || coalesce(cd.day_narrative, ''), $9, $10),
			            p.tsq,
			            'StartSel=' || $9 || ', StopSel=' || $9 || ', MaxFragments=2, MinWords=10, MaxWords=30, ShortWord=3, HighlightAll=false'
			          ) AS headline
			     FROM calendar_days cd, parsed p
			    WHERE ${filters} AND cd.fts @@ p.tsq
			 )
			 SELECT entry_date::text AS entry_date, corrected_text, has_memory, headline
			   FROM matched
			  ORDER BY rank DESC, entry_date ASC
			  LIMIT $7 OFFSET $8`,
			[...filterParams, q, PAGE_SIZE, offset, SENTINEL, SENTINEL_LOOKALIKE]
		);
		rows = rowsRes.rows;
	}

	const chips = await getResultChips(rows.map((r) => r.entry_date));
	const results: SearchResult[] = rows.map((row) => {
		const segments = row.headline !== null ? buildSegments(row.headline) : [];
		const finalSegments = segments.some((seg) => seg.highlight)
			? segments
			: [{ text: fallbackSnippet(row.corrected_text ?? ''), highlight: false }];
		return {
			entryDate: row.entry_date,
			dateLabel: formatHumanDate(row.entry_date),
			segments: finalSegments,
			hasMemory: row.has_memory,
			chips: chips.get(row.entry_date) ?? []
		};
	});

	return {
		...base,
		total,
		totalPages: Math.ceil(total / PAGE_SIZE),
		results,
		searched: true
	};
};
