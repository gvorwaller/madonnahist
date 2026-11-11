<script lang="ts">
	/**
	 * Full-screen view of one day's handwriting (V3 Slice 1). Shared by Today
	 * (tap a thumbnail) and Day (tap the image). A native modal <dialog> gives
	 * focus trapping, Escape and an inert page behind it in Safari and Chrome.
	 * Pinch-zoom stays available on touch devices.
	 *
	 * Gaylon (mockup review 2026-11-07): from the full day image you can go
	 * on to the whole month page, so `monthHref` adds that link.
	 */
	let {
		src,
		alt,
		monthHref = null,
		monthLabel = null,
		dayHref = null
	}: {
		src: string;
		alt: string;
		monthHref?: string | null;
		monthLabel?: string | null;
		dayHref?: string | null;
	} = $props();

	let dlg: HTMLDialogElement | undefined = $state();
	let shown = $state(false);

	export function open() {
		shown = true;
		dlg?.showModal();
	}
	function close() {
		dlg?.close();
	}
	function onClick(e: MouseEvent) {
		if (e.target === dlg) close();
	}
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<dialog
	class="zoom"
	aria-label={alt}
	bind:this={dlg}
	onclick={onClick}
	onclose={() => (shown = false)}
>
	<div class="bar">
		{#if dayHref}
			<a class="zbtn" href={dayHref}>Read the day ▸</a>
		{/if}
		{#if monthHref}
			<a class="zbtn" href={monthHref}>{monthLabel ?? 'The whole month page'} ▸</a>
		{/if}
		<span class="spacer"></span>
		<button type="button" class="close" aria-label="Close" onclick={close}>✕</button>
	</div>
	<div class="scroll">
		{#if shown}
			<img {src} {alt} />
		{/if}
	</div>
</dialog>

<style>
	.zoom {
		position: fixed;
		inset: 0;
		width: 100%;
		max-width: none;
		height: 100%;
		max-height: none;
		margin: 0;
		padding: 0;
		border: 0;
		background: #14120e;
		color: #fff;
		overflow: auto;
		overscroll-behavior: contain;
	}
	.zoom::backdrop {
		background: rgba(20, 18, 14, 0.94);
	}
	.bar {
		position: sticky;
		top: 0;
		z-index: 1;
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 8px;
		padding: calc(8px + env(safe-area-inset-top)) 12px 8px;
		background: #14120e;
	}
	.spacer {
		flex: 1;
	}
	.zbtn {
		display: inline-flex;
		align-items: center;
		min-height: 48px;
		padding: 0 14px;
		border-radius: 10px;
		background: rgba(255, 255, 255, 0.14);
		color: #fff;
		font-family: var(--font-sans);
		font-size: 16px;
		font-weight: 700;
		text-decoration: none;
	}
	.zbtn:hover {
		background: rgba(255, 255, 255, 0.24);
	}
	.close {
		width: 48px;
		height: 48px;
		border: 0;
		border-radius: 50%;
		background: rgba(255, 255, 255, 0.18);
		color: #fff;
		font-size: 22px;
		cursor: pointer;
	}
	.zbtn:focus-visible,
	.close:focus-visible {
		outline: 3px solid #fff;
		outline-offset: 2px;
	}
	.scroll {
		display: flex;
		justify-content: center;
		padding: 8px 8px calc(16px + env(safe-area-inset-bottom));
		touch-action: pinch-zoom pan-x pan-y;
	}
	img {
		max-width: 100%;
		height: auto;
		background: #f4ecd6;
	}
</style>
