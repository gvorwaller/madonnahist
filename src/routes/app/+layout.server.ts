import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ locals }) => {
	const u = locals.user;
	return {
		user: u ?? null,
		// Menu shows "Your other tools" links only for roles that can open them
		// (mirrors roleAllowed() in src/hooks.server.ts); the family never sees them.
		canCorrect: u?.role === 'admin' || u?.role === 'corrector',
		canAdmin: u?.role === 'admin'
	};
};
