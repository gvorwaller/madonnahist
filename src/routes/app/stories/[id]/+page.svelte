<script lang="ts">
	const { data } = $props();

	function formatDate(iso: string): string {
		return new Date(iso).toLocaleDateString('en-US', {
			month: 'long',
			day: 'numeric',
			year: 'numeric'
		});
	}

	function narrativeParagraphs(text: string): string[] {
		return text.split(/\n{2,}/).map((p) => p.trim()).filter((p) => p.length > 0);
	}
</script>

<svelte:head>
	<title>{data.available ? `${data.question} — madonnahist` : 'Story — madonnahist'}</title>
</svelte:head>

{#if !data.available}
	<div class="story-page">
		{#if !data.renderMode}
			<a href="/app/stories" class="back-link">&larr; Family stories</a>
		{/if}
		<div class="unavailable-card">
			<h1>Not found</h1>
			<p>That story doesn't exist, or may have been removed.</p>
			{#if !data.renderMode}
				<a href="/app/stories" class="btn-primary">Back to family stories</a>
			{/if}
		</div>
	</div>
{:else}
	<div class="story-page" class:render-mode={data.renderMode}>
		{#if !data.renderMode}
			<a href="/app/stories" class="back-link">&larr; Family stories</a>
		{/if}

		<article class="story">
			<p class="story-eyebrow">Family story</p>
			<h1 class="story-question">{data.question}</h1>

			<div class="story-text">
				{#each narrativeParagraphs(data.narrativeText) as para, i (i)}
					<p>{para}</p>
				{/each}
			</div>

			<p class="story-provenance">
				AI-generated — written from {data.dayCount} transcribed
				day{data.dayCount === 1 ? '' : 's'} matching {data.subsetSummary}
				&middot; saved {formatDate(data.createdAt)}
			</p>

			{#if !data.renderMode}
				<!-- td-863a4a: PDF opens in a NEW tab so iPad Safari's inline PDF
				     view can't swallow the app tab (closing it returns here), and
				     Print uses this page's own @media print styles — on iPad
				     that goes straight to AirPrint with no PDF detour. -->
				<button type="button" class="btn-secondary" onclick={() => window.print()}>
					Print
				</button>
			{/if}
			{#if !data.renderMode && data.pdfSizeKb !== null}
				<a class="btn-secondary" href="/app/stories/{data.id}/pdf" target="_blank" rel="noopener">
					Download PDF ({data.pdfSizeKb} KB)
				</a>
			{/if}
		</article>
	</div>
{/if}

<style>
	.story-page {
		padding: 1rem;
		max-width: 640px;
		margin: 0 auto;
		min-height: 60vh;
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

	.unavailable-card {
		margin-top: 3.5rem;
		background: var(--color-paper);
		border: 1px solid var(--color-border);
		border-radius: 10px;
		padding: 1.5rem 1.25rem;
		text-align: center;
	}
	.unavailable-card h1 {
		font-family: var(--font-sans);
		font-size: 1.25rem;
		margin: 0 0 0.5rem;
		color: var(--color-ink);
	}
	.unavailable-card p {
		font-family: var(--font-serif);
		font-size: 1.05rem;
		line-height: 1.6;
		color: var(--color-ink-muted);
		margin: 0 0 1.25rem;
	}

	.story {
		background: var(--color-paper);
		border: 1px solid var(--color-border);
		border-radius: 10px;
		padding: 1.5rem 1.4rem;
		margin-top: 0.5rem;
	}
	.story-eyebrow {
		font-family: var(--font-sans);
		font-size: 0.75rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--color-amber);
		margin: 0 0 0.5rem;
	}
	.story-question {
		font-family: var(--font-serif);
		font-size: 1.5rem;
		font-weight: 700;
		color: var(--color-ink);
		margin: 0 0 1.1rem;
	}
	.story-text p {
		font-family: var(--font-serif);
		font-size: 1.05rem;
		line-height: 1.7;
		color: var(--color-ink);
		white-space: pre-wrap;
		margin: 0 0 1rem;
	}
	.story-text p:last-child {
		margin-bottom: 0;
	}
	.story-provenance {
		margin: 1.25rem 0 0;
		padding-top: 0.9rem;
		border-top: 1px solid var(--color-border);
		font-family: var(--font-sans);
		font-size: 0.78rem;
		color: var(--color-ink-muted);
	}

	.btn-primary,
	.btn-secondary {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: 48px;
		padding: 0.6rem 1.4rem;
		border-radius: 8px;
		font-family: var(--font-sans);
		font-weight: 700;
		text-decoration: none;
	}
	.btn-primary {
		background: var(--color-evergreen);
		color: #fff;
	}
	.btn-secondary {
		margin-top: 1.25rem;
		background: var(--color-chip-bg);
		color: var(--color-ink);
		border: 1px solid var(--color-border);
	}
	.btn-secondary:hover {
		background: var(--color-highlight-bg);
	}
	.btn-primary:focus-visible,
	.btn-secondary:focus-visible {
		outline: 2px solid var(--color-evergreen-dark);
		outline-offset: 2px;
	}

	/* ── Print: same conventions as the book page's PDF export
	     (src/routes/app/book/[scope]/[key]/+page.svelte) — the worker's
	     headless Chromium always requests ?render=pdf (so .back-link and the
	     download button are never even in the DOM, per the template above),
	     but this also covers a family member printing the page directly from
	     a normal browser visit without ?render=pdf. ── */
	@media print {
		.back-link,
		.btn-secondary {
			display: none !important;
		}
		.story-page {
			min-height: 0;
			padding: 0;
			max-width: none;
		}
		.story {
			border: 1px solid #999;
			background: #fff;
		}
		.story-question,
		.story-text p,
		.story-provenance,
		.story-eyebrow {
			color: #000 !important;
			background: none !important;
		}
	}
</style>
