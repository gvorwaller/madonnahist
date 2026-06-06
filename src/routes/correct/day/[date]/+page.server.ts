import { query } from '$lib/db';
import { populateLexicon } from '$lib/correction-lexicon';
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
		monthKey
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
		if (correctedText === '') return fail(400, { error: 'Corrected text cannot be empty' });

		const userId = Number(locals.user.id);

		const dayRes = await query<{ day_id: number; llm_draft_run_id: number | null; correction_status: string }>(
			`SELECT cd.id AS day_id, cd.latest_llm_draft_run_id AS llm_draft_run_id, cd.correction_status
			   FROM calendar_days cd WHERE cd.entry_date = $1`, [entryDate]
		);
		if (!dayRes.rows[0]) return fail(404, { error: 'Day not found' });
		const { day_id, llm_draft_run_id, correction_status } = dayRes.rows[0];
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

		if (wasAlreadyCorrected) {
			redirect(303, `/correct/day/${entryDate}`);
		}

		const nextDate = await nextUncorrectedDate(entryDate);
		redirect(303, `/correct/day/${nextDate ?? entryDate}`);
	},

	skip: async ({ params, locals }) => {
		if (!locals.user) return fail(401, { error: 'Not authenticated' });
		const entryDate = params.date;
		if (!validDate(entryDate)) return fail(400, { error: 'Invalid date' });

		const userId = Number(locals.user.id);

		const dayRes = await query<{ day_id: number }>(
			`SELECT id AS day_id FROM calendar_days WHERE entry_date = $1`, [entryDate]
		);
		if (!dayRes.rows[0]) return fail(404, { error: 'Day not found' });

		await query(
			`INSERT INTO day_corrections (day_id, corrected_text, review_note, status_after, editor_user_id)
			 VALUES ($1, '', 'skipped', 'in_progress', $2)`,
			[dayRes.rows[0].day_id, userId]
		);

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

		const dayRes = await query<{ day_id: number }>(
			`SELECT id AS day_id FROM calendar_days WHERE entry_date = $1`, [entryDate]
		);
		if (!dayRes.rows[0]) return fail(404, { error: 'Day not found' });

		await query(
			`INSERT INTO day_corrections (day_id, corrected_text, review_note, status_after, editor_user_id)
			 VALUES ($1, '', $2, 'illegible', $3)`,
			[dayRes.rows[0].day_id, reviewNote, userId]
		);

		const nextDate = await nextUncorrectedDate(entryDate);
		redirect(303, `/correct/day/${nextDate ?? entryDate}`);
	}
} satisfies Actions;
