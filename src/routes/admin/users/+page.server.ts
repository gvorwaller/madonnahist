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
}

export const load: PageServerLoad = async ({ locals }) => {
	requireAdmin(locals);
	const usersRes = await query<UserRow>(
		`SELECT id, username, display_name, role, created_at::text, last_login_at::text
		   FROM users ORDER BY role, username`
	);
	const invites = await outstandingInvites();
	return {
		users: usersRes.rows.map((u) => {
			const inv = invites.get(u.id);
			return {
				...u,
				// Invites are onboarding only: a viewer who has never signed in.
				canInvite: u.role === 'viewer' && u.last_login_at === null,
				invite: inv ? { expiresAt: inv.expiresAt, expired: inv.expired } : null
			};
		})
	};
};

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
	const res = await client.query<{ username: string; role: string; last_login_at: string | null }>(
		`SELECT username, role, last_login_at::text FROM users WHERE id = $1 FOR UPDATE`,
		[userId]
	);
	const u = res.rows[0];
	if (!u) return { error: 'User not found', status: 404 };
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

		const before = await query<{ username: string; role: string }>(
			`SELECT username, role FROM users WHERE id = $1`, [targetId]
		);
		if (!before.rows[0]) return fail(404, { error: 'User not found' });

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
	}
};
