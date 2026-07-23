import { getYearCoverage, type YearCoverage } from '$lib/server/viewer';
import type { PageServerLoad } from './$types';

export interface DecadeGroup {
	decade: number; // e.g. 1970
	years: YearCoverage[];
	accepted: number; // decade totals, so a collapsed group still informs
	total: number;
}

export const load: PageServerLoad = async () => {
	const years = await getYearCoverage();

	const byDecade = new Map<number, YearCoverage[]>();
	for (const y of years) {
		const decade = Math.floor(y.year / 10) * 10;
		const list = byDecade.get(decade);
		if (list) list.push(y);
		else byDecade.set(decade, [y]);
	}

	const decades: DecadeGroup[] = Array.from(byDecade.entries())
		.sort((a, b) => b[0] - a[0]) // most recent decade first
		.map(([decade, decadeYears]) => ({
			decade,
			years: decadeYears.sort((a, b) => b.year - a.year),
			accepted: decadeYears.reduce((sum, y) => sum + y.accepted, 0),
			total: decadeYears.reduce((sum, y) => sum + y.total, 0)
		}));

	return { decades };
};
