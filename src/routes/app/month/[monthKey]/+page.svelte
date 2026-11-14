<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { page } from '$app/state';
	import ImageZoom from '$lib/components/viewer/ImageZoom.svelte';
	import { MONTHS, backLabel, backTarget, withFrom } from '$lib/viewer/nav';

	const { data } = $props();

	// Back goes where the reader came from (validated /app path), else this
	// month's year page.
	const fromParam = $derived(page.url.searchParams.get('from'));
	const backHref = $derived(
		backTarget(fromParam, data.found ? `/app/year/${data.year}` : '/app/timeline')
	);
	const backText = $derived(backLabel(backHref));

	const monthName = $derived(data.found || data.reason === 'missing' ? MONTHS[data.month - 1] : '');
	const monthTitle = $derived(data.found ? `${monthName} ${data.year}` : null);
	const here = $derived(`/app/month/${data.monthKey}`);

	/** Day of this month the reader came from, outlined in amber on the photo. */
	const currentDay = $derived.by(() => {
		if (!data.found || !fromParam) return null;
		const m = /^\/app\/day\/(\d{4}-\d{2})-(\d{2})(?:\?|$)/.exec(fromParam);
		return m && m[1] === data.monthKey ? Number(m[2]) : null;
	});

	const monthLabel = (key: string) =>
		`${MONTHS[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;

	function fmt(entryDate: string, opts: Intl.DateTimeFormatOptions): string {
		return new Date(entryDate + 'T00:00:00Z').toLocaleDateString('en-US', {
			...opts,
			timeZone: 'UTC'
		});
	}

	type Item =
		| { kind: 'day'; entryDate: string; text: string; hasMemory: boolean }
		| { kind: 'gap'; text: string };

	/** Reading list with a line for each run of days not transcribed yet. */
	const items = $derived.by((): Item[] => {
		if (!data.found || data.days.length === 0) return [];
		const last = new Date(Date.UTC(data.year, data.month, 0)).getUTCDate();
		const byDay = new Map(data.days.map((d) => [Number(d.entryDate.slice(8, 10)), d]));
		const out: Item[] = [];
		let gapStart: number | null = null;
		const closeGap = (end: number) => {
			if (gapStart === null) return;
			const what =
				gapStart === end ? `${monthName} ${gapStart}` : `${monthName} ${gapStart}–${end}`;
			out.push({
				kind: 'gap',
				text: `${what} ${gapStart === end ? "isn't" : "aren't"} transcribed yet.`
			});
			gapStart = null;
		};
		for (let day = 1; day <= last; day++) {
			const d = byDay.get(day);
			if (d) {
				closeGap(day - 1);
				out.push({ kind: 'day', ...d });
			} else if (gapStart === null) {
				gapStart = day;
			}
		}
		closeGap(last);
		return out;
	});

	// Tap targets are drawn only once the served image is known to have the
	// shape the crop bounds were measured on (plan: CODEX #8).
	let img: HTMLImageElement | undefined = $state();
	let cellsOk = $state(false);
	let imgFailed = $state(false);
	function checkImage() {
		if (!img || !data.found || !data.photo || img.naturalWidth === 0) return;
		const served = img.naturalWidth / img.naturalHeight;
		const expected = data.photo.width / data.photo.height;
		cellsOk = Math.abs(served - expected) / expected < 0.015;
	}
	onMount(() => {
		if (img?.complete) checkImage();
	});
	const showCells = $derived(cellsOk && data.found && (data.photo?.cells.length ?? 0) > 0);

	let zoom: ImageZoom | undefined = $state();
	async function openZoom() {
		await tick();
		zoom?.open();
	}
</script>

<svelte:head>
	<title>{monthTitle ?? 'Month'} — Vorwaller Family History</title>
</svelte:head>

{#snippet cells()}
	{#if data.found && data.photo && showCells}
		{#each data.photo.cells as c (c.day)}
			{@const style = `left:${c.left}%;top:${c.top}%;width:${c.width}%;height:${c.height}%`}
			{#if c.ready}
				{@const date = `${data.monthKey}-${String(c.day).padStart(2, '0')}`}
				<a
					class="cell ready"
					class:current={c.day === currentDay}
					{style}
					href={withFrom(`/app/day/${date}`, here)}
					aria-label="{monthName} {c.day}, read this day"
					><span class="tick" aria-hidden="true">✓</span></a
				>
			{:else}
				<span class="cell notyet" {style} aria-hidden="true"></span>
			{/if}
		{/each}
	{/if}
{/snippet}

<div class="v-page wide">
	<a class="v-back" href={backHref}>◂ {backText}</a>

	{#if !data.found}
		<div class="v-empty">
			<div class="icon" aria-hidden="true">🗓️</div>
			<h1 class="v-title">{data.reason === 'invalid' ? 'Not a valid month' : 'Not captured yet'}</h1>
			<p>
				{#if data.reason === 'invalid'}
					That doesn't look like a month in this archive.
				{:else}
					The page for {monthName}
					{data.year} hasn't been photographed yet. Check back later.
				{/if}
			</p>
			<a class="v-btn primary" href={backHref}>◂ {backText}</a>
		</div>
	{:else}
		<nav class="month-nav" aria-label="Other months">
			{#if data.prevMonth}
				<a
					class="arrow"
					href="/app/month/{data.prevMonth}"
					aria-label="Previous month, {monthLabel(data.prevMonth)}">‹</a
				>
			{:else}
				<span class="arrow off" aria-hidden="true">‹</span>
			{/if}
			<h1 class="m">{monthTitle}</h1>
			{#if data.nextMonth}
				<a
					class="arrow"
					href="/app/month/{data.nextMonth}"
					aria-label="Next month, {monthLabel(data.nextMonth)}">›</a
				>
			{:else}
				<span class="arrow off" aria-hidden="true">›</span>
			{/if}
		</nav>
		<p class="v-sub center">
			{#if data.days.length > 0}
				{data.days.length}
				{data.days.length === 1 ? 'day' : 'days'} to read
			{:else}
				Nothing transcribed yet
			{/if}
		</p>

		<div class="layout">
			<div class="photo-col">
				{#if imgFailed}
					<p class="img-missing">
						The photo of this page isn't available right now. The days below are complete.
					</p>
				{:else}
					<div
						class="photo"
						role="group"
						aria-label="Madonna's {monthTitle} calendar page{showCells
							? '. Outlined days can be opened.'
							: ''}"
					>
						<img
							bind:this={img}
							src="/app/month/{data.monthKey}/page-image"
							alt="Madonna's calendar page for {monthTitle}"
							onload={checkImage}
							onerror={() => (imgFailed = true)}
						/>
						{@render cells()}
					</div>
					{#if showCells}
						<ul class="legend">
							<li><i class="sw ready" aria-hidden="true">✓</i> Green outline: ready to read, tap it</li>
							<li><i class="sw notyet" aria-hidden="true"></i> Shaded: not transcribed yet</li>
						</ul>
					{/if}
					<div class="v-actions">
						<button type="button" class="v-btn secondary" onclick={openZoom}>🔍 Zoom in</button>
					</div>
				{/if}
			</div>

			<section class="reading-col" aria-labelledby="reading-h">
				<div class="v-section-h">
					<h2 id="reading-h">Every day this month</h2>
					{#if data.days.length > 0}<span class="v-count">{data.days.length}</span>{/if}
				</div>
				{#if items.length === 0}
					<div class="v-empty">
						<div class="icon" aria-hidden="true">✍️</div>
						<h2>Nothing to read yet</h2>
						<p>
							Madonna hasn't transcribed any days from {monthTitle} yet. The photo above shows
							the page as she wrote it.
						</p>
					</div>
				{:else}
					<ul class="reading">
						{#each items as it, i (it.kind === 'day' ? it.entryDate : `gap-${i}`)}
							{#if it.kind === 'day'}
								<li>
									<div class="r-head">
										<a class="pill" href={withFrom(`/app/day/${it.entryDate}`, here)}
											>{fmt(it.entryDate, { weekday: 'short', month: 'short', day: 'numeric' })}<span
												class="v-sr">: open this day</span
											></a
										>
										{#if it.hasMemory}
											<span class="v-mem-flag">🗨 Madonna remembers</span>
										{/if}
									</div>
									<p class="diary">{it.text}</p>
								</li>
							{:else}
								<li class="gap">{it.text}</li>
							{/if}
						{/each}
					</ul>
				{/if}
			</section>
		</div>
	{/if}
</div>

{#if data.found && !imgFailed}
	<ImageZoom
		bind:this={zoom}
		src="/app/month/{data.monthKey}/page-image"
		alt="Madonna's calendar page for {monthTitle}, enlarged"
		overlay={cells}
	/>
{/if}

<style>
	.month-nav {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		margin: 4px 0 0;
	}
	.m {
		margin: 0;
		font-family: var(--font-serif);
		font-size: 29px;
		font-weight: 700;
		text-align: center;
		color: var(--color-ink);
	}
	.arrow {
		flex: none;
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
	a.arrow:hover {
		border-color: var(--color-ink-muted);
	}
	.arrow.off {
		visibility: hidden;
	}
	.center {
		text-align: center;
		margin: 2px 0 16px;
	}

	.layout {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 8px 32px;
	}
	@media (min-width: 1024px) {
		.layout {
			grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
			align-items: start;
		}
		.photo-col {
			position: sticky;
			top: calc(var(--topbar-h) + 16px);
		}
		.reading-col > .v-section-h {
			margin-top: 0;
		}
	}

	/* Tap targets sit over the photo, positioned in percent of the image. */
	.photo {
		position: relative;
		border: 1px solid var(--color-border);
		border-radius: 10px;
		overflow: hidden;
		background: #f4ecd6;
	}
	.photo img {
		display: block;
		width: 100%;
		height: auto;
	}
	.cell {
		position: absolute;
		box-sizing: border-box;
	}
	a.cell.ready {
		box-shadow: inset 0 0 0 2px var(--color-evergreen);
		border-radius: 3px;
	}
	a.cell.ready:hover {
		box-shadow: inset 0 0 0 3px var(--color-evergreen);
		background: rgba(32, 77, 58, 0.1);
	}
	a.cell.ready:focus-visible {
		outline: 3px solid var(--color-amber);
		outline-offset: 0;
	}
	a.cell.current {
		box-shadow: inset 0 0 0 3px var(--color-amber);
	}
	.tick {
		position: absolute;
		top: 2px;
		right: 2px;
		width: 16px;
		height: 16px;
		border-radius: 50%;
		display: grid;
		place-items: center;
		background: var(--color-evergreen);
		color: #fff;
		font-size: 11px;
		font-weight: 700;
		line-height: 1;
	}
	/* Not transcribed yet: a cream wash with hatching (shape, not just color). */
	.cell.notyet {
		background: repeating-linear-gradient(
			135deg,
			rgba(250, 246, 236, 0.62) 0 6px,
			rgba(222, 212, 189, 0.62) 6px 9px
		);
	}

	.legend {
		list-style: none;
		margin: 10px 0 0;
		padding: 0;
		display: flex;
		flex-wrap: wrap;
		gap: 6px 18px;
		font-size: 15px;
		color: var(--color-ink-muted);
	}
	.legend li {
		display: inline-flex;
		align-items: center;
		gap: 8px;
	}
	.sw {
		width: 22px;
		height: 18px;
		border-radius: 3px;
		display: grid;
		place-items: center;
		font-style: normal;
		font-size: 12px;
		font-weight: 700;
	}
	.sw.ready {
		box-shadow: inset 0 0 0 2px var(--color-evergreen);
		color: var(--color-evergreen);
		background: var(--color-paper);
	}
	.sw.notyet {
		border: 1px solid var(--color-border);
		background: repeating-linear-gradient(135deg, #faf6ec 0 6px, #ded4bd 6px 9px);
	}
	.img-missing {
		margin: 0;
		padding: 14px;
		border: 1px dashed var(--color-ink-muted);
		border-radius: 10px;
		color: var(--color-ink-muted);
		font-size: 16px;
		text-align: center;
	}

	.reading {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.reading li {
		padding: 12px 0 14px;
		border-top: 1px solid var(--color-border);
	}
	.reading li:first-child {
		border-top: 0;
		padding-top: 0;
	}
	.r-head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px 12px;
		margin: 0 0 4px;
	}
	.pill {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		padding: 0 14px;
		border-radius: 999px;
		background: var(--color-evergreen-soft);
		color: var(--color-evergreen-dark);
		font-weight: 700;
		font-size: 16px;
		text-decoration: none;
	}
	.pill:hover {
		text-decoration: underline;
	}
	.diary {
		margin: 0;
		font-family: var(--font-serif);
		font-size: 19px;
		line-height: 1.65;
		max-width: 62ch;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.reading li.gap {
		padding: 10px 0;
		font-size: 16px;
		font-style: italic;
		color: var(--color-ink-muted);
	}
</style>
