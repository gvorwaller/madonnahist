import { query } from '$lib/db';
import { getAdjacentCapturedMonths, getMonthPhoto, getMonthReading } from '$lib/server/viewer';
import { getPeriodMemories, getWriterForUser, viewerIdOf } from '$server/memories';
import type { HiddenMemories, MemoryView } from '$lib/viewer/memories';
import type { PageServerLoad } from './$types';

/**
 * Viewer month page (td-852d99; V3 Slice 3, td-ed1751) — the full scanned
 * calendar-page photo with tap-a-day targets, then a reading list of every
 * accepted day's full text. Any authenticated role reaches this
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

export const load: PageServerLoad = async ({ params, locals }) => {
	const parsed = parseMonthKey(params.monthKey);

	// Malformed/out-of-range month keys get the same friendly "nothing here"
	// treatment as a real month with no captured page yet — no format leak,
	// no raw 404 page, matching the precedent set by /app/year/[year] and
	// /app/book/[scope]/[key].
	if (!parsed) {
		return {
			found: false as const,
			reason: 'invalid' as const,
			monthKey: params.monthKey,
			memories: [] as MemoryView[],
			hiddenMemories: [] as HiddenMemories[],
			canWrite: false
		};
	}

	const { year, month } = parsed;
	const key = (m: { year: number; month: number } | null) =>
		m ? `${m.year}-${String(m.month).padStart(2, '0')}` : null;

	// Month memories are independent of the captured page (plan §4): an
	// uncaptured month still shows them. They never widen the calendar data.
	const viewerId = viewerIdOf(locals);
	const [{ memories, hidden: hiddenMemories }, writer] = await Promise.all([
		getPeriodMemories('month', params.monthKey, viewerId),
		getWriterForUser(viewerId)
	]);
	const canWrite = !!writer;

	const pageRes = await query<{ id: number }>(
		`SELECT id FROM calendar_pages WHERE year = $1 AND month = $2`,
		[year, month]
	);
	const pageRow = pageRes.rows[0];

	if (!pageRow) {
		// With memories, keep the header chevrons; the photo column is
		// omitted by the page (AGY2 #4).
		const adjacent =
			memories.length + hiddenMemories.length > 0
				? await getAdjacentCapturedMonths(year, month)
				: { prev: null, next: null };
		return {
			found: false as const,
			reason: 'missing' as const,
			monthKey: params.monthKey,
			year,
			month,
			memories,
			hiddenMemories,
			canWrite,
			prevMonth: key(adjacent.prev),
			nextMonth: key(adjacent.next)
		};
	}

	// Accepted-only: the reading list and the photo's links come from
	// accepted days. Other days get an inert, shaded cell (position only).
	const [days, photo, adjacent] = await Promise.all([
		getMonthReading(year, month),
		getMonthPhoto(pageRow.id),
		getAdjacentCapturedMonths(year, month)
	]);

	return {
		found: true as const,
		monthKey: params.monthKey,
		year,
		month,
		days,
		photo,
		prevMonth: key(adjacent.prev),
		nextMonth: key(adjacent.next),
		memories,
		hiddenMemories,
		canWrite
	};
};

