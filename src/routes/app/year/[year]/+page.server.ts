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
			pdfExport: null as { byteSize: number } | null
		};
	}

	const year = Number(params.year);

	const [byMonth, adjacent, coverage, narrative, pdfExportRes] = await Promise.all([
		getAcceptedDaysByMonth(year),
		getAdjacentAcceptedYears(year),
		getCoverage(),
		getPublishedNarrative('year', String(year)),
		// Most recent full-book export for this year, if any — feeds the
		// "Download PDF (N MB)" link (Gaylon, 2026-07-23). Only the 'full'
		// mode is surfaced here; narrative-only/days-only exports (if any)
		// are reachable directly via /app/year/[year]/pdf?mode=... but aren't
		// worth a second link on this page per the request's scope.
		query<{ byte_size: string }>(
			`SELECT byte_size FROM pdf_exports
			  WHERE scope = 'year' AND scope_key = $1 AND content_mode = 'full'
			  ORDER BY created_at DESC LIMIT 1`,
			[String(year)]
		)
	]);

	const months = Array.from({ length: 12 }, (_, i) => ({
		month: i + 1,
		acceptedDays: byMonth.get(i + 1) ?? []
	}));

	// BIGINT comes back from node-pg as a string — Number() here only for
	// display (human-readable size), never fed back into a query.
	const pdfExport = pdfExportRes.rows[0] ? { byteSize: Number(pdfExportRes.rows[0].byte_size) } : null;

	return {
		validYear: true as const,
		year,
		months,
		prevYear: adjacent.prev,
		nextYear: adjacent.next,
		coverage,
		narrative,
		pdfExport
	};
};
