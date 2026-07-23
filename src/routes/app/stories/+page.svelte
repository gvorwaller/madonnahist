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
	<h1>Family stories</h1>
	<p class="intro">
		Answers to questions asked of the archive — each one written only from
		Madonna's transcribed calendar entries, and saved here after review.
	</p>

	{#if data.stories.length === 0}
		<div class="empty-state">
			<p>No saved stories yet — they'll appear here as questions get asked and kept.</p>
		</div>
	{:else}
		{#each data.stories as story (story.id)}
			<article class="story-card">
				<h2 class="story-question">{story.question}</h2>
				<div class="story-text">{story.narrativeText}</div>
				<p class="story-provenance">
					AI-generated — written from {story.dayCount} transcribed
					day{story.dayCount === 1 ? '' : 's'} matching {story.subsetSummary}
					&middot; saved {formatDate(story.createdAt)}
				</p>
			</article>
		{/each}
	{/if}
</div>

<style>
	.stories-page {
		padding: 1rem;
	}
	h1 {
		font-family: var(--font-sans);
		font-size: 1.25rem;
		margin: 0 0 0.5rem;
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
	.story-card {
		background: var(--color-paper);
		border: 1px solid var(--color-border);
		border-radius: 10px;
		padding: 1rem 1.1rem;
		margin-bottom: 1rem;
	}
	.story-question {
		font-family: var(--font-serif);
		font-size: 1.1rem;
		font-weight: 700;
		color: var(--color-ink);
		margin: 0 0 0.6rem;
	}
	.story-text {
		font-family: var(--font-serif);
		font-size: 1.02rem;
		line-height: 1.65;
		color: var(--color-ink);
		white-space: pre-wrap;
	}
	.story-provenance {
		margin: 0.8rem 0 0;
		padding-top: 0.6rem;
		border-top: 1px solid var(--color-border);
		font-family: var(--font-sans);
		font-size: 0.78rem;
		color: var(--color-ink-muted);
	}
</style>
