import { query } from '$lib/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	const res = await query<{
		id: number;
		year: number;
		month: number;
		page_image_path: string;
		total_days: number;
		ocr_complete: number;
		avg_confidence: number | null;
		flagged_count: number;
	}>(`
		SELECT cp.id, cp.year, cp.month, cp.page_image_path,
		       COUNT(cd.id)::int AS total_days,
		       COUNT(cd.latest_ocr_run_id)::int AS ocr_complete,
		       ROUND(AVG(cd.latest_confidence_score)::numeric, 3)::float AS avg_confidence,
		       COUNT(*) FILTER (WHERE cd.correction_status = 'flagged')::int AS flagged_count
		  FROM calendar_pages cp
		  JOIN calendar_days cd ON cd.page_id = cp.id
		 GROUP BY cp.id
		 ORDER BY cp.year, cp.month
	`);

	return { pages: res.rows };
};
