<script lang="ts">
	/**
	 * A thin bar across the top while a page is loading (V3 Slice 2), so a
	 * slow load (Search, a long year) doesn't look like a dead tap. Ported
	 * from birds' NavProgress. Fixed at the top above the viewer's top bar
	 * (z-index 30); the menu is a modal <dialog> in the top layer, so it's
	 * never covered. pointer-events: none, so it can never eat a tap.
	 */
	import { navigating } from '$app/state';
	import { HOLD_AFTER_DONE_MS, SHOW_DELAY_MS, TICK_MS, widthAt } from '$lib/viewer/nav-progress';

	let visible = $state(false);
	let width = $state(0);
	/** Polite screen-reader note; fast navigations announce nothing. */
	let announcement = $state('');

	$effect(() => {
		if (!navigating.to) return;
		let tick: ReturnType<typeof setInterval> | undefined;
		const startedAt = Date.now();
		const showTimer = setTimeout(() => {
			visible = true;
			announcement = 'Loading';
			width = widthAt(Date.now() - startedAt);
			tick = setInterval(() => {
				width = widthAt(Date.now() - startedAt);
			}, TICK_MS);
		}, SHOW_DELAY_MS);
		return () => {
			clearTimeout(showTimer);
			clearInterval(tick);
			if (visible) {
				width = 100;
				announcement = '';
				setTimeout(() => {
					// A newer navigation may have taken over the bar meanwhile.
					if (navigating.to) return;
					visible = false;
					width = 0;
				}, HOLD_AFTER_DONE_MS);
			}
		};
	});
</script>

{#if visible}
	<div class="nav-progress" aria-hidden="true">
		<div class="fill" style:width="{width}%"></div>
	</div>
{/if}
<span class="v-sr" aria-live="polite">{announcement}</span>

<style>
	.nav-progress {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		height: 4px;
		z-index: 40;
		pointer-events: none;
	}
	.fill {
		height: 100%;
		background: var(--color-amber);
		transition: width 0.2s ease;
	}
</style>
