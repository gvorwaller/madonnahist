/**
 * The app-wide "You've been signed out" bar (td-46337c).
 *
 * Raised by the enhance wrapper in src/lib/forms.ts when a form's POST comes
 * back as the hook's plain 401 (src/lib/viewer/session.ts isSignedOutResult).
 * Shown by src/lib/components/SignedOutBar.svelte in the root layout.
 */
export const signedOut = $state({ shown: false, signInHref: '/login' });

/** `signInHref` comes back to the page the refused save was made on. */
export function showSignedOut(signInHref: string): void {
	signedOut.signInHref = signInHref;
	signedOut.shown = true;
}

export function hideSignedOut(): void {
	signedOut.shown = false;
}
