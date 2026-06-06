import { query } from '$lib/db';
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) error(401, 'Not authenticated');

	const monthsRes = await query<{
		year: number;
		month: number;
		total_days: number;
		corrected_count: number;
		illegible_count: number;
		skipped_count: number;
		pending_count: number;
		draft_ready_count: number;
		first_pending_date: string | null;
	}>(`
		SELECT cp.year, cp.month,
		       COUNT(cd.id)::int AS total_days,
		       COUNT(*) FILTER (WHERE cd.correction_status = 'accepted')::int AS corrected_count,
		       COUNT(*) FILTER (WHERE cd.correction_status = 'illegible')::int AS illegible_count,
		       COUNT(*) FILTER (WHERE cd.correction_status = 'in_progress')::int AS skipped_count,
		       COUNT(*) FILTER (WHERE cd.correction_status = 'pending')::int AS pending_count,
		       COUNT(*) FILTER (WHERE cd.latest_llm_draft_run_id IS NOT NULL)::int AS draft_ready_count,
		       MIN(cd.entry_date::text) FILTER (WHERE cd.correction_status = 'pending') AS first_pending_date
		  FROM calendar_pages cp
		  JOIN calendar_days cd ON cd.page_id = cp.id
		 GROUP BY cp.year, cp.month
		 ORDER BY cp.year, cp.month
	`);

	const resumeRes = await query<{ entry_date: string }>(
		`SELECT entry_date::text AS entry_date FROM calendar_days
		  WHERE correction_status = 'pending'
		  ORDER BY entry_date LIMIT 1`
	);

	return {
		months: monthsRes.rows,
		resumeDate: resumeRes.rows[0]?.entry_date ?? null
	};
};
