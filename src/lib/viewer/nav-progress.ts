/**
 * Timing for the family viewer's navigation progress bar (V3 Slice 2),
 * ported from birds (src/lib/nav-progress-core.ts). The width is driven by
 * JS, not a CSS animation, so the reduced-motion rule in viewer.css (which
 * turns animations off) can't freeze it part-way.
 */

/** Don't flash on fast navigations. */
export const SHOW_DELAY_MS = 150;
/** Let the bar visibly reach 100% before it leaves. */
export const HOLD_AFTER_DONE_MS = 200;
/** How often the trickle recomputes. */
export const TICK_MS = 100;

/**
 * Fast start, easing toward 90%; never reaches 100% on its own, so a
 * stalled load never looks finished. Completion snaps to 100 in the component.
 */
export function widthAt(elapsedMs: number): number {
	if (elapsedMs <= 0) return 0;
	return Math.min(89, 90 * (1 - Math.exp(-elapsedMs / 1500)));
}
