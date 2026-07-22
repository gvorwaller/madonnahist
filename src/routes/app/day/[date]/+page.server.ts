import { query } from '$lib/db';
import { formatHumanDate, getAdjacentAcceptedDates, isValidEntryDate } from '$lib/server/viewer';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
	const entryDate = params.date;

	// Malformed dates get the same friendly "not transcribed" treatment as a
	// nonexistent or non-accepted date — no 404 error page, no format leak.
	if (!isValidEntryDate(entryDate)) {
		return { found: false as const, entryDate: params.date, dateLabel: null };
	}

	const dateLabel = formatHumanDate(entryDate);

	// Publishable-day predicate applied directly in this query — a day that
	// exists but isn't accepted yet is treated identically to one that
	// doesn't exist at all.
	const res = await query<{
		corrected_text: string | null;
		day_narrative: string | null;
		has_image: boolean;
	}>(
		`SELECT corrected_text, day_narrative, (day_image_path IS NOT NULL) AS has_image
		   FROM calendar_days
		  WHERE entry_date = $1 AND correction_status = 'accepted'`,
		[entryDate]
	);

	const row = res.rows[0];
	if (!row) {
		return { found: false as const, entryDate, dateLabel };
	}

	// Predicate re-applied independently here too (rather than trusting the
	// row lookup above) — see src/lib/server/viewer.ts file header.
	const [{ prev, next }, tagsRes] = await Promise.all([
		getAdjacentAcceptedDates(entryDate),
		query<{ tag_slug: string; tag_label: string }>(
			`SELECT dt.tag_slug, dt.tag_label
			   FROM day_tags dt
			   JOIN calendar_days cd ON cd.id = dt.day_id
			  WHERE cd.entry_date = $1 AND cd.correction_status = 'accepted'
			  ORDER BY dt.tag_label`,
			[entryDate]
		)
	]);

	return {
		found: true as const,
		entryDate,
		dateLabel,
		correctedText: row.corrected_text ?? '',
		dayNarrative: row.day_narrative,
		hasImage: row.has_image,
		tags: tagsRes.rows,
		prevDate: prev,
		nextDate: next
	};
};
