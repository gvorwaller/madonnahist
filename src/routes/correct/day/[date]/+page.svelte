<script lang="ts">
	import { enhance } from '$app/forms';

	const { data } = $props();

	const monthNames = ['', 'January', 'February', 'March', 'April', 'May', 'June',
		'July', 'August', 'September', 'October', 'November', 'December'];

	const initialText = $derived(
		data.latestCorrection?.corrected_text && data.latestCorrection.corrected_text.trim() !== ''
			? data.latestCorrection.corrected_text
			: data.day.draft_text ?? data.day.ocr_raw_text ?? ''
	);

	let correctedText = $state('');
	$effect(() => { data.day.entry_date; correctedText = initialText; });

	let dayNarrative = $state('');
	$effect(() => { data.day.entry_date; dayNarrative = data.day.day_narrative ?? ''; });

	let saving = $state(false);
	let saveError = $state('');
	let showFlagModal = $state(false);
	let flagNote = $state('');
	let lightboxOpen = $state(false);
	let pageImageOpen = $state(false);

	const dateLabel = $derived(
		new Date(data.day.entry_date + 'T00:00:00').toLocaleDateString('en-US', {
			weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
		})
	);

	const dayNum = $derived(new Date(data.day.entry_date + 'T00:00:00').getDate());

	const statusLabel = $derived.by(() => {
		const s = data.day.correction_status;
		if (s === 'accepted') return 'Corrected';
		if (s === 'in_progress') return 'Skipped';
		if (s === 'illegible') return 'Illegible';
		if (s === 'flagged') return 'Flagged';
		return 'Pending';
	});

	const statusClass = $derived.by(() => {
		const s = data.day.correction_status;
		if (s === 'accepted') return 'status-done';
		if (s === 'illegible' || s === 'flagged') return 'status-flag';
		return 'status-pending';
	});

	const imageSrc = $derived(`/correct/day/${data.day.entry_date}/cell-image`);
	const paddedCropSrc = $derived(`/correct/day/${data.day.entry_date}/cell-image?pad=20`);
	const pageImageSrc = $derived(`/correct/day/${data.day.entry_date}/page-image`);
	const manualEntry = $derived(!data.day.draft_text && !data.day.ocr_raw_text);

	let pageImageContainer: HTMLElement | undefined = $state(undefined);

	$effect(() => {
		if (!manualEntry || !pageImageContainer || !data.day.crop_bounds || !data.day.page_height) return;
		const cb = data.day.crop_bounds;
		const ph = data.day.page_height;
		const containerH = pageImageContainer.clientHeight;
		const imgH = pageImageContainer.querySelector('img')?.clientHeight;
		if (!imgH) return;
		const targetY = (cb.y / ph) * imgH - containerH / 2 + (cb.height / ph) * imgH / 2;
		pageImageContainer.scrollTop = Math.max(0, targetY);
	});

	const highlightStyle = $derived.by(() => {
		const cb = data.day.crop_bounds;
		const pw = data.day.page_width;
		const ph = data.day.page_height;
		if (!cb || !pw || !ph) return '';
		return `left:${(cb.x / pw) * 100}%;top:${(cb.y / ph) * 100}%;width:${(cb.width / pw) * 100}%;height:${(cb.height / ph) * 100}%`;
	});
</script>

<svelte:window onkeydown={(e) => {
	if (e.key === 'Escape') {
		if (lightboxOpen) lightboxOpen = false;
		if (pageImageOpen) pageImageOpen = false;
		if (showFlagModal) { showFlagModal = false; flagNote = ''; }
	}
}} />

