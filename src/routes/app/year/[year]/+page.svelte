<script lang="ts">
	import { page } from '$app/state';
	import { MONTHS, backLabel, backTarget, withFrom } from '$lib/viewer/nav';

	const { data } = $props();

	// Back goes where the reader came from (validated /app path), else the Timeline.
	const backHref = $derived(backTarget(page.url.searchParams.get('from'), '/app/timeline'));
	const backText = $derived(backLabel(backHref));
	const here = $derived(`/app/year/${data.year}`);

	const withDays = $derived(data.months.filter((m) => m.count > 0));
	const emptyMonths = $derived(data.months.filter((m) => m.count === 0));
	const totalDays = $derived(withDays.reduce((sum, m) => sum + m.count, 0));

	const spanLabel = $derived.by(() => {
		if (withDays.length === 0) return '';
		const first = MONTHS[withDays[0].month - 1];
		const last = MONTHS[withDays[withDays.length - 1].month - 1];
		return first === last ? first : `${first} to ${last}`;
	});

	const pad = (n: number) => String(n).padStart(2, '0');
	const plural = (n: number, one: string, many: string) =>
		`${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

	function weekdayShort(entryDate: string): string {
		return new Date(entryDate + 'T00:00:00Z').toLocaleDateString('en-US', {
			weekday: 'short',
			timeZone: 'UTC'
		});
	}

	function narrativeParagraphs(text: string): string[] {
		return text
			.split(/\n{2,}/)
			.map((p) => p.trim())
			.filter((p) => p.length > 0);
	}

	// Same output as /admin/exports' formatBytes.
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
	const PDF_LABEL: Record<string, string> = {
		full: 'PDF, whole year',
		narrative: 'PDF, story only',
		days: 'PDF, days only'
	};
	// A PDF is an edition as of the day it was made (CODEX1 finding 10).
	const pdfMadeOn = $derived.by(() => {
		if (data.pdfExports.length === 0) return null;
		const latest = data.pdfExports.map((e) => e.createdAt).sort()[data.pdfExports.length - 1];
		return new Date(latest).toLocaleDateString('en-US', {
			month: 'short',
			day: 'numeric',
			year: 'numeric'
		});
	});
</script>

<svelte:head>
	<title>{data.validYear ? data.year : 'Year'} — Vorwaller Family History</title>
</svelte:head>

<div class="v-page wide">
	<a class="v-back" href={backHref}>◂ {backText}</a>

	{#if !data.validYear}
		<div class="v-empty">
			<div class="icon" aria-hidden="true">🗓️</div>
			<h1 class="v-title">Not a year in this archive</h1>
			<p>That doesn't look like a year Madonna's calendars cover.</p>
			<a class="v-btn primary" href="/app/timeline">Go to the Timeline</a>
		</div>
	{:else}
		<nav class="year-nav" aria-label="Other years">
			{#if data.prevYear}
				<a
					class="arrow"
					href="/app/year/{data.prevYear}"
					aria-label="Previous year, {data.prevYear}">‹</a
				>
			{:else}
				<span class="arrow off" aria-hidden="true">‹</span>
			{/if}
			<h1 class="y">{data.year}</h1>
			{#if data.nextYear}
				<a class="arrow" href="/app/year/{data.nextYear}" aria-label="Next year, {data.nextYear}"
					>›</a
				>
			{:else}
				<span class="arrow off" aria-hidden="true">›</span>
			{/if}
		</nav>
		{#if totalDays > 0}
			<p class="v-sub center">{plural(totalDays, 'day', 'days')} so far · {spanLabel}</p>
		{/if}

		{#if data.narrative}
			<details class="v-fold story" id="story" open>
				<summary>📖 The story of {data.year}</summary>
				<div class="v-fold-body">
					{#each narrativeParagraphs(data.narrative) as para, i (i)}
						<p class="para">{para}</p>
					{/each}
					<p class="v-provenance">
						<b>AI-written</b> from Madonna's {data.year} calendar, reviewed before publishing
					</p>
				</div>
			</details>
		{/if}

		{#if totalDays > 0}
			<div class="v-actions downloads">
				<a class="v-btn secondary" href="/app/book/year/{data.year}"
					>📚 Read {data.year} as a book</a
				>
				{#each data.pdfExports as ex (ex.mode)}
					<a
						class="v-btn secondary"
						href="/app/year/{data.year}/pdf?mode={ex.mode}"
						target="_blank"
						rel="noopener"
						>⬇ {PDF_LABEL[ex.mode] ?? 'PDF'}
						<span class="size">({formatBytes(ex.byteSize)})</span></a
					>
				{/each}
			</div>
			{#if pdfMadeOn}
				<p class="pdf-note">PDFs show the archive as of {pdfMadeOn}.</p>
			{/if}

			<section aria-labelledby="months-h">
				<div class="v-section-h"><h2 id="months-h">Months</h2></div>
				<div class="months">
					{#each withDays as m (m.month)}
						{@const monthHref = withFrom(`/app/month/${data.year}-${pad(m.month)}`, here)}
						<section class="monthcard" aria-labelledby="m-{m.month}">
							<header>
								<h3 id="m-{m.month}"><a href={monthHref}>{MONTHS[m.month - 1]}</a></h3>
								<span class="meta">{plural(m.count, 'day', 'days')}</span>
							</header>
							{#if m.highlights.length > 0}
								<ul class="rows">
									{#each m.highlights as h (h.entryDate)}
										<li>
											<a class="row" href={withFrom(`/app/day/${h.entryDate}`, here)}>
												<span class="d"
													>{Number(h.entryDate.slice(8, 10))}<small
														>{weekdayShort(h.entryDate)}</small
													></span
												>
												<span class="snip"
													>{h.snippet}{#if h.hasMemory}
														<span class="mem">
															🗨 <span class="v-sr">Madonna remembers this day</span></span
														>{/if}</span
												>
											</a>
										</li>
									{/each}
								</ul>
							{/if}
							<footer>
								<a href={monthHref}>All {plural(m.count, 'day', 'days')} ▸</a>
							</footer>
						</section>
					{/each}
				</div>
				{#if emptyMonths.length > 0}
					<p class="not-yet">
						<b>Not transcribed yet:</b>
						{emptyMonths.map((m) => MONTHS[m.month - 1]).join(', ')}
					</p>
				{/if}
			</section>
		{:else}
			<div class="v-empty">
				<div class="icon" aria-hidden="true">✍️</div>
				<h2>No days from {data.year} yet</h2>
				<p>Check back as Madonna works through the calendars.</p>
				<a class="v-btn primary" href="/app/timeline">Go to the Timeline</a>
			</div>
		{/if}
	{/if}
</div>

<style>
	.year-nav {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		margin: 4px 0 0;
	}
	.y {
		margin: 0;
		font-family: var(--font-serif);
		font-size: 36px;
		font-weight: 700;
		color: var(--color-ink);
	}
	.arrow {
		width: 48px;
		height: 48px;
		border-radius: 999px;
		border: 1px solid var(--color-border);
		background: var(--color-paper);
		display: grid;
		place-items: center;
		font-size: 30px;
		line-height: 1;
		padding-bottom: 4px;
		color: var(--color-ink);
		text-decoration: none;
	}
	a.arrow:hover {
		border-color: var(--color-ink-muted);
	}
	.arrow.off {
		visibility: hidden;
	}
	.center {
		text-align: center;
		margin: 2px 0 16px;
	}

	.story {
		margin-bottom: 14px;
	}
	.story > summary {
		font-family: var(--font-serif);
		font-size: 20px;
	}
	.para {
		margin: 0 0 12px;
		font-family: var(--font-serif);
		font-size: 19px;
		line-height: 1.7;
		max-width: 65ch;
	}

	.downloads {
		margin-top: 0;
	}
	.size {
		font-weight: 400;
	}
	.pdf-note {
		margin: 6px 0 0;
		font-size: 15px;
		color: var(--color-ink-muted);
	}

	.months {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 12px;
	}
	@media (min-width: 640px) {
		.months {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}
	@media (min-width: 1024px) {
		.months {
			grid-template-columns: repeat(3, minmax(0, 1fr));
		}
	}
	.monthcard {
		display: flex;
		flex-direction: column;
		background: var(--color-paper);
		border: 1px solid var(--color-border);
		border-radius: var(--radius);
		overflow: hidden;
	}
	.monthcard header {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 4px 14px;
		background: var(--color-evergreen-soft);
		color: var(--color-evergreen-dark);
	}
	.monthcard h3 {
		margin: 0;
		font-size: 19px;
	}
	.monthcard h3 a {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		color: var(--color-evergreen-dark);
		text-decoration: none;
	}
	.monthcard h3 a:hover {
		text-decoration: underline;
	}
	.meta {
		margin-left: auto;
		font-size: 15px;
		font-weight: 600;
	}
	.rows {
		list-style: none;
		margin: 0;
		padding: 2px 14px 0;
	}
	.rows li + li {
		border-top: 1px solid var(--color-border);
	}
	.row {
		display: grid;
		grid-template-columns: 44px minmax(0, 1fr);
		gap: 10px;
		padding: 10px 0;
		color: inherit;
		text-decoration: none;
	}
	.row:hover .snip {
		text-decoration: underline;
	}
	.d {
		font-family: var(--font-serif);
		font-size: 21px;
		font-weight: 700;
		color: var(--color-evergreen-dark);
		text-align: center;
		line-height: 1.1;
	}
	.d small {
		display: block;
		font-family: var(--font-sans);
		font-size: 15px;
		font-weight: 600;
		color: var(--color-ink-muted);
	}
	.snip {
		font-family: var(--font-serif);
		font-size: 17px;
		line-height: 1.5;
		overflow-wrap: anywhere;
	}
	.monthcard footer {
		margin-top: auto;
		padding: 0 14px 6px;
	}
	.monthcard footer a {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		font-weight: 700;
		font-size: 16px;
		color: var(--color-evergreen);
	}
	.not-yet {
		margin: 14px 0 0;
		font-size: 16px;
		color: var(--color-ink-muted);
	}
</style>
