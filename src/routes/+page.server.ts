import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/**
 * Viewer-role users have only one place to go, so `/` sends them straight
 * to the family viewer instead of a landing page with a single card (V3
 * Slice 1). Admin and corrector users keep the landing cards.
 */
export const load: PageServerLoad = ({ locals }) => {
	if (locals.user?.role === 'viewer') redirect(303, '/app');
	return {};
};
