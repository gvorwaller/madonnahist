<script lang="ts" generics="T extends { year: number | string }">
	/**
	 * Collapsible decade sections for admin lists of years (Gaylon,
	 * 2026-11-18): Grid Alignment, PDF Exports, Year Narratives.
	 *
	 * A decade starts open when `startOpen` says it has something waiting
	 * (pages to align, a draft to review, a PDF generating). Once you open or
	 * close one, that choice is remembered for this tab (sessionStorage, the
	 * same helper as the viewer's Timeline) and replaces the defaults.
	 */
	import { onMount, type Snippet } from 'svelte';
	import { readOpenDecades, writeOpenDecades } from '$lib/viewer/prefs';

	interface Props {
		items: T[];
		storageKey: string;
		startOpen: (items: T[]) => boolean;
		/** Heading text after the decade name, e.g. "2 years · 24/24 done". */
		summary: Snippet<[T[]]>;
		children: Snippet<[T[]]>;
	}

	const { items, storageKey, startOpen, summary, children }: Props = $props();

	function group(list: T[]) {
		const map = new Map<number, T[]>();
		for (const item of list) {
			const decade = Math.floor(Number(item.year) / 10) * 10;
			if (!map.has(decade)) map.set(decade, []);
			map.get(decade)!.push(item);
		}
		return [...map.entries()].sort((a, b) => a[0] - b[0]);
	}

	const decades = $derived(group(items));

	// svelte-ignore state_referenced_locally
	let open = $state<Record<number, boolean>>(
		Object.fromEntries(group(items).map(([d, list]) => [d, startOpen(list)]))
	);

	onMount(() => {
		const saved = readOpenDecades(storageKey);
		if (saved) open = saved;
	});

	function toggled(decade: number, e: Event) {
		const isOpen = (e.currentTarget as HTMLDetailsElement).open;
		if ((open[decade] ?? false) === isOpen) return;
		open = { ...open, [decade]: isOpen };
		writeOpenDecades(storageKey, open);
	}

	function setAll(isOpen: boolean) {
		open = Object.fromEntries(decades.map(([d]) => [d, isOpen]));
		writeOpenDecades(storageKey, open);
	}
</script>

<p class="tools">
	<button type="button" class="linkbtn" onclick={() => setAll(true)}>Open all</button>
	<span aria-hidden="true">·</span>
	<button type="button" class="linkbtn" onclick={() => setAll(false)}>Close all</button>
</p>
{#each decades as [decade, list] (decade)}
	<details class="decade" open={open[decade] ?? false} ontoggle={(e) => toggled(decade, e)}>
		<summary>
			<span class="decade-label">{decade}s</span>
			<span class="decade-stats">{@render summary(list)}</span>
		</summary>
		<div class="decade-body">
			{@render children(list)}
		</div>
	</details>
{/each}

<style>
	.tools {
		margin: 0 0 0.6rem;
		font-size: 0.85rem;
		color: #4a4a4a;
	}
	.linkbtn {
		background: none;
		border: none;
		padding: 0.6rem 0.25rem;
		font: inherit;
		color: #1f4e8a;
		text-decoration: underline;
		cursor: pointer;
	}
	.decade {
		border: 1px solid #d0d0d0;
		border-radius: 8px;
		background: #fff;
	}
	.decade + .decade {
		margin-top: 0.6rem;
	}
	.decade > summary {
		list-style: none;
		cursor: pointer;
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.25rem 0.75rem;
		min-height: 48px;
		padding: 0.5rem 2.5rem 0.5rem 1rem;
		position: relative;
		font-weight: 700;
		font-size: 1.05rem;
		color: #222;
	}
	.decade > summary::-webkit-details-marker {
		display: none;
	}
	.decade > summary::after {
		content: '▸';
		position: absolute;
		right: 1rem;
		top: 50%;
		translate: 0 -50%;
		color: #4a4a4a;
		transition: rotate 0.15s;
	}
	.decade[open] > summary::after {
		rotate: 90deg;
	}
	.decade-label {
		min-width: 3.5rem;
	}
	.decade-stats {
		font-weight: 400;
		font-size: 0.85rem;
		color: #4a4a4a;
	}
	.decade-body {
		padding: 0 0.75rem 0.75rem;
		overflow-x: auto;
	}
</style>
