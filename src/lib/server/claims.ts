import { query } from '$lib/db';

export interface MonthClaim {
	sessionId: number;
	userId: number;
	displayName: string;
	lastActivity: Date;
	isFresh: boolean;
}

async function getStaleThresholdHours(): Promise<number> {
	const res = await query<{ value: string }>(`SELECT value FROM app_state WHERE key = 'claim_stale_hours'`);
	return res.rows[0] ? Number(res.rows[0].value) : 4;
}

export async function getClaimForMonth(year: number, month: number): Promise<MonthClaim | null> {
	const hours = await getStaleThresholdHours();
	const res = await query<{
		id: string; user_id: string; display_name: string; last_activity_at: string;
	}>(`
		SELECT cs.id, cs.user_id, u.display_name, cs.last_activity_at
		  FROM correction_sessions cs
		  JOIN users u ON u.id = cs.user_id
		 WHERE cs.queue_scope @> $1::jsonb
		   AND cs.status IN ('active', 'paused')
		 ORDER BY cs.last_activity_at DESC
		 LIMIT 1
	`, [JSON.stringify({ year, month })]);

	if (!res.rows[0]) return null;
	const row = res.rows[0];
	const lastActivity = new Date(row.last_activity_at);
	const staleAt = new Date(Date.now() - hours * 3600_000);
	return {
		sessionId: Number(row.id),
		userId: Number(row.user_id),
		displayName: row.display_name,
		lastActivity,
		isFresh: lastActivity > staleAt,
	};
}

export async function claimMonth(userId: number, year: number, month: number): Promise<number> {
	const scope = JSON.stringify({ year, month });

	const existing = await query<{ id: string }>(`
		SELECT id FROM correction_sessions
		 WHERE user_id = $1
		   AND queue_scope @> $2::jsonb
		   AND status IN ('active', 'paused')
		 LIMIT 1
	`, [userId, scope]);

	if (existing.rows[0]) {
		const id = Number(existing.rows[0].id);
		await query(`UPDATE correction_sessions SET last_activity_at = NOW(), status = 'active' WHERE id = $1`, [id]);
		return id;
	}

	// Pause any other active sessions for this user (one active claim at a time)
	await query(`
		UPDATE correction_sessions SET status = 'paused'
		 WHERE user_id = $1 AND status = 'active'
	`, [userId]);

	const ins = await query<{ id: string }>(`
		INSERT INTO correction_sessions (user_id, queue_scope, status)
		VALUES ($1, $2::jsonb, 'active')
		RETURNING id
	`, [userId, scope]);

	return Number(ins.rows[0].id);
}

export async function releaseClaim(sessionId: number): Promise<void> {
	await query(`UPDATE correction_sessions SET status = 'abandoned' WHERE id = $1`, [sessionId]);
}

export async function heartbeat(userId: number, year: number, month: number, dayId: number): Promise<void> {
	await query(`
		UPDATE correction_sessions
		   SET last_activity_at = NOW(), current_day_id = $1
		 WHERE user_id = $2
		   AND queue_scope @> $3::jsonb
		   AND status = 'active'
	`, [dayId, userId, JSON.stringify({ year, month })]);
}

export async function completeSession(userId: number, year: number, month: number): Promise<void> {
	await query(`
		UPDATE correction_sessions SET status = 'completed'
		 WHERE user_id = $1
		   AND queue_scope @> $2::jsonb
		   AND status = 'active'
	`, [userId, JSON.stringify({ year, month })]);
}

export interface PausedSession {
	sessionId: number;
	startedAt: Date;
	year: number | null;
	month: number | null;
}

/**
 * "Done for now" (td-b52a49 item 4a). Pauses whatever session is currently
 * `active` for this user — claimMonth()'s exclusivity rule means a user has
 * at most one active session at a time, so no month/scope needs to be
 * passed in. Returns null if the user had no active session (e.g. double
 * submit, or the session already went stale/abandoned).
 */
