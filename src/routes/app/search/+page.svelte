<script lang="ts">
	import { page } from '$app/state';
	const { data } = $props();

	function pageHref(targetPage: number): string {
		const params = new URLSearchParams();
		if (data.q) params.set('q', data.q);
		if (data.year) params.set('year', String(data.year));
		if (data.tag) params.set('tag', data.tag);
		if (data.person) params.set('person', data.person);
		if (data.place) params.set('place', data.place);
		if (targetPage > 1) params.set('page', String(targetPage));
		const qs = params.toString();
		return qs ? `/app/search?${qs}` : '/app/search';
	}

	const selectedTagLabel = $derived(
		data.tag ? (data.tagOptions.find((t) => t.slug === data.tag)?.label ?? data.tag) : null
	);
	const selectedPersonLabel = $derived(
		data.person ? (data.personOptions.find((p) => p.slug === data.person)?.label ?? data.person) : null
	);
	const selectedPlaceLabel = $derived(
		data.place ? (data.placeOptions.find((p) => p.slug === data.place)?.label ?? data.place) : null
	);
</script>

<svelte:head>
	<title>Search — madonnahist</title>
</svelte:head>

<div class="search-page">
	<h1>Search</h1>

	<p class="coverage-banner">
		Searching {data.coverage.accepted} of {data.coverage.total} transcribed days ({data.coverage.percent}%)
		— more entries appear as correction continues.
	</p>

	<form method="GET" class="search-form">
		<input
			type="search"
			name="q"
			value={data.q}
			placeholder="Search entries…"
			maxlength="200"
			aria-label="Search entries"
			class="search-input"
		/>
		<label class="year-filter">
			<span class="year-label">Year:</span>
			<select name="year" value={data.year ?? ''}>
				<option value="">any year</option>
				{#each data.years as y (y)}
					<option value={y}>{y}</option>
				{/each}
			</select>
		</label>
		<label class="year-filter">
			<span class="year-label">Tag:</span>
			<select name="tag" value={data.tag ?? ''}>
				<option value="">any tag</option>
				{#each data.tagOptions as t (t.slug)}
					<option value={t.slug}>{t.label}</option>
				{/each}
			</select>
		</label>
		<label class="year-filter">
			<span class="year-label">Person:</span>
			<select name="person" value={data.person ?? ''}>
				<option value="">anyone</option>
				{#each data.personOptions as p (p.slug)}
					<option value={p.slug}>{p.label}</option>
				{/each}
			</select>
		</label>
		<label class="year-filter">
			<span class="year-label">Place:</span>
			<select name="place" value={data.place ?? ''}>
				<option value="">anywhere</option>
				{#each data.placeOptions as p (p.slug)}
					<option value={p.slug}>{p.label}</option>
				{/each}
			</select>
		</label>
		<button type="submit" class="search-btn">Search</button>
	</form>

	{#if !data.searched}
		<p class="hint">Search sixty years of transcribed calendar entries — try a name, place, or activity.</p>
	{:else if data.results.length === 0}
		<p class="hint">
			{#if data.q}
				No results for "{data.q}"{#if selectedTagLabel} tagged "{selectedTagLabel}"{/if}{#if selectedPersonLabel} mentioning {selectedPersonLabel}{/if}{#if selectedPlaceLabel} at {selectedPlaceLabel}{/if}. Try different filters.
			{:else}
				No accepted days match{#if selectedTagLabel} tag "{selectedTagLabel}"{/if}{#if selectedPersonLabel} person "{selectedPersonLabel}"{/if}{#if selectedPlaceLabel} place "{selectedPlaceLabel}"{/if} yet.
			{/if}
		</p>
	{:else}
		<p class="result-count">
			{data.total} result{data.total === 1 ? '' : 's'}{#if selectedTagLabel} tagged "{selectedTagLabel}"{/if}{#if selectedPersonLabel} mentioning {selectedPersonLabel}{/if}{#if selectedPlaceLabel} at {selectedPlaceLabel}{/if}
		</p>

		<ul class="results">
			{#each data.results as result (result.entryDate)}
				<li>
					<a class="result-card" href="/app/day/{result.entryDate}?from={encodeURIComponent(page.url.pathname + page.url.search)}">
						<div class="result-date">{result.dateLabel}</div>
						<p class="result-snippet">
							{#each result.segments as seg, i (i)}
								{#if seg.highlight}<mark>{seg.text}</mark>{:else}{seg.text}{/if}
							{/each}
						</p>
					</a>
				</li>
			{/each}
		</ul>

		{#if data.totalPages > 1}
			<nav class="pager" aria-label="Search results pages">
				{#if data.page > 1}
					<a href={pageHref(data.page - 1)} class="pager-btn">&larr; Previous</a>
				{:else}
					<span class="pager-btn disabled">&larr; Previous</span>
				{/if}
				<span class="pager-status">Page {data.page} of {data.totalPages}</span>
				{#if data.page < data.totalPages}
					<a href={pageHref(data.page + 1)} class="pager-btn">Next &rarr;</a>
				{:else}
					<span class="pager-btn disabled">Next &rarr;</span>
				{/if}
			</nav>
		{/if}
	{/if}
</div>

<style>
	.search-page {
		padding: 1rem;
	}
	h1 {
		font-family: var(--font-sans);
		font-size: 1.25rem;
		margin: 0.5rem 0 0.75rem;
	}
	.coverage-banner {
		font-family: var(--font-sans);
		font-size: 0.8rem;
		color: var(--color-ink-muted);
		margin: 0 0 1rem;
	}
	.search-form {
		display: flex;
		flex-wrap: wrap;
		gap: 0.6rem;
		margin-bottom: 1.25rem;
	}
	.search-input {
		flex: 1 1 100%;
		min-height: 48px;
		font-size: 1rem;
		font-family: var(--font-sans);
		padding: 0.6rem 0.8rem;
		border: 1px solid var(--color-border);
		border-radius: 8px;
		background: var(--color-paper);
		color: var(--color-ink);
		box-sizing: border-box;
	}
	.search-input:focus-visible {
		outline: 2px solid var(--color-evergreen-dark);
		outline-offset: 1px;
	}
	.year-filter {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		font-family: var(--font-sans);
		font-size: 0.85rem;
		color: var(--color-ink-muted);
	}
	.year-filter select {
		min-height: 48px;
		font-size: 0.95rem;
		padding: 0.3rem 0.5rem;
		border: 1px solid var(--color-border);
		border-radius: 6px;
		background: var(--color-paper);
		color: var(--color-ink);
	}
	.year-filter select:focus-visible {
		outline: 2px solid var(--color-evergreen-dark);
		outline-offset: 1px;
	}
	.search-btn {
		min-height: 48px;
		padding: 0.5rem 1.25rem;
		border: none;
		border-radius: 8px;
		background: var(--color-evergreen);
		color: #fff;
		font-family: var(--font-sans);
		font-weight: 700;
		font-size: 0.95rem;
		cursor: pointer;
	}
	.search-btn:focus-visible {
		outline: 2px solid var(--color-ink);
		outline-offset: 2px;
	}
	.hint {
		font-family: var(--font-serif);
		font-size: 1.05rem;
		color: var(--color-ink-muted);
		line-height: 1.6;
	}
	.result-count {
		font-family: var(--font-sans);
		font-size: 0.85rem;
		color: var(--color-ink-muted);
		margin: 0 0 0.75rem;
	}
	.results {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.85rem;
	}
	.result-card {
		display: block;
		background: var(--color-paper);
		border: 1px solid var(--color-border);
		border-radius: 8px;
		padding: 0.85rem 1rem;
		text-decoration: none;
		color: inherit;
	}
	.result-card:focus-visible {
		outline: 2px solid var(--color-evergreen-dark);
		outline-offset: 2px;
	}
	.result-date {
		font-family: var(--font-sans);
		font-weight: 700;
		font-size: 0.95rem;
		color: var(--color-evergreen-dark);
		margin-bottom: 0.35rem;
	}
	.result-snippet {
		font-family: var(--font-serif);
		font-size: 1rem;
		line-height: 1.55;
		color: var(--color-ink);
		margin: 0;
	}
	.result-snippet mark {
		background: var(--color-highlight-bg);
		color: var(--color-ink);
		border-radius: 2px;
		padding: 0 0.1rem;
	}
	.pager {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		margin-top: 1.5rem;
	}
	.pager-btn {
		min-height: 48px;
		display: flex;
		align-items: center;
		padding: 0 1rem;
		border: 1px solid var(--color-evergreen);
		border-radius: 8px;
		color: var(--color-evergreen-dark);
		font-family: var(--font-sans);
		font-weight: 600;
		font-size: 0.9rem;
		text-decoration: none;
	}
	.pager-btn.disabled {
		border-color: var(--color-border);
		color: var(--color-ink-muted);
		opacity: 0.6;
	}
	.pager-btn:focus-visible {
		outline: 2px solid var(--color-evergreen-dark);
		outline-offset: 2px;
	}
	.pager-status {
		font-family: var(--font-sans);
		font-size: 0.85rem;
		color: var(--color-ink-muted);
	}
</style>