<div class="page">
	<header>
		<div class="breadcrumbs">
			<a href="/correct" class="back">Queue</a>
			<span class="crumb-sep">/</span>
			<a href="/correct/month/{data.monthKey}" class="back">{monthNames[data.day.month]} {data.day.year}</a>
		</div>
		<div class="header-row">
			<h1>{dateLabel}</h1>
			<span class="status-badge {statusClass}">{statusLabel}</span>
		</div>
		<div class="nav-row">
			<span class="position">Day {data.position} of {data.total}</span>
			<div class="nav-links">
				{#if data.prevAny}
					<a href="/correct/day/{data.prevAny}" class="nav-link">Prev</a>
				{/if}
				{#if data.nextAny}
					<a href="/correct/day/{data.nextAny}" class="nav-link">Next</a>
				{/if}
				{#if data.prevDate || data.nextDate}
					<span class="nav-sep"></span>
				{/if}
				{#if data.prevDate}
					<a href="/correct/day/{data.prevDate}" class="nav-link uncorrected">Prev uncorrected</a>
				{/if}
				{#if data.nextDate}
					<a href="/correct/day/{data.nextDate}" class="nav-link uncorrected">Next uncorrected</a>
				{/if}
			</div>
		</div>
	</header>

	<div class="editor-grid">
		<div class="col-image">
			{#if manualEntry}
				<div class="manual-crop-section">
					<img src={paddedCropSrc} alt="Day {dayNum} crop" class="manual-crop-img" />
				</div>
				<button class="page-image-container" bind:this={pageImageContainer} onclick={() => pageImageOpen = true}>
					<img src={pageImageSrc} alt="Full page — {monthNames[data.day.month]} {data.day.year}" class="page-img-inline" />
					{#if highlightStyle}
						<div class="cell-highlight" style={highlightStyle}></div>
					{/if}
				</button>
				<div class="manual-label">Manual entry — day {dayNum}</div>
			{:else}
				<button class="img-btn" onclick={() => lightboxOpen = true}>
					<img src={imageSrc} alt="Day cell {dayNum}" class="cell-img" />
				</button>
				<button class="page-btn" onclick={() => pageImageOpen = true}>
					View full page
				</button>
			{/if}
		</div>

		<div class="col-editor">
			{#if data.day.draft_text}
				<div class="draft-section">
					<span class="section-label">Machine draft</span>
					<div class="draft-text">{data.day.draft_text}</div>
				</div>
			{/if}

			<div class="correction-section">
				<label class="section-label" for="corrected-text">Corrected text</label>
				<textarea
					id="corrected-text"
					class="correction-textarea"
					bind:value={correctedText}
					placeholder="Type the corrected transcription here..."
				></textarea>
			</div>

			<div class="narrative-section">
				<label class="section-label" for="day-narrative">
					Day narrative
					<span class="field-hint">Memories, context, stories this entry brings to mind</span>
				</label>
				<textarea
					id="day-narrative"
					class="narrative-textarea"
					bind:value={dayNarrative}
					placeholder="What do you remember about this day? Any stories or context not written on the page..."
				></textarea>
			</div>
		</div>
	</div>

	{#if saveError}
		<div class="error-banner" role="alert">
			Save failed: {saveError}
			<button class="error-dismiss" onclick={() => saveError = ''}>Dismiss</button>
		</div>
	{/if}

	<div class="actions-bar">
		<button class="action-btn btn-danger" onclick={() => showFlagModal = true}>
			Flag Illegible
		</button>

		<form method="POST" action="?/skip" use:enhance={() => {
			saving = true;
			return ({ update }) => { saving = false; update(); };
		}}>
			<button type="submit" class="action-btn btn-secondary" disabled={saving}>
				Skip
			</button>
		</form>

		<form method="POST" action="?/save" use:enhance={() => {
			saving = true;
			saveError = '';
			return ({ result, update }) => {
				saving = false;
				if (result.type === 'failure') {
					saveError = (result.data as { error?: string })?.error ?? 'Save failed';
				} else {
					update();
				}
			};
		}}>
			<input type="hidden" name="correctedText" value={correctedText} />
			<input type="hidden" name="dayNarrative" value={dayNarrative} />
			<button type="submit" class="action-btn btn-primary" disabled={saving || correctedText.trim() === ''}>
				{saving ? 'Saving...' : data.day.correction_status === 'accepted' ? 'Save' : 'Save & Next'}
			</button>
		</form>
	</div>
</div>

{#if showFlagModal}
	<div class="modal-overlay" role="dialog" aria-label="Flag as illegible">
		<div class="modal">
			<h2>Flag as Illegible</h2>
			<p>This day will be marked as illegible and skipped. You can add an optional note.</p>
			<textarea
				class="flag-note"
				bind:value={flagNote}
				placeholder="Optional note (e.g., 'water damage', 'pencil too faint')"
			></textarea>
			<div class="modal-actions">
				<button class="action-btn btn-secondary" onclick={() => { showFlagModal = false; flagNote = ''; }}>
					Cancel
				</button>
				<form method="POST" action="?/flag" use:enhance={() => {
					saving = true;
					return ({ update }) => { saving = false; showFlagModal = false; update(); };
				}}>
					<input type="hidden" name="reviewNote" value={flagNote} />
					<button type="submit" class="action-btn btn-danger" disabled={saving}>
						Confirm
					</button>
				</form>
			</div>
		</div>
	</div>
{/if}

{#if lightboxOpen}
	<div class="lightbox-overlay" role="dialog" aria-label="Day cell zoom">
		<button class="lightbox-close" onclick={() => lightboxOpen = false} aria-label="Close">&times;</button>
		<button class="lightbox-bg" onclick={() => lightboxOpen = false} aria-label="Close overlay"></button>
		<div class="lightbox-content">
			<img src={imageSrc} alt="Day cell {dayNum}" class="lightbox-img" />
		</div>
	</div>
{/if}

{#if pageImageOpen}
	<div class="lightbox-overlay" role="dialog" aria-label="Full calendar page">
		<button class="lightbox-close" onclick={() => pageImageOpen = false} aria-label="Close">&times;</button>
		<button class="lightbox-bg" onclick={() => pageImageOpen = false} aria-label="Close overlay"></button>
		<div class="lightbox-content">
			<div class="lightbox-header">{monthNames[data.day.month]} {data.day.year} — Full Page</div>
			<img src={pageImageSrc} alt="Full calendar page" class="lightbox-img" />
		</div>
	</div>
{/if}

<style>
	.page {
		max-width: 1200px;
		margin: 0 auto;
		padding: 1rem;
		display: flex;
		flex-direction: column;
		min-height: 100vh;
	}
	header {
		margin-bottom: 1rem;
	}
	.breadcrumbs {
		display: flex;
		align-items: center;
		gap: 0.35rem;
	}
	.crumb-sep {
		color: #aaa;
		font-size: 0.85rem;
	}
	.back {
		font-size: 0.85rem;
		color: #555;
		text-decoration: none;
	}
	.back:hover { text-decoration: underline; }
	.header-row {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		margin: 0.25rem 0 0.3rem;
	}
	h1 {
		margin: 0;
		font-size: 1.3rem;
	}
	.status-badge {
		padding: 0.2rem 0.6rem;
		border-radius: 4px;
		font-size: 0.75rem;
		font-weight: 600;
	}
	.status-pending { background: #fff3cd; color: #856404; }
	.status-done { background: #e6f4e6; color: #1a7a1a; }
	.status-flag { background: #fde2e2; color: #c33; }
	.nav-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}
	.position {
		font-size: 0.85rem;
		color: #666;
	}
	.nav-links {
		display: flex;
		gap: 0.75rem;
	}
	.nav-link {
		font-size: 0.8rem;
		color: #555;
		text-decoration: none;
	}
	.nav-link:hover { text-decoration: underline; }
	.nav-link.uncorrected {
		color: #1a7a1a;
	}
	.nav-sep {
		width: 1px;
		height: 1rem;
		background: #ccc;
	}

	.editor-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 1.5rem;
		flex: 1;
	}
	.col-image {
		display: flex;
		flex-direction: column;
	}
	.img-btn {
		padding: 0;
		border: none;
		background: none;
		cursor: zoom-in;
		display: block;
		width: 100%;
	}
	.page-btn {
		margin-top: 0.5rem;
		padding: 0.4rem 0.8rem;
		border: 1px solid #ccc;
		border-radius: 4px;
		background: #fff;
		cursor: pointer;
		font-size: 0.8rem;
		color: #555;
		width: 100%;
	}
	.page-btn:hover {
		border-color: #666;
		color: #333;
	}
	.cell-img {
		width: 100%;
		height: auto;
		border-radius: 4px;
		border: 1px solid #ccc;
		display: block;
	}
	.manual-crop-section {
		border: 2px solid #c33;
		border-radius: 4px;
		margin-bottom: 0.5rem;
		background: #fff;
	}
	.manual-crop-img {
		width: 100%;
		height: auto;
		display: block;
		border-radius: 3px;
	}
	.page-image-container {
		position: relative;
		max-height: 40vh;
		overflow: auto;
		border: 1px solid #ccc;
		border-radius: 4px;
		padding: 0;
		background: none;
		cursor: zoom-in;
		display: block;
		width: 100%;
	}
	.page-img-inline {
		width: 100%;
		height: auto;
		display: block;
	}
	.cell-highlight {
		position: absolute;
		border: 3px solid #c33;
		background: rgba(204, 51, 51, 0.08);
		border-radius: 2px;
		pointer-events: none;
	}
	.manual-label {
		margin-top: 0.4rem;
		font-size: 0.8rem;
		font-weight: 600;
		color: #8b7355;
		text-align: center;
	}
	.col-editor {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
	.section-label {
		display: block;
		font-size: 0.8rem;
		font-weight: 600;
		color: #555;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		margin-bottom: 0.3rem;
	}
	.draft-section {
		background: #f8f8f4;
		padding: 0.75rem 1rem;
		border-radius: 4px;
		border: 1px solid #e0ddd0;
	}
	.draft-text {
		font-size: 0.95rem;
		line-height: 1.6;
		white-space: pre-wrap;
		color: #444;
	}
	.correction-section {
		flex: 1;
		display: flex;
		flex-direction: column;
	}
	.correction-textarea {
		width: 100%;
		min-height: 200px;
		flex: 1;
		font-size: 18px;
		font-family: inherit;
		line-height: 1.6;
		padding: 0.75rem 1rem;
		border: 2px solid #999;
		border-radius: 6px;
		resize: vertical;
		box-sizing: border-box;
	}
	.correction-textarea:focus {
		outline: none;
		border-color: #1a7a1a;
	}

	.narrative-section {
		border-top: 1px solid #e0e0e0;
		padding-top: 0.75rem;
	}
	.narrative-section .section-label {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.field-hint {
		font-size: 0.72rem;
		font-weight: 400;
		color: #888;
		text-transform: none;
		letter-spacing: 0;
	}
	.narrative-textarea {
		width: 100%;
		min-height: 80px;
		font-size: 16px;
		font-family: inherit;
		line-height: 1.5;
		padding: 0.6rem 0.85rem;
		border: 1px solid #c4b5a0;
		border-radius: 6px;
		resize: vertical;
		box-sizing: border-box;
		background: #fdfcf9;
	}
	.narrative-textarea:focus {
		outline: none;
		border-color: #8b7355;
	}

	.error-banner {
		padding: 0.75rem 1rem;
		background: #fde2e2;
		border: 1px solid #c33;
		border-radius: 4px;
		color: #c33;
		font-size: 0.9rem;
		font-weight: 600;
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-top: 0.5rem;
	}
	.error-dismiss {
		background: none;
		border: none;
		color: #c33;
		cursor: pointer;
		font-size: 0.85rem;
		text-decoration: underline;
	}
	.actions-bar {
		position: sticky;
		bottom: 0;
		background: #fff;
		border-top: 1px solid #ddd;
		padding: 0.75rem 0;
		margin-top: 1rem;
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 0.75rem;
	}
	.actions-bar form {
		display: contents;
	}
	.action-btn {
		min-height: 58px;
		min-width: 120px;
		padding: 0.75rem 1.5rem;
		font-size: 1.05rem;
		font-weight: 600;
		border-radius: 6px;
		cursor: pointer;
		border: none;
	}
	.btn-primary {
		background: #1a7a1a;
		color: #fff;
	}
	.btn-primary:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
	.btn-secondary {
		background: #fff;
		color: #333;
		border: 1px solid #ccc;
	}
	.btn-danger {
		background: #fff;
		color: #c33;
		border: 1px solid #c33;
	}

	.modal-overlay {
		position: fixed;
		inset: 0;
		z-index: 1000;
		background: rgba(0, 0, 0, 0.5);
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.modal {
		background: #fff;
		border-radius: 8px;
		padding: 1.5rem;
		max-width: 480px;
		width: 90%;
	}
	.modal h2 {
		margin: 0 0 0.5rem;
		font-size: 1.15rem;
	}
	.modal p {
		margin: 0 0 1rem;
		color: #555;
		font-size: 0.9rem;
	}
	.flag-note {
		width: 100%;
		min-height: 80px;
		font-size: 16px;
		font-family: inherit;
		padding: 0.5rem;
		border: 1px solid #ccc;
		border-radius: 4px;
		margin-bottom: 1rem;
		box-sizing: border-box;
		resize: vertical;
	}
	.modal-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.75rem;
	}
	.modal-actions .action-btn {
		min-height: 48px;
		min-width: 100px;
		font-size: 0.95rem;
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
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.75rem;
	}
	.lightbox-header {
		color: #fff;
		font-size: 1.1rem;
		font-weight: 600;
	}
	.lightbox-img {
		max-width: 90vw;
		max-height: 85vh;
		border-radius: 4px;
		object-fit: contain;
	}

	@media (max-width: 768px) {
		.editor-grid {
			grid-template-columns: 1fr;
		}
	}
</style>
