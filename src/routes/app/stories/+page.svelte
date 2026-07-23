<script lang="ts">
	const { data } = $props();

	function formatDate(iso: string): string {
		return new Date(iso).toLocaleDateString('en-US', {
			month: 'long',
			day: 'numeric',
			year: 'numeric'
		});
	}
</script>

<svelte:head>
	<title>Family stories — madonnahist</title>
</svelte:head>

<div class="stories-page">
	<a href="/app/search" class="back-link">&larr; Back to Search</a>

	<h1>Family stories</h1>
	<p class="intro">
		Answers to questions asked of the archive — each one written only from
		Madonna's transcribed calendar entries, and saved here after review.
		Tap a question to read the full story.
	</p>

	{#if data.stories.length === 0}
		<div class="empty-state">
			<p>No saved stories yet — they'll appear here as questions get asked and kept.</p>
		</div>
	{:else}
		<ul class="story-list">
			{#each data.stories as story (story.id)}
				<li>
					<a class="story-card" href="/app/stories/{story.id}">
						<h2 class="story-question">{story.question}</h2>
						<p class="story-meta">
							{story.dayCount} transcribed day{story.dayCount === 1 ? '' : 's'}
							&middot; {story.subsetSummary}
							&middot; saved {formatDate(story.createdAt)}
						</p>
					</a>
				</li>
			{/each}
		</ul>
	{/if}
</div>

<style>
	.stories-page {
		padding: 1rem;
		max-width: 640px;
		margin: 0 auto;
	}
	.back-link {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		font-family: var(--font-sans);
		font-size: 0.9rem;
		font-weight: 600;
		color: var(--color-evergreen-dark);
		text-decoration: none;
		margin-bottom: 0.25rem;
	}
	.back-link:hover {
		text-decoration: underline;
	}
	.back-link:focus-visible {
		outline: 2px solid var(--color-evergreen-dark);
		outline-offset: 2px;
	}
	h1 {
		font-family: var(--font-sans);
		font-size: 1.25rem;
		margin: 0.25rem 0 0.5rem;
		color: var(--color-ink);
	}
	.intro {
		font-family: var(--font-sans);
		font-size: 0.9rem;
		color: var(--color-ink-muted);
		margin: 0 0 1.25rem;
		line-height: 1.5;
	}
	.empty-state p {
		font-family: var(--font-serif);
		font-size: 1.05rem;
		color: var(--color-ink-muted);
	}
	.story-list {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.story-list li {
		margin-bottom: 0.85rem;
	}
	.story-card {
		display: block;
		min-height: 44px;
		background: var(--color-paper);
		border: 1px solid var(--color-border);
		border-radius: 10px;
		padding: 1rem 1.1rem;
		text-decoration: none;
		color: inherit;
	}
	.story-card:hover {
		background: var(--color-highlight-bg);
	}
	.story-card:focus-visible {
		outline: 2px solid var(--color-evergreen-dark);
		outline-offset: 2px;
	}
	.story-question {
		font-family: var(--font-serif);
		font-size: 1.1rem;
		font-weight: 700;
		color: var(--color-ink);
		margin: 0 0 0.5rem;
	}
	.story-meta {
		margin: 0;
		font-family: var(--font-sans);
		font-size: 0.8rem;
		color: var(--color-ink-muted);
	}
</style>
