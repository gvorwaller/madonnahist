<script lang="ts">
	import { browser } from '$app/environment';
	import { onMount } from 'svelte';

	const { data } = $props();

	const STORAGE_KEY = 'madonnahist.browse.openDecades';

	// Per-decade open state, keyed by decade year (e.g. 1970). All decades
	// still start collapsed by default (per Gaylon, 2026-07-22) — this record
	// drives each <details>'s `open` attribute directly (rather than raw DOM
	// manipulation) so the session-remembered state restored in onMount below
	// can override the default without a flash: the record starts empty
	// (everything collapsed), onMount overwrites it synchronously before the
	// user can interact, and Svelte re-renders from that single source of
	// truth either way.
	let openDecades = $state<Record<number, boolean>>({});

	onMount(() => {
		if (!browser) return;
		try {
			const raw = sessionStorage.getItem(STORAGE_KEY);
			if (!raw) return;
			const openList: unknown = JSON.parse(raw);
			if (!Array.isArray(openList)) return;
			const restored: Record<number, boolean> = {};
			for (const decade of openList) {
				if (typeof decade === 'number') restored[decade] = true;
			}
			openDecades = restored;
		} catch {
			// Corrupt/foreign sessionStorage value — ignore, keep the default
			// (all collapsed) rather than throw.
		}
	});

	function persist() {
		if (!browser) return;
		const openList = Object.entries(openDecades)
			.filter(([, isOpen]) => isOpen)
			.map(([decade]) => Number(decade));
		sessionStorage.setItem(STORAGE_KEY, JSON.stringify(openList));
	}

	function handleToggle(decade: number, e: Event) {
		const el = e.currentTarget as HTMLDetailsElement;
		openDecades = { ...openDecades, [decade]: el.open };
		persist();
	}

	function expandAll() {
		const all: Record<number, boolean> = {};
		for (const g of data.decades) all[g.decade] = true;
		openDecades = all;
		persist();
	}

	function collapseAll() {
		const all: Record<number, boolean> = {};
		for (const g of data.decades) all[g.decade] = false;
		openDecades = all;
		persist();
	}
</script>

<svelte:head>
	<title>Browse — madonnahist</title>
</svelte:head>

