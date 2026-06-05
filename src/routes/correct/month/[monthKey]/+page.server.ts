import { query } from '$lib/db';
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

function parseMonthKey(key: string): { year: number; month: number } | null {
	const m = key.match(/^(\d{4})-(\d{2})$/);
	if (!m) return null;
	const year = Number(m[1]);
	const month = Number(m[2]);
	if (month < 1 || month > 12) return null;
	return { year, month };
}

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.user) error(401, 'Not authenticated');
	const parsed = parseMonthKey(params.monthKey);
	if (!parsed) error(400, 'Invalid month (expected YYYY-MM)');

	const days = await query<{
		entry_date: string;
		day_number: number;
		correction_status: string;
		has_draft: boolean;
		corrected_text: string | null;
	}>(`
		SELECT cd.entry_date::text AS entry_date,
		       EXTRACT(DAY FROM cd.entry_date)::int AS day_number,
		       cd.correction_status,
		       cd.latest_llm_draft_run_id IS NOT NULL AS has_draft,
		       cd.corrected_text
		  FROM calendar_days cd
		  JOIN calendar_pages cp ON cp.id = cd.page_id
		 WHERE cp.year = $1 AND cp.month = $2
		 ORDER BY cd.entry_date
	`, [parsed.year, parsed.month]);

	return {
		year: parsed.year,
		month: parsed.month,
		days: days.rows
	};
};
