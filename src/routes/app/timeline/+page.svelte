<script lang="ts">
	import { onMount } from 'svelte';
	import { MONTHS } from '$lib/viewer/nav';
	import {
		readOpenDecades,
		readOrder,
		writeOpenDecades,
		writeOrder,
		type Order
	} from '$lib/viewer/prefs';

	const { data } = $props();

	type Year = (typeof data.years)[number];

	const OPEN_KEY = 'vfh.timeline.openDecades';
	const LETTERS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];

	// Oldest first by default, with a toggle shared with Stories (Gaylon,
	// mockup review 2026-11-07). Decades start collapsed; open state is
	// remembered for this tab. The server sends years oldest first.
	let order = $state<Order>('oldest');
	let openDecades = $state<Record<number, boolean>>({});

	const decades = $derived.by(() => {
		const out: { decade: number; years: Year[]; accepted: number; stories: number }[] = [];
		const years = order === 'oldest' ? data.years : [...data.years].reverse();
		for (const y of years) {
			const decade = Math.floor(y.year / 10) * 10;
			let g = out[out.length - 1];
			if (!g || g.decade !== decade) {
				g = { decade, years: [], accepted: 0, stories: 0 };
				out.push(g);
			}
			g.years.push(y);
			g.accepted += y.accepted;
			if (y.storyLine) g.stories++;
		}
		return out;
	});

	onMount(() => {
		order = readOrder() ?? 'oldest';
		openDecades = readOpenDecades(OPEN_KEY) ?? {};
	});

	function setOrder(next: Order) {
		order = next;
		writeOrder(next);
	}
	function toggled(decade: number, e: Event) {
		openDecades = { ...openDecades, [decade]: (e.currentTarget as HTMLDetailsElement).open };
		writeOpenDecades(OPEN_KEY, openDecades);
	}
	function setAll(open: boolean) {
		const all: Record<number, boolean> = {};
		for (const g of decades) all[g.decade] = open;
		openDecades = all;
		writeOpenDecades(OPEN_KEY, openDecades);
	}

	function daysIn(year: number, month: number): number {
		return new Date(Date.UTC(year, month, 0)).getUTCDate();
	}
	/** Bar height in percent; a month with any days gets at least a visible sliver. */
	function barHeight(y: Year, i: number): number {
		const n = y.months[i];
		if (n === 0) return 0;
		return Math.max(12, Math.round((n / daysIn(y.year, i + 1)) * 100));
	}
	const n = (count: number, one: string, many: string) =>
		`${count.toLocaleString('en-US')} ${count === 1 ? one : many}`;

	/** "January to April", "March", or "January to December (some gaps)". */
	function span(y: Year): string {
		const filled = y.months.map((c, i) => (c > 0 ? i : -1)).filter((i) => i >= 0);
		if (filled.length === 0) return '';
		const first = MONTHS[filled[0]];
		const last = MONTHS[filled[filled.length - 1]];
		return first === last ? first : `${first} to ${last}`;
	}
	function rowLabel(y: Year): string {
		return `${y.year}: ${n(y.accepted, 'day', 'days')}, ${span(y)}.${y.storyLine ? ' Year story available.' : ''}`;
	}
</script>

<svelte:head>
	<title>Timeline — Vorwaller Family History</title>
</svelte:head>

