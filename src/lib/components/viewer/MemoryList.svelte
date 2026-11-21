<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { navigating, page } from '$app/state';
	import { isSignedOutResult, signInHref } from '$lib/viewer/session';
	import { refreshWhenSettled } from '$lib/viewer/refresh';
	import { tick } from 'svelte';
	import type { SubmitFunction } from '@sveltejs/kit';
	import { withFrom } from '$lib/viewer/nav';
	import { possessive, type HiddenMemories, type MemoryView } from '$lib/viewer/memories';

	/**
	 * Memories on a Day, Month or Year page (plan:
	 * docs/2026-11-16-writers-and-memories-plan.md §4). Shared memories show
	 * to everyone; a draft shows only to the person who typed it, with a
	 * dashed border, a "Draft — only you" badge and an Edit link (AGY2 #7).
	 *
	 * Whose memories you see (td-76a40f): under someone else's memory is a
	 * "Hide <name>'s memories" button (never for Madonna's or your own). A
	 * writer you've hidden shows as one line per writer, saying how many are
	 * hidden here, with a Show button. The same choice is on Your account.
	 * The buttons post to /app/account and come back here, so they work
	 * without JavaScript; with it, the page reloads its data in place and
	 * focus moves to what replaced the button.
	 */
	const {
		memories,
		hidden = [],
		of,
		here
	}: {
		memories: MemoryView[];
		/** Writers the reader hid that have memories on this page. */
		hidden?: HiddenMemories[];
		/** "this day", "this month" or "this year", for labels. */
		of: string;
		/** This page's path, so Back returns here from the editor. */
		here: string;
	} = $props();

	/** Where hide/show come back to: this page, keeping its ?from=. */
	const returnTo = $derived(page.url.pathname + page.url.search);
	let busy = $state(false);
	let problem = $state<string | null>(null);
	/** Set when the session expired: where to sign in and come back. */
	let signInTo = $state<string | null>(null);

	/** Path and query of a URL or href, as the browser resolves it here. */
	const pathOf = (href: string) => {
		const u = new URL(href, location.href);
		return u.pathname + u.search;
	};

	/**
	 * Hide/show: reload this page's data in place, then move focus. The
	 * reader may already be leaving when the answer arrives (CODEX #3, re-
	 * review #2): a link tapped meanwhile, still loading or done. Then no
	 * focus or message (they'd land on a page they've left), and a saved
	 * choice refreshes the new page only once its navigation has settled
	 * (refreshing sooner cancels it; it may have loaded the old choice).
	 */
	function toggle(focusId: () => string): SubmitFunction {
		return () => {
			const tappedOn = pathOf(location.href);
			const leaving = () => navigating.to !== null || pathOf(location.href) !== tappedOn;
			busy = true;
			problem = null;
			signInTo = null;
			return async ({ result }) => {
				try {
					const saved = result.type === 'redirect' && pathOf(result.location) === tappedOn;
					if (leaving()) {
						if (saved) void refreshWhenSettled();
						return;
					}
					if (isSignedOutResult(result)) {
						signInTo = signInHref(page.url);
					} else if (saved) {
						await invalidateAll();
						if (leaving()) return;
						await tick();
						document.getElementById(focusId())?.focus();
					} else {
						problem = "Couldn't change that. Reload the page and try again.";
					}
				} finally {
					busy = false;
				}
			};
		};
	}

	const hiddenText = (h: HiddenMemories) =>
		h.count === 1
			? `${possessive(h.writerName)} memory of ${of} is hidden.`
			: `${possessive(h.writerName)} ${h.count} memories of ${of} are hidden.`;
</script>

{#each memories as m (m.id)}
	<aside
		class="v-memory"
		class:draft={!m.shared}
		id="m-{m.id}"
		tabindex="-1"
		aria-label="{m.writerName}'s memory of {of}"
	>
		<p class="who">🗨 {m.writerName} remembers</p>
		<p class="text">{m.body}</p>
		{#if m.mine}
			<p class="mine">
				{#if m.shared}
					<span class="v-badge shared">✓ Shared with family</span>
				{:else}
					<span class="v-badge draft">🔒 Draft — only you</span>
				{/if}
				<a class="edit" href={withFrom(`/app/memories/${m.id}`, here)}
					>{m.shared ? 'Edit' : 'Edit draft'}<span class="v-sr"> your memory</span></a
				>
			</p>
		{:else if m.canHide}
			<form
				class="hide"
				method="POST"
				action="/app/account?/hideWriter"
				use:enhance={toggle(() => `hidden-w-${m.writerId}`)}
			>
				<input type="hidden" name="writer" value={m.writerId} />
				<input type="hidden" name="returnTo" value={returnTo} />
				<button type="submit" class="v-linkbtn" disabled={busy}
					>Hide {possessive(m.writerName)} memories</button
				>
			</form>
		{/if}
	</aside>
{/each}

{#each hidden as h (h.writerId)}
	<div class="v-hidden-mem" id="hidden-w-{h.writerId}" tabindex="-1">
		<p><span aria-hidden="true">🙈</span> {hiddenText(h)}</p>
		<div class="row">
			<form
				method="POST"
				action="/app/account?/showWriter"
				use:enhance={toggle(() => {
					const first = memories.find((m) => m.writerId === h.writerId);
					return first ? `m-${first.id}` : `hidden-w-${h.writerId}`;
				})}
			>
				<input type="hidden" name="writer" value={h.writerId} />
				<input type="hidden" name="returnTo" value={returnTo} />
				<button type="submit" class="v-linkbtn" disabled={busy}
					>Show {possessive(h.writerName)} memories</button
				>
			</form>
			<a class="v-linkbtn" href="/app/account#memories-h">Whose memories you see</a>
		</div>
	</div>
{/each}

{#if signInTo}
	<p class="v-alert" role="alert">
		You've been signed out, so nothing changed. <a href={signInTo}>Sign in again</a>, then try once
		more.
	</p>
{:else if problem}
	<p class="v-alert" role="alert">{problem}</p>
{/if}

<style>
	.mine {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px 12px;
		margin: 10px 0 0;
	}
	.edit {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		font-weight: 700;
		color: var(--color-evergreen);
	}
	.hide {
		margin: 6px 0 -6px;
	}
	.hide .v-linkbtn {
		padding: 0;
		font-size: 15px;
	}
	.v-hidden-mem {
		margin: 18px 0 0;
		padding: 10px 14px;
		max-width: 62ch;
		border: 1px dashed var(--color-ink-muted);
		border-radius: 10px;
		background: var(--color-paper);
	}
	.v-hidden-mem p {
		margin: 0;
		color: var(--color-ink-muted); /* 9.3:1 on paper */
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		gap: 0 16px;
	}
	.row .v-linkbtn {
		padding: 0;
	}
	.v-hidden-mem:focus,
	aside:focus {
		outline: 3px solid var(--color-evergreen-dark);
		outline-offset: 2px;
	}
</style>