<div class="browse-page">
	<h1>Browse</h1>

	{#if data.decades.length === 0}
		<div class="empty-state">
			<p>No calendar pages have been ingested yet — check back once capture work begins.</p>
		</div>
	{:else}
		<div class="list-tools">
			<button type="button" class="linkbtn" onclick={expandAll}>Expand all</button>
			<span class="tools-sep" aria-hidden="true">&middot;</span>
			<button type="button" class="linkbtn" onclick={collapseAll}>Collapse all</button>
		</div>

		{#each data.decades as group (group.decade)}
			<!-- Native details/summary: collapsible with no JS, keyboard- and
			     Safari-native. All decades start collapsed (per Gaylon,
			     2026-07-22) — the summary rows carry coverage, so the closed
			     list is a clean decade index. `open` is driven from the
			     openDecades $state record (never toggled via raw DOM writes)
			     so Expand/Collapse-all and session restore all funnel through
			     one source of truth. -->
			<details
				class="decade-section"
				open={openDecades[group.decade] ?? false}
				ontoggle={(e) => handleToggle(group.decade, e)}
			>
				<summary class="decade-title">
					<span class="decade-name">{group.decade}s</span>
					<span class="decade-coverage">{group.accepted} of {group.total} days</span>
					<span class="decade-chevron" aria-hidden="true">&#9656;</span>
				</summary>
				<ul class="year-list">
					{#each group.years as y (y.year)}
						<li class="year-item">
							<a href="/app/year/{y.year}" class="year-row">
								<span class="year-num">{y.year}</span>
								<span class="year-coverage">
									{y.accepted} of {y.total} days ({y.percent}%)
								</span>
							</a>
							{#if y.accepted > 0}
								<a href="/app/book/year/{y.year}" class="book-link">Read as book &#9656;</a>
							{/if}
						</li>
					{/each}
				</ul>
			</details>
		{/each}
	{/if}
</div>

<style>
	.browse-page {
		padding: 1rem;
	}
	h1 {
		font-family: var(--font-sans);
		font-size: 1.25rem;
		margin: 0 0 1rem;
		color: var(--color-ink);
	}
	.list-tools {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin: 0 0 0.75rem;
	}
	.tools-sep {
		color: var(--color-ink-muted);
	}
	.linkbtn {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		padding: 0 0.4rem;
		background: none;
		border: none;
		font-family: var(--font-sans);
		font-size: 0.85rem;
		font-weight: 600;
		color: var(--color-evergreen-dark);
		text-decoration: underline;
		cursor: pointer;
	}
	.linkbtn:focus-visible {
		outline: 2px solid var(--color-evergreen-dark);
		outline-offset: 2px;
	}
	.decade-section {
		margin-bottom: 1.5rem;
	}
	.decade-title {
		display: flex;
		align-items: baseline;
		gap: 0.6rem;
		font-family: var(--font-sans);
		font-size: 1rem;
		font-weight: 700;
		color: var(--color-amber);
		/* no text-transform: "1980s", not "1980S" */
		letter-spacing: 0.04em;
		margin: 0 0 0.5rem;
		padding: 0.5rem 0 0.4rem; /* >=44px tap target with line height */
		border-bottom: 1px solid var(--color-border);
		cursor: pointer;
		list-style: none; /* hide the native marker; we render our own chevron */
	}
	.decade-title::-webkit-details-marker {
		display: none; /* Safari's native marker */
	}
	.decade-title:focus-visible {
		outline: 2px solid var(--color-evergreen);
		outline-offset: 2px;
	}
	.decade-coverage {
		margin-left: auto;
		font-weight: 400;
		font-size: 0.85rem;
		color: var(--color-ink-muted);
	}
	.decade-chevron {
		font-size: 0.8rem;
		transition: transform 0.15s ease;
	}
	details[open] > .decade-title .decade-chevron {
		transform: rotate(90deg);
	}
	.year-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.year-item {
		display: flex;
		align-items: stretch;
		gap: 0.5rem;
	}
	.year-row {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		min-height: 52px;
		padding: 0.5rem 0.9rem;
		background: var(--color-paper);
		border: 1px solid var(--color-border);
		border-radius: 8px;
		text-decoration: none;
		color: inherit;
		box-sizing: border-box;
	}
	.book-link {
		display: flex;
		align-items: center;
		justify-content: center;
		flex: 0 0 auto;
		min-height: 44px;
		padding: 0.5rem 0.7rem;
		background: var(--color-paper);
		border: 1px solid var(--color-border);
		border-radius: 8px;
		font-family: var(--font-sans);
		font-size: 0.78rem;
		font-weight: 600;
		color: var(--color-ink-muted);
		text-decoration: none;
		white-space: nowrap;
		box-sizing: border-box;
	}
	.book-link:hover {
		border-color: var(--color-evergreen);
		color: var(--color-evergreen-dark);
	}
	.book-link:focus-visible {
		outline: 2px solid var(--color-evergreen-dark);
		outline-offset: 2px;
	}
	.year-row:hover {
		border-color: var(--color-evergreen);
	}
	.year-row:focus-visible {
		outline: 2px solid var(--color-evergreen-dark);
		outline-offset: 2px;
	}
	.year-num {
		font-family: var(--font-sans);
		font-weight: 700;
		font-size: 1.05rem;
		color: var(--color-evergreen-dark);
	}
	.year-coverage {
		font-family: var(--font-sans);
		font-size: 0.8rem;
		color: var(--color-ink-muted);
		text-align: right;
	}

	.empty-state {
		background: var(--color-paper);
		border: 1px solid var(--color-border);
		border-radius: 10px;
		padding: 1.5rem 1.25rem;
		text-align: center;
	}
	.empty-state p {
		font-family: var(--font-serif);
		font-size: 1.05rem;
		line-height: 1.6;
		color: var(--color-ink-muted);
		margin: 0;
	}
</style>
