/**
 * Invite-link onboarding (V3 Slice 1b, td-681a6d; migration 0028).
 * Plan: docs/2026-11-05-family-viewer-v3-redesign-plan.md §Invite-link onboarding.
 *
 * The link /invite/<token> is a bearer credential:
 * - the token is 32 random bytes (base64url, 43 chars); only its SHA-256
 *   hash is stored, and neither ever reaches the audit log or app logs;
 * - it works once, for 30 days, and only for a viewer account that has
 *   never signed in (onboarding only; established accounts use the admin
 *   password reset);
 * - GET never consumes it. Redeeming is one transaction that locks the
 *   user, consumes the link conditionally, sets the password and name,
 *   ends any old sessions, starts the new one, and writes the audit row.
 *
 * Issue, revoke and redeem all lock the users row first, so a re-issue and
 * a redeem of the same account can't interleave.
 */
import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';
import { query, withTransaction } from '$lib/db';
import { createSession } from './session';

export const INVITE_TTL_DAYS = 30;
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 200;
export const MAX_DISPLAY_NAME_LENGTH = 60;

/** Exactly the shape newInviteToken() makes; hooks.server.ts uses the same rule. */
export const INVITE_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function hashInviteToken(token: string): string {
	return createHash('sha256').update(token, 'utf8').digest('hex');
}

function newInviteToken(): { token: string; hash: string } {
	const token = randomBytes(32).toString('base64url');
	return { token, hash: hashInviteToken(token) };
}

