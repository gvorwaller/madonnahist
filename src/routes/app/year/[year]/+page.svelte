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

	function pad(n: number): string {
		return String(n).padStart(2, '0');
	}

	// td-852d99: month names link to the full-page-image month view; the
	// "from" param lets /app/month/[monthKey] point Back at this year page.
	function monthHref(year: number, month: number): string {
		return `/app/month/${year}-${pad(month)}?from=${encodeURIComponent(`/app/year/${year}`)}`;
	}

	function narrativeParagraphs(text: string): string[] {
		return text.split(/\n{2,}/).map((p) => p.trim()).filter((p) => p.length > 0);
	}

	// Matches src/routes/admin/exports/+page.svelte's formatBytes exactly —
	// duplicated rather than shared, same small-per-route-helper precedent as
	// the pdfExportFilename() duplication between the two download endpoints.
	function formatBytes(n: number): string {
		if (!Number.isFinite(n) || n < 0) return '—';
		if (n < 1024) return `${n} B`;
		const units = ['KB', 'MB', 'GB'];
		let value = n / 1024;
		let unitIndex = 0;
		while (value >= 1024 && unitIndex < units.length - 1) {
			value /= 1024;
			unitIndex++;
		}
		return `${value.toFixed(1)} ${units[unitIndex]}`;
	}
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

		{#if yearHasAcceptedDays}
			<a href="/app/book/year/{data.year}" class="book-cta">Read {data.year} as a book &#9656;</a>
		{/if}

		{#if data.pdfExports.length > 0}
			<section class="downloads-block" aria-label="Print and download">
				<p class="downloads-heading">Print &amp; download</p>
				<ul class="downloads-list">
					{#each data.pdfExports as ex (ex.mode)}
						<li>
							<a href="/app/year/{data.year}/pdf?mode={ex.mode}" class="pdf-link" target="_blank" rel="noopener">
								{ex.mode === 'full'
									? `Full year PDF (${formatBytes(ex.byteSize)})`
									: ex.mode === 'narrative'
										? `Year summary only (${formatBytes(ex.byteSize)})`
										: `Days only (${formatBytes(ex.byteSize)})`}
							</a>
						</li>
					{/each}
				</ul>
			</section>
		{/if}

		{#if data.narrative}
			<section class="year-narrative">
				<p class="narrative-label">AI-generated year summary, reviewed by the family</p>
				{#each narrativeParagraphs(data.narrative) as para, i (i)}
					<p class="narrative-para">{para}</p>
				{/each}
			</section>
		{/if}

		{#if !yearHasAcceptedDays}
			<p class="empty-hint">
				No transcribed days for {data.year} yet — check back as correction continues
				({data.coverage.accepted} of {data.coverage.total} days transcribed so far).
			</p>
		{/if}

		<div class="months">
			{#each data.months as m (m.month)}
				<MonthGrid
					year={data.year}
					month={m.month}
					acceptedDays={m.acceptedDays}
					linkSuffix={`?from=${encodeURIComponent(`/app/year/${data.year}`)}`}
					titleHref={monthHref(data.year, m.month)}
				/>
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

	.book-cta {
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 52px;
		margin: 0 0 1.25rem;
		padding: 0.6rem 1rem;
		border-radius: 8px;
		background: var(--color-evergreen);
		color: #fff;
		font-family: var(--font-serif);
		font-size: 1.05rem;
		font-weight: 700;
		text-decoration: none;
		text-align: center;
	}
	.book-cta:hover {
		background: var(--color-evergreen-dark);
	}
	.book-cta:focus-visible {
		outline: 2px solid var(--color-ink);
		outline-offset: 2px;
	}

	.downloads-block {
		margin: 0.75rem 0 1rem;
		padding: 0.75rem 0.9rem;
		background: var(--color-paper);
		border: 1px solid var(--color-border);
		border-radius: 8px;
	}
	.downloads-heading {
		font-family: var(--font-sans);
		font-size: 0.8rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--color-ink-muted);
		margin: 0 0 0.4rem;
	}
	.downloads-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}
	.pdf-link {
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 44px;
		margin: -0.5rem 0 1.25rem;
		font-family: var(--font-sans);
		font-size: 0.85rem;
		font-weight: 600;
		color: var(--color-ink-muted);
		text-decoration: underline;
	}
	.pdf-link:hover {
		color: var(--color-evergreen-dark);
	}
	.pdf-link:focus-visible {
		outline: 2px solid var(--color-evergreen-dark);
		outline-offset: 2px;
	}

	.empty-hint {
		font-family: var(--font-serif);
		font-size: 0.95rem;
		line-height: 1.6;
		color: var(--color-ink-muted);
		margin: 0 0 1rem;
	}

	.year-narrative {
		background: var(--color-cream);
		border: 1px solid var(--color-border);
		border-radius: 10px;
		padding: 1.1rem 1.25rem;
		margin: 0 0 1.25rem;
	}
	.narrative-label {
		font-family: var(--font-sans);
		font-size: 0.75rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--color-amber);
		margin: 0 0 0.75rem;
	}
	.narrative-para {
		font-family: var(--font-serif);
		font-style: italic;
		font-size: 1.05rem;
		line-height: 1.65;
		color: var(--color-ink);
		margin: 0 0 0.85rem;
	}
	.narrative-para:last-child {
		margin-bottom: 0;
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
