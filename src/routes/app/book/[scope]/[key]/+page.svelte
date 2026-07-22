<script lang="ts">
	import { onMount } from 'svelte';

	const { data } = $props();

	let progress = $state(0);
	let currentChapterIndex = $state(0);
	let chapterEls: (HTMLElement | null)[] = [];

	function clamp01(n: number): number {
		return Math.min(1, Math.max(0, n));
	}

	// Scroll-progress + "current chapter" tracking. Safari's elastic overscroll
	// can push window.scrollY below 0 or the effective max above
	// document.documentElement.scrollHeight - window.innerHeight momentarily
	// during a bounce — clamp defensively so the bar never reads outside
	// [0, 100]% and the chapter index never goes out of range.
	function updateProgress() {
		const doc = document.documentElement;
		const scrollTop = Math.max(0, window.scrollY || doc.scrollTop || 0);
		const maxScroll = Math.max(1, doc.scrollHeight - window.innerHeight);
		progress = clamp01(scrollTop / maxScroll);

		let idx = 0;
		for (let i = 0; i < chapterEls.length; i++) {
			const el = chapterEls[i];
			if (el && el.getBoundingClientRect().top <= 96) idx = i;
		}
		currentChapterIndex = idx;
	}

	let ticking = false;
	function onScroll() {
		if (ticking) return;
		ticking = true;
		requestAnimationFrame(() => {
			updateProgress();
			ticking = false;
		});
	}

	onMount(() => {
		window.addEventListener('scroll', onScroll, { passive: true });
		updateProgress();
		return () => window.removeEventListener('scroll', onScroll);
	});

	function narrativeParagraphs(text: string): string[] {
		return text.split(/\n{2,}/).map((p) => p.trim()).filter((p) => p.length > 0);
	}
</script>

<svelte:head>
	<title>{data.available ? `${data.year} — Book — madonnahist` : 'Book view — madonnahist'}</title>
</svelte:head>