<div class="v-page wide">
	<h1 class="v-title">Timeline</h1>
	<p class="v-sub">
		Madonna's calendars, a year at a time. The bars show how many days of each month are
		transcribed.
	</p>

	{#if data.years.length === 0}
		<div class="v-empty">
			<div class="icon" aria-hidden="true">🗓️</div>
			<h2>Nothing here yet</h2>
			<p>Years appear here as Madonna's calendars are photographed and transcribed.</p>
		</div>
	{:else}
		<div class="v-tools">
			<div class="v-order" role="group" aria-label="Order">
				<button type="button" aria-pressed={order === 'oldest'} onclick={() => setOrder('oldest')}
					>Oldest first</button
				>
				<button type="button" aria-pressed={order === 'newest'} onclick={() => setOrder('newest')}
					>Newest first</button
				>
			</div>
			<span>
				<button type="button" class="v-linkbtn" onclick={() => setAll(true)}>Expand all</button>
				<span aria-hidden="true">·</span>
				<button type="button" class="v-linkbtn" onclick={() => setAll(false)}>Collapse all</button>
			</span>
		</div>

		{#each decades as g (g.decade)}
			<details
				class="v-fold decade"
				open={openDecades[g.decade] ?? false}
				ontoggle={(e) => toggled(g.decade, e)}
			>
				<summary>
					<span class="dname">{g.decade}s</span>
					<span class="dmeta">
						{g.accepted > 0 ? n(g.accepted, 'day', 'days') : 'Not transcribed yet'}{g.stories > 0
							? ` · ${n(g.stories, 'story', 'stories')}`
							: ''}
					</span>
				</summary>
				<div class="v-fold-body">
					<ul class="years">
						{#each g.years as y (y.year)}
							<li>
								{#if y.accepted > 0}
									<a class="yearrow" href="/app/year/{y.year}" aria-label={rowLabel(y)}>
										<span class="y">{y.year}<small>{n(y.accepted, 'day', 'days')}</small></span>
										<span class="strip" aria-hidden="true">
											<span class="bars">
												{#each y.months as count, i (i)}
													<i class:none={count === 0} style:height="{barHeight(y, i)}%"></i>
												{/each}
											</span>
											<span class="letters">
												{#each LETTERS as l, i (i)}<span>{l}</span>{/each}
											</span>
										</span>
										{#if y.storyLine}
											<span class="line" aria-hidden="true"
												><b class="story-flag">Year story ·</b> {y.storyLine}</span
											>
										{:else if y.highlight}
											<span class="line" aria-hidden="true">{y.highlight}</span>
										{/if}
									</a>
								{:else}
									<div class="yearrow pending">
										<span class="y">{y.year}</span>
										<span class="line muted">Not transcribed yet</span>
									</div>
								{/if}
							</li>
						{/each}
					</ul>
				</div>
			</details>
		{/each}
	{/if}
</div>

<style>
	/* Decade summaries match the Stories tab's. */
	.dname {
		font-size: 19px;
		color: var(--color-amber);
	}
	.dmeta {
		font-size: 15px;
		font-weight: 600;
		color: var(--color-ink-muted);
	}
	.years {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 10px;
	}
	@media (min-width: 1024px) {
		.years {
			grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
		}
	}
	.yearrow {
		display: grid;
		grid-template-columns: 76px minmax(0, 1fr);
		gap: 6px 14px;
		align-items: center;
		min-height: 72px;
		height: 100%;
		padding: 12px 14px;
		background: var(--color-paper);
		border: 1px solid var(--color-border);
		border-radius: var(--radius);
		color: inherit;
		text-decoration: none;
	}
	a.yearrow:hover {
		border-color: var(--color-evergreen);
	}
	.y {
		grid-row: span 2;
		font-family: var(--font-serif);
		font-size: 24px;
		font-weight: 700;
		color: var(--color-evergreen-dark);
		line-height: 1.1;
	}
	.y small {
		display: block;
		margin-top: 4px;
		font-family: var(--font-sans);
		font-size: 15px;
		font-weight: 600;
		color: var(--color-ink-muted);
	}
	.strip {
		display: block;
		min-width: 0;
	}
	.bars,
	.letters {
		display: grid;
		grid-template-columns: repeat(12, minmax(0, 1fr));
		gap: 3px;
	}
	.bars {
		align-items: end;
		height: 32px;
	}
	.bars i {
		display: block;
		background: var(--color-evergreen);
		border-radius: 2px 2px 0 0;
	}
	/* No days that month: a short dashed stub (shape, not just color). */
	.bars i.none {
		border-bottom: 2px dashed var(--color-memory-rule);
		background: none;
		border-radius: 0;
	}
	.letters {
		margin-top: 2px;
		font-size: 15px;
		line-height: 1.2;
		color: var(--color-ink-muted);
		text-align: center;
	}
	.letters span {
		overflow: hidden;
	}
	.line {
		grid-column: 2;
		margin: 0;
		font-family: var(--font-serif);
		font-size: 17px;
		line-height: 1.4;
		overflow: hidden;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
	}
	.story-flag {
		font-family: var(--font-sans);
		font-size: 15px;
		color: var(--color-amber);
	}
	.yearrow.pending {
		background: transparent;
		border-style: dashed;
		border-color: var(--color-ink-muted);
	}
	.yearrow.pending .y {
		color: var(--color-ink-muted);
		grid-row: auto;
	}
	.muted {
		font-family: var(--font-sans);
		font-size: 16px;
		color: var(--color-ink-muted);
	}
	@media (max-width: 359px) {
		.letters {
			display: none;
		}
	}
</style>
