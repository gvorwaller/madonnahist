import { error, fail } from '@sveltejs/kit';
import { withTransaction } from '$lib/db';
import { cleanDisplayName } from '$server/invites';
import type { Actions, PageServerLoad } from './$types';

/**
 * "Your name" (V3 Slice 1b): a family member sees their username and can
 * change the name the family history shows for them. The username (what
 * they sign in with) never changes here.
 */

function realUserId(locals: App.Locals): number {
	const id = Number(locals.user?.id);
	// id '0' is the PDF renderer's synthetic GET-only user, never a person.
	if (!locals.user || !Number.isInteger(id) || id <= 0) error(403, 'Not available');
	return id;
}

export const load: PageServerLoad = async ({ locals, request }) => {
	realUserId(locals);
	const ua = request.headers.get('user-agent') ?? '';
	const platform = /iPhone|iPad|iPod/i.test(ua) ? 'ios' : /Android/i.test(ua) ? 'android' : 'other';
	return {
		username: locals.user!.username,
		displayName: locals.user!.display_name,
		platform: platform as 'ios' | 'android' | 'other'
	};
};

export const actions: Actions = {
	rename: async ({ request, locals }) => {
		const userId = realUserId(locals);
		const form = await request.formData();
		const raw = (form.get('displayName') ?? '').toString();
		const name = cleanDisplayName(raw);
		if ('error' in name) return fail(400, { error: name.error, displayName: raw });

		await withTransaction(async (client) => {
			const before = await client.query<{ display_name: string }>(
				`SELECT display_name FROM users WHERE id = $1 FOR UPDATE`,
				[userId]
			);
			if (before.rows[0]?.display_name === name.name) return;
			await client.query(`UPDATE users SET display_name = $2 WHERE id = $1`, [userId, name.name]);
			await client.query(
				`INSERT INTO audit_log (user_id, action, entity_type, entity_id, before_value, after_value, description)
				 VALUES ($1, 'display_name_change', 'users', $1, $2::jsonb, $3::jsonb, 'Changed their display name')`,
				[
					userId,
					JSON.stringify({ display_name: before.rows[0]?.display_name ?? null }),
					JSON.stringify({ display_name: name.name })
				]
			);
		});
		return { saved: true, displayName: name.name };
	}
};