/** Trimmed, single-spaced display name, or an error message for the form. */
export function cleanDisplayName(raw: string): { name: string } | { error: string } {
	// eslint-disable-next-line no-control-regex
	const name = raw
		.replace(/[\u0000-\u001f\u007f]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	if (!name) return { error: 'Please enter your name.' };
	if (name.length > MAX_DISPLAY_NAME_LENGTH)
		return { error: `Please keep your name under ${MAX_DISPLAY_NAME_LENGTH} characters.` };
	return { name };
}

export function passwordProblem(password: string, confirm: string): string | null {
	if (password.length < MIN_PASSWORD_LENGTH)
		return `Your password needs at least ${MIN_PASSWORD_LENGTH} characters.`;
	if (password.length > MAX_PASSWORD_LENGTH) return 'That password is too long.';
	if (password !== confirm) return "The two passwords don't match. Please type them again.";
	return null;
}

export type InviteProblem = 'invalid' | 'expired' | 'used' | 'revoked';

export type InviteLookup =
	| {
			status: 'valid';
			inviteId: number;
			userId: number;
			username: string;
			displayName: string;
			expiresAt: string;
	  }
	| { status: InviteProblem };

interface InviteRow {
	id: number;
	user_id: number;
	expires_at: string;
	used_at: string | null;
	revoked_at: string | null;
	expired: boolean;
	username: string;
	display_name: string;
	role: string;
	last_login_at: string | null;
}

const INVITE_SELECT = `
	SELECT i.id::int AS id, i.user_id, i.expires_at::text, i.used_at::text, i.revoked_at::text,
	       i.expires_at <= NOW() AS expired,
	       u.username, u.display_name, u.role, u.last_login_at::text
	  FROM user_invites i
	  JOIN users u ON u.id = i.user_id`;

function classify(row: InviteRow | undefined): InviteLookup {
	if (!row) return { status: 'invalid' };
	if (row.used_at) return { status: 'used' };
	if (row.revoked_at) return { status: 'revoked' };
	if (row.expired) return { status: 'expired' };
	if (row.role !== 'viewer') return { status: 'invalid' };
	// Signed in some other way (e.g. an admin password reset): the account
	// is established, so the onboarding link no longer applies.
	if (row.last_login_at) return { status: 'used' };
	return {
		status: 'valid',
		inviteId: row.id,
		userId: row.user_id,
		username: row.username,
		displayName: row.display_name,
		expiresAt: row.expires_at
	};
}

/** Read-only check of a link. Never consumes it. */
export async function lookupInvite(token: string): Promise<InviteLookup> {
	if (!INVITE_TOKEN_RE.test(token)) return { status: 'invalid' };
	const res = await query<InviteRow>(`${INVITE_SELECT} WHERE i.token_hash = $1`, [
		hashInviteToken(token)
	]);
	return classify(res.rows[0]);
}

/**
 * Revoke any outstanding link for this user and issue a fresh one. The
 * caller has already locked the users row (SELECT ... FOR UPDATE) inside
 * `client`'s transaction and checked it is a never-signed-in viewer.
 * The raw token is returned once, for the admin to copy; it is not stored.
 */
export async function issueInvite(
	client: pg.PoolClient,
	userId: number,
	createdBy: number
): Promise<{ token: string; expiresAt: string; revokedPrevious: boolean }> {
	const revoked = await client.query(
		`UPDATE user_invites SET revoked_at = NOW()
		  WHERE user_id = $1 AND used_at IS NULL AND revoked_at IS NULL`,
		[userId]
	);
	const { token, hash } = newInviteToken();
	const res = await client.query<{ expires_at: string }>(
		`INSERT INTO user_invites (user_id, token_hash, expires_at, created_by)
		 VALUES ($1, $2, NOW() + make_interval(days => $3), $4)
		 RETURNING expires_at::text`,
		[userId, hash, INVITE_TTL_DAYS, createdBy]
	);
	return { token, expiresAt: res.rows[0].expires_at, revokedPrevious: (revoked.rowCount ?? 0) > 0 };
}

/** Revoke the outstanding link, if any. Caller holds the users row lock. */
export async function revokeInvite(client: pg.PoolClient, userId: number): Promise<boolean> {
	const res = await client.query(
		`UPDATE user_invites SET revoked_at = NOW()
		  WHERE user_id = $1 AND used_at IS NULL AND revoked_at IS NULL`,
		[userId]
	);
	return (res.rowCount ?? 0) > 0;
}

export type RedeemResult =
	| { ok: true; sessionId: string; username: string; displayName: string }
	| { ok: false; reason: InviteProblem };

/**
 * Consume a link and set up the account, atomically. `passwordHash` is
 * computed by the caller (argon2) before the transaction so no lock is held
 * during hashing. Concurrent or repeated submits: exactly one succeeds.
 */
export async function redeemInvite(
	token: string,
	passwordHash: string,
	displayName: string
): Promise<RedeemResult> {
	if (!INVITE_TOKEN_RE.test(token)) return { ok: false, reason: 'invalid' };
	const hash = hashInviteToken(token);

	return withTransaction(async (client) => {
		const found = await client.query<{ user_id: number }>(
			`SELECT user_id FROM user_invites WHERE token_hash = $1`,
			[hash]
		);
		if (!found.rows[0]) return { ok: false, reason: 'invalid' };
		const userId = found.rows[0].user_id;

		// Same lock order as issue/revoke: the user row first.
		await client.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [userId]);

		const current = classify(
			(await client.query<InviteRow>(`${INVITE_SELECT} WHERE i.token_hash = $1`, [hash])).rows[0]
		);
		if (current.status !== 'valid') return { ok: false, reason: current.status };

		const consumed = await client.query(
			`UPDATE user_invites SET used_at = NOW()
			  WHERE id = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()`,
			[current.inviteId]
		);
		if (consumed.rowCount !== 1) return { ok: false, reason: 'used' };

		await client.query(
			`UPDATE users SET password_hash = $2, display_name = $3, last_login_at = NOW()
			  WHERE id = $1 AND role = 'viewer'`,
			[userId, passwordHash, displayName]
		);
		await client.query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
		const sessionId = await createSession(userId, client);

		// IDs and outcome only: never the link, its hash, or the password.
		await client.query(
			`INSERT INTO audit_log (user_id, action, entity_type, entity_id, before_value, after_value, description)
			 VALUES ($1, 'invite_redeem', 'users', $1, $2::jsonb, $3::jsonb, $4)`,
			[
				userId,
				JSON.stringify({ display_name: current.displayName }),
				JSON.stringify({ display_name: displayName, invite_id: current.inviteId }),
				`Accepted invite and set a password ("${current.username}")`
			]
		);

		return { ok: true, sessionId, username: current.username, displayName };
	});
}

export interface InviteStatusRow {
	userId: number;
	expiresAt: string;
	expired: boolean;
}

/** Outstanding (unused, unrevoked) links by user, for /admin/users. */
export async function outstandingInvites(): Promise<Map<number, InviteStatusRow>> {
	const res = await query<{ user_id: number; expires_at: string; expired: boolean }>(
		`SELECT user_id, expires_at::text, expires_at <= NOW() AS expired
		   FROM user_invites
		  WHERE used_at IS NULL AND revoked_at IS NULL`
	);
	return new Map(
		res.rows.map((r) => [
			r.user_id,
			{ userId: r.user_id, expiresAt: r.expires_at, expired: r.expired }
		])
	);
}
