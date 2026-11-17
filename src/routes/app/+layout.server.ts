import { getWriterForUser, viewerIdOf } from '$server/memories';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals }) => {
	const u = locals.user;
	const viewerId = viewerIdOf(locals);
	return {
		user: u ?? null,
		// Menu shows "Your other tools" links only for roles that can open them
		// (mirrors roleAllowed() in src/hooks.server.ts); the family never sees them.
		canCorrect: u?.role === 'admin' || u?.role === 'corrector',
		canAdmin: u?.role === 'admin',
		// "My memories" menu link. Navigation only; every /app/memories route
		// checks again (src/lib/server/memories.ts requireWriter).
		canWriteMemories: viewerId > 0 && !!(await getWriterForUser(viewerId))
	};
};
