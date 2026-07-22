import { query } from '$lib/db';
import {
	getAcceptedDaysByMonth,
	getAdjacentAcceptedYears,
	getCoverage
} from '$lib/server/viewer';
import type { PageServerLoad } from './$types';

const MIN_YEAR = 1900;
const MAX_YEAR = 2100;

function isValidYearParam(s: string | undefined): s is string {
	if (!s || !/^\d{4}$/.test(s)) return false;
	const y = Number(s);
	return y >= MIN_YEAR && y <= MAX_YEAR;
}

/**
 * Published year narrative, or null if none exists / isn't published yet —
 * Phase E item 4. Filters is_published = true directly in the SQL (same
 * "every /app query independently applies its own predicate" rule as the
 * accepted-day predicate in src/lib/server/viewer.ts): an unpublished draft
 * must never reach this route regardless of any page-level check.
 */
async function getPublishedYearNarrative(year: number): Promise<string | null> {
	const res = await query<{ summary_text: string }>(
		`SELECT summary_text FROM narrative_summaries
		  WHERE scope = 'year' AND scope_key = $1 AND is_published = true`,
		[String(year)]
	);
	return res.rows[0]?.summary_text ?? null;
}

export const load: PageServerLoad = async ({ params }) => {
	// Malformed/out-of-range years get the same friendly "nothing here" state
	// as a real year with zero accepted days — no format leak, no 404 page.
	if (!isValidYearParam(params.year)) {
		return {
			validYear: false as const,
			year: params.year,
			months: [] as Array<{ month: number; acceptedDays: number[] }>,
			prevYear: null,
			nextYear: null,
			coverage: await getCoverage(),
			narrative: null as string | null
		};
	}

	const year = Number(params.year);

	const [byMonth, adjacent, coverage, narrative] = await Promise.all([
		getAcceptedDaysByMonth(year),
		getAdjacentAcceptedYears(year),
		getCoverage(),
		getPublishedYearNarrative(year)
	]);

	const months = Array.from({ length: 12 }, (_, i) => ({
		month: i + 1,
		acceptedDays: byMonth.get(i + 1) ?? []
	}));

	return {
		validYear: true as const,
		year,
		months,
		prevYear: adjacent.prev,
		nextYear: adjacent.next,
		coverage,
		narrative
	};
};
