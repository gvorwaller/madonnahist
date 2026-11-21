import { error, fail, redirect } from '@sveltejs/kit';
import { query, withTransaction } from '$lib/db';
import { backTarget } from '$lib/viewer/nav';
import { listHideableWriters, saveHiddenWriters, setWriterHidden } from '$server/memories';
import { hashPassword, verifyPassword } from '$server/auth';
import { cleanDisplayName, passwordProblem, revokeInvite } from '$server/invites';
import { allow } from '$server/rate-limit';
import { createSession, SESSION_COOKIE_NAME } from '$server/session';
import { SESSION_COOKIE_OPTS } from '../../../hooks.server';
import type { Actions, PageServerLoad } from './$types';

/**
 * "Your account" (V3 Slice 1b; password added 2026-11-15): a signed-in
 * person sees their username, can change the name the family history shows
 * for them, and can change their own password. The username (what they sign
 * in with) never changes here.
 */

/** Wrong-current-password ceiling per person (argon2 work and guessing). */
const PASSWORD_TRIES = 5;
const PASSWORD_WINDOW_MS = 15 * 60 * 1000;

function realUserId(locals: App.Locals): number {
	const id = Number(locals.user?.id);
	// id '0' is the PDF renderer's synthetic GET-only user, never a person.
	if (!locals.user || !Number.isInteger(id) || id <= 0) error(403, 'Not available');
	return id;
}

export const load: PageServerLoad = async ({ locals, request }) => {
	const userId = realUserId(locals);
	const ua = request.headers.get('user-agent') ?? '';
	const platform = /iPhone|iPad|iPod/i.test(ua) ? 'ios' : /Android/i.test(ua) ? 'android' : 'other';
	return {
		username: locals.user!.username,
		displayName: locals.user!.display_name,
		platform: platform as 'ios' | 'android' | 'other',
		// "Memories you see" (td-76a40f): empty until someone besides
		// Madonna and you has shared a memory.
		memoryWriters: await listHideableWriters(userId)
	};
};

/** Thrown inside the transaction when the password changed underneath us. */
class PasswordMoved extends Error {}

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
	},

	password: async ({ request, locals, cookies }) => {
		const userId = realUserId(locals);
		const form = await request.formData();
		const current = (form.get('currentPassword') ?? '').toString();
		const next = (form.get('newPassword') ?? '').toString();
		const confirm = (form.get('confirmPassword') ?? '').toString();

		// Checks that need no password work come first, so typos in the new
		// password never use up the person's tries.
		if (!current) return fail(400, { pwError: 'Please type your current password.' });
		const problem = passwordProblem(next, confirm);
		if (problem) return fail(400, { pwError: problem });

		if (!allow(`password-change:${userId}`, PASSWORD_TRIES, PASSWORD_WINDOW_MS)) {
			return fail(429, {
				pwError: 'Too many tries. Please wait 15 minutes, then try again.'
			});
		}

		const row = (
			await query<{ password_hash: string }>(`SELECT password_hash FROM users WHERE id = $1`, [
				userId
			])
		).rows[0];
		if (!row || !(await verifyPassword(row.password_hash, current))) {
			return fail(400, { pwError: "That isn't your current password. Please try again." });
		}
		if (next === current) {
			return fail(400, { pwError: 'Your new password is the same as your current one.' });
		}

		const newHash = await hashPassword(next);
		let sessionId: string;
		try {
			sessionId = await withTransaction(async (client) => {
				// Only replace the hash we checked: if it changed meanwhile (an
				// admin reset, another device), stop rather than overwrite it.
				const upd = await client.query(
					`UPDATE users SET password_hash = $2 WHERE id = $1 AND password_hash = $3`,
					[userId, newHash, row.password_hash]
				);
				if (upd.rowCount !== 1) throw new PasswordMoved();
				// Every other device is signed out; this one gets a fresh session.
				await client.query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
				// An open invite link would only overwrite the new password.
				await revokeInvite(client, userId);
				const sid = await createSession(userId, client);
				// Never the password or its hash: who and what only.
				await client.query(
					`INSERT INTO audit_log (user_id, action, entity_type, entity_id, before_value, after_value, description)
					 VALUES ($1, 'password_change', 'users', $1, NULL, NULL,
					         'Changed their own password; other devices signed out')`,
					[userId]
				);
				return sid;
			});
		} catch (e) {
			if (e instanceof PasswordMoved) {
				return fail(409, {
					pwError: 'Your password was just changed somewhere else. Please sign in again.'
				});
			}
			throw e;
		}

		cookies.set(SESSION_COOKIE_NAME, sessionId, SESSION_COOKIE_OPTS);
		return { pwSaved: true };
	},

	// ── Whose memories you see (td-76a40f) ──────────────────────────
	// hideWriter / showWriter come from the button under a memory and the
	// "hidden" note on Day, Month and Year pages. They always redirect back
	// to that page (validated to /app), so they work without JavaScript; the
	// page's enhance handler reloads its data in place instead.

	hideWriter: async ({ request, locals }) => {
		const userId = realUserId(locals);
		const form = await request.formData();
		const writer = form.get('writer');
		if (!(await setWriterHidden(userId, writer, true))) {
			return fail(400, { memoryError: "Those memories can't be hidden." });
		}
		const back = backTarget(form.get('returnTo')?.toString(), '/app/account');
		redirect(303, `${back}#hidden-w-${Number(writer)}`);
	},

	showWriter: async ({ request, locals }) => {
		const userId = realUserId(locals);
		const form = await request.formData();
		if (!(await setWriterHidden(userId, form.get('writer'), false))) {
			return fail(400, { memoryError: "Those memories can't be changed." });
		}
		redirect(303, backTarget(form.get('returnTo')?.toString(), '/app/account'));
	},

	memoryWriters: async ({ request, locals }) => {
		const userId = realUserId(locals);
		const form = await request.formData();
		const ok = await saveHiddenWriters(userId, form.getAll('writer'), form.getAll('show'), form.getAll('wasShown'));
		if (!ok) return fail(400, { memoryError: "Couldn't save that. Reload the page and try again." });
		return { memoriesSaved: true };
	}
};
