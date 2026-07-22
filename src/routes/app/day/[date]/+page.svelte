<script lang="ts">
	const { data } = $props();

	let zoomOpen = $state(false);

	function closeZoom() {
		zoomOpen = false;
	}
</script>

<svelte:head>
	<title>{data.found ? data.dateLabel : 'Not yet transcribed'} — madonnahist</title>
</svelte:head>

<svelte:window
	onkeydown={(e) => {
		if (e.key === 'Escape' && zoomOpen) closeZoom();
	}}
/>

{#if !data.found}
	<div class="day-page">
		<a href="/app" class="back-link">&larr; Back to On this day</a>
		<div class="not-transcribed">
			<h1>Not transcribed yet</h1>
			<p>
				{#if data.dateLabel}
					This day ({data.dateLabel}) hasn't been transcribed yet — check back once
					correction work reaches it.
				{:else}
					This day isn't transcribed yet.
				{/if}
			</p>
			<a href="/app" class="btn-primary">Back to On this day</a>
		</div>
	</div>
{:else}
	<div class="day-page">
		<a href="/app" class="back-link">&larr; Back</a>

		<h1>{data.dateLabel}</h1>

		{#if data.hasImage}
			<button class="image-btn" onclick={() => (zoomOpen = true)}>
				<img
					class="day-image"
					src="/app/day/{data.entryDate}/image"
					alt="Calendar entry for {data.dateLabel}"
				/>
				<span class="zoom-hint">Tap to zoom</span>
			</button>
		{/if}

		<div class="corrected-text">{data.correctedText}</div>

		{#if data.entities.length > 0}
			<div class="tags-block">
				<p class="tags-heading">People &amp; places</p>
				<div class="tag-chips">
					{#each data.entities as ent (ent.entityType + ':' + ent.slug)}
						<a href="/app/{ent.entityType}/{ent.slug}" class="tag-chip entity-chip">{ent.displayName}</a>
					{/each}
				</div>
			</div>
		{/if}

		{#if data.tags.length > 0}
			<div class="tags-block">
				<p class="tags-heading">Tags</p>
				<div class="tag-chips">
					{#each data.tags as tag (tag.tag_slug)}
						<a href="/app/search?tag={tag.tag_slug}" class="tag-chip">{tag.tag_label}</a>
					{/each}
				</div>
			</div>
		{/if}

		{#if data.dayNarrative}
			<div class="narrative">
				<p class="narrative-label">In context <span class="generated-tag">— generated</span></p>
				<p class="narrative-text">{data.dayNarrative}</p>
			</div>
		{/if}

		<div class="day-nav">
			{#if data.prevDate}
				<a href="/app/day/{data.prevDate}" class="nav-btn">&#9666; Previous day</a>
			{:else}
				<span class="nav-btn disabled">&#9666; Previous day</span>
			{/if}
			{#if data.nextDate}
				<a href="/app/day/{data.nextDate}" class="nav-btn">Next day &#9656;</a>
			{:else}
				<span class="nav-btn disabled">Next day &#9656;</span>
			{/if}
		</div>
	</div>

	{#if zoomOpen}
		<div class="zoom-overlay" role="dialog" aria-label="Zoomed day image">
			<button class="zoom-close" onclick={closeZoom} aria-label="Close zoomed image">&times;</button>
			<div class="zoom-scroll">
				<img
					class="zoom-image"
					src="/app/day/{data.entryDate}/image"
					alt="Calendar entry for {data.dateLabel}, zoomed"
				/>
			</div>
		</div>
	{/if}
{/if}

<style>
	.day-page {
		padding: 1rem;
	}
	.back-link {
		display: inline-block;
		margin-bottom: 0.75rem;
		font-family: var(--font-sans);
		font-size: 0.9rem;
		color: var(--color-evergreen-dark);
		text-decoration: none;
		min-height: 48px;
		display: flex;
		align-items: center;
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
		margin: 0 0 1rem;
		color: var(--color-ink);
	}

	.not-transcribed {
		background: var(--color-paper);
		border: 1px solid var(--color-border);
		border-radius: 10px;
		padding: 1.5rem 1.25rem;
		text-align: center;
	}
	.not-transcribed h1 {
		text-align: center;
	}
	.not-transcribed p {
		font-family: var(--font-serif);
		font-size: 1.05rem;
		line-height: 1.6;
		color: var(--color-ink-muted);
		margin: 0 0 1.25rem;
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
	.day-image {
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

	.corrected-text {
		margin-top: 1.25rem;
		font-family: var(--font-serif);
		font-size: 1.15rem;
		line-height: 1.7;
		color: var(--color-ink);
		white-space: pre-wrap;
	}

	.tags-block {
		margin-top: 1.25rem;
	}
	.tags-heading {
		font-family: var(--font-sans);
		font-size: 0.8rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--color-ink-muted);
		margin: 0 0 0.5rem;
	}
	.tag-chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}
	.tag-chip {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		padding: 0.3rem 0.85rem;
		background: var(--color-chip-bg);
		color: var(--color-ink-muted);
		border-radius: 999px;
		font-family: var(--font-sans);
		font-size: 0.85rem;
		font-weight: 500;
		text-decoration: none;
	}
	.tag-chip:hover {
		background: var(--color-highlight-bg);
		color: var(--color-ink);
	}
	.tag-chip:focus-visible {
		outline: 2px solid var(--color-evergreen-dark);
		outline-offset: 2px;
	}
	.entity-chip {
		background: var(--color-cream);
		border: 1px solid var(--color-evergreen);
		color: var(--color-evergreen-dark);
		font-weight: 700;
	}
	.entity-chip:hover {
		background: var(--color-evergreen);
		color: #fff;
	}

	.narrative {
		margin-top: 1.5rem;
		padding-top: 1.25rem;
		border-top: 1px solid var(--color-border);
	}
	.narrative-label {
		font-family: var(--font-sans);
		font-size: 0.8rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--color-ink-muted);
		margin: 0 0 0.5rem;
	}
	.generated-tag {
		font-weight: 500;
		text-transform: none;
		letter-spacing: normal;
		color: var(--color-amber);
	}
	.narrative-text {
		font-family: var(--font-serif);
		font-style: italic;
		font-size: 1.05rem;
		line-height: 1.6;
		color: var(--color-ink);
		background: var(--color-cream);
		border: 1px solid var(--color-border);
		border-radius: 8px;
		padding: 0.9rem 1rem;
		margin: 0;
	}

	.day-nav {
		display: flex;
		gap: 0.75rem;
		margin-top: 1.75rem;
	}
	.nav-btn {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 52px;
		padding: 0.6rem 0.5rem;
		border-radius: 8px;
		border: 1px solid var(--color-evergreen);
		background: var(--color-paper);
		color: var(--color-evergreen-dark);
		font-family: var(--font-sans);
		font-weight: 600;
		font-size: 0.95rem;
		text-decoration: none;
		text-align: center;
	}
	.nav-btn.disabled {
		border-color: var(--color-border);
		color: var(--color-ink-muted);
		opacity: 0.6;
	}
	.nav-btn:focus-visible {
		outline: 2px solid var(--color-evergreen-dark);
		outline-offset: 2px;
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
