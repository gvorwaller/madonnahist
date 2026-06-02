<script lang="ts">
	const { data } = $props();

	const monthNames = ['', 'January', 'February', 'March', 'April', 'May', 'June',
		'July', 'August', 'September', 'October', 'November', 'December'];
	const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

	type Filter = 'all' | 'low' | 'blank';
	let filter: Filter = $state('all');

	const title = $derived(`${monthNames[data.page.month]} ${data.page.year}`);

	let lightboxSrc: string | null = $state(null);
	let lightboxAlt: string = $state('');
	let lightboxText: string = $state('');

	function openLightbox(src: string, alt: string, text: string) {
		lightboxSrc = src;
		lightboxAlt = alt;
		lightboxText = text;
	}

	function closeLightbox() {
		lightboxSrc = null;
	}

	function onLightboxKey(e: KeyboardEvent) {
		if (e.key === 'Escape') closeLightbox();
	}

	function dayOfMonth(d: { entry_date: string }): number {
		return new Date(d.entry_date + 'T00:00:00').getDate();
	}

	function dayOfWeek(d: { entry_date: string }): number {
		return new Date(d.entry_date + 'T00:00:00').getDay();
	}

	function confClass(score: number | null): string {
		if (score === null) return '';
		if (score >= 0.7) return 'conf-high';
		if (score >= 0.4) return 'conf-med';
		return 'conf-low';
	}

	function matchesFilter(d: typeof data.days[0]): boolean {
		if (filter === 'all') return true;
		if (filter === 'low') return d.confidence_score !== null && d.confidence_score < 0.4;
		if (filter === 'blank') return d.raw_text !== null && d.raw_text.trim() === '';
		return true;
	}

	const firstDow = $derived(data.days.length > 0 ? dayOfWeek(data.days[0]) : 0);
	const totalCells = $derived(firstDow + data.days.length);
	const gridRows = $derived(Math.ceil(totalCells / 7));
</script>

