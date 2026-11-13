import { fail } from '@sveltejs/kit';
import { hashPassword } from '$server/auth';
import { SESSION_COOKIE_NAME } from '$server/session';
import {
	cleanDisplayName,
	hashInviteToken,
	INVITE_TOKEN_RE,
	lookupInvite,
	passwordProblem,
	redeemInvite,
	type InviteProblem
} from '$server/invites';
import { allow } from '$server/rate-limit';
import { SESSION_COOKIE_OPTS } from '../../../hooks.server';
import type { Actions, PageServerLoad } from './$types';

/**
 * Public invite page (V3 Slice 1b). hooks.server.ts lets exactly
 * /invite/<43-char token> through without a session and adds no-store and
 * no-referrer headers. GET only reads the link; POST ?/redeem uses it.
 *
 * Work ceilings (in-memory, see rate-limit.ts): link checks are bounded
 * globally, and argon2 hashing only runs for a link that checks out, with a
 * per-link and a global cap on attempts.
 */

const WINDOW_MS = 10 * 60 * 1000;
const LOOKUPS_PER_WINDOW = 300;
const REDEEMS_PER_LINK = 10;
const REDEEMS_PER_WINDOW = 100;

type Platform = 'ios' | 'android' | 'other';

function platformOf(ua: string): Platform {
	if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
	if (/Android/i.test(ua)) return 'android';
	return 'other';
}

export const load: PageServerLoad = async ({ params, locals, request }) => {
	const platform = platformOf(request.headers.get('user-agent') ?? '');
	// The PDF renderer's synthetic user (id '0') is never a real session.
	const signedInAs =
		locals.user && locals.user.id !== '0'
			? (locals.user.display_name ?? locals.user.username)
			: null;

	if (!allow('invite:lookup', LOOKUPS_PER_WINDOW, WINDOW_MS)) {
		return { state: 'busy' as const, platform, signedInAs };
	}
	const invite = await lookupInvite(params.token);
	if (invite.status !== 'valid') {
		return { state: invite.status, platform, signedInAs };
	}
	return {
		state: 'valid' as const,
		platform,
		signedInAs,
		username: invite.username,
		displayName: invite.displayName,
		expiresAt: invite.expiresAt
	};
};

export const actions: Actions = {
	redeem: async ({ params, request, cookies }) => {
		const token = params.token;
		const form = await request.formData();
		const rawName = (form.get('displayName') ?? '').toString();
		const password = (form.get('password') ?? '').toString();
		const confirm = (form.get('confirm') ?? '').toString();

		if (!INVITE_TOKEN_RE.test(token)) return fail(410, { problem: 'invalid' as InviteProblem });

		const perLink = allow(`invite:redeem:${hashInviteToken(token)}`, REDEEMS_PER_LINK, WINDOW_MS);
		const global = allow('invite:redeem', REDEEMS_PER_WINDOW, WINDOW_MS);
		if (!perLink || !global) {
			return fail(429, {
				displayName: rawName,
				error: 'Too many tries just now. Please wait ten minutes and try again.'
			});
		}

		// Cheap check before any hashing work.
		const invite = await lookupInvite(token);
		if (invite.status !== 'valid') return fail(410, { problem: invite.status });

		const name = cleanDisplayName(rawName);
		if ('error' in name) return fail(400, { displayName: rawName, error: name.error });
		const problem = passwordProblem(password, confirm);
		if (problem) return fail(400, { displayName: name.name, error: problem });

		const passwordHash = await hashPassword(password);
		const result = await redeemInvite(token, passwordHash, name.name);
		if (!result.ok) return fail(410, { problem: result.reason });

		cookies.set(SESSION_COOKIE_NAME, result.sessionId, SESSION_COOKIE_OPTS);
		return { success: true, username: result.username, displayName: result.displayName };
	}
};
