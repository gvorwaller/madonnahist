<svelte:head>
	<title>Browse — madonnahist</title>
</svelte:head>

<div class="browse-stub">
	<h1>Browse</h1>
	<p class="coming">Coming soon</p>
	<p class="desc">
		Year and decade browsing — month grids of transcribed days, with narrative summaries and a
		"read as a book" view — lands in the next phase.
	</p>
	<a href="/app" class="back">&larr; On this day</a>
</div>

<style>
	.browse-stub {
		padding: 2rem 1rem;
		text-align: center;
	}
	h1 {
		font-family: var(--font-sans);
		font-size: 1.25rem;
		margin: 0 0 0.3rem;
	}
	.coming {
		font-family: var(--font-sans);
		color: var(--color-amber);
		font-size: 0.8rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		margin: 0 0 1.25rem;
	}
	.desc {
		font-family: var(--font-serif);
		font-size: 1.05rem;
		line-height: 1.6;
		color: var(--color-ink-muted);
		max-width: 32rem;
		margin: 0 auto 1.5rem;
	}
	.back {
		display: inline-flex;
		align-items: center;
		min-height: 48px;
		font-family: var(--font-sans);
		color: var(--color-evergreen-dark);
		text-decoration: none;
		font-weight: 600;
	}
	.back:hover {
		text-decoration: underline;
	}
</style>