<div class="page">
	<header>
		<a href="/admin/ocr-review" class="back">All Pages</a>
		<h1>{title} — OCR Review</h1>
		<a href="/admin/grid-align/{data.page.id}" class="grid-link">Adjust Grid</a>
		<div class="stats-bar">
			<span class="stat">OCR: <strong>{data.stats.ocrComplete}/{data.stats.total}</strong></span>
			{#if data.stats.avgConfidence !== null}
				<span class="stat">Avg:
					<strong class={confClass(data.stats.avgConfidence)}>
						{(data.stats.avgConfidence * 100).toFixed(0)}%
					</strong>
				</span>
			{/if}
			<span class="stat">Draft: <strong>{data.stats.draftComplete}/{data.stats.total}</strong></span>
			{#if data.stats.flaggedCount > 0}
				<span class="stat">Flagged: <strong class="conf-low">{data.stats.flaggedCount}</strong></span>
			{/if}
			{#if data.stats.blankCount > 0}
				<span class="stat">Blank: <strong>{data.stats.blankCount}</strong></span>
			{/if}
		</div>
		<div class="filters">
			<button class:active={filter === 'all'} onclick={() => filter = 'all'}>All</button>
			<button class:active={filter === 'low'} onclick={() => filter = 'low'}>Low Conf</button>
			<button class:active={filter === 'blank'} onclick={() => filter = 'blank'}>Blank</button>
		</div>
	</header>

	<div class="calendar-header">
		{#each dayNames as dn}
			<div class="dow">{dn}</div>
		{/each}
	</div>

	<div class="calendar-grid" style="--rows: {gridRows}">
		{#each { length: firstDow } as _, i}
			<div class="cell empty" style="grid-column: {i + 1}; grid-row: 1"></div>
		{/each}

		{#each data.days as day, idx}
			{@const col = ((firstDow + idx) % 7) + 1}
			{@const row = Math.floor((firstDow + idx) / 7) + 1}
			{@const visible = matchesFilter(day)}
			<div class="cell" class:hidden={!visible} class:has-ocr={day.raw_text !== null}
				class:is-blank={day.raw_text !== null && day.raw_text.trim() === ''}
				style="grid-column: {col}; grid-row: {row}">
				<div class="cell-header">
					<span class="day-num">{dayOfMonth(day)}</span>
					{#if day.confidence_score !== null}
						<span class="conf-badge {confClass(day.confidence_score)}">
							{(day.confidence_score * 100).toFixed(0)}%
						</span>
					{/if}
				</div>
				{#if day.draft_text !== null || day.raw_text !== null}
					{@const displayText = day.draft_text ?? day.raw_text ?? ''}
					{@const cropSrc = `/admin/ocr-review/${data.page.id}/crop/${day.day_id}?v=${data.page.grid_version}`}
					<button class="img-btn" onclick={() => openLightbox(cropSrc, `Day ${dayOfMonth(day)}`, displayText.trim())}>
						<img src={cropSrc}
							alt="Day cell {dayOfMonth(day)}" class="cell-img" loading="lazy" />
					</button>
					<div class="ocr-text" class:is-draft={day.draft_text !== null}>
						{displayText.trim() || '(blank)'}
					</div>
					{#if day.draft_text !== null && day.raw_text !== null}
						<div class="ocr-source">draft</div>
					{:else if day.raw_text !== null}
						<div class="ocr-source raw">raw OCR</div>
					{/if}
				{:else}
					<div class="status-msg">Pending</div>
				{/if}
			</div>
		{/each}
	</div>
</div>

<svelte:window onkeydown={onLightboxKey} />

{#if lightboxSrc}
	<div class="lightbox-overlay" role="dialog" aria-label="Day cell detail">
		<button class="lightbox-close" onclick={closeLightbox} aria-label="Close">&times;</button>
		<button class="lightbox-bg" onclick={closeLightbox} aria-label="Close overlay"></button>
		<div class="lightbox-content">
			<div class="lightbox-header">{lightboxAlt}</div>
			<img src={lightboxSrc} alt={lightboxAlt} class="lightbox-img" />
			<div class="lightbox-text">{lightboxText || '(blank)'}</div>
		</div>
	</div>
{/if}

<style>
	.page {
		max-width: 1400px;
		margin: 0 auto;
		padding: 1rem;
	}
	header {
		margin-bottom: 1rem;
	}
	.back {
		font-size: 0.85rem;
		color: #555;
		text-decoration: none;
	}
	.back:hover {
		text-decoration: underline;
	}
	h1 {
		margin: 0.25rem 0 0.5rem;
		font-size: 1.4rem;
	}
	.grid-link {
		display: inline-block;
		padding: 0.35rem 0.8rem;
		border: 1px solid #ccc;
		border-radius: 4px;
		background: #fff;
		font-size: 0.8rem;
		text-decoration: none;
		color: #333;
		margin-bottom: 0.5rem;
	}
	.grid-link:hover {
		background: #f0f0f0;
	}
	.stats-bar {
		display: flex;
		gap: 1.25rem;
		flex-wrap: wrap;
		margin-bottom: 0.75rem;
		font-size: 0.9rem;
	}
	.stat strong {
		font-weight: 600;
	}
	.filters {
		display: flex;
		gap: 0.4rem;
	}
	.filters button {
		padding: 0.3rem 0.7rem;
		border: 1px solid #ccc;
		border-radius: 4px;
		background: #fff;
		cursor: pointer;
		font-size: 0.8rem;
	}
	.filters button.active {
		background: #333;
		color: #fff;
		border-color: #333;
	}

	.calendar-header {
		display: grid;
		grid-template-columns: repeat(7, 1fr);
		gap: 1px;
		margin-bottom: 2px;
	}
	.dow {
		text-align: center;
		font-size: 0.75rem;
		font-weight: 600;
		color: #666;
		padding: 0.3rem 0;
	}
	.calendar-grid {
		display: grid;
		grid-template-columns: repeat(7, 1fr);
		grid-template-rows: repeat(var(--rows), auto);
		gap: 3px;
	}
	.cell {
		border: 1px solid #ddd;
		border-radius: 4px;
		padding: 0.35rem;
		min-height: 120px;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		overflow: hidden;
		background: #fafafa;
	}
	.cell.empty {
		border: none;
		background: transparent;
	}
	.cell.hidden {
		opacity: 0.15;
	}
	.cell.is-blank {
		background: #fffbe6;
	}
	.cell-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}
	.day-num {
		font-weight: 700;
		font-size: 0.85rem;
	}
	.conf-badge {
		font-size: 0.7rem;
		font-weight: 600;
		padding: 0.1rem 0.35rem;
		border-radius: 3px;
		background: #eee;
	}
	.conf-high { color: #1a7a1a; background: #e6f4e6; }
	.conf-med { color: #8a6d00; background: #fef3cd; }
	.conf-low { color: #c33; background: #fde2e2; }
	.img-btn {
		padding: 0;
		border: none;
		background: none;
		cursor: zoom-in;
		display: block;
		width: 100%;
	}
	.cell-img {
		width: 100%;
		height: auto;
		border-radius: 2px;
		border: 1px solid #e0e0e0;
		display: block;
	}
	.ocr-text {
		font-size: 0.72rem;
		line-height: 1.35;
		color: #333;
		white-space: pre-wrap;
		word-break: break-word;
		max-height: 6rem;
		overflow-y: auto;
	}
	.ocr-text.is-draft {
		color: #1a5a1a;
	}
	.ocr-source {
		font-size: 0.65rem;
		color: #1a7a1a;
		font-weight: 600;
	}
	.ocr-source.raw {
		color: #8a6d00;
	}
	.status-msg {
		font-size: 0.8rem;
		color: #888;
		padding: 1rem 0;
		text-align: center;
	}

	.lightbox-overlay {
		position: fixed;
		inset: 0;
		z-index: 1000;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.lightbox-bg {
		position: absolute;
		inset: 0;
		background: rgba(0, 0, 0, 0.85);
		border: none;
		cursor: pointer;
	}
	.lightbox-close {
		position: absolute;
		top: 1rem;
		right: 1.5rem;
		z-index: 1002;
		background: none;
		border: none;
		color: #fff;
		font-size: 2.5rem;
		cursor: pointer;
		line-height: 1;
	}
	.lightbox-content {
		position: relative;
		z-index: 1001;
		max-width: 90vw;
		max-height: 90vh;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 1rem;
	}
	.lightbox-header {
		color: #fff;
		font-size: 1.1rem;
		font-weight: 600;
	}
	.lightbox-img {
		max-width: 90vw;
		max-height: 60vh;
		border-radius: 4px;
		object-fit: contain;
	}
	.lightbox-text {
		color: #e0e0e0;
		font-size: 1rem;
		line-height: 1.5;
		white-space: pre-wrap;
		max-width: 700px;
		max-height: 20vh;
		overflow-y: auto;
		text-align: left;
		padding: 0.75rem 1rem;
		background: rgba(255, 255, 255, 0.08);
		border-radius: 4px;
	}
</style>
