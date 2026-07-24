// td-b52a49 item 3 — History panel data source. GET-only JSON endpoint;
// route gating in src/hooks.server.ts already restricts /correct/* to
// admin|corrector, so no extra auth check beyond the locals.user presence
// check below is needed here.
import { query } from '$lib/db';
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

function validDate(s: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
	const d = new Date(s + 'T00:00:00');
	return !isNaN(d.getTime());
}

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) error(401, 'Not authenticated');
	const entryDate = params.date;
	if (!validDate(entryDate)) error(400, 'Invalid date');

	const dayRes = await query<{ day_id: number }>(
		`SELECT id AS day_id FROM calendar_days WHERE entry_date = $1`, [entryDate]
	);
	if (!dayRes.rows[0]) error(404, 'No calendar day for this date');
	const { day_id } = dayRes.rows[0];

	const [ocrRes, llmRes, correctionsRes] = await Promise.all([
		query<{ vendor: string; created_at: string; raw_text: string; confidence_score: number | null }>(
			`SELECT vendor, created_at, raw_text, confidence_score
			   FROM ocr_runs WHERE day_id = $1 ORDER BY created_at DESC`,
			[day_id]
		),
		query<{ model_name: string; created_at: string; draft_text: string }>(
			`SELECT model_name, created_at, draft_text
			   FROM llm_draft_runs WHERE day_id = $1 ORDER BY created_at DESC`,
			[day_id]
		),
		query<{ display_name: string; created_at: string; status_after: string; corrected_text: string; review_note: string | null }>(
			`SELECT u.display_name, dc.created_at, dc.status_after, dc.corrected_text, dc.review_note
			   FROM day_corrections dc
			   JOIN users u ON u.id = dc.editor_user_id
			  WHERE dc.day_id = $1 ORDER BY dc.created_at DESC`,
			[day_id]
		)
	]);

	return json({
		ocrRuns: ocrRes.rows,
		llmDraftRuns: llmRes.rows,
		corrections: correctionsRes.rows
	});
};
