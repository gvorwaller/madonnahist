import { query } from '$lib/db';
import { firstSentences, getCoverage } from '$lib/server/viewer';
import { todayInAppTz } from '$lib/server/time';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	// "Today" means today in the family's home timezone (src/lib/server/time.ts)
	// — a UTC anchor would flip to tomorrow's entries every evening, and
	// Postgres CURRENT_DATE depends on whatever timezone a given session
	// happens to be configured with (the local test cluster was found running
	// America/New_York despite cs.md's UTC rule).
	const { month, day } = todayInAppTz();

	// Publishable-day predicate applied directly in this query (see
	// src/lib/server/viewer.ts) — every /app query filters independently.
	const daysRes = await query<{ entry_date: string; corrected_text: string | null }>(
		`SELECT entry_date::text AS entry_date, corrected_text
		   FROM calendar_days
		  WHERE correction_status = 'accepted'
		    AND EXTRACT(MONTH FROM entry_date) = $1
		    AND EXTRACT(DAY FROM entry_date) = $2
		  ORDER BY entry_date ASC`,
		[month, day]
	);

	const coverage = await getCoverage();

	const entries = daysRes.rows.map((row) => ({
		entryDate: row.entry_date,
		year: Number(row.entry_date.slice(0, 4)),
		preview: firstSentences(row.corrected_text ?? '', 2)
	}));

	return {
		month,
		day,
		entries,
		coverage
	};
};
