import { query, withTransaction } from '$lib/db';
import { error, fail, redirect } from '@sveltejs/kit';
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { hashPassword } from '$server/auth';
import { SESSION_COOKIE_NAME } from '$server/session';
import { cleanDisplayName, issueInvite, outstandingInvites, revokeInvite } from '$server/invites';
import type { PageServerLoad, Actions } from './$types';

const ROLES = ['admin', 'corrector', 'viewer'] as const;
type Role = (typeof ROLES)[number];

const MIN_PASSWORD_LENGTH = 8;

function requireAdmin(locals: App.Locals) {
	if (!locals.user || locals.user.role !== 'admin') {
		error(403, 'Admin access required');
	}
}

// Same normalization as the login action (src/routes/login/+page.server.ts):
// trim, lowercase.
function normalizeUsername(raw: string): string {
	return raw.trim().toLowerCase();
}

interface UserRow {
	id: number;
	username: string;
	display_name: string;
	role: Role;
	created_at: string;
	last_login_at: string | null;
	removed_at: string | null;
}

export const load: PageServerLoad = async ({ locals }) => {
	requireAdmin(locals);
	const usersRes = await query<UserRow>(
		`SELECT id, username, display_name, role, created_at::text, last_login_at::text,
		        removed_at::text
		   FROM users ORDER BY role, username`
	);
	const invites = await outstandingInvites();
	const selfId = Number(locals.user!.id);
	const activeAdmins = usersRes.rows.filter((u) => u.role === 'admin' && !u.removed_at).length;
	const rows = usersRes.rows.map((u) => {
		const inv = invites.get(u.id);
		return {
			...u,
			isSelf: u.id === selfId,
			// Invites are onboarding only: a viewer who has never signed in.
			canInvite: !u.removed_at && u.role === 'viewer' && u.last_login_at === null,
			invite: inv && !u.removed_at ? { expiresAt: inv.expiresAt, expired: inv.expired } : null,
			// Mirrors the server guards in removeAccess (never yourself, never
			// the last admin who can still sign in).
			canRemove: u.id !== selfId && !(u.role === 'admin' && activeAdmins <= 1)
		};
	});
	return {
		users: rows.filter((u) => !u.removed_at),
		removed: rows.filter((u) => u.removed_at)
	};
};

const ACTIVE_ADMIN_SQL = `SELECT id FROM users WHERE role = 'admin' AND removed_at IS NULL ORDER BY id FOR UPDATE`;

// What a refused permanent delete was blocked by, in plain words. The
// database decides (FK NO ACTION from each content table); this only names it.
const CONTENT_WORDS: Record<string, string> = {
	day_corrections: 'corrections',
	calendar_days: 'corrected days',
	correction_sessions: 'correction sessions',
	crop_templates: 'crop templates',
	notation_key: 'shorthand entries',
	tag_vocabulary: 'tag decisions',
	adhoc_narratives: 'saved stories',
	pdf_exports: 'PDFs',
	place_locations: 'place map decisions',
	memories: 'memories',
	memory_revisions: 'memories',
	narrative_drafts: 'year story drafts',
	narrative_guidance: 'year story notes'
};

function isFkViolation(err: unknown): err is { code: string; table?: string } {
	return !!err && typeof err === 'object' && 'code' in err && err.code === '23503';
}

// Usernames are what people type to sign in: keep them simple.
const USERNAME_RE = /^[a-z0-9_][a-z0-9._-]{1,31}$/;

/**
 * Lock a user row and confirm an invite may be issued for it. Returns the
 * username, or an error message.
 */
