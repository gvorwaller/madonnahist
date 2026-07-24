import { query } from '$lib/db';
import { getAcceptedDaysByMonth } from '$lib/server/viewer';
import type { PageServerLoad } from './$types';

/**
 * Viewer month page (td-852d99) — the full scanned calendar-page image plus
 * the existing MonthGrid day navigator. Any authenticated role reaches this
 * (gated by src/hooks.server.ts's blanket /app allow), unlike the
 * accepted-only day pages: see this route's page-image/+server.ts for the
 * deliberate policy note on why the page photo itself is not gated the same
 * way individual day crops are.
 *
 * MIN_YEAR/MAX_YEAR duplicated locally rather than shared — same precedent
 * as /app/year/[year], /app/year/[year]/pdf, and /app/book/[scope]/[key].
 */
const MIN_YEAR = 1900;
const MAX_YEAR = 2100;

function parseMonthKey(monthKey: string | undefined): { year: number; month: number } | null {
	if (!monthKey || !/^\d{4}-\d{2}$/.test(monthKey)) return null;
	const [yearStr, monthStr] = monthKey.split('-');
	const year = Number(yearStr);
	const month = Number(monthStr);
	if (year < MIN_YEAR || year > MAX_YEAR) return null;
	if (month < 1 || month > 12) return null;
	return { year, month };
}

export const load: PageServerLoad = async ({ params }) => {
	const parsed = parseMonthKey(params.monthKey);

	// Malformed/out-of-range month keys get the same friendly "nothing here"
	// treatment as a real month with no captured page yet — no format leak,
	// no raw 404 page, matching the precedent set by /app/year/[year] and
	// /app/book/[scope]/[key].
	if (!parsed) {
		return {
			found: false as const,
			reason: 'invalid' as const,
			monthKey: params.monthKey
		};
	}

	const { year, month } = parsed;

	const pageRes = await query<{ id: number }>(
		`SELECT id FROM calendar_pages WHERE year = $1 AND month = $2`,
		[year, month]
	);
	const pageRow = pageRes.rows[0];

	if (!pageRow) {
		return {
			found: false as const,
			reason: 'missing' as const,
			monthKey: params.monthKey,
			year,
			month
		};
	}

	const [byMonth, coverageRes] = await Promise.all([
		getAcceptedDaysByMonth(year),
		query<{ accepted: number; total: number }>(
			`SELECT COUNT(*) FILTER (WHERE correction_status = 'accepted')::int AS accepted,
			        COUNT(*)::int AS total
			   FROM calendar_days WHERE page_id = $1`,
			[pageRow.id]
		)
	]);

	const coverage = coverageRes.rows[0] ?? { accepted: 0, total: 0 };

	return {
		found: true as const,
		monthKey: params.monthKey,
		year,
		month,
		acceptedDays: byMonth.get(month) ?? [],
		coverage
	};
};
