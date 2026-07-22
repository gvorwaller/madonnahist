<script lang="ts">
	import MonthGrid from '$components/MonthGrid.svelte';

	const { data } = $props();

	const monthNames = [
		'January', 'February', 'March', 'April', 'May', 'June',
		'July', 'August', 'September', 'October', 'November', 'December'
	];

	const yearHasAcceptedDays = $derived(
		data.validYear && data.months.some((m) => m.acceptedDays.length > 0)
	);
</script>

<svelte:head>
	<title>{data.validYear ? data.year : 'Year'} — madonnahist</title>
</svelte:head>

<div class="year-page">
	<a href="/app/browse" class="back-link">&larr; Back to Browse</a>

	{#if !data.validYear}
		<div class="empty-state">
			<h1>Not a valid year</h1>
			<p>That doesn't look like a year in this archive.</p>
			<a href="/app/browse" class="btn-primary">Back to Browse</a>
		</div>
	{:else}
		<nav class="year-nav" aria-label="Year navigation">
			{#if data.prevYear}
				<a href="/app/year/{data.prevYear}" class="year-chevron">&#9666; {data.prevYear}</a>
			{:else}
				<span class="year-chevron disabled">&#9666;</span>
			{/if}
			<h1 class="year-title">{data.year}</h1>
			{#if data.nextYear}
				<a href="/app/year/{data.nextYear}" class="year-chevron">{data.nextYear} &#9656;</a>
			{:else}
				<span class="year-chevron disabled">&#9656;</span>
			{/if}
		</nav>

		{#if !yearHasAcceptedDays}
			<p class="empty-hint">
				No transcribed days for {data.year} yet — check back as correction continues
				({data.coverage.accepted} of {data.coverage.total} days transcribed so far).
			</p>
		{/if}

		<div class="months">
			{#each data.months as m (m.month)}
				<MonthGrid year={data.year} month={m.month} acceptedDays={m.acceptedDays} />
				{#if m.acceptedDays.length === 0}
					<p class="month-empty">No transcribed days in {monthNames[m.month - 1]} {data.year} yet.</p>
				{/if}
			{/each}
		</div>
	{/if}
</div>

<style>
	.year-page {
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

	.year-nav {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		margin: 0.25rem 0 0.75rem;
	}
	.year-title {
		font-family: var(--font-sans);
		font-size: 1.4rem;
		margin: 0;
		color: var(--color-ink);
	}
	.year-chevron {
		display: flex;
		align-items: center;
		min-height: 48px;
		padding: 0 0.6rem;
		font-family: var(--font-sans);
		font-weight: 600;
		font-size: 0.95rem;
		color: var(--color-evergreen-dark);
		text-decoration: none;
		border-radius: 8px;
	}
	.year-chevron:hover {
		background: var(--color-chip-bg);
	}
	.year-chevron:focus-visible {
		outline: 2px solid var(--color-evergreen-dark);
		outline-offset: 2px;
	}
	.year-chevron.disabled {
		color: var(--color-ink-muted);
		opacity: 0.5;
	}

	.empty-hint {
		font-family: var(--font-serif);
		font-size: 0.95rem;
		line-height: 1.6;
		color: var(--color-ink-muted);
		margin: 0 0 1rem;
	}

	.months {
		display: flex;
		flex-direction: column;
	}
	.month-empty {
		margin: -0.75rem 0 1rem;
		font-family: var(--font-sans);
		font-size: 0.8rem;
		color: var(--color-ink-muted);
		font-style: italic;
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
</style>
