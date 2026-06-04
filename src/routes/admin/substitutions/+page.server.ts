import { query } from '$lib/db';
import { loadSubstitutionRules, runSubstitutionPass } from '$lib/ocr/substitutions';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	const rules = await loadSubstitutionRules();

	const uncorrectedCount = await query<{ cnt: number }>(
		`SELECT COUNT(*)::int AS cnt
		   FROM calendar_days
		  WHERE correction_status IS DISTINCT FROM 'accepted'
		    AND latest_llm_draft_run_id IS NOT NULL`
	);

	const totalDays = await query<{ cnt: number }>(
		`SELECT COUNT(*)::int AS cnt FROM calendar_days WHERE latest_llm_draft_run_id IS NOT NULL`
	);

	const lastRun = await query<{ created_at: string; cnt: number }>(
		`SELECT created_at::text, COUNT(*)::int AS cnt
		   FROM llm_draft_runs
		  WHERE model_name = 'substitution-pass'
		  GROUP BY created_at
		  ORDER BY created_at DESC
		  LIMIT 1`
	);

	return {
		rules,
		uncorrectedCount: uncorrectedCount.rows[0]?.cnt ?? 0,
		totalDays: totalDays.rows[0]?.cnt ?? 0,
		lastRun: lastRun.rows[0] ?? null
	};
};

export const actions: Actions = {
	run: async () => {
		const summary = await runSubstitutionPass();
		return { summary };
	}
};
