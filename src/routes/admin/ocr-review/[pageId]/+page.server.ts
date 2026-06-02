import { query } from '$lib/db';
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
	const pageId = Number(params.pageId);
	if (!Number.isFinite(pageId)) error(400, 'Invalid page ID');

	const pageRes = await query<{
		id: number;
		year: number;
		month: number;
		page_image_path: string;
		grid_version: number;
	}>(`SELECT id, year, month, page_image_path, grid_version FROM calendar_pages WHERE id = $1`, [pageId]);

	if (!pageRes.rows[0]) error(404, 'Page not found');
	const page = pageRes.rows[0];

	const dayRes = await query<{
		day_id: number;
		entry_date: string;
		crop_bounds: { x: number; y: number; width: number; height: number };
		raw_text: string | null;
		confidence_score: number | null;
		ocr_vendor: string | null;
		draft_text: string | null;
		draft_model: string | null;
		correction_status: string;
	}>(`
		SELECT cd.id AS day_id,
		       cd.entry_date::text AS entry_date,
		       cd.crop_bounds,
		       orr.raw_text,
		       orr.confidence_score,
		       orr.vendor AS ocr_vendor,
		       ldr.draft_text,
		       ldr.model_name AS draft_model,
		       cd.correction_status
		  FROM calendar_days cd
		  LEFT JOIN ocr_runs orr ON orr.id = cd.latest_ocr_run_id
		  LEFT JOIN llm_draft_runs ldr ON ldr.id = cd.latest_llm_draft_run_id
		 WHERE cd.page_id = $1
		 ORDER BY cd.entry_date
	`, [pageId]);

	const days = dayRes.rows;
	const ocrComplete = days.filter(d => d.raw_text !== null).length;
	const draftComplete = days.filter(d => d.draft_text !== null).length;
	const withText = days.filter(d => d.raw_text !== null && d.raw_text.trim() !== '');
	const avgConfidence = withText.length > 0
		? withText.reduce((sum, d) => sum + (d.confidence_score ?? 0), 0) / withText.length
		: null;
	const flaggedCount = days.filter(d => d.correction_status === 'flagged').length;
	const blankCount = days.filter(d => d.raw_text !== null && d.raw_text.trim() === '').length;

	return {
		page,
		days,
		stats: {
			total: days.length,
			ocrComplete,
			draftComplete,
			avgConfidence,
			flaggedCount,
			blankCount
		}
	};
};