export async function pauseActiveSession(userId: number): Promise<PausedSession | null> {
	const res = await query<{ id: string; started_at: string; queue_scope: unknown }>(`
		UPDATE correction_sessions
		   SET status = 'paused', last_activity_at = NOW()
		 WHERE user_id = $1 AND status = 'active'
		 RETURNING id, started_at, queue_scope
	`, [userId]);

	const row = res.rows[0];
	if (!row) return null;

	// JSONB comes back as an object already (see cs.md's JSONB-vs-SQLite note);
	// guard with typeof anyway in case a future driver/version change reverts
	// that.
	const scope = (typeof row.queue_scope === 'string' ? JSON.parse(row.queue_scope) : row.queue_scope) as
		| { year?: number; month?: number }
		| null
		| undefined;

	return {
		sessionId: Number(row.id),
		startedAt: new Date(row.started_at),
		year: scope?.year ?? null,
		month: scope?.month ?? null,
	};
}

export interface UserResume {
	entryDate: string;
	year: number;
	month: number;
}

export async function getUserResume(userId: number): Promise<UserResume | null> {
	// status IN ('active', 'paused') — not just 'active'. A session paused via
	// "Done for now" (td-b52a49 item 4) must still be resumable: pausing only
	// marks the session paused, it never abandons it. Matches the same
	// two-status filter getClaimForMonth() already uses for the same reason.
	const res = await query<{ entry_date: string; year: number; month: number }>(`
		SELECT cd.entry_date::text AS entry_date, cp.year, cp.month
		  FROM correction_sessions cs
		  JOIN calendar_days cd ON cd.id = cs.current_day_id
		  JOIN calendar_pages cp ON cp.id = cd.page_id
		 WHERE cs.user_id = $1
		   AND cs.status IN ('active', 'paused')
		 ORDER BY cs.last_activity_at DESC
		 LIMIT 1
	`, [userId]);

	if (!res.rows[0]) return null;
	const { entry_date, year, month } = res.rows[0];

	// If that day is already corrected, find next pending in that month
	const status = await query<{ correction_status: string }>(`
		SELECT correction_status FROM calendar_days WHERE entry_date = $1
	`, [entry_date]);

	if (status.rows[0]?.correction_status === 'pending') {
		return { entryDate: entry_date, year, month };
	}

	const next = await query<{ entry_date: string }>(`
		SELECT cd.entry_date::text AS entry_date
		  FROM calendar_days cd
		  JOIN calendar_pages cp ON cp.id = cd.page_id
		 WHERE cp.year = $1 AND cp.month = $2
		   AND cd.correction_status = 'pending'
		 ORDER BY cd.entry_date
		 LIMIT 1
	`, [year, month]);

	if (next.rows[0]) return { entryDate: next.rows[0].entry_date, year, month };
	return null;
}

export interface ClaimSummary {
	year: number;
	month: number;
	displayName: string;
	userId: number;
	lastActivity: Date;
	isFresh: boolean;
}

export async function getClaimsForAllMonths(): Promise<ClaimSummary[]> {
	const hours = await getStaleThresholdHours();
	const staleAt = new Date(Date.now() - hours * 3600_000);

	const res = await query<{
		year: string; month: string; display_name: string; user_id: string; last_activity_at: string;
	}>(`
		SELECT (cs.queue_scope->>'year')::int AS year,
		       (cs.queue_scope->>'month')::int AS month,
		       u.display_name,
		       cs.user_id,
		       cs.last_activity_at
		  FROM correction_sessions cs
		  JOIN users u ON u.id = cs.user_id
		 WHERE cs.status IN ('active', 'paused')
		 ORDER BY cs.last_activity_at DESC
	`);

	return res.rows.map(row => {
		const lastActivity = new Date(row.last_activity_at);
		return {
			year: Number(row.year),
			month: Number(row.month),
			displayName: row.display_name,
			userId: Number(row.user_id),
			lastActivity,
			isFresh: lastActivity > staleAt,
		};
	});
}
