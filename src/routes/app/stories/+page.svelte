<script lang="ts">
	import { onMount } from 'svelte';
	import {
		readOpenDecades,
		readOrder,
		writeOpenDecades,
		writeOrder,
		type Order
	} from '$lib/viewer/prefs';

	const { data } = $props();

	const OPEN_KEY = 'vfh.stories.openDecades';

	// Year stories grouped by decade like the Timeline: every decade starts
	// collapsed, Expand/Collapse all, and the same oldest/newest choice
	// (Gaylon, 2026-11-11). The server sends newest year first.
	let order = $state<Order>('oldest');
	let openDecades = $state<Record<number, boolean>>({});

	const decades = $derived.by(() => {
		const out: { decade: number; stories: typeof data.yearStories }[] = [];
		const years = order === 'newest' ? data.yearStories : [...data.yearStories].reverse();
		for (const y of years) {
			const decade = Math.floor(y.year / 10) * 10;
			const last = out[out.length - 1];
			if (last && last.decade === decade) last.stories.push(y);
			else out.push({ decade, stories: [y] });
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

	function formatDate(iso: string): string {
		return new Date(iso).toLocaleDateString('en-US', {
			month: 'short',
			day: 'numeric',
			year: 'numeric'
		});
	}
</script>

<svelte:head>
	<title>Stories — Vorwaller Family History</title>
</svelte:head>

<div class="v-page wide">
	<h1 class="v-title">Stories</h1>
	<p class="v-sub">
		Stories written from Madonna's calendars, and reviewed before they appear here.
	</p>

	<section aria-labelledby="ys-h">
		<div class="v-section-h">
			<h2 id="ys-h">Year stories <span class="v-count">{data.yearStories.length}</span></h2>
		</div>
		{#if data.yearStories.length === 0}
			<p class="v-muted">
				No year stories yet. They appear here once a year is written up and reviewed.
			</p>
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
					<button type="button" class="v-linkbtn" onclick={() => setAll(false)}>Collapse all</button
					>
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
						<span class="dmeta"
							>{g.stories.length}
							{g.stories.length === 1 ? 'story' : 'stories'}</span
						>
					</summary>
					<div class="v-fold-body">
						<ul class="storylist">
							{#each g.stories as y (y.year)}
								<li class="v-card yearstory">
									<a class="story-link" href="/app/year/{y.year}#story">
										<span class="v-eyebrow">{y.year}</span>
										<span class="h">The story of {y.year}</span>
										<span class="teaser">{y.teaser}</span>
									</a>
									<p class="v-provenance">
										<b>AI-written</b> from Madonna's {y.year} calendar, reviewed
									</p>
									<div class="links">
										<a href="/app/year/{y.year}#story">Read the story ▸</a>
										<a href="/app/book/year/{y.year}">📚 Read {y.year} as a book ▸</a>
									</div>
								</li>
							{/each}
						</ul>
					</div>
				</details>
			{/each}
		{/if}
	</section>

	<section aria-labelledby="fs-h">
		<div class="v-section-h">
			<h2 id="fs-h">Family Stories <span class="v-count">{data.stories.length}</span></h2>
		</div>
		<p class="v-sub intro">
			Each one gathers a theme across many days, written only from Madonna's transcribed entries.
		</p>
		{#if data.stories.length === 0}
			<p class="v-muted">No Family Stories yet. They'll appear here as they're written and kept.</p>
		{:else}
			<ul class="storylist">
				{#each data.stories as story (story.id)}
					<li>
						<a class="v-card qa" href="/app/stories/{story.id}">
							<span class="h">{story.question}</span>
							<span class="v-provenance">
								<b>AI-written</b> from {story.dayCount}
								{story.dayCount === 1 ? 'day' : 'days'} · {story.subsetSummary} · saved {formatDate(
									story.createdAt
								)}
							</span>
						</a>
					</li>
				{/each}
			</ul>
		{/if}
	</section>
</div>

<style>
	.storylist {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 12px;
	}
	.storylist :global(.v-card + .v-card) {
		margin-top: 0;
	}
	@media (min-width: 1024px) {
		.storylist {
			grid-template-columns: 1fr 1fr;
		}
	}
	.dname {
		font-size: 19px;
		color: var(--color-amber);
	}
	.dmeta {
		font-size: 15px;
		font-weight: 600;
		color: var(--color-ink-muted);
	}
	.decade .yearstory {
		background: var(--color-cream);
	}
	section + section {
		margin-top: 28px;
	}
	.intro {
		margin: -4px 0 12px;
	}
	.story-link {
		display: flex;
		flex-direction: column;
		gap: 4px;
		color: inherit;
		text-decoration: none;
	}
	.h {
		font-family: var(--font-serif);
		font-size: 21px;
		font-weight: 700;
		line-height: 1.3;
		overflow-wrap: anywhere;
	}
	.teaser {
		font-family: var(--font-serif);
		line-height: 1.55;
	}
	.story-link:hover .h {
		text-decoration: underline;
	}
	.links {
		display: flex;
		flex-wrap: wrap;
		gap: 0 18px;
	}
	.links a {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		font-weight: 700;
		color: var(--color-evergreen);
		text-decoration: none;
	}
	.links a:hover {
		text-decoration: underline;
	}
	.qa {
		height: 100%;
		display: flex;
		flex-direction: column;
	}
</style>
