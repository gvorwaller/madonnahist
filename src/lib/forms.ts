import { applyAction, enhance as kitEnhance } from '$app/forms';
import type { ActionResult, SubmitFunction } from '@sveltejs/kit';
import { isSignedOutResult, signInHref } from '$lib/viewer/session';
import { showSignedOut } from '$lib/signed-out.svelte';
import { settleFocus } from '$lib/dialog-opener';

/** What a page's own failure path shows inline, beside the bar. */
export const SIGNED_OUT_MESSAGE = "You've been signed out, so that wasn't saved.";

/**
 * SvelteKit's `enhance`, plus one rule (td-46337c): a POST answered by the
 * hook's signed-out 401 is handed to the page as what it is, a 401
 * **failure**, and raises the app-wide "You've been signed out" bar.
 *
 * Why a failure: the hook's plain 401 JSON isn't an ActionResult, so the
 * default update() silently did nothing, and callbacks written as
 * "failure → keep the input, anything else → clear it / close the editor"
 * took the wrong branch (CODEX review). As a failure, every page's
 * existing "it didn't save, keep what was typed" path applies, and
 * `form.error` carries SIGNED_OUT_MESSAGE.
 *
 * Use this everywhere instead of `$app/forms` enhance
 * (scripts/test-signed-out.ts checks). A form that handles signed-out
 * itself (its own message and sign-in link, e.g. inside a modal, where the
 * bar can't be reached) adds `data-signed-out-inline`: it gets the raw
 * result, checks it with isSignedOutResult, and no bar is raised.
 *
 * A late answer for a page the person has already left (form removed or
 * URL changed) still reaches the form's callback, so busy flags reset, but
 * raises no bar: it would point the sign-in back at the wrong page.
 *
 * When the page's update() is done, focus that a closing dialog put back on
 * its opener is put back again if Kit's update reset it (td-eb28c8).
 */
export function enhance<
	Success extends Record<string, unknown> | undefined,
	Failure extends Record<string, unknown> | undefined
>(form: HTMLFormElement, submit?: SubmitFunction<Success, Failure>): { destroy(): void } {
	return kitEnhance<Success, Failure>(form, async (input) => {
		// Before the page's own pre-submit work, which may await (e.g. the
		// correction editor flushes its autosave) while the URL changes.
		const from = location.href;
		const after = submit ? await submit(input) : undefined;
		return async (raw) => {
			const opts = {
				...raw,
				update: async (u?: { reset?: boolean; invalidateAll?: boolean }) => {
					try {
						await raw.update(u);
					} finally {
						settleFocus();
					}
				}
			};
			let o = opts;
			if (!form.hasAttribute('data-signed-out-inline') && isSignedOutResult(opts.result)) {
				if (form.isConnected && location.href === from) showSignedOut(signInHref(new URL(from)));
				const result = {
					type: 'failure',
					status: 401,
					data: { error: SIGNED_OUT_MESSAGE, signedOut: true }
				} as unknown as ActionResult<Success, Failure>;
				o = {
					...opts,
					result,
					// What Kit's default update() does with a failure: set `form`
					// (no reset) when the page is the action's own page.
					// Only for the visit that submitted it: a late answer must not
					// put its message on a fresh visit to the same page.
					update: async () => {
						const here = location.origin + location.pathname;
						const samePage = here === opts.action.origin + opts.action.pathname;
						if (samePage && form.isConnected && location.href === from) await applyAction(result);
						settleFocus();
					}
				};
			}
			if (after) await after(o);
			else await o.update();
		};
	});
}
