import { query } from '$lib/db';
import {
	firstSentences,
	getLatestSavedStory,
	getNearestMonthDayWithEntries,
	getPublishedYearStories,
	getRecentlyAccepted,
	monthDayKey,
	parseMonthDay,
	pickLeadYearStory,
	shiftMonthDay
} from '$lib/server/viewer';
import { todayInAppTz } from '$lib/server/time';
import type { PageServerLoad } from './$types';

/**
 * Today (V3 Slice 1): the lead year story, then "On this day" for any
 * month/day (`?date=MM-DD`, default today in the family's timezone), then
 * the latest saved family story, recently added days and "Surprise me"
 * (Slice 2). An empty date offers the nearest date
 * that has entries (Gaylon, mockup review 2026-11-07).
 *
 * Accepted-only: every query here applies the publishable-day predicate
 * itself (see src/lib/server/viewer.ts). Year stories are published-only;
 * saved stories are admin-curated by saving (plan §Publication exceptions).
 */
export const load: PageServerLoad = async ({ url }) => {
	const now = todayInAppTz();
	// `?date=MM-DD` from the app's own links; `?m=&d=` from the no-JS picker form.
	const m = url.searchParams.get('m');
	const d = url.searchParams.get('d');
	const requested = parseMonthDay(
		url.searchParams.get('date') ?? (m && d ? `${m.padStart(2, '0')}-${d.padStart(2, '0')}` : null)
	);
	const date = requested ?? { month: now.month, day: now.day };
	const isToday = date.month === now.month && date.day === now.day;

	const daysRes = await query<{
		entry_date: string;
		corrected_text: string | null;
		has_memory: boolean;
		has_image: boolean;
	}>(
		`SELECT entry_date::text AS entry_date, corrected_text,
		        (day_narrative IS NOT NULL AND btrim(day_narrative) <> '') AS has_memory,
		        (day_image_path IS NOT NULL) AS has_image
		   FROM calendar_days
		  WHERE correction_status = 'accepted'
		    AND EXTRACT(MONTH FROM entry_date) = $1
		    AND EXTRACT(DAY FROM entry_date) = $2
		  ORDER BY entry_date ASC`,
		[date.month, date.day]
	);

	const entries = daysRes.rows.map((row) => {
		const d = new Date(row.entry_date + 'T00:00:00Z');
		return {
			entryDate: row.entry_date,
			year: d.getUTCFullYear(),
			yearsAgo: now.year - d.getUTCFullYear(),
			weekday: d.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }),
			preview: firstSentences(row.corrected_text ?? '', 3, 280),
			hasMemory: row.has_memory,
			hasImage: row.has_image
		};
	});

	const [stories, latestSaved, recent, nearest] = await Promise.all([
		getPublishedYearStories(),
		getLatestSavedStory(),
		getRecentlyAccepted(5),
		entries.length === 0 ? getNearestMonthDayWithEntries(date) : Promise.resolve(null)
	]);

	const lead = pickLeadYearStory(
		stories,
		date,
		entries.map((e) => e.year)
	);

	return {
		date: { ...date, key: monthDayKey(date) },
		isToday,
		prevKey: monthDayKey(shiftMonthDay(date, -1)),
		nextKey: monthDayKey(shiftMonthDay(date, 1)),
		entries,
		nearest: nearest ? { ...nearest, key: monthDayKey(nearest) } : null,
		leadStory: lead ? { year: lead.year, teaser: firstSentences(lead.text, 2, 200) } : null,
		latestSaved,
		recent
	};
};
