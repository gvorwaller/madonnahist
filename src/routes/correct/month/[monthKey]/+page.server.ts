import { query } from '$lib/db';
import { error, fail, redirect } from '@sveltejs/kit';
import { getClaimForMonth, claimMonth, releaseClaim } from '$lib/server/claims';
import type { PageServerLoad, Actions } from './$types';

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
	const userId = Number(locals.user.id);

	const days = await query<{
		entry_date: string;
		day_number: number;
		correction_status: string;
		has_draft: boolean;
		corrected_text: string | null;
		has_narrative: boolean;
	}>(`
		SELECT cd.entry_date::text AS entry_date,
		       EXTRACT(DAY FROM cd.entry_date)::int AS day_number,
		       cd.correction_status,
		       cd.latest_llm_draft_run_id IS NOT NULL AS has_draft,
		       cd.corrected_text,
		       (cd.day_narrative IS NOT NULL AND cd.day_narrative != '') AS has_narrative
		  FROM calendar_days cd
		  JOIN calendar_pages cp ON cp.id = cd.page_id
		 WHERE cp.year = $1 AND cp.month = $2
		 ORDER BY cd.entry_date
	`, [parsed.year, parsed.month]);

	const claim = await getClaimForMonth(parsed.year, parsed.month);
	let otherClaim: { sessionId: number; displayName: string; lastActivity: string; isFresh: boolean } | null = null;

	if (!claim || claim.userId === userId) {
		await claimMonth(userId, parsed.year, parsed.month);
	} else if (!claim.isFresh) {
		await releaseClaim(claim.sessionId);
		await claimMonth(userId, parsed.year, parsed.month);
	} else {
		otherClaim = {
			sessionId: claim.sessionId,
			displayName: claim.displayName,
			lastActivity: claim.lastActivity.toISOString(),
			isFresh: claim.isFresh,
		};
	}

	return {
		year: parsed.year,
		month: parsed.month,
		days: days.rows,
		otherClaim,
		hasClaim: !otherClaim,
		isAdmin: locals.user.role === 'admin',
	};
};

export const actions: Actions = {
	takeover: async ({ params, locals }) => {
		if (!locals.user) return fail(401, { error: 'Not authenticated' });
		const parsed = parseMonthKey(params.monthKey);
		if (!parsed) return fail(400, { error: 'Invalid month' });
		const userId = Number(locals.user.id);

		const claim = await getClaimForMonth(parsed.year, parsed.month);
		if (claim && claim.userId !== userId) {
			await releaseClaim(claim.sessionId);
		}
		await claimMonth(userId, parsed.year, parsed.month);
		return { success: true };
	},

	release: async ({ params, locals }) => {
		if (!locals.user) return fail(401, { error: 'Not authenticated' });
		const parsed = parseMonthKey(params.monthKey);
		if (!parsed) return fail(400, { error: 'Invalid month' });
		const userId = Number(locals.user.id);

		const claim = await getClaimForMonth(parsed.year, parsed.month);
		if (claim && (claim.userId === userId || locals.user.role === 'admin')) {
			await releaseClaim(claim.sessionId);
		}
		redirect(303, '/correct');
	},
};
