import { query } from '$lib/db';
import type { Handle } from '@sveltejs/kit';

// TODO td-510a34: Replace with real session lookup (argon2id + cookie sessions).
// For now, /correct routes get Madonna's user from the DB by username.
export const handle: Handle = async ({ event, resolve }) => {
	if (event.url.pathname.startsWith('/correct')) {
		const res = await query<{ id: number; username: string; role: string; display_name: string }>(
			`SELECT id, username, role, display_name FROM users WHERE username = 'madonna' LIMIT 1`
		);
		if (res.rows[0]) {
			const u = res.rows[0];
			event.locals.user = {
				id: String(u.id),
				username: u.username,
				role: u.role as 'admin' | 'corrector' | 'viewer',
				display_name: u.display_name
			};
		}
	}

	return resolve(event);
};
