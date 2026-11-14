<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { tick } from 'svelte';
	import ImageZoom from '$lib/components/viewer/ImageZoom.svelte';
	import { MONTHS, currentFrom, withFrom } from '$lib/viewer/nav';

	const { data } = $props();

	const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

	function mdLabel(key: string): string {
		const [m, d] = key.split('-').map(Number);
		return `${MONTHS[m - 1]} ${d}`;
	}
	function shortDate(entryDate: string): string {
		return new Date(entryDate + 'T00:00:00Z').toLocaleDateString('en-US', {
			month: 'short',
			day: 'numeric',
			year: 'numeric',
			timeZone: 'UTC'
		});
	}
	function savedOn(iso: string): string {
		return new Date(iso).toLocaleDateString('en-US', {
			month: 'short',
			day: 'numeric',
			year: 'numeric'
		});
	}

	const agoLine = (yearsAgo: number, weekday: string) =>
		yearsAgo > 0 ? `${yearsAgo} ${yearsAgo === 1 ? 'year' : 'years'} ago · ${weekday}` : weekday;

	const dateLabel = $derived(mdLabel(data.date.key));
	const from = $derived(currentFrom(page.url));

	// Date picker (month + day, any year). Plain GET form, so it works
	// without JavaScript; with JS, picking a month/day navigates at once.
	let pickMonth = $state(0);
	let pickDay = $state(0);
	$effect.pre(() => {
		pickMonth = data.date.month;
		pickDay = data.date.day;
	});
	const daysInPicked = $derived(DAYS_IN_MONTH[pickMonth - 1] ?? 31);
	let pickerOpen = $state(false);

	function pickGo(e: SubmitEvent) {
		e.preventDefault();
		const day = Math.min(pickDay, daysInPicked);
		pickerOpen = false;
		goto(`/app?date=${String(pickMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
	}

	// One shared full-screen viewer for the handwriting thumbnails.
	let zoom: ImageZoom | undefined = $state();
	let zoomDate = $state<string | null>(null);
	async function openZoom(entryDate: string) {
		zoomDate = entryDate;
		await tick(); // let the src/labels update before the dialog opens
		zoom?.open();
	}
	const zoomMonthLabel = $derived.by(() => {
		if (!zoomDate) return null;
		const [y, m] = zoomDate.split('-').map(Number);
		return `The whole ${MONTHS[m - 1]} ${y} page`;
	});
</script>

<svelte:head>
	<title>{data.isToday ? 'Today' : dateLabel} — Vorwaller Family History</title>
</svelte:head>

<div class="v-page wide today">
	{#if data.leadStory}
		<section class="lead" aria-labelledby="lead-h">
			<a class="v-card story" href="/app/year/{data.leadStory.year}#story">
				<p class="v-eyebrow">Year story</p>
				<h2 id="lead-h">The story of {data.leadStory.year}</h2>
				<p class="teaser">{data.leadStory.teaser}</p>
				<p class="v-provenance">
					<b>AI-written</b> from Madonna's {data.leadStory.year} calendar, reviewed before publishing
					·
					<span class="read">Read the story ▸</span>
				</p>
			</a>
		</section>
	{/if}

	<section class="main" aria-labelledby="otd-h">
		<p class="v-eyebrow">{data.isToday ? 'Today · On this day' : 'On this day'}</p>
		<h1 id="otd-h" class="v-title">{dateLabel}</h1>

		<div class="date-nav">
			<a
				class="arrow"
				href="/app?date={data.prevKey}"
				aria-label="Previous date, {mdLabel(data.prevKey)}">‹</a
			>
			<details class="picker" bind:open={pickerOpen}>
				<summary>📅 Pick a date</summary>
				<form method="GET" action="/app" class="picker-form" onsubmit={pickGo}>
					<label>
						<span>Month</span>
						<select name="m" bind:value={pickMonth}>
							{#each MONTHS as name, i (name)}
								<option value={i + 1}>{name}</option>
							{/each}
						</select>
					</label>
					<label>
						<span>Day</span>
						<select name="d" bind:value={pickDay}>
							{#each Array.from({ length: daysInPicked }, (_, i) => i + 1) as n (n)}
								<option value={n}>{n}</option>
							{/each}
						</select>
					</label>
					<button type="submit" class="v-btn primary">Go</button>
				</form>
			</details>
			<a
				class="arrow"
				href="/app?date={data.nextKey}"
				aria-label="Next date, {mdLabel(data.nextKey)}">›</a
			>
		</div>
		{#if !data.isToday}
			<p class="back-today"><a href="/app">Back to today</a></p>
		{/if}

		{#if data.entries.length === 0}
			<div class="v-empty">
				<div class="icon" aria-hidden="true">🗓️</div>
				<h2>No entries for {dateLabel} yet</h2>
				{#if data.date.month === 2 && data.date.day === 29}
					<p>Leap days are rare, and only some years have been transcribed so far.</p>
				{:else}
					<p>Only some years have been transcribed so far.</p>
				{/if}
				{#if data.nearest}
					<a class="v-btn primary" href="/app?date={data.nearest.key}">
						See {mdLabel(data.nearest.key)} ({data.nearest.count}
						{data.nearest.count === 1 ? 'entry' : 'entries'})
					</a>
				{/if}
			</div>
		{:else}
			<p class="v-sub count-line">
				{data.entries.length}
				{data.entries.length === 1 ? 'year has' : 'years have'} an entry for this date
			</p>
			<ul class="entries">
				{#each data.entries as e (e.entryDate)}
					<li class="v-card entry" class:has-thumb={e.hasImage}>
						<a class="entry-link" href={withFrom(`/app/day/${e.entryDate}`, from)}>
							<span class="entry-head">
								<span class="year">{e.year}</span>
								<span class="ago">{agoLine(e.yearsAgo, e.weekday)}</span>
								{#if e.hasMemory}
									<span class="v-mem-flag">🗨 Madonna remembers</span>
								{/if}
							</span>
							{#if e.preview}
								<span class="snippet">{e.preview}</span>
							{/if}
							<span class="more">Read the day ▸</span>
						</a>
						{#if e.hasImage}
							<button
								type="button"
								class="thumb"
								onclick={() => openZoom(e.entryDate)}
								aria-label="See the handwriting for {shortDate(e.entryDate)}"
							>
								<img src="/app/day/{e.entryDate}/image?w=240" alt="" loading="lazy" />
							</button>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	{#if data.latestSaved}
		<section class="more-stories" aria-labelledby="fs-h">
			<div class="v-section-h">
				<h2 id="fs-h">Latest family story</h2>
				<a href="/app/stories">All stories ▸</a>
			</div>
			<a class="v-card qa" href="/app/stories/{data.latestSaved.id}">
				<h3>{data.latestSaved.question}</h3>
				<p class="v-provenance">
					<b>AI-written</b> from {data.latestSaved.dayCount}
					{data.latestSaved.dayCount === 1 ? 'day' : 'days'} · saved {savedOn(
						data.latestSaved.createdAt
					)}
				</p>
			</a>
		</section>
	{/if}

	<section class="extra" aria-labelledby="recent-h">
		{#if data.recent.length > 0}
			<div class="v-section-h">
				<h2 id="recent-h">Recently added</h2>
			</div>
			<ul class="recent v-card">
				{#each data.recent as r (r.entryDate)}
					<li>
						<a href={withFrom(`/app/day/${r.entryDate}`, from)}>
							<b>{shortDate(r.entryDate)}</b>
							{#if r.snippet}<span>{r.snippet}</span>{/if}
						</a>
					</li>
				{/each}
			</ul>
		{:else}
			<h2 id="recent-h" class="v-sr">More to read</h2>
		{/if}
		<a class="v-btn secondary block surprise" href="/app/surprise" data-sveltekit-reload
			>🎲 Surprise me: a random day</a
		>
	</section>

	<p class="growing">The archive grows every week as Madonna works through the calendars.</p>
</div>

<ImageZoom
	bind:this={zoom}
	src={zoomDate ? `/app/day/${zoomDate}/image` : ''}
	alt={zoomDate ? `Madonna's handwriting for ${shortDate(zoomDate)}` : 'Handwriting'}
	dayHref={zoomDate ? withFrom(`/app/day/${zoomDate}`, from) : null}
	monthHref={zoomDate ? withFrom(`/app/month/${zoomDate.slice(0, 7)}`, from) : null}
	monthLabel={zoomMonthLabel}
/>

<style>
	.today {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		grid-template-areas: 'lead' 'main' 'more' 'extra' 'growing';
		gap: 0 28px;
	}
	.lead {
		grid-area: lead;
		margin-bottom: 22px;
	}
	.main {
		grid-area: main;
	}
	.more-stories {
		grid-area: more;
	}
	.extra {
		grid-area: extra;
	}
	.growing {
		grid-area: growing;
		text-align: center;
		color: var(--color-ink-muted);
		font-size: 16px;
		margin: 28px 0 0;
	}
	@media (min-width: 1024px) {
		.today {
			grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr);
			grid-template-areas: 'main lead' 'main more' 'main extra' 'growing growing';
			align-items: start;
			grid-template-rows: auto auto 1fr auto;
		}
		.more-stories .v-section-h {
			margin-top: 0;
		}
	}

	.story h2 {
		font-family: var(--font-serif);
		font-size: 22px;
		margin: 4px 0 6px;
	}
	.teaser {
		margin: 0;
		font-family: var(--font-serif);
		line-height: 1.6;
	}
	.read {
		color: var(--color-evergreen);
		font-weight: 700;
	}
	.recent {
		list-style: none;
		margin: 0;
		padding: 4px 16px;
	}
	.recent li + li {
		border-top: 1px solid var(--color-border);
	}
	.recent a {
		display: flex;
		flex-direction: column;
		justify-content: center;
		min-height: 52px;
		padding: 8px 0;
		color: inherit;
		text-decoration: none;
	}
	.recent b {
		color: var(--color-evergreen-dark);
		font-size: 16px;
	}
	.recent span {
		font-family: var(--font-serif);
		font-size: 17px;
		line-height: 1.4;
		overflow: hidden;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
	}
	.recent a:hover span {
		text-decoration: underline;
	}
	.surprise {
		margin-top: 14px;
	}
	.qa h3 {
		font-family: var(--font-serif);
		font-size: 20px;
		margin: 0;
	}

	/* Date navigator */
	.date-nav {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		margin: 8px 0 4px;
	}
	.arrow {
		flex: 0 0 auto;
		width: 48px;
		height: 48px;
		border-radius: 999px;
		border: 1px solid var(--color-border);
		background: var(--color-paper);
		display: grid;
		place-items: center;
		font-size: 30px;
		line-height: 1;
		padding-bottom: 4px;
		color: var(--color-ink);
		text-decoration: none;
	}
	.arrow:hover {
		border-color: var(--color-ink-muted);
	}
	.picker {
		flex: 1;
		min-width: 0;
	}
	.picker > summary {
		list-style: none;
		min-height: 48px;
		border-radius: 999px;
		border: 1px solid var(--color-border);
		background: var(--color-paper);
		display: flex;
		align-items: center;
		justify-content: center;
		font-weight: 700;
		cursor: pointer;
	}
	.picker > summary::-webkit-details-marker {
		display: none;
	}
	.picker[open] > summary {
		border-color: var(--color-evergreen);
	}
	.picker-form {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: 10px;
		margin-top: 8px;
		padding: 12px;
		background: var(--color-paper);
		border: 1px solid var(--color-border);
		border-radius: var(--radius);
	}
	.picker-form label {
		display: flex;
		flex-direction: column;
		gap: 2px;
		font-size: 15px;
		font-weight: 700;
		color: var(--color-ink-muted);
	}
	.picker-form select {
		min-height: 48px;
		border-radius: 10px;
		border: 1px solid var(--color-ink-muted);
		background: #fff;
		color: var(--color-ink);
		padding: 0 10px;
	}
	.back-today {
		margin: 4px 0 0;
		text-align: center;
	}
	.back-today a {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		color: var(--color-evergreen);
		font-weight: 700;
	}
	.count-line {
		text-align: center;
		margin: 6px 0 14px;
	}
	.v-empty {
		margin-top: 16px;
	}

	/* Entry cards: text first, a small handwriting thumbnail beside */
	.entries {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.entry {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 12px;
		padding: 0;
		overflow: hidden;
	}
	.entry.has-thumb {
		grid-template-columns: minmax(0, 1fr) 98px;
	}
	.entry-link {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 14px 0 6px 16px;
		color: inherit;
		text-decoration: none;
	}
	.entry:not(.has-thumb) .entry-link {
		padding-right: 16px;
	}
	.entry-head {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 4px 10px;
	}
	.year {
		font-family: var(--font-serif);
		font-size: 24px;
		font-weight: 700;
		color: var(--color-evergreen-dark);
	}
	.ago {
		font-size: 15px;
		color: var(--color-ink-muted);
	}
	.snippet {
		font-family: var(--font-serif);
		font-size: 19px;
		line-height: 1.6;
		overflow-wrap: anywhere;
	}
	.more {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		font-weight: 700;
		font-size: 16px;
		color: var(--color-evergreen);
	}
	.entry-link:hover .more {
		text-decoration: underline;
	}
	.thumb {
		align-self: start;
		width: 84px;
		height: 84px;
		margin: 14px 14px 0 0;
		padding: 0;
		border: 1px solid var(--color-border);
		border-radius: 8px;
		background: #f4ecd6;
		overflow: hidden;
		cursor: zoom-in;
	}
	.thumb img {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: cover;
		object-position: top left;
	}
</style>
