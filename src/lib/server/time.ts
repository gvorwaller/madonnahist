import { env } from '$env/dynamic/private';

/**
 * The family's home timezone — the single "local time" the app presents.
 *
 * Storage stays UTC everywhere (timestamptz columns, app code), matching the
 * BTC-dashboard precedent; this constant is applied only at the edges:
 * computing the "today" anchor for "On this day" and formatting system
 * timestamps for display. calendar_days.entry_date is a civil DATE with no
 * timezone at all, so archive dates themselves are never converted.
 *
 * Deliberately NOT the visitor's browser timezone: server-rendered pages
 * would mismatch on hydration, and "on this day in our history" should mean
 * the family's home day regardless of where a family member happens to be.
 */
export const APP_TIMEZONE = env.MADONNAHIST_TIMEZONE || 'America/New_York';

/** Current civil date in the app's home timezone. Intl handles DST. */
export function todayInAppTz(): { year: number; month: number; day: number } {
	// en-CA formats as YYYY-MM-DD.
	const ymd = new Intl.DateTimeFormat('en-CA', {
		timeZone: APP_TIMEZONE,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit'
	}).format(new Date());
	const [year, month, day] = ymd.split('-').map(Number);
	return { year, month, day };
}

/** Format a UTC timestamp (ISO string or Date) for display in home-tz local time. */
export function formatTimestampInAppTz(value: string | Date): string {
	const date = typeof value === 'string' ? new Date(value) : value;
	return new Intl.DateTimeFormat('en-US', {
		timeZone: APP_TIMEZONE,
		weekday: 'short',
		year: 'numeric',
		month: 'short',
		day: 'numeric',
		hour: 'numeric',
		minute: '2-digit',
		timeZoneName: 'short'
	}).format(date);
}

/**
 * Convert a civil date (`YYYY-MM-DD`) interpreted as local midnight in the
 * app's home timezone into the equivalent UTC instant — used to turn an
 * admin-supplied date-range boundary (e.g. `/admin/audit`'s "from"/"to"
 * filters) into a comparison against a `timestamptz` column like
 * `audit_log.occurred_at`.
 *
 * Standard "double conversion" trick (same approach libraries like
 * date-fns-tz use for `zonedTimeToUtc`): start with a UTC guess equal to the
 * target wall-clock time, see what that guess actually renders as when
 * formatted back in the target timezone, then shift the guess by the
 * difference. One correction pass is enough for a fixed offset; run it
 * twice so a DST-transition day still converges (the second pass corrects
 * against the already-adjusted guess).
 */
export function startOfDayInAppTzAsUtc(dateStr: string): Date {
	const [y, m, d] = dateStr.split('-').map(Number);
	// The desired wall-clock instant, expressed as UTC ms. Each correction
	// pass must measure the guess's rendered wall clock against THIS fixed
	// target — measuring against the moving guess makes the loop overshoot
	// to double the offset (caught in review 2026-07-23: 2026-07-23 EDT
	// returned 08:00Z instead of 04:00Z).
	const targetMs = Date.UTC(y, m - 1, d, 0, 0, 0);
	let guessMs = targetMs;
	for (let i = 0; i < 2; i++) {
		const parts = new Intl.DateTimeFormat('en-US', {
			timeZone: APP_TIMEZONE,
			hour12: false,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit'
		}).formatToParts(new Date(guessMs));
		const map: Record<string, string> = {};
		for (const p of parts) map[p.type] = p.value;
		// Intl's 24h "hour" can render as "24" for local midnight — normalize
		// with % 24 before feeding it back into Date.UTC.
		const renderedAsUtcMs = Date.UTC(
			Number(map.year),
			Number(map.month) - 1,
			Number(map.day),
			Number(map.hour) % 24,
			Number(map.minute),
			Number(map.second)
		);
		guessMs -= renderedAsUtcMs - targetMs;
	}
	return new Date(guessMs);
}

/** `dateStr` (YYYY-MM-DD) plus one calendar day, as plain date-component arithmetic — no timezone involved. */
export function nextDateStr(dateStr: string): string {
	const [y, m, d] = dateStr.split('-').map(Number);
	return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}
