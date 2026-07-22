import { query, withTransaction } from '$lib/db';
import { populateLexicon } from '$lib/correction-lexicon';
import { heartbeat, completeSession } from '$lib/server/claims';
import { isValidTagLabel, slugifyTagLabel } from '$lib/server/tags';
import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

function validDate(s: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
	const d = new Date(s + 'T00:00:00');
	return !isNaN(d.getTime());
}

async function nextUncorrectedDate(afterDate: string): Promise<string | null> {
	const res = await query<{ entry_date: string }>(
		`SELECT entry_date::text AS entry_date FROM calendar_days
		  WHERE entry_date > $1
		    AND correction_status = 'pending'
		  ORDER BY entry_date LIMIT 1`, [afterDate]
	);
	return res.rows[0]?.entry_date ?? null;
}

async function prevUncorrectedDate(beforeDate: string): Promise<string | null> {
	const res = await query<{ entry_date: string }>(
		`SELECT entry_date::text AS entry_date FROM calendar_days
		  WHERE entry_date < $1
		    AND correction_status = 'pending'
		  ORDER BY entry_date DESC LIMIT 1`, [beforeDate]
	);
	return res.rows[0]?.entry_date ?? null;
}

async function nextAnyDate(afterDate: string, pageId: number): Promise<string | null> {
	const res = await query<{ entry_date: string }>(
		`SELECT entry_date::text AS entry_date FROM calendar_days
		  WHERE page_id = $2 AND entry_date > $1
		  ORDER BY entry_date LIMIT 1`, [afterDate, pageId]
	);
	return res.rows[0]?.entry_date ?? null;
}

async function prevAnyDate(beforeDate: string, pageId: number): Promise<string | null> {
	const res = await query<{ entry_date: string }>(
		`SELECT entry_date::text AS entry_date FROM calendar_days
		  WHERE page_id = $2 AND entry_date < $1
		  ORDER BY entry_date DESC LIMIT 1`, [beforeDate, pageId]
	);
	return res.rows[0]?.entry_date ?? null;
}

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.user) error(401, 'Not authenticated');
	const entryDate = params.date;
	if (!validDate(entryDate)) error(400, 'Invalid date');

	const dayRes = await query<{
		day_id: number;
		entry_date: string;
		page_id: number;
		correction_status: string;
		corrected_text: string | null;
		day_narrative: string | null;
		review_note: string | null;
		draft_text: string | null;
		llm_draft_run_id: number | null;
		ocr_raw_text: string | null;
		crop_bounds: { x: number; y: number; width: number; height: number } | null;
		year: number;
		month: number;
		page_width: number | null;
		page_height: number | null;
	}>(`
		SELECT cd.id AS day_id,
		       cd.entry_date::text AS entry_date,
		       cd.page_id,
		       cd.correction_status,
		       cd.corrected_text,
		       cd.day_narrative,
		       cd.review_note,
		       ldr.draft_text,
		       ldr.id AS llm_draft_run_id,
		       orr.raw_text AS ocr_raw_text,
		       cd.crop_bounds,
		       cp.year,
		       cp.month,
		       COALESCE(cp.warped_width, cp.image_width) AS page_width,
		       COALESCE(cp.warped_height, cp.image_height) AS page_height
		  FROM calendar_days cd
		  JOIN calendar_pages cp ON cp.id = cd.page_id
		  LEFT JOIN llm_draft_runs ldr ON ldr.id = cd.latest_llm_draft_run_id
		  LEFT JOIN ocr_runs orr ON orr.id = cd.latest_ocr_run_id
		 WHERE cd.entry_date = $1
	`, [entryDate]);

	if (!dayRes.rows[0]) error(404, 'No calendar day for this date');
	const day = dayRes.rows[0];

	const [tagsRes, tagSuggestionsRes] = await Promise.all([
		query<{ tag_slug: string; tag_label: string; source: string }>(
			`SELECT tag_slug, tag_label, source FROM day_tags WHERE day_id = $1 ORDER BY tag_label`,
			[day.day_id]
		),
		// DISTINCT ON, not DISTINCT: the same slug can carry different labels
		// across days ("Sunday school" / "Sunday School" → sunday-school), and
		// the datalist consuming this is a keyed {#each} on tag_slug — duplicate
		// keys crash Svelte's client-side render while SSR still succeeds
		// (production incident 2026-07-22: day pages silently failed to mount
		// after the AI tag backfill introduced label variants).
		query<{ tag_slug: string; tag_label: string }>(
			`SELECT DISTINCT ON (tag_slug) tag_slug, tag_label FROM day_tags ORDER BY tag_slug, tag_label`
		)
	]);

	const latestCorrectionRes = await query<{ corrected_text: string; status_after: string }>(
		`SELECT corrected_text, status_after FROM day_corrections
		  WHERE day_id = $1 ORDER BY created_at DESC LIMIT 1`, [day.day_id]
	);
	const latestCorrection = latestCorrectionRes.rows[0] ?? null;

	const countRes = await query<{ total: number; position: number }>(
		`SELECT
		   (SELECT COUNT(*)::int FROM calendar_days WHERE page_id = $1) AS total,
		   (SELECT COUNT(*)::int FROM calendar_days WHERE page_id = $1 AND entry_date <= $2) AS position`,
		[day.page_id, entryDate]
	);

	const nextDate = await nextUncorrectedDate(entryDate);
	const prevDate = await prevUncorrectedDate(entryDate);
	const nextAny = await nextAnyDate(entryDate, day.page_id);
	const prevAny = await prevAnyDate(entryDate, day.page_id);
	const monthKey = `${day.year}-${String(day.month).padStart(2, '0')}`;

	return {
		day,
		latestCorrection,
		position: countRes.rows[0]?.position ?? 0,
		total: countRes.rows[0]?.total ?? 0,
		nextDate,
		prevDate,
		nextAny,
		prevAny,
		monthKey,
		tags: tagsRes.rows,
		tagSuggestions: tagSuggestionsRes.rows,
		serverLoadedAt: new Date().toISOString(),
	};
};

