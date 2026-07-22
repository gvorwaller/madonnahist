import {
	getAcceptedDaysByMonth,
	getAdjacentAcceptedYears,
	getCoverage,
	getPublishedNarrative
} from '$lib/server/viewer';
import type { PageServerLoad } from './$types';

const MIN_YEAR = 1900;
const MAX_YEAR = 2100;

function isValidYearParam(s: string | undefined): s is string {
	if (!s || !/^\d{4}$/.test(s)) return false;
	const y = Number(s);
	return y >= MIN_YEAR && y <= MAX_YEAR;
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
		getPublishedNarrative('year', String(year))
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
