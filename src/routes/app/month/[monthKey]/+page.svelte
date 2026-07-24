<script lang="ts">
	import { page } from '$app/state';
	import MonthGrid from '$components/MonthGrid.svelte';

	const { data } = $props();

	const monthNames = [
		'January', 'February', 'March', 'April', 'May', 'June',
		'July', 'August', 'September', 'October', 'November', 'December'
	];

	let zoomOpen = $state(false);
	function closeZoom() {
		zoomOpen = false;
	}

	// Same back-navigation-memory pattern as /app/day/[date] — a page linking
	// here appends ?from=<encoded /app path>; falls back to this month's own
	// year page (always known) rather than a bare /app.
	const fromParam = $derived(page.url.searchParams.get('from'));
	const backHref = $derived.by(() => {
		if (fromParam && /^\/app(\/|\?|$)/.test(fromParam)) return fromParam;
		return data.found ? `/app/year/${data.year}` : '/app';
	});
	const backLabel = $derived.by(() => {
		if (backHref.startsWith('/app/year/')) {
			// Parsed straight from the href (not data.year) — the "from" param
			// (when present) is the actual page the visitor came from, which
			// isn't necessarily this month's own year.
			return `Back to ${backHref.slice('/app/year/'.length, '/app/year/'.length + 4)}`;
		}
		if (backHref.startsWith('/app/browse')) return 'Back to Browse';
		return 'Back to On this day';
	});

	const monthTitle = $derived(data.found ? `${monthNames[data.month - 1]} ${data.year}` : null);
</script>

<svelte:head>
	<title>{monthTitle ?? 'Month'} — madonnahist</title>
</svelte:head>

<svelte:window
	onkeydown={(e) => {
		if (e.key === 'Escape' && zoomOpen) closeZoom();
	}}
/>

<div class="month-page">
	<a href={backHref} class="back-link">&larr; {backLabel}</a>

	{#if !data.found}
		<div class="empty-state">
			<h1>{data.reason === 'invalid' ? 'Not a valid month' : 'Not captured yet'}</h1>
			<p>
				{#if data.reason === 'invalid'}
					That doesn't look like a month in this archive.
				{:else}
					This month ({monthNames[data.month - 1]} {data.year}) hasn't been captured yet — check
					back once its page has been photographed and ingested.
				{/if}
			</p>
			<a href={backHref} class="btn-primary">{backLabel}</a>
		</div>
	{:else}
		<h1 class="month-heading">{monthTitle}</h1>

		<button class="image-btn" onclick={() => (zoomOpen = true)}>
			<img
				class="month-image"
				src="/app/month/{data.monthKey}/page-image"
				alt="Calendar page for {monthTitle}"
			/>
			<span class="zoom-hint">Tap to zoom</span>
		</button>

		<p class="coverage-line">
			{#if data.coverage.total > 0}
				{data.coverage.accepted} of {data.coverage.total} days transcribed
			{:else}
				No days ingested for this month yet.
			{/if}
		</p>

		<MonthGrid
			year={data.year}
			month={data.month}
			acceptedDays={data.acceptedDays}
			linkSuffix={`?from=${encodeURIComponent(`/app/month/${data.monthKey}`)}`}
		/>
	{/if}
</div>

{#if zoomOpen}
	<div class="zoom-overlay" role="dialog" aria-label="Zoomed calendar page">
		<button class="zoom-close" onclick={closeZoom} aria-label="Close zoomed image">&times;</button>
		<div class="zoom-scroll">
			<img
				class="zoom-image"
				src="/app/month/{data.monthKey}/page-image"
				alt="Calendar page for {monthTitle}, zoomed"
			/>
		</div>
	</div>
{/if}

<style>
	.month-page {
		padding: 1rem;
	}
	.back-link {
		display: inline-flex;
		align-items: center;
		min-height: 48px;
		margin-bottom: 0.5rem;
		font-family: var(--font-sans);
		font-size: 0.9rem;
		color: var(--color-evergreen-dark);
		text-decoration: none;
	}
	.back-link:hover {
		text-decoration: underline;
	}
	.back-link:focus-visible {
		outline: 2px solid var(--color-evergreen-dark);
		outline-offset: 2px;
	}

	.month-heading {
		font-family: var(--font-sans);
		font-size: 1.25rem;
		margin: 0 0 0.75rem;
		color: var(--color-ink);
	}

	.image-btn {
		display: block;
		width: 100%;
		padding: 0;
		border: 1px solid var(--color-border);
		border-radius: 8px;
		background: var(--color-paper);
		cursor: zoom-in;
		position: relative;
		overflow: hidden;
	}
	.image-btn:focus-visible {
		outline: 2px solid var(--color-evergreen-dark);
		outline-offset: 2px;
	}
	.month-image {
		display: block;
		width: 100%;
		height: auto;
	}
	.zoom-hint {
		position: absolute;
		right: 0.5rem;
		bottom: 0.5rem;
		background: rgba(43, 38, 32, 0.72);
		color: #fff;
		font-family: var(--font-sans);
		font-size: 0.7rem;
		padding: 0.2rem 0.5rem;
		border-radius: 4px;
	}

	.coverage-line {
		margin: 0.75rem 0 1.25rem;
		font-family: var(--font-sans);
		font-size: 0.85rem;
		color: var(--color-ink-muted);
	}

	.empty-state {
		background: var(--color-paper);
		border: 1px solid var(--color-border);
		border-radius: 10px;
		padding: 1.5rem 1.25rem;
		text-align: center;
	}
	.empty-state h1 {
		font-family: var(--font-sans);
		font-size: 1.25rem;
		margin: 0 0 0.5rem;
	}
	.empty-state p {
		font-family: var(--font-serif);
		font-size: 1.05rem;
		line-height: 1.6;
		color: var(--color-ink-muted);
		margin: 0 0 1.25rem;
	}
	.btn-primary {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: 52px;
		padding: 0.6rem 1.5rem;
		border-radius: 8px;
		background: var(--color-evergreen);
		color: #fff;
		font-family: var(--font-sans);
		font-weight: 700;
		text-decoration: none;
	}
	.btn-primary:focus-visible {
		outline: 2px solid var(--color-ink);
		outline-offset: 2px;
	}

	.zoom-overlay {
		position: fixed;
		inset: 0;
		z-index: 100;
		background: rgba(20, 18, 14, 0.92);
		touch-action: pinch-zoom;
	}
	.zoom-scroll {
		width: 100%;
		height: 100%;
		overflow: auto;
		display: flex;
		align-items: flex-start;
		justify-content: center;
	}
	.zoom-image {
		max-width: 100%;
		height: auto;
		touch-action: pinch-zoom;
	}
	.zoom-close {
		position: fixed;
		top: 0.75rem;
		right: 1rem;
		z-index: 101;
		width: 48px;
		height: 48px;
		border-radius: 50%;
		border: none;
		background: rgba(255, 255, 255, 0.15);
		color: #fff;
		font-size: 1.75rem;
		line-height: 1;
		cursor: pointer;
	}
	.zoom-close:focus-visible {
		outline: 2px solid #fff;
		outline-offset: 2px;
	}
</style>