async function lockInvitable(
	client: pg.PoolClient,
	userId: number
): Promise<{ username: string } | { error: string; status: number }> {
	const res = await client.query<{
		username: string;
		role: string;
		last_login_at: string | null;
		removed: boolean;
	}>(
		`SELECT username, role, last_login_at::text, removed_at IS NOT NULL AS removed
		   FROM users WHERE id = $1 FOR UPDATE`,
		[userId]
	);
	const u = res.rows[0];
	if (!u) return { error: 'User not found', status: 404 };
	if (u.removed) return { error: `"${u.username}" has no access. Restore it first.`, status: 409 };
	if (u.role !== 'viewer') return { error: 'Invite links are only for family (viewer) accounts', status: 400 };
	if (u.last_login_at)
		return {
			error: `"${u.username}" has already signed in. Use Reset password instead.`,
			status: 409
		};
	return { username: u.username };
}

function inviteUrl(origin: string, token: string): string {
	return `${origin}/invite/${token}`;
}

export const actions: Actions = {
	create: async ({ request, locals }) => {
		requireAdmin(locals);
		const data = await request.formData();
		const username = normalizeUsername((data.get('username') as string) ?? '');
		const displayName = ((data.get('displayName') as string) ?? '').trim();
		const role = data.get('role') as string;
		const password = (data.get('password') as string) ?? '';

		if (!username) return fail(400, { error: 'Username is required' });
		if (!displayName) return fail(400, { error: 'Display name is required' });
		if (!ROLES.includes(role as Role)) return fail(400, { error: 'Invalid role' });
		if (password.length < MIN_PASSWORD_LENGTH) {
			return fail(400, { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
		}

		const existing = await query<{ id: number }>(`SELECT id FROM users WHERE username = $1`, [username]);
		if (existing.rows[0]) {
			return fail(409, { error: `Username "${username}" is already taken` });
		}

		const passwordHash = await hashPassword(password);

		try {
			await withTransaction(async (client) => {
				const res = await client.query<{ id: number }>(
					`INSERT INTO users (username, display_name, role, password_hash)
					 VALUES ($1, $2, $3, $4) RETURNING id`,
					[username, displayName, role, passwordHash]
				);
				// Never log plaintext password or hash — audit records who/what/role only.
				await client.query(
					`INSERT INTO audit_log (user_id, action, entity_type, entity_id, before_value, after_value, description)
					 VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)`,
					[Number(locals.user!.id), 'user_create', 'users', res.rows[0].id,
					 null, JSON.stringify({ username, display_name: displayName, role }),
					 `Created user "${username}" (${role})`]
				);
			});
		} catch (err) {
			// Unique-violation race: two concurrent creates for the same username.
			if (err && typeof err === 'object' && 'code' in err && err.code === '23505') {
				return fail(409, { error: `Username "${username}" is already taken` });
			}
			throw err;
		}
	},

	// V3 Slice 1b: create a viewer account with an unknown password and
	// return a one-time invite link (shown once; only its hash is stored).
	invite: async ({ request, locals, url }) => {
		requireAdmin(locals);
		const data = await request.formData();
		const username = normalizeUsername((data.get('username') as string) ?? '');
		const name = cleanDisplayName((data.get('displayName') as string) ?? '');

		if (!USERNAME_RE.test(username)) {
			return fail(400, {
				error: 'Username: 2–32 lowercase letters, numbers, dots, dashes or underscores'
			});
		}
		if ('error' in name) return fail(400, { error: 'Display name is required (60 characters max)' });

		// Nobody ever learns this password: the family member sets their own.
		const unusableHash = await hashPassword(randomBytes(32).toString('base64url'));

		try {
			const issued = await withTransaction(async (client) => {
				const res = await client.query<{ id: number }>(
					`INSERT INTO users (username, display_name, role, password_hash)
					 VALUES ($1, $2, 'viewer', $3) RETURNING id`,
					[username, name.name, unusableHash]
				);
				const userId = res.rows[0].id;
				const invite = await issueInvite(client, userId, Number(locals.user!.id));
				await client.query(
					`INSERT INTO audit_log (user_id, action, entity_type, entity_id, before_value, after_value, description)
					 VALUES ($1, 'user_invite', 'users', $2, NULL, $3::jsonb, $4)`,
					[
						Number(locals.user!.id),
						userId,
						JSON.stringify({ username, display_name: name.name, role: 'viewer' }),
						`Created viewer "${username}" and issued an invite link`
					]
				);
				return invite;
			});
			return {
				inviteLink: {
					url: inviteUrl(url.origin, issued.token),
					expiresAt: issued.expiresAt,
					username,
					displayName: name.name
				}
			};
		} catch (err) {
			if (err && typeof err === 'object' && 'code' in err && err.code === '23505') {
				return fail(409, { error: `Username "${username}" is already taken` });
			}
			throw err;
		}
	},

	// New link for an existing never-signed-in viewer; cancels any older one.
	reissueInvite: async ({ request, locals, url }) => {
		requireAdmin(locals);
		const data = await request.formData();
		const targetId = Number(data.get('userId'));
		if (!Number.isInteger(targetId)) return fail(400, { error: 'Invalid user ID' });

		const result = await withTransaction(async (client) => {
			const locked = await lockInvitable(client, targetId);
			if ('error' in locked) return locked;
			const invite = await issueInvite(client, targetId, Number(locals.user!.id));
			await client.query(
				`INSERT INTO audit_log (user_id, action, entity_type, entity_id, before_value, after_value, description)
				 VALUES ($1, 'invite_reissue', 'users', $2, NULL, NULL, $3)`,
				[
					Number(locals.user!.id),
					targetId,
					`Issued a new invite link for "${locked.username}"${invite.revokedPrevious ? '; the earlier link was cancelled' : ''}`
				]
			);
			return { ...invite, username: locked.username };
		});
		if ('error' in result) return fail(result.status, { error: result.error });

		const nameRes = await query<{ display_name: string }>(
			`SELECT display_name FROM users WHERE id = $1`,
			[targetId]
		);
		return {
			inviteLink: {
				url: inviteUrl(url.origin, result.token),
				expiresAt: result.expiresAt,
				username: result.username,
				displayName: nameRes.rows[0]?.display_name ?? result.username
			}
		};
	},

	revokeInvite: async ({ request, locals }) => {
		requireAdmin(locals);
		const data = await request.formData();
		const targetId = Number(data.get('userId'));
		if (!Number.isInteger(targetId)) return fail(400, { error: 'Invalid user ID' });

		type Outcome = { ok: true } | { error: string; status: number };
		const result = await withTransaction(async (client): Promise<Outcome> => {
			const u = await client.query<{ username: string }>(
				`SELECT username FROM users WHERE id = $1 FOR UPDATE`,
				[targetId]
			);
			if (!u.rows[0]) return { error: 'User not found', status: 404 };
			const revoked = await revokeInvite(client, targetId);
			if (!revoked) return { error: 'There is no open invite link to cancel', status: 409 };
			await client.query(
				`INSERT INTO audit_log (user_id, action, entity_type, entity_id, before_value, after_value, description)
				 VALUES ($1, 'invite_revoke', 'users', $2, NULL, NULL, $3)`,
				[Number(locals.user!.id), targetId, `Cancelled the invite link for "${u.rows[0].username}"`]
			);
			return { ok: true };
		});
		if ('error' in result) return fail(result.status, { error: result.error });
		return { revoked: true };
	},

	resetPassword: async ({ request, locals, cookies }) => {
		requireAdmin(locals);
		const data = await request.formData();
		const targetId = Number(data.get('userId'));
		const newPassword = (data.get('newPassword') as string) ?? '';

		if (!Number.isFinite(targetId)) return fail(400, { error: 'Invalid user ID' });
		if (newPassword.length < MIN_PASSWORD_LENGTH) {
			return fail(400, { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
		}

		const before = await query<{ username: string; role: string; removed: boolean }>(
			`SELECT username, role, removed_at IS NOT NULL AS removed FROM users WHERE id = $1`, [targetId]
		);
		if (!before.rows[0]) return fail(404, { error: 'User not found' });
		if (before.rows[0].removed) {
			return fail(409, { error: `"${before.rows[0].username}" has no access. Restore it first.` });
		}

		const newHash = await hashPassword(newPassword);

		await withTransaction(async (client) => {
			await client.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [newHash, targetId]);
			// A compromised session must not survive a password reset.
			await client.query(`DELETE FROM sessions WHERE user_id = $1`, [targetId]);
			// The admin chose a password, so an open invite link would only
			// overwrite it: cancel it (V3 Slice 1b).
			await revokeInvite(client, targetId);
			await client.query(
				`INSERT INTO audit_log (user_id, action, entity_type, entity_id, before_value, after_value, description)
				 VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)`,
				[Number(locals.user!.id), 'user_password_reset', 'users', targetId,
				 null, null,
				 `Reset password for "${before.rows[0].username}" (${before.rows[0].role}); all sessions invalidated`]
			);
		});

		// If the admin reset their own password, their own session row was just
		// deleted above — the cookie they're holding is now dead. Clear it and
		// send them to log back in rather than leaving a broken state.
		if (Number(locals.user!.id) === targetId) {
			cookies.delete(SESSION_COOKIE_NAME, { path: '/' });
			redirect(303, '/login');
		}
	},

	// Remove access: the account stays (everything they added keeps their
	// name) but can't sign in. Reversible with restoreAccess.
	removeAccess: async ({ request, locals }) => {
		requireAdmin(locals);
		const adminId = Number(locals.user!.id);
		const targetId = Number((await request.formData()).get('userId'));
		if (!Number.isInteger(targetId)) return fail(400, { error: 'Invalid user ID' });
		if (targetId === adminId) return fail(400, { error: "You can't remove your own access." });

		type Outcome = { ok: true } | { error: string; status: number };
		const result = await withTransaction(async (client): Promise<Outcome> => {
			// Lock every active admin first (same order for every caller), so
			// two admins removing each other can't leave none.
			const admins = (await client.query<{ id: number }>(ACTIVE_ADMIN_SQL)).rows;
			const u = (
				await client.query<{ username: string; display_name: string; role: string; removed: boolean }>(
					`SELECT username, display_name, role, removed_at IS NOT NULL AS removed
					   FROM users WHERE id = $1 FOR UPDATE`,
					[targetId]
				)
			).rows[0];
			if (!u) return { error: 'User not found', status: 404 };
			if (u.removed) return { error: `"${u.username}" already has no access.`, status: 409 };
			if (u.role === 'admin' && admins.length <= 1) {
				return { error: "That's the last admin who can sign in.", status: 409 };
			}
			await client.query(`UPDATE users SET removed_at = NOW(), removed_by = $2 WHERE id = $1`, [
				targetId,
				adminId
			]);
			await client.query(`DELETE FROM sessions WHERE user_id = $1`, [targetId]);
			await revokeInvite(client, targetId);
			await client.query(
				`INSERT INTO audit_log (user_id, action, entity_type, entity_id, before_value, after_value, description)
				 VALUES ($1, 'user_remove', 'users', $2, $3::jsonb, NULL, $4)`,
				[
					adminId,
					targetId,
					JSON.stringify({ username: u.username, display_name: u.display_name, role: u.role }),
					`Removed access for "${u.username}" (${u.role}); signed out everywhere`
				]
			);
			return { ok: true };
		});
		if ('error' in result) return fail(result.status, { error: result.error });
		return { removed: true };
	},

	restoreAccess: async ({ request, locals }) => {
		requireAdmin(locals);
		const adminId = Number(locals.user!.id);
		const targetId = Number((await request.formData()).get('userId'));
		if (!Number.isInteger(targetId)) return fail(400, { error: 'Invalid user ID' });

		type Outcome = { ok: true } | { error: string; status: number };
		const result = await withTransaction(async (client): Promise<Outcome> => {
			const u = (
				await client.query<{ username: string; role: string; removed: boolean }>(
					`SELECT username, role, removed_at IS NOT NULL AS removed FROM users WHERE id = $1 FOR UPDATE`,
					[targetId]
				)
			).rows[0];
			if (!u) return { error: 'User not found', status: 404 };
			if (!u.removed) return { error: `"${u.username}" already has access.`, status: 409 };
			await client.query(`UPDATE users SET removed_at = NULL, removed_by = NULL WHERE id = $1`, [
				targetId
			]);
			await client.query(
				`INSERT INTO audit_log (user_id, action, entity_type, entity_id, before_value, after_value, description)
				 VALUES ($1, 'user_restore', 'users', $2, NULL, NULL, $3)`,
				[adminId, targetId, `Restored access for "${u.username}" (${u.role})`]
			);
			return { ok: true };
		});
		if ('error' in result) return fail(result.status, { error: result.error });
		return { restored: true };
	},

	// Delete permanently: only an account whose access was removed first,
	// and only if it never added anything. The database decides the second
	// part: content tables keep a plain FK to users, so deleting an author
	// fails (23503) and nothing changes.
	deleteAccount: async ({ request, locals }) => {
		requireAdmin(locals);
		const adminId = Number(locals.user!.id);
		const targetId = Number((await request.formData()).get('userId'));
		if (!Number.isInteger(targetId)) return fail(400, { error: 'Invalid user ID' });
		if (targetId === adminId) return fail(400, { error: "You can't delete your own account." });

		const u = (
			await query<{ username: string; display_name: string; role: string; removed: boolean }>(
				`SELECT username, display_name, role, removed_at IS NOT NULL AS removed FROM users WHERE id = $1`,
				[targetId]
			)
		).rows[0];
		if (!u) return fail(404, { error: 'User not found' });
		if (!u.removed) return fail(409, { error: `Remove access for "${u.username}" first.` });

		try {
			const outcome = await withTransaction(async (client) => {
				const locked = await client.query(
					`SELECT 1 FROM users WHERE id = $1 AND removed_at IS NOT NULL FOR UPDATE`,
					[targetId]
				);
				if (locked.rowCount !== 1) return 'changed' as const;
				// The record of who it was outlives the account.
				await client.query(
					`INSERT INTO audit_log (user_id, action, entity_type, entity_id, before_value, after_value, description)
					 VALUES ($1, 'user_delete', 'users', $2, $3::jsonb, NULL, $4)`,
					[
						adminId,
						targetId,
						JSON.stringify({ username: u.username, display_name: u.display_name, role: u.role }),
						`Permanently deleted "${u.username}" (${u.display_name}, ${u.role})`
					]
				);
				await client.query(`DELETE FROM users WHERE id = $1`, [targetId]);
				return 'deleted' as const;
			});
			if (outcome === 'changed') {
				return fail(409, { error: `"${u.username}" changed meanwhile. Please try again.` });
			}
		} catch (err) {
			if (isFkViolation(err)) {
				// The writer link is checked before memories, so name the
				// memories when there are any; otherwise say what the link is.
				let table = err.table;
				if (table === 'writers') {
					const wrote = await query(`SELECT 1 FROM memories WHERE created_by = $1 LIMIT 1`, [
						targetId
					]);
					if (wrote.rowCount === 0) {
						return fail(409, {
							error: `"${u.username}" is set up to write memories, so it can only have access removed.`
						});
					}
					table = 'memories';
				}
				const what = (table && CONTENT_WORDS[table]) || 'records';
				return fail(409, {
					error: `"${u.username}" has added to the history (${what}), so it can only have access removed.`
				});
			}
			throw err;
		}
		return { deleted: u.username };
	}
};
