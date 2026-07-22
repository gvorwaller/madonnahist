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
