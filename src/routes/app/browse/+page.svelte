<script lang="ts">
	const { data } = $props();
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
		{#each data.decades as group (group.decade)}
			<section class="decade-section">
				<h2 class="decade-title">{group.decade}s</h2>
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
			</section>
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
	.decade-section {
		margin-bottom: 1.5rem;
	}
	.decade-title {
		font-family: var(--font-sans);
		font-size: 1rem;
		font-weight: 700;
		color: var(--color-amber);
		text-transform: uppercase;
		letter-spacing: 0.04em;
		margin: 0 0 0.5rem;
		padding-bottom: 0.3rem;
		border-bottom: 1px solid var(--color-border);
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
