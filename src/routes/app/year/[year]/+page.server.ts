import { query } from '$lib/db';
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
			narrative: null as string | null,
			pdfExports: [] as Array<{ mode: string; byteSize: number }>
		};
	}

	const year = Number(params.year);

	const [byMonth, adjacent, coverage, narrative, pdfExportRes] = await Promise.all([
		getAcceptedDaysByMonth(year),
		getAdjacentAcceptedYears(year),
		getCoverage(),
		getPublishedNarrative('year', String(year)),
		// Latest export per content mode for this year — feeds the
		// "Print & download" block (Gaylon, 2026-07-23) listing every
		// available variant (full / narrative-only / days-only).
		query<{ content_mode: string; byte_size: string }>(
			`SELECT DISTINCT ON (content_mode) content_mode, byte_size
			   FROM pdf_exports
			  WHERE scope = 'year' AND scope_key = $1
			  ORDER BY content_mode, created_at DESC`,
			[String(year)]
		)
	]);

	const months = Array.from({ length: 12 }, (_, i) => ({
		month: i + 1,
		acceptedDays: byMonth.get(i + 1) ?? []
	}));

	// BIGINT comes back from node-pg as a string — Number() here only for
	// display (human-readable size), never fed back into a query.
	const modeOrder: Record<string, number> = { full: 0, narrative: 1, days: 2 };
	const pdfExports = pdfExportRes.rows
		.map((r) => ({ mode: r.content_mode, byteSize: Number(r.byte_size) }))
		.sort((a, b) => (modeOrder[a.mode] ?? 9) - (modeOrder[b.mode] ?? 9));

	return {
		validYear: true as const,
		year,
		months,
		prevYear: adjacent.prev,
		nextYear: adjacent.next,
		coverage,
		narrative,
		pdfExports
	};
};