{#if !data.available}
	<div class="book-page">
		<a href="/app/browse" class="exit-btn standalone" aria-label="Back to Browse">&times;</a>
		<div class="unavailable-card">
			<h1>Not available yet</h1>
			<p>
				{#if data.reason === 'scope'}
					Book view for this isn't ready yet — only yearly books are available right now.
				{:else}
					That doesn't look like a valid year to read as a book.
				{/if}
			</p>
			<a href="/app/browse" class="btn-primary">Back to Browse</a>
		</div>
	</div>
{:else}
	<div class="reader">
		<div class="progress-track" aria-hidden="true">
			<div class="progress-fill" style="width: {(progress * 100).toFixed(1)}%"></div>
		</div>

		<div class="reader-chrome">
			<a href="/app/year/{data.year}" class="exit-btn" aria-label="Exit book view, back to {data.year} overview">
				&times;
			</a>
			<div class="chapter-indicator" aria-live="polite">
				{#if data.chapters.length > 0}
					{data.chapters[Math.min(currentChapterIndex, data.chapters.length - 1)].monthName}
					<span class="chapter-count">
						&middot; {Math.min(currentChapterIndex + 1, data.chapters.length)} of {data.chapters.length}
					</span>
				{/if}
				<span class="progress-percent">{Math.round(progress * 100)}%</span>
			</div>
		</div>

		<article class="book">
			<header class="book-header">
				<p class="book-eyebrow">madonnahist</p>
				<h1 class="book-title">{data.year}</h1>
				<p class="book-coverage">
					{data.coverage.accepted} of {data.coverage.total} days transcribed
					{#if data.coverage.accepted < data.coverage.total}so far{/if}
				</p>
			</header>

			{#if data.narrative}
				<section class="book-intro">
					<p class="intro-label">AI-generated year summary, reviewed by the family</p>
					{#each narrativeParagraphs(data.narrative) as para, i (i)}
						<p class="intro-para">{para}</p>
					{/each}
				</section>
			{/if}

			{#if data.chapters.length === 0}
				<p class="book-empty">No transcribed days for {data.year} yet — check back as correction continues.</p>
			{/if}

			{#each data.chapters as chapter, ci (chapter.month)}
				<section class="chapter" class:first-chapter={ci === 0}>
					<h2 class="chapter-title" bind:this={chapterEls[ci]}>{chapter.monthName}</h2>
					{#each chapter.days as day (day.entryDate)}
						<div class="day-entry">
							<p class="day-label">{day.dateLabel}</p>
							{#if day.hasImage}
								<a href="/app/day/{day.entryDate}" class="day-thumb-link">
									<img
										class="day-thumb"
										src="/app/day/{day.entryDate}/image"
										alt="Calendar entry for {day.dateLabel}"
										loading="lazy"
									/>
								</a>
							{/if}
							<p class="day-text">{day.correctedText}</p>
							{#if day.dayNarrative}
								<p class="day-narrative">
									<span class="generated-tag">In context &mdash; generated.</span>
									{day.dayNarrative}
								</p>
							{/if}
						</div>
					{/each}
				</section>
			{/each}

			{#if data.nextYear}
				<footer class="book-continue">
					<a href="/app/book/year/{data.nextYear}" class="btn-primary">Continue to {data.nextYear} &#9656;</a>
				</footer>
			{/if}
		</article>
	</div>
{/if}

<style>
	/* ── Fallback ("not available") state ─────────────────────────────── */
	.book-page {
		padding: 1rem;
		min-height: 60vh;
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
	.exit-btn.standalone {
		position: fixed;
	}

	/* ── Reader chrome: progress bar, exit control, chapter indicator ───── */
	.reader {
		background: var(--color-paper);
		min-height: 100vh;
	}
	.progress-track {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		height: 3px;
		background: transparent;
		z-index: 30;
	}
	.progress-fill {
		height: 100%;
		background: var(--color-evergreen);
		transition: width 0.08s linear;
	}
	.reader-chrome {
		position: fixed;
		top: 3px;
		left: 0;
		right: 0;
		z-index: 29;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-height: 44px;
		padding: 0.25rem 0.5rem 0.25rem 0.75rem;
		background: rgba(255, 253, 248, 0.94);
		border-bottom: 1px solid var(--color-border);
		backdrop-filter: blur(2px);
	}
	.exit-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 44px;
		height: 44px;
		flex: 0 0 44px;
		border-radius: 50%;
		background: var(--color-chip-bg);
		color: var(--color-ink);
		font-size: 1.4rem;
		line-height: 1;
		text-decoration: none;
		z-index: 31;
	}
	.exit-btn:hover {
		background: var(--color-highlight-bg);
	}
	.exit-btn:focus-visible {
		outline: 2px solid var(--color-evergreen-dark);
		outline-offset: 2px;
	}
	.chapter-indicator {
		flex: 1;
		display: flex;
		align-items: baseline;
		gap: 0.4rem;
		min-width: 0;
		font-family: var(--font-sans);
		font-size: 0.82rem;
		font-weight: 600;
		color: var(--color-ink-muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.chapter-count {
		font-weight: 500;
		color: var(--color-ink-muted);
	}
	.progress-percent {
		margin-left: auto;
		font-weight: 700;
		color: var(--color-evergreen-dark);
	}

	/* ── Book content ─────────────────────────────────────────────────── */
	.book {
		max-width: 640px;
		margin: 0 auto;
		padding: 3.5rem 1.25rem 3rem;
	}
	.book-header {
		text-align: center;
		margin-bottom: 1.75rem;
	}
	.book-eyebrow {
		font-family: var(--font-sans);
		font-size: 0.75rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--color-amber);
		margin: 0 0 0.5rem;
	}
	.book-title {
		font-family: var(--font-serif);
		font-size: 2.4rem;
		margin: 0 0 0.5rem;
		color: var(--color-ink);
	}
	.book-coverage {
		font-family: var(--font-sans);
		font-size: 0.85rem;
		color: var(--color-ink-muted);
		margin: 0;
	}

	.book-intro {
		background: var(--color-cream);
		border: 1px solid var(--color-border);
		border-radius: 10px;
		padding: 1.25rem 1.4rem;
		margin: 0 0 2.5rem;
	}
	.intro-label {
		font-family: var(--font-sans);
		font-size: 0.75rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--color-amber);
		margin: 0 0 0.75rem;
	}
	.intro-para {
		font-family: var(--font-serif);
		font-style: italic;
		font-size: 1.1rem;
		line-height: 1.7;
		color: var(--color-ink);
		margin: 0 0 0.9rem;
	}
	.intro-para:last-child {
		margin-bottom: 0;
	}

	.book-empty {
		font-family: var(--font-serif);
		font-size: 1.05rem;
		color: var(--color-ink-muted);
		text-align: center;
		margin: 2rem 0;
	}

	.chapter {
		margin-bottom: 2.5rem;
	}
	.chapter-title {
		font-family: var(--font-serif);
		font-size: 1.9rem;
		font-weight: 700;
		color: var(--color-evergreen-dark);
		text-align: center;
		margin: 0 0 2rem;
		padding-top: 0.5rem;
		scroll-margin-top: 60px;
	}

	.day-entry {
		margin-bottom: 2.25rem;
		overflow: hidden; /* contain the floated thumbnail */
	}
	.day-label {
		font-family: var(--font-sans);
		font-size: 0.85rem;
		font-weight: 700;
		color: var(--color-ink-muted);
		margin: 0 0 0.6rem;
	}
	.day-thumb-link {
		display: block;
		float: left;
		width: 76px;
		margin: 0 1rem 0.5rem 0;
		border: 1px solid var(--color-border);
		border-radius: 6px;
		overflow: hidden;
	}
	.day-thumb-link:focus-visible {
		outline: 2px solid var(--color-evergreen-dark);
		outline-offset: 2px;
	}
	.day-thumb {
		display: block;
		width: 100%;
		height: auto;
	}
	.day-text {
		font-family: var(--font-serif);
		font-size: 1.18rem;
		line-height: 1.75;
		max-width: 65ch;
		color: var(--color-ink);
		white-space: pre-wrap;
		margin: 0;
	}
	.day-narrative {
		clear: both;
		margin: 0.85rem 0 0;
		padding: 0.75rem 0.9rem;
		background: var(--color-cream);
		border: 1px solid var(--color-border);
		border-radius: 8px;
		font-family: var(--font-serif);
		font-style: italic;
		font-size: 1rem;
		line-height: 1.6;
		color: var(--color-ink);
	}
	.generated-tag {
		font-family: var(--font-sans);
		font-style: normal;
		font-weight: 700;
		font-size: 0.75rem;
		text-transform: uppercase;
		letter-spacing: 0.03em;
		color: var(--color-amber);
	}

	.book-continue {
		text-align: center;
		margin-top: 3rem;
		padding-top: 2rem;
		border-top: 1px solid var(--color-border);
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

	/* ── Print: seeds Phase H PDF export ──────────────────────────────── */
	@media print {
		.progress-track,
		.reader-chrome,
		.book-continue {
			display: none !important;
		}
		.reader {
			background: #fff;
			min-height: 0;
		}
		.book {
			max-width: none;
			padding: 0;
			color: #000;
		}
		.book-header {
			margin-bottom: 1.5rem;
		}
		.book-title,
		.chapter-title,
		.day-text,
		.day-narrative,
		.intro-para,
		.book-coverage,
		.book-eyebrow,
		.intro-label,
		.generated-tag,
		.day-label {
			color: #000 !important;
			background: none !important;
		}
		.book-intro,
		.day-narrative {
			border: 1px solid #999;
		}
		.chapter {
			page-break-before: always;
			margin-bottom: 0;
		}
		/* Class-based, not :first-of-type — the intro narrative section (also
		   a <section>, rendered before the chapters) would otherwise claim
		   the tag-based :first-of-type slot, leaving the actual first chapter
		   with an unwanted page break before it whenever a narrative is
		   present. */
		.chapter.first-chapter {
			page-break-before: avoid;
		}
		.day-entry {
			page-break-inside: avoid;
			break-inside: avoid;
		}
		.day-thumb-link {
			width: 56px;
			border-color: #999;
		}
	}
</style>
