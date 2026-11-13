import { error, fail } from '@sveltejs/kit';
import { withTransaction } from '$lib/db';
import { cleanAboutText, getAboutText, MAX_ABOUT_LENGTH, saveAboutText } from '$server/about';
import type { Actions, PageServerLoad } from './$types';

/**
 * /admin/about — edit the family viewer's "About this archive" text
 * (V3 Slice 1b). Stored in app_state; empty text goes back to the default.
 */

function requireAdmin(locals: App.Locals) {
	if (!locals.user || locals.user.role !== 'admin') error(403, 'Admin access required');
}

export const load: PageServerLoad = async ({ locals }) => {
	requireAdmin(locals);
	const about = await getAboutText();
	return {
		text: about.isDefault ? '' : about.text,
		defaultText: about.isDefault ? about.text : null
	};
};

export const actions: Actions = {
	save: async ({ request, locals }) => {
		requireAdmin(locals);
		const form = await request.formData();
		const text = cleanAboutText((form.get('text') ?? '').toString());
		if (text.length > MAX_ABOUT_LENGTH) {
			return fail(400, { error: `Please keep it under ${MAX_ABOUT_LENGTH} characters.`, text });
		}
		const before = await getAboutText();
		await withTransaction(async (client) => {
			await saveAboutText(client, text);
			await client.query(
				`INSERT INTO audit_log (user_id, action, entity_type, entity_id, before_value, after_value, description)
				 VALUES ($1, 'about_text_update', 'app_state', 0, $2::jsonb, $3::jsonb, $4)`,
				[
					Number(locals.user!.id),
					JSON.stringify({ text: before.isDefault ? null : before.text }),
					JSON.stringify({ text: text || null }),
					text
						? 'Updated the family "About this archive" text'
						: 'Reset "About this archive" to the default text'
				]
			);
		});
		return { saved: true };
	}
};
