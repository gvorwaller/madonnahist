import { query } from '$lib/db';
import {
	formatHumanDate,
	getAdjacentAcceptedDates,
	getSameDateOtherYears,
	isValidEntryDate,
	VISIBLE_DAY_TAGS
} from '$lib/server/viewer';
import { getDayEntityChips } from '$lib/server/entities';
import { getDayMemories, getWriterForUser, viewerIdOf } from '$server/memories';
import type { HiddenMemories, MemoryView } from '$lib/viewer/memories';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, locals }) => {
	const entryDate = params.date;

	// Malformed dates get the same friendly "not transcribed" treatment as a
	// nonexistent or non-accepted date — no 404 error page, no format leak.
	if (!isValidEntryDate(entryDate)) {
		return {
			found: false as const,
			entryDate: params.date,
			dateLabel: null,
			memories: [] as MemoryView[],
			hiddenMemories: [] as HiddenMemories[],
			canWrite: false,
			prevDate: null,
			nextDate: null
		};
	}

	const dateLabel = formatHumanDate(entryDate);

	// Memories are independent of the calendar (plan §4, CODEX #4): loaded
	// before the "not transcribed" exit, so a shared memory (or your own
	// draft) still shows on a day Madonna hasn't reached. They never widen
	// what calendar text, tags, chips or images this page returns.
	const viewerId = viewerIdOf(locals);
	const [{ memories, hidden: hiddenMemories }, writer] = await Promise.all([
		getDayMemories(entryDate, viewerId),
		getWriterForUser(viewerId)
	]);
	const canWrite = !!writer;
	// A day whose only memories are hidden still counts as a memory day, so
	// the page can say what's hidden and offer to show it (td-76a40f).
	const anyMemories = memories.length + hiddenMemories.length > 0;

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
		// Prev/Next still work on a memory-only day (AGY2 #1).
		const adjacent =
			anyMemories ? await getAdjacentAcceptedDates(entryDate) : { prev: null, next: null };
		return {
			found: false as const,
			entryDate,
			dateLabel,
			memories,
			hiddenMemories,
			canWrite,
			prevDate: adjacent.prev,
			nextDate: adjacent.next
		};
	}

	// Predicate re-applied independently here too (rather than trusting the
	// row lookup above) — see src/lib/server/viewer.ts file header.
	const [{ prev, next }, tagsRes, entities, otherYears] = await Promise.all([
		getAdjacentAcceptedDates(entryDate),
		query<{ tag_slug: string; tag_label: string }>(
			`SELECT vt.tag_slug, vt.tag_label
			   FROM ${VISIBLE_DAY_TAGS} vt
			   JOIN calendar_days cd ON cd.id = vt.day_id
			  WHERE cd.entry_date = $1 AND cd.correction_status = 'accepted'
			  ORDER BY vt.tag_label`,
			[entryDate]
		),
		getDayEntityChips(entryDate),
		getSameDateOtherYears(entryDate)
	]);

	return {
		found: true as const,
		entryDate,
		dateLabel,
		correctedText: row.corrected_text ?? '',
		dayNarrative: row.day_narrative,
		hasImage: row.has_image,
		tags: tagsRes.rows,
		entities,
		prevDate: prev,
		nextDate: next,
		otherYears,
		memories,
		hiddenMemories,
		canWrite
	};
};
