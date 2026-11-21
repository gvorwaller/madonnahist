<script lang="ts">
	import { onMount, type Snippet } from 'svelte';
	import { currentOpener, restoreFocus, trapTab } from '$lib/dialog-opener';

	/**
	 * A modal dialog for the admin and correction pages (td-eb28c8). Shown with
	 * the native <dialog>.showModal(), so the page behind is inert (Tab and
	 * clicks can't reach it, screen readers don't read it) and Escape closes
	 * it, in Safari and Chrome alike.
	 *
	 * Put it inside the page's {#if}: it opens when it appears and closes
	 * when the page clears its state. Escape calls `onclose`, which should
	 * clear that state. Tab and Shift+Tab wrap around inside it. Focus starts
	 * on the dialog itself (`autofocus` on the <dialog>, so showModal() never
	 * focuses a field first: Enter can't confirm by accident, and iPad
	 * doesn't pop up the keyboard), and goes back to the button that opened
	 * it afterwards, or to `opener` when the page knows better (a dialog
	 * opened by a save's answer, not by a click).
	 *
	 * The dialog is a bare, full-screen box: the page's own overlay and box
	 * markup goes inside unchanged and keeps its look.
	 */
	interface Props {
		/** The dialog's name, when there's no heading to point at. */
		label?: string;
		/** id of the heading that names the dialog. */
		labelledby?: string;
		/** Escape was pressed: clear the state that shows this dialog. */
		onclose: () => void;
		/** Where focus goes back to, looked up at close; default: what was clicked to open it. */
		opener?: () => HTMLElement | null;
		children: Snippet;
	}
	const { label, labelledby, onclose, opener: findOpener, children }: Props = $props();

	let dlg: HTMLDialogElement;
	let removed = false;

	onMount(() => {
		const clicked = findOpener ? null : currentOpener();
		dlg.showModal();
		dlg.focus();
		return () => {
			removed = true;
			// Close before restoring focus: while it's open, the page is inert.
			if (dlg.open) dlg.close();
			restoreFocus(findOpener ?? clicked);
		};
	});
</script>

<!-- svelte-ignore a11y_autofocus -->
<dialog
	bind:this={dlg}
	autofocus
	class="modal-dialog"
	tabindex="-1"
	aria-label={label}
	aria-labelledby={labelledby}
	onkeydown={trapTab}
	oncancel={(e) => {
		e.preventDefault();
		onclose();
	}}
	onclose={() => {
		// Chrome may close it anyway after repeated Escapes; keep state in step.
		if (!removed) onclose();
	}}
>
	{@render children()}
</dialog>

<style>
	.modal-dialog {
		position: fixed;
		inset: 0;
		width: 100%;
		height: 100%;
		max-width: none;
		max-height: none;
		margin: 0;
		padding: 0;
		border: 0;
		background: transparent;
		color: inherit;
		overflow: visible;
	}
	.modal-dialog:focus {
		outline: none;
	}
	.modal-dialog::backdrop {
		background: transparent;
	}
</style>
