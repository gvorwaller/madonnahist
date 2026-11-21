<script lang="ts">
	import { enhance } from '$lib/forms';
	import { currentOpener, restoreFocus, trapTab } from '$lib/dialog-opener';
	import { page } from '$app/state';
	import MemoryForm from '$lib/components/viewer/MemoryForm.svelte';
	import { backLabel, backTarget, withFrom } from '$lib/viewer/nav';
	import { memoryDateLabel, memoryPageHref } from '$lib/viewer/memories';

	const { data, form } = $props();

	const from = $derived(backTarget(page.url.searchParams.get('from'), ''));
	const backHref = $derived(from || '/app/memories');
	const backText = $derived(backLabel(backHref));
	const when = $derived(memoryDateLabel(data.memory.date, data.memory.precision));
	const here = $derived(`/app/memories/${data.memory.id}`);

	// Save failures carry the typed values; share/unshare/delete failures don't.
	const values = $derived(form && 'values' in form ? form.values : null);
	const error = $derived(form && 'error' in form ? (form.error ?? null) : null);
	const formError = $derived(values ? error : null);
	const otherError = $derived(values ? null : error);
	const done = $derived(form && 'done' in form ? form.done : null);

	// The version this page's text was loaded at. It only moves forward when
	// one of this page's own version-checked actions succeeds; reloading data
	// after an action never quietly adopts text this page hasn't shown
	// (CODEX code review #1).
	// After a refused save the page shows the text that was submitted, so it
	// keeps the version that text was based on (needed without JS, where
	// the page re-renders with a fresh load) (CODEX code review #2).
	// A memory kept from before a sign-out (td-46337c) brings back the
	// version its text was based on, and Save, Unshare and Delete all use it:
	// none of them may act on a revision the writer hasn't seen. Discard
	// returns to the loaded text and its version together.
	// svelte-ignore state_referenced_locally
	let loadedVersion = $state(
		form && 'version' in form && typeof form.version === 'string' && 'values' in form
			? form.version
			: data.memory.version
	);

	let confirmDialog: HTMLDialogElement | undefined = $state();
	// "Keep it" or Escape puts focus back on the Delete button (td-eb28c8).
	let confirmOpener: HTMLElement | null = null;
	let busy = $state(false);
</script>

<svelte:head>
	<title>Edit memory — Vorwaller Family History</title>
</svelte:head>

<div class="v-page">
	<a class="v-back" href={backHref}>◂ {backText}</a>
	<h1 class="v-title">Your memory of {when}</h1>
	<p class="status">
		{#if data.memory.shared}
			<span class="v-badge shared">✓ Shared with family</span>
		{:else}
			<span class="v-badge draft">🔒 Draft — only you</span>
		{/if}
		<a href={withFrom(memoryPageHref(data.memory.date, data.memory.precision), here) + `#m-${data.memory.id}`}
			>View on page</a
		>
	</p>

	{#if done}
		<p class="v-note" role="status">{done}</p>
	{/if}

	<MemoryForm
		action="/app/memories/{data.memory.id}?/save"
		initial={values ?? data.initial}
		mode={data.memory.shared ? 'shared' : 'draft'}
		version={loadedVersion}
		{from}
		maxYear={data.maxYear}
		error={formError}
		canonical={data.initial}
		onrestore={(v) => (loadedVersion = v)}
		ondiscard={() => (loadedVersion = data.memory.version)}
	/>

	<section class="more" aria-labelledby="more-h">
		<h2 id="more-h">Sharing and deleting</h2>
		{#if data.memory.shared}
			<form
				method="POST"
				action="/app/memories/{data.memory.id}?/unshare"
				use:enhance={() => {
					busy = true;
					return async ({ result, update }) => {
						if (result.type === 'success' && typeof result.data?.version === 'string') {
							loadedVersion = result.data.version;
						}
						await update({ reset: false });
						busy = false;
					};
				}}
			>
				<input type="hidden" name="version" value={loadedVersion} />
				<p>The family can read this memory. Unsharing makes it a private draft again.</p>
				<button type="submit" class="v-btn secondary" disabled={busy}>🔒 Unshare</button>
			</form>
		{/if}
		{#if otherError}
			<p class="v-alert" role="alert">{otherError}</p>
		{/if}
		<p>Deleting removes this memory from the family history.</p>
		<button
			type="button"
			class="v-btn danger"
			onclick={() => {
				confirmOpener = currentOpener();
				confirmDialog?.showModal();
			}}
		>
			Delete this memory…
		</button>
	</section>
</div>

<dialog
	bind:this={confirmDialog}
	class="confirm"
	aria-labelledby="del-h"
	onkeydown={trapTab}
	onclose={() => restoreFocus(confirmOpener)}
>
	<h2 id="del-h">Delete your memory of {when}?</h2>
	<p>It will no longer show anywhere in the family history.</p>
	<form
		method="POST"
		action="/app/memories/{data.memory.id}?/delete"
		use:enhance={() => {
			busy = true;
			return async ({ update }) => {
				confirmDialog?.close();
				await update();
				busy = false;
			};
		}}
	>
		<input type="hidden" name="version" value={loadedVersion} />
		<div class="v-actions">
			<button type="submit" class="v-btn danger solid" disabled={busy}>Delete memory</button>
			<button type="button" class="v-btn secondary" onclick={() => confirmDialog?.close()}
				>Keep it</button
			>
		</div>
	</form>
</dialog>

<style>
	.status {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px 16px;
		margin: 6px 0 4px;
	}
	.status a {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		font-weight: 700;
		color: var(--color-evergreen);
	}
	.more {
		margin-top: 32px;
		padding-top: 16px;
		border-top: 1px solid var(--color-border);
	}
	.more h2 {
		margin: 0 0 6px;
		font-size: 20px;
	}
	.more p {
		margin: 12px 0 8px;
		color: var(--color-ink-muted);
	}
	.v-btn.danger {
		background: var(--color-paper);
		border: 2px solid var(--color-danger);
		color: var(--color-danger);
	}
	.v-btn.danger.solid {
		background: var(--color-danger);
		color: #fff;
	}
	.confirm {
		max-width: min(440px, calc(100vw - 32px));
		padding: 20px;
		border: 1px solid var(--color-border);
		border-radius: 14px;
		background: var(--color-paper);
		color: var(--color-ink);
	}
	.confirm::backdrop {
		background: rgba(0, 0, 0, 0.45);
	}
	.confirm h2 {
		margin: 0 0 8px;
		font-size: 21px;
	}
	.confirm p {
		margin: 0 0 8px;
	}
</style>
