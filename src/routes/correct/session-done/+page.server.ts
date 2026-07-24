// td-b52a49 item 4 — session summary screen, reached after "Done for now"
// pauses the user's active correction_sessions row
// (src/lib/server/claims.ts's pauseActiveSession()). Requires a `?session=`
// query param naming the paused session; anything missing/invalid/not owned
// by the current user falls back to /correct rather than erroring — this
// page has no meaning without a specific session to summarize.
import { query } from '$lib/db';
import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url, locals }) => {
	if (!locals.user) error(401, 'Not authenticated');
	const userId = Number(locals.user.id);

	const sessionIdParam = url.searchParams.get('session');
	const sessionId = sessionIdParam ? Number(sessionIdParam) : NaN;
	if (!sessionIdParam || !Number.isInteger(sessionId) || sessionId <= 0) {
		redirect(303, '/correct');
	}

	const sessionRes = await query<{ started_at: string; queue_scope: unknown }>(
		`SELECT started_at, queue_scope FROM correction_sessions WHERE id = $1 AND user_id = $2`,
		[sessionId, userId]
	);
	const session = sessionRes.rows[0];
	if (!session) redirect(303, '/correct');

	// JSONB comes back as an object already; guard with typeof anyway (see
	// cs.md's JSONB-vs-SQLite note).
	const scope = (typeof session.queue_scope === 'string' ? JSON.parse(session.queue_scope) : session.queue_scope) as
		| { year?: number; month?: number }
		| null
		| undefined;

	// "days corrected in this sitting" — per td-b52a49 item 4a's spec: count
	// of day_corrections rows with status_after='accepted' by this user
	// since the session row's started_at. Note: started_at is the session's
	// ORIGINAL creation time, not the most recent resume — claimMonth()
	// reactivates an existing paused/active session rather than resetting
	// started_at, so a session resumed across multiple sittings counts
	// corrections from all of them, not just the most recent one.
	const countsRes = await query<{ accepted: number; flagged: number; skipped: number }>(
		`SELECT
		   COUNT(*) FILTER (WHERE status_after = 'accepted')::int AS accepted,
		   COUNT(*) FILTER (WHERE status_after IN ('flagged', 'illegible'))::int AS flagged,
		   COUNT(*) FILTER (WHERE status_after = 'in_progress' AND review_note = 'skipped')::int AS skipped
		 FROM day_corrections
		WHERE editor_user_id = $1 AND created_at >= $2`,
		[userId, session.started_at]
	);
	const counts = countsRes.rows[0] ?? { accepted: 0, flagged: 0, skipped: 0 };

	const monthKey = scope?.year && scope?.month
		? `${scope.year}-${String(scope.month).padStart(2, '0')}`
		: null;

	return {
		correctedCount: counts.accepted,
		flaggedCount: counts.flagged,
		skippedCount: counts.skipped,
		year: scope?.year ?? null,
		month: scope?.month ?? null,
		monthKey,
		startedAt: new Date(session.started_at).toISOString(),
	};
};