export const actions = {
	save: async ({ params, request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Not authenticated' });
		const entryDate = params.date;
		if (!validDate(entryDate)) return fail(400, { error: 'Invalid date' });

		const formData = await request.formData();
		const correctedText = (formData.get('correctedText') as string ?? '').trim();
		const dayNarrative = (formData.get('dayNarrative') as string ?? '').trim() || null;
		const pageLoadedAt = formData.get('pageLoadedAt') as string | null;
		if (correctedText === '') return fail(400, { error: 'Corrected text cannot be empty' });

		const userId = Number(locals.user.id);

		const dayRes = await query<{ day_id: number; llm_draft_run_id: number | null; correction_status: string; year: number; month: number }>(
			`SELECT cd.id AS day_id, cd.latest_llm_draft_run_id AS llm_draft_run_id, cd.correction_status, cp.year, cp.month
			   FROM calendar_days cd
			   JOIN calendar_pages cp ON cp.id = cd.page_id
			  WHERE cd.entry_date = $1`, [entryDate]
		);
		if (!dayRes.rows[0]) return fail(404, { error: 'Day not found' });
		const { day_id, llm_draft_run_id, correction_status, year, month } = dayRes.rows[0];
		const wasAlreadyCorrected = correction_status === 'accepted';

		await query(
			`INSERT INTO day_corrections (day_id, corrected_text, status_after, editor_user_id, source_llm_draft_run_id)
			 VALUES ($1, $2, 'accepted', $3, $4)`,
			[day_id, correctedText, userId, llm_draft_run_id]
		);

		await populateLexicon(day_id, correctedText);

		await query(
			`UPDATE calendar_days SET day_narrative = $1 WHERE id = $2`,
			[dayNarrative, day_id]
		);

		await heartbeat(userId, year, month, day_id);

		if (wasAlreadyCorrected) {
			redirect(303, `/correct/day/${entryDate}`);
		}

		const nextDate = await nextUncorrectedDate(entryDate);

		if (!nextDate) {
			await completeSession(userId, year, month);
		}

		// Conflict detection
		let conflictParam = '';
		if (pageLoadedAt) {
			const conflictRes = await query<{ display_name: string }>(
				`SELECT u.display_name FROM day_corrections dc
				   JOIN users u ON u.id = dc.editor_user_id
				  WHERE dc.day_id = $1 AND dc.editor_user_id != $2 AND dc.created_at > $3::timestamptz
				  ORDER BY dc.created_at DESC LIMIT 1`,
				[day_id, userId, pageLoadedAt]
			);
			if (conflictRes.rows[0]) {
				conflictParam = `?conflict=${encodeURIComponent(conflictRes.rows[0].display_name)}`;
			}
		}

		redirect(303, `/correct/day/${nextDate ?? entryDate}${conflictParam}`);
	},

	skip: async ({ params, locals }) => {
		if (!locals.user) return fail(401, { error: 'Not authenticated' });
		const entryDate = params.date;
		if (!validDate(entryDate)) return fail(400, { error: 'Invalid date' });

		const userId = Number(locals.user.id);

		const dayRes = await query<{ day_id: number; year: number; month: number }>(
			`SELECT cd.id AS day_id, cp.year, cp.month
			   FROM calendar_days cd JOIN calendar_pages cp ON cp.id = cd.page_id
			  WHERE cd.entry_date = $1`, [entryDate]
		);
		if (!dayRes.rows[0]) return fail(404, { error: 'Day not found' });
		const { day_id, year, month } = dayRes.rows[0];

		await query(
			`INSERT INTO day_corrections (day_id, corrected_text, review_note, status_after, editor_user_id)
			 VALUES ($1, '', 'skipped', 'in_progress', $2)`,
			[day_id, userId]
		);

		await heartbeat(userId, year, month, day_id);

		const nextDate = await nextUncorrectedDate(entryDate);
		redirect(303, `/correct/day/${nextDate ?? entryDate}`);
	},

	flag: async ({ params, request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Not authenticated' });
		const entryDate = params.date;
		if (!validDate(entryDate)) return fail(400, { error: 'Invalid date' });

		const formData = await request.formData();
		const reviewNote = (formData.get('reviewNote') as string ?? '').trim() || 'Flagged as illegible';
		const userId = Number(locals.user.id);

		const dayRes = await query<{ day_id: number; year: number; month: number }>(
			`SELECT cd.id AS day_id, cp.year, cp.month
			   FROM calendar_days cd JOIN calendar_pages cp ON cp.id = cd.page_id
			  WHERE cd.entry_date = $1`, [entryDate]
		);
		if (!dayRes.rows[0]) return fail(404, { error: 'Day not found' });
		const { day_id, year, month } = dayRes.rows[0];

		await query(
			`INSERT INTO day_corrections (day_id, corrected_text, review_note, status_after, editor_user_id)
			 VALUES ($1, '', $2, 'illegible', $3)`,
			[day_id, reviewNote, userId]
		);

		await heartbeat(userId, year, month, day_id);

		const nextDate = await nextUncorrectedDate(entryDate);
		redirect(303, `/correct/day/${nextDate ?? entryDate}`);
	},

	addTag: async ({ params, request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Not authenticated' });
		const entryDate = params.date;
		if (!validDate(entryDate)) return fail(400, { error: 'Invalid date' });

		const formData = await request.formData();
		const rawLabel = (formData.get('tagLabel') as string ?? '');
		if (!isValidTagLabel(rawLabel)) {
			return fail(400, { error: 'Tag must be 1-40 characters' });
		}
		const tagLabel = rawLabel.trim();
		const tagSlug = slugifyTagLabel(tagLabel);
		if (tagSlug === '') {
			return fail(400, { error: 'Tag must contain at least one letter or number' });
		}

		const dayRes = await query<{ day_id: number }>(
			`SELECT id AS day_id FROM calendar_days WHERE entry_date = $1`, [entryDate]
		);
		if (!dayRes.rows[0]) return fail(404, { error: 'Day not found' });
		const { day_id } = dayRes.rows[0];
		const userId = Number(locals.user.id);

		await withTransaction(async (client) => {
			await client.query(
				`INSERT INTO day_tags (day_id, tag_slug, tag_label, source)
				 VALUES ($1, $2, $3, 'human')
				 ON CONFLICT (day_id, tag_slug) DO NOTHING`,
				[day_id, tagSlug, tagLabel]
			);
			await client.query(
				`INSERT INTO audit_log (user_id, action, entity_type, entity_id, before_value, after_value, description)
				 VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)`,
				[userId, 'tag_add', 'day_tags', day_id,
				 null, JSON.stringify({ tag_slug: tagSlug, tag_label: tagLabel, source: 'human' }),
				 `Added tag "${tagLabel}" to ${entryDate}`]
			);
		});
	},

	removeTag: async ({ params, request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Not authenticated' });
		const entryDate = params.date;
		if (!validDate(entryDate)) return fail(400, { error: 'Invalid date' });

		const formData = await request.formData();
		const tagSlug = (formData.get('tagSlug') as string ?? '').trim();
		if (tagSlug === '') return fail(400, { error: 'Missing tag' });

		const dayRes = await query<{ day_id: number }>(
			`SELECT id AS day_id FROM calendar_days WHERE entry_date = $1`, [entryDate]
		);
		if (!dayRes.rows[0]) return fail(404, { error: 'Day not found' });
		const { day_id } = dayRes.rows[0];
		const userId = Number(locals.user.id);

		// Allow removing both human- and AI-sourced tags — corrector judgment
		// wins (see Phase C deliverable 3).
		const before = await query<{ tag_label: string; source: string }>(
			`SELECT tag_label, source FROM day_tags WHERE day_id = $1 AND tag_slug = $2`,
			[day_id, tagSlug]
		);
		if (!before.rows[0]) return fail(404, { error: 'Tag not found' });

		await withTransaction(async (client) => {
			await client.query(
				`DELETE FROM day_tags WHERE day_id = $1 AND tag_slug = $2`,
				[day_id, tagSlug]
			);
			await client.query(
				`INSERT INTO audit_log (user_id, action, entity_type, entity_id, before_value, after_value, description)
				 VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)`,
				[userId, 'tag_remove', 'day_tags', day_id,
				 JSON.stringify({ tag_slug: tagSlug, tag_label: before.rows[0].tag_label, source: before.rows[0].source }),
				 null,
				 `Removed tag "${before.rows[0].tag_label}" from ${entryDate}`]
			);
		});
	}
} satisfies Actions;
