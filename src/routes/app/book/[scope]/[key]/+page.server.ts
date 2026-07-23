import { query } from '$lib/db';
import {
	formatHumanDateNoYear,
	getAdjacentAcceptedYears,
	getPublishedNarrative
} from '$lib/server/viewer';
import type { PageServerLoad } from './$types';

/**
 * On-screen book reader (Phase F of
 * docs/2026-07-21-next-phases-search-viewer-narrative-plan.md).
 *
 * Honestly scoped as a v0: a continuous reading flow, not the mockup B5
 * paginated book (3-5 days per page, horizontal swipe). Only `scope='year'`
 * is supported for now — any other scope, or a malformed/out-of-range year
 * key, renders a friendly "not available" page (never a crash or a raw
 * 404/500), matching the precedent set by /app/year/[year] for invalid
 * years.
 */

const MIN_YEAR = 1900;
const MAX_YEAR = 2100;

function isValidYearKey(s: string | undefined): s is string {
	if (!s || !/^\d{4}$/.test(s)) return false;
	const y = Number(s);
	return y >= MIN_YEAR && y <= MAX_YEAR;
}

export type BookContentMode = 'full' | 'narrative' | 'days';

function isValidContentMode(s: string | null): s is BookContentMode {
	return s === 'full' || s === 'narrative' || s === 'days';
}

export interface BookDay {
	entryDate: string;
	dateLabel: string;
	correctedText: string;
	dayNarrative: string | null;
	hasImage: boolean;
}

export interface BookChapter {
	month: number;
	monthName: string;
	days: BookDay[];
}

const MONTH_NAMES = [
	'January', 'February', 'March', 'April', 'May', 'June',
	'July', 'August', 'September', 'October', 'November', 'December'
];

export const load: PageServerLoad = async ({ params, url }) => {
	if (params.scope !== 'year') {
		return { available: false as const, reason: 'scope' as const };
	}

	if (!isValidYearKey(params.key)) {
		return { available: false as const, reason: 'key' as const };
	}

	// Phase H: `?render=pdf` is a server-read-only rendering mode for the
	// enrichment worker's headless Chromium (backend/workers/enrichment-worker.ts's
	// processPdfExport). It never changes what data loads — only what the
	// page renders (see +page.svelte): images go eager (a lazy-loaded <img>
	// below the fold is simply never fetched by a headless print pass, since
	// there's no scroll/viewport-intersection event to trigger it), and the
	// progress bar / exit button / "continue to next year" chrome are
	// omitted, since none of that is meaningful in a printed PDF. A normal
	// human visit without the query param is completely unchanged.
	const renderMode = url.searchParams.get('render') === 'pdf';

	// Phase H content-mode filter (Gaylon, 2026-07-23): 'narrative' renders
	// only the header + published narrative, 'days' renders only the header
	// + day chapters, 'full' (default) is the original behavior. Only
	// honored in render=pdf mode, per the spec — a normal human visit to the
	// book ignores ?content= entirely and always gets the full book, so this
	// can never surprise someone just reading (only the enrichment worker's
	// headless render ever sets both params together).
	const contentModeParam = url.searchParams.get('content');
	const contentMode: BookContentMode =
		renderMode && isValidContentMode(contentModeParam) ? contentModeParam : 'full';

	const year = Number(params.key);

	// The ONE query pulling the year's accepted days, per the Phase F spec —
	// accepted-only predicate applied directly in the SQL, same rule as every
	// other /app query (see src/lib/server/viewer.ts file header). Always run
	// regardless of contentMode: 'narrative' mode still needs the accepted
	// count for the book header's coverage line, even though it renders no
	// chapters.
	const [daysRes, totalRes, narrative, adjacent] = await Promise.all([
		query<{
			entry_date: string;
			corrected_text: string | null;
			day_narrative: string | null;
			has_image: boolean;
		}>(
			`SELECT entry_date::text AS entry_date, corrected_text, day_narrative,
			        (day_image_path IS NOT NULL) AS has_image
			   FROM calendar_days
			  WHERE correction_status = 'accepted' AND EXTRACT(YEAR FROM entry_date)::int = $1
			  ORDER BY entry_date`,
			[year]
		),
		// Total ingested days for the year (any status) — the denominator for
		// the "N of M days transcribed so far" coverage note. Aggregate count
		// only, no row content, same non-predicate precedent as
		// getCoverage()/getYearCoverage() in src/lib/server/viewer.ts.
		query<{ total: number }>(
			`SELECT COUNT(*)::int AS total FROM calendar_days WHERE EXTRACT(YEAR FROM entry_date)::int = $1`,
			[year]
		),
		// 'days' mode never shows the narrative — skip the query entirely
		// rather than fetch it and merely not render it, since the point of
		// 'days' mode is that the narrative text shouldn't even leave the DB.
		contentMode === 'days' ? Promise.resolve(null) : getPublishedNarrative('year', String(year)),
		getAdjacentAcceptedYears(year)
	]);

	const total = totalRes.rows[0]?.total ?? 0;
	const accepted = daysRes.rows.length;

	// 'narrative' mode never shows day chapters — same "don't even build it"
	// rule as skipping the narrative fetch above for 'days' mode. The
	// accepted count for the header is already captured above regardless.
	let chapters: BookChapter[] = [];
	if (contentMode !== 'narrative') {
		const chaptersByMonth = new Map<number, BookDay[]>();
		for (const row of daysRes.rows) {
			const month = Number(row.entry_date.slice(5, 7));
			const day: BookDay = {
				entryDate: row.entry_date,
				dateLabel: formatHumanDateNoYear(row.entry_date),
				correctedText: row.corrected_text ?? '',
				dayNarrative: row.day_narrative,
				hasImage: row.has_image
			};
			const list = chaptersByMonth.get(month);
			if (list) list.push(day);
			else chaptersByMonth.set(month, [day]);
		}

		// Only months with at least one accepted day become chapters — this is
		// a reading flow, not the month-grid browser, so an empty month
		// contributes nothing to read.
		chapters = Array.from(chaptersByMonth.entries())
			.sort((a, b) => a[0] - b[0])
			.map(([month, days]) => ({ month, monthName: MONTH_NAMES[month - 1], days }));
	}

	// "Continue to YYYY" only when the next accepted-day year actually has
	// accepted days (getAdjacentAcceptedYears already guarantees that — it's
	// derived from getAcceptedYears(), which only includes years with >= 1
	// accepted day).
	return {
		available: true as const,
		year,
		coverage: { accepted, total },
		narrative,
		contentMode,
		chapters,
		nextYear: adjacent.next,
		renderMode
	};
};
