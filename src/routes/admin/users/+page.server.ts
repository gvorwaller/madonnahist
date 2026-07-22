import { query, withTransaction } from '$lib/db';
import { error, fail, redirect } from '@sveltejs/kit';
import { hashPassword } from '$server/auth';
import { SESSION_COOKIE_NAME } from '$server/session';
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
	return { users: usersRes.rows };
};

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
