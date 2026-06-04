import { query } from '$lib/db';
import { json } from '@sveltejs/kit';
import type { Handle } from '@sveltejs/kit';

// TODO td-510a34: Replace with real session lookup (argon2id + cookie sessions).
// For now, /correct routes get Madonna's user and /admin routes get Gaylon's user.
// Admin routes restricted to localhost only (access via SSH tunnel or local dev).

const LOCALHOST = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

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
	} else if (event.url.pathname.startsWith('/admin')) {
		const clientIp = event.getClientAddress();
		if (!LOCALHOST.has(clientIp)) {
			console.warn(`[AUTH] Rejected /admin request from ${clientIp}`);
			return json({ error: 'Unauthorized' }, { status: 403 });
		}

		const res = await query<{ id: number; username: string; role: string; display_name: string }>(
			`SELECT id, username, role, display_name FROM users WHERE username = 'gaylon' LIMIT 1`
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
