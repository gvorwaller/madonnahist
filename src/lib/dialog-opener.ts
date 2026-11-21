/**
 * Keyboard focus for modal dialogs (td-eb28c8): where it goes back to when
 * a dialog closes, and keeping Tab inside one while it's open.
 *
 * Safari doesn't focus a <button> when it's clicked (see CLAUDE.md), so by
 * the time a dialog opens document.activeElement is usually <body>, and the
 * browser's own "return focus on close" has nothing to return to. So the
 * last control clicked is remembered here (capture phase, so it's seen
 * before any handler opens a dialog), and used if it was just now.
 */
const CONTROL = 'button, a[href], input, select, textarea, summary, [tabindex]';
const FRESH_MS = 1500;

let lastClicked: { el: HTMLElement; at: number } | null = null;

/**
 * Focus put back after a dialog closed, which a form's update may still
 * undo: after a successful action Kit resets focus to <body> once the page
 * has re-rendered, i.e. after the dialog is gone (CODEX td-eb28c8 #2).
 * src/lib/forms.ts calls settleFocus() when that update is done. Any key
 * or tap by the person since means they've moved on: nothing is redone.
 */
let pending: { find: () => HTMLElement | null; href: string; at: number } | null = null;
const SETTLE_MS = 30_000;

if (typeof document !== 'undefined') {
	document.addEventListener(
		'click',
		(e) => {
			const t = e.target instanceof Element ? e.target.closest<HTMLElement>(CONTROL) : null;
			if (t) lastClicked = { el: t, at: Date.now() };
		},
		true
	);
	const movedOn = () => (pending = null);
	document.addEventListener('pointerdown', movedOn, true);
	document.addEventListener('keydown', movedOn, true);
}

/** The control that is opening a dialog right now, if there is one. */
export function currentOpener(): HTMLElement | null {
	if (lastClicked && Date.now() - lastClicked.at < FRESH_MS && lastClicked.el.isConnected) {
		return lastClicked.el;
	}
	const active = document.activeElement;
	if (active instanceof HTMLElement && active !== document.body) return active;
	return null;
}

/** A modal is open: Escape belongs to it, not to the page behind. */
export function modalOpen(): boolean {
	return document.querySelector('dialog[open]') !== null;
}

/**
 * Put focus back on the opener, unless it's gone (e.g. its row was deleted).
 * Given a lookup, it's asked again when settling, so a control the update
 * re-rendered (e.g. "Invite link" becoming "New link") is found anew
 * (CODEX td-eb28c8 round 2 #1).
 */
export function restoreFocus(opener: HTMLElement | null | (() => HTMLElement | null)): void {
	const find = typeof opener === 'function' ? opener : () => opener;
	pending = { find, href: location.href, at: Date.now() };
	const el = find();
	if (el?.isConnected) el.focus({ preventScroll: true });
}

/**
 * A form's update has finished (src/lib/forms.ts): if it reset focus to
 * <body> after a dialog put it back, put it back again. Not after a
 * navigation, not over a newer dialog, and not if the opener is gone.
 */
export function settleFocus(): void {
	const p = pending;
	pending = null;
	if (!p || Date.now() - p.at > SETTLE_MS || location.href !== p.href || modalOpen()) return;
	const active = document.activeElement;
	if (active && active !== document.body && active !== document.documentElement) return;
	const el = p.find();
	if (el?.isConnected) el.focus({ preventScroll: true });
}

const TABBABLE =
	'a[href], button, input, select, textarea, summary, iframe, [contenteditable="true"], [contenteditable=""], [tabindex]';

function tabStops(root: HTMLElement): HTMLElement[] {
	return [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter(
		(el) =>
			el.tabIndex >= 0 &&
			!(el as HTMLButtonElement).disabled &&
			!(el instanceof HTMLInputElement && el.type === 'hidden') &&
			el.getClientRects().length > 0 &&
			getComputedStyle(el).visibility !== 'hidden' &&
			!el.closest('[inert]')
	);
}

/**
 * Tab and Shift+Tab move between the dialog's own controls and wrap around
 * (CODEX td-eb28c8 #1). A modal <dialog> only makes the page inert; Tab
 * past its last control still leaves it, to the browser's toolbar. Moving
 * focus here also means Safari's default (Tab skips buttons) can't strand
 * a keyboard user on the one text field of a confirm dialog.
 * Use as the dialog's onkeydown.
 */
export function trapTab(e: KeyboardEvent): void {
	if (e.key !== 'Tab' || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
	const dialog = e.currentTarget as HTMLElement;
	const stops = tabStops(dialog);
	e.preventDefault();
	if (stops.length === 0) {
		dialog.focus();
		return;
	}
	const i = stops.indexOf(document.activeElement as HTMLElement);
	const last = stops.length - 1;
	const next = e.shiftKey ? (i <= 0 ? last : i - 1) : i === -1 || i === last ? 0 : i + 1;
	stops[next].focus();
}
