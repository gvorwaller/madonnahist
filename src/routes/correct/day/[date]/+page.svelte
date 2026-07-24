<script lang="ts">
	import { enhance, deserialize } from '$app/forms';
	import { page } from '$app/stores';

	const { data } = $props();

	const conflictBy = $derived($page.url.searchParams.get('conflict'));
	let conflictDismissed = $state(false);

	const monthNames = ['', 'January', 'February', 'March', 'April', 'May', 'June',
		'July', 'August', 'September', 'October', 'November', 'December'];

	const initialText = $derived(
		data.latestCorrection?.corrected_text && data.latestCorrection.corrected_text.trim() !== ''
			? data.latestCorrection.corrected_text
			: data.day.draft_text ?? data.day.ocr_raw_text ?? ''
	);

	let correctedText = $state('');
	let lastSavedText = $state('');
	let dayNarrative = $state('');
	let lastSavedNarrative = $state('');

	// Reset editor state ONLY when the day actually changes (tracked by
	// VALUE, not by object identity). The original effects here depended on
	// `data.day.entry_date` through the reactive `data` prop, so ANY data
	// invalidation — adding/accepting a tag, any enhance update() — re-ran
	// them and silently reset the textarea to initialText, destroying
	// whatever Madonna had typed since (production incident 2026-07-24:
	// Save appeared to "not save" because the form submitted the reverted
	// machine-draft text). The lastLoadedDate guard makes an equal-date
	// refresh a no-op for user-owned state.
	let lastLoadedDate = $state('');
	$effect(() => {
		const d = data.day.entry_date;
		if (d === lastLoadedDate) return;
		lastLoadedDate = d;
		correctedText = initialText;
		lastSavedText = initialText;
		dayNarrative = data.day.day_narrative ?? '';
		lastSavedNarrative = data.day.day_narrative ?? '';
		conflictDismissed = false;
		newTagLabel = '';
		tagError = '';
	});

	let saving = $state(false);
	let saveError = $state('');
	let showFlagModal = $state(false);
	let flagNote = $state('');
	let lightboxOpen = $state(false);
	let pageImageOpen = $state(false);
	let newTagLabel = $state('');
	let tagError = $state('');

	// td-c51cdb — human-confirmed tags keep the existing chips+remove UI;
	// AI-sourced suggestions render separately with Accept/Dismiss controls.
	const humanTags = $derived(data.tags.filter((t) => t.source !== 'ai'));
	const aiTags = $derived(data.tags.filter((t) => t.source === 'ai'));

	// td-b52a49 item 1 — auto-save. Debounces 1.5s after the last change to
	// correctedText/dayNarrative, and never fires while an explicit
	// save/skip/flag/accept-draft submit is in flight (the `saving` guard
	// below). See ?/autosave in +page.server.ts for the server-side safety
	// gate that suppresses the day_corrections insert on already-accepted
	// days.
	let autosaveTimer: ReturnType<typeof setTimeout> | undefined;
	let autosaveInFlight = $state(false);
	let autosaveStatus = $state('');

	$effect(() => {
		data.day.entry_date;
		autosaveStatus = '';
		if (autosaveTimer) clearTimeout(autosaveTimer);
	});

	function scheduleAutosave() {
		if (saving) return;
		if (correctedText === lastSavedText && dayNarrative === lastSavedNarrative) return;
		if (autosaveTimer) clearTimeout(autosaveTimer);
		autosaveTimer = setTimeout(() => { void doAutosave(); }, 1500);
	}

	$effect(() => {
		correctedText;
		dayNarrative;
		scheduleAutosave();
	});

	// Single-flight serialization (CODEX1 review finding 1, client half):
	// overlapping autosaves could complete out of order, making an older
	// snapshot the latest correction and corrupting lastSavedText. Only one
	// request runs at a time; a change arriving mid-flight queues exactly one
	// rerun after the current request settles.
	let autosaveActive: Promise<void> | null = null;
	let autosaveRerun = false;

	async function doAutosave(): Promise<void> {
		if (autosaveActive) {
			autosaveRerun = true;
			return;
		}
		autosaveActive = runAutosave();
		try {
			await autosaveActive;
		} finally {
			autosaveActive = null;
			if (autosaveRerun) {
				autosaveRerun = false;
				await doAutosave();
			}
		}
	}

	async function runAutosave(): Promise<void> {
		if (saving) return;
		const textChanged = correctedText !== lastSavedText;
		const narrativeChanged = dayNarrative !== lastSavedNarrative;
		if (!textChanged && !narrativeChanged) return;

		autosaveInFlight = true;
		const snapshotText = correctedText;
		const snapshotNarrative = dayNarrative;
		try {
			const formData = new FormData();
			if (textChanged) formData.set('correctedText', snapshotText);
			if (narrativeChanged) formData.set('dayNarrative', snapshotNarrative);
			const res = await fetch('?/autosave', { method: 'POST', body: formData });
			const result = deserialize(await res.text());
			if (result.type === 'success') {
				if (textChanged) lastSavedText = snapshotText;
				if (narrativeChanged) lastSavedNarrative = snapshotNarrative;
				const now = new Date();
				autosaveStatus = `Draft saved ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
			} else {
				autosaveStatus = 'Draft save failed';
			}
		} catch {
			autosaveStatus = 'Draft save failed';
		} finally {
			autosaveInFlight = false;
		}
	}

	async function flushAutosave(): Promise<void> {
		if (autosaveTimer) clearTimeout(autosaveTimer);
		// Wait out any in-flight request first so the final state wins.
		if (autosaveActive) await autosaveActive;
		await doAutosave();
	}

	let historyOpen = $state(false);
	let historyLoading = $state(false);
	let historyError = $state('');
	let historyData: {
		ocrRuns: { vendor: string; created_at: string; raw_text: string; confidence_score: number | null }[];
		llmDraftRuns: { model_name: string; created_at: string; draft_text: string }[];
		corrections: { display_name: string; created_at: string; status_after: string; corrected_text: string; review_note: string | null }[];
	} | null = $state(null);

	async function openHistory() {
		historyOpen = true;
		historyLoading = true;
		historyError = '';
		try {
			const res = await fetch(`/correct/day/${data.day.entry_date}/history`);
			if (!res.ok) throw new Error(`status ${res.status}`);
			historyData = await res.json();
		} catch {
			historyError = 'Could not load history.';
		} finally {
			historyLoading = false;
		}
	}

	function formatHistoryTime(iso: string): string {
		return new Date(iso).toLocaleString([], {
			month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit'
		});
	}

	const canAcceptDraft = $derived(
		!!data.day.draft_text && data.day.draft_text.trim() !== '' && data.day.correction_status !== 'accepted'
	);
	// Accept Draft replaces the day's text with the machine draft VERBATIM.
	// If Madonna has already typed corrections that differ from the draft,
	// one tap would silently discard her visible work (this contributed to
	// the 2026-07-24 lost-text incident) — so it disables the moment the
	// textarea diverges from the draft, with the title explaining why.
	const textMatchesDraft = $derived(
		correctedText.trim() === (data.day.draft_text ?? '').trim() || correctedText.trim() === ''
	);

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
		if (historyOpen) historyOpen = false;
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
			<div class="header-actions">
				<button type="button" class="header-btn" onclick={openHistory}>History</button>
				<form
					method="POST"
					action="?/pause"
					use:enhance={async () => {
						// Flush any pending debounced autosave before navigating away
						// — SvelteKit's enhance awaits this submit callback before
						// firing the actual POST, so the last few keystrokes before
						// "Done for now" aren't lost. See doAutosave()'s server-side
						// safety gate for what happens on an already-accepted day.
						await flushAutosave();
						return async ({ update }) => { update(); };
					}}
				>
					<button type="submit" class="header-btn">Done for now</button>
				</form>
			</div>
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

	{#if conflictBy && !conflictDismissed}
		<div class="conflict-bar" role="status">
			<span>Note: <strong>{conflictBy}</strong> also edited the previous day while you were on it. Your save is canonical.</span>
			<button class="conflict-dismiss" onclick={() => conflictDismissed = true}>Dismiss</button>
		</div>
	{/if}

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
				<div class="correction-label-row">
					<label class="section-label" for="corrected-text">Corrected text</label>
					{#if autosaveInFlight}
						<span class="autosave-status">Saving draft…</span>
					{:else if autosaveStatus}
						<span class="autosave-status">{autosaveStatus}</span>
					{/if}
				</div>
				<textarea
					id="corrected-text"
					class="correction-textarea"
					bind:value={correctedText}
					placeholder="Type the corrected transcription here..."
				></textarea>
			</div>

			{#if aiTags.length > 0}
				<div class="tags-section suggested-tags-section">
					<span class="section-label" id="suggested-tags-heading">Suggested tags</span>
					<div class="tag-chips" role="group" aria-labelledby="suggested-tags-heading">
						{#each aiTags as tag (tag.tag_slug)}
							<span class="tag-chip ai-tag">
								{tag.tag_label}
								<form
									method="POST"
									action="?/acceptTag"
									use:enhance={() => {
										tagError = '';
										return ({ result, update }) => {
											if (result.type === 'failure') {
												tagError = (result.data as { error?: string })?.error ?? 'Accept failed';
											}
											update();
										};
									}}
								>
									<input type="hidden" name="tagSlug" value={tag.tag_slug} />
									<button type="submit" class="tag-accept" aria-label="Accept suggested tag {tag.tag_label}">&check;</button>
								</form>
								<form
									method="POST"
									action="?/removeTag"
									use:enhance={() => {
										tagError = '';
										return ({ result, update }) => {
											if (result.type === 'failure') {
												tagError = (result.data as { error?: string })?.error ?? 'Dismiss failed';
											}
											update();
										};
									}}
								>
									<input type="hidden" name="tagSlug" value={tag.tag_slug} />
									<button type="submit" class="tag-remove" aria-label="Dismiss suggested tag {tag.tag_label}">&times;</button>
								</form>
							</span>
						{/each}
					</div>
				</div>
			{/if}

			<div class="tags-section">
				<span class="section-label" id="tags-heading">Tags</span>
				<div class="tag-chips" role="group" aria-labelledby="tags-heading">
					{#each humanTags as tag (tag.tag_slug)}
						<span class="tag-chip">
							{tag.tag_label}
							<form
								method="POST"
								action="?/removeTag"
								use:enhance={() => {
									tagError = '';
									return ({ result, update }) => {
										if (result.type === 'failure') {
											tagError = (result.data as { error?: string })?.error ?? 'Remove failed';
										}
										update();
									};
								}}
							>
								<input type="hidden" name="tagSlug" value={tag.tag_slug} />
								<button type="submit" class="tag-remove" aria-label="Remove tag {tag.tag_label}">&times;</button>
							</form>
						</span>
					{:else}
						<span class="tags-empty">No tags yet</span>
					{/each}
				</div>
				<form
					method="POST"
					action="?/addTag"
					class="tag-add-form"
					use:enhance={() => {
						tagError = '';
						return ({ result, update }) => {
							if (result.type === 'failure') {
								tagError = (result.data as { error?: string })?.error ?? 'Add failed';
							} else {
								newTagLabel = '';
							}
							update();
						};
					}}
				>
					<input
						type="text"
						name="tagLabel"
						list="tag-suggestions"
						bind:value={newTagLabel}
						maxlength="40"
						placeholder="Add a tag…"
						class="tag-input"
						aria-label="Add a tag"
					/>
					<datalist id="tag-suggestions">
						{#each data.tagSuggestions as s (s.tag_slug)}
							<option value={s.tag_label}></option>
						{/each}
					</datalist>
					<button type="submit" class="tag-add-btn" disabled={newTagLabel.trim() === ''}>Add</button>
				</form>
				{#if tagError}
					<p class="tag-error" role="alert">{tagError}</p>
				{/if}
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
			if (autosaveTimer) clearTimeout(autosaveTimer);
			return ({ update }) => { saving = false; update(); };
		}}>
			<button type="submit" class="action-btn btn-secondary" disabled={saving}>
				Skip
			</button>
		</form>

		{#if canAcceptDraft}
			<form method="POST" action="?/acceptDraft" use:enhance={() => {
				saving = true;
				saveError = '';
				if (autosaveTimer) clearTimeout(autosaveTimer);
				return ({ result, update }) => {
					saving = false;
					if (result.type === 'failure') {
						saveError = (result.data as { error?: string })?.error ?? 'Accept draft failed';
					} else {
						update();
					}
				};
			}}>
				<button
					type="submit"
					class="action-btn btn-accept-draft"
					disabled={saving || !textMatchesDraft}
					title={!textMatchesDraft
						? 'Your text differs from the machine draft — use Save to keep your edits'
						: 'Accept the machine draft as-is and continue'}
				>
					Accept Draft
				</button>
			</form>
		{/if}

		<form method="POST" action="?/save" use:enhance={() => {
			saving = true;
			saveError = '';
			if (autosaveTimer) clearTimeout(autosaveTimer);
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
			<input type="hidden" name="pageLoadedAt" value={data.serverLoadedAt} />
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
					if (autosaveTimer) clearTimeout(autosaveTimer);
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

{#if historyOpen}
	<div class="modal-overlay" role="dialog" aria-label="History for {dateLabel}">
		<div class="modal history-modal">
			<div class="history-header">
				<h2>History — {dateLabel}</h2>
				<button class="history-close" onclick={() => historyOpen = false} aria-label="Close history">&times;</button>
			</div>
			<div class="history-body">
				{#if historyLoading}
					<p class="history-loading">Loading…</p>
				{:else if historyError}
					<p class="history-error" role="alert">{historyError}</p>
				{:else if historyData}
					<section class="history-section">
						<h3>Corrections</h3>
						{#each historyData.corrections as c, i (i)}
							<div class="history-entry">
								<div class="history-entry-meta">
									<span class="history-entry-who">{c.display_name}</span>
									<span class="history-entry-when">{formatHistoryTime(c.created_at)}</span>
									<span class="history-entry-status">{c.status_after}</span>
								</div>
								{#if c.corrected_text}
									<div class="history-entry-text">{c.corrected_text}</div>
								{/if}
								{#if c.review_note}
									<div class="history-entry-note">Note: {c.review_note}</div>
								{/if}
							</div>
						{:else}
							<p class="history-empty">No correction history yet.</p>
						{/each}
					</section>

					<section class="history-section">
						<h3>LLM drafts</h3>
						{#each historyData.llmDraftRuns as d, i (i)}
							<div class="history-entry">
								<div class="history-entry-meta">
									<span class="history-entry-who">{d.model_name}</span>
									<span class="history-entry-when">{formatHistoryTime(d.created_at)}</span>
								</div>
								<div class="history-entry-text">{d.draft_text}</div>
							</div>
						{:else}
							<p class="history-empty">No LLM drafts yet.</p>
						{/each}
					</section>

					<section class="history-section">
						<h3>OCR runs</h3>
						{#each historyData.ocrRuns as o, i (i)}
							<div class="history-entry">
								<div class="history-entry-meta">
									<span class="history-entry-who">{o.vendor}</span>
									<span class="history-entry-when">{formatHistoryTime(o.created_at)}</span>
									{#if o.confidence_score !== null}
										<span class="history-entry-status">confidence {o.confidence_score.toFixed(2)}</span>
									{/if}
								</div>
								<div class="history-entry-text">{o.raw_text}</div>
							</div>
						{:else}
							<p class="history-empty">No OCR runs yet.</p>
						{/each}
					</section>
				{/if}
			</div>
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
	.header-actions {
		display: flex;
		gap: 0.5rem;
		margin-left: auto;
	}
	.header-btn {
		min-height: 44px;
		padding: 0.4rem 1rem;
		background: #fff;
		border: 1px solid #ccc;
		border-radius: 6px;
		color: #333;
		font-size: 0.85rem;
		font-weight: 500;
		font-family: inherit;
		cursor: pointer;
	}
	.header-btn:hover {
		border-color: #999;
		background: #f5f5f5;
	}
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
	.correction-label-row {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.5rem;
	}
	.autosave-status {
		font-size: 0.75rem;
		font-weight: 500;
		color: #666;
		white-space: nowrap;
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

	.tags-section {
		border-top: 1px solid #e0e0e0;
		padding-top: 0.75rem;
	}
	.suggested-tags-section {
		border-top: none;
		padding-top: 0;
	}
	.tag-chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		margin: 0.4rem 0 0.6rem;
	}
	.tags-empty {
		font-size: 0.85rem;
		color: #888;
		font-style: italic;
	}
	.tag-chip {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		padding: 0.3rem 0.3rem 0.3rem 0.7rem;
		background: #eef3ec;
		border: 1px solid #c8d8c4;
		border-radius: 999px;
		font-size: 0.85rem;
		color: #2b4a2b;
	}
	.tag-chip.ai-tag {
		background: #f3ecf7;
		border-color: #d8c4e8;
		color: #4a2b5a;
	}
	.tag-chip form {
		display: contents;
	}
	.tag-remove {
		display: flex;
		align-items: center;
		justify-content: center;
		min-width: 44px;
		min-height: 44px;
		margin: -0.3rem -0.3rem -0.3rem 0;
		border: none;
		background: none;
		font-size: 1.1rem;
		line-height: 1;
		color: inherit;
		cursor: pointer;
		border-radius: 999px;
	}
	.tag-remove:hover {
		background: rgba(0, 0, 0, 0.08);
	}
	.tag-accept {
		display: flex;
		align-items: center;
		justify-content: center;
		min-width: 44px;
		min-height: 44px;
		margin: -0.3rem 0 -0.3rem 0;
		border: none;
		background: none;
		font-size: 1rem;
		font-weight: 700;
		line-height: 1;
		color: #1a7a1a;
		cursor: pointer;
		border-radius: 999px;
	}
	.tag-accept:hover {
		background: rgba(26, 122, 26, 0.12);
	}
	.tag-add-form {
		display: flex;
		gap: 0.5rem;
	}
	.tag-input {
		flex: 1;
		min-height: 44px;
		font-size: 16px;
		font-family: inherit;
		padding: 0.4rem 0.7rem;
		border: 1px solid #ccc;
		border-radius: 6px;
		box-sizing: border-box;
	}
	.tag-input:focus {
		outline: none;
		border-color: #1a7a1a;
	}
	.tag-add-btn {
		min-height: 44px;
		min-width: 60px;
		padding: 0.4rem 0.9rem;
		border: 1px solid #1a7a1a;
		border-radius: 6px;
		background: #fff;
		color: #1a7a1a;
		font-weight: 600;
		cursor: pointer;
	}
	.tag-add-btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
	.tag-error {
		margin: 0.4rem 0 0;
		font-size: 0.8rem;
		color: #c33;
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
	.btn-accept-draft {
		background: #fff;
		color: #4a2b5a;
		border: 1px solid #d8c4e8;
	}
	.btn-accept-draft:hover {
		background: #f3ecf7;
	}
	.btn-accept-draft:disabled {
		opacity: 0.4;
		cursor: not-allowed;
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

	.history-modal {
		max-width: 640px;
		max-height: 85vh;
		display: flex;
		flex-direction: column;
	}
	.history-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		margin-bottom: 0.75rem;
	}
	.history-header h2 {
		margin: 0;
		font-size: 1.1rem;
	}
	.history-close {
		min-width: 44px;
		min-height: 44px;
		background: none;
		border: none;
		font-size: 1.5rem;
		line-height: 1;
		color: #555;
		cursor: pointer;
	}
	.history-body {
		overflow-y: auto;
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
	}
	.history-section h3 {
		margin: 0 0 0.5rem;
		font-size: 0.8rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: #666;
	}
	.history-entry {
		padding: 0.6rem 0.75rem;
		background: #f8f8f4;
		border: 1px solid #e0ddd0;
		border-radius: 6px;
		margin-bottom: 0.5rem;
	}
	.history-entry-meta {
		display: flex;
		gap: 0.6rem;
		flex-wrap: wrap;
		font-size: 0.75rem;
		color: #888;
		margin-bottom: 0.3rem;
	}
	.history-entry-who {
		font-weight: 600;
		color: #444;
	}
	.history-entry-text {
		font-size: 0.9rem;
		line-height: 1.5;
		white-space: pre-wrap;
		color: #333;
	}
	.history-entry-note {
		margin-top: 0.3rem;
		font-size: 0.8rem;
		color: #c33;
	}
	.history-empty {
		font-size: 0.85rem;
		color: #888;
		font-style: italic;
	}
	.history-loading, .history-error {
		font-size: 0.9rem;
		color: #555;
	}
	.history-error {
		color: #c33;
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

	.conflict-bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		background: #e8f4fd;
		border: 1px solid #b3d9f2;
		border-radius: 6px;
		padding: 0.6rem 1rem;
		margin-bottom: 1rem;
		font-size: 0.85rem;
		color: #1a4a6b;
	}
	.conflict-dismiss {
		padding: 0.3rem 0.75rem;
		background: transparent;
		border: 1px solid #b3d9f2;
		border-radius: 4px;
		font-size: 0.8rem;
		cursor: pointer;
		font-family: inherit;
		color: #1a4a6b;
		flex-shrink: 0;
	}
	.conflict-dismiss:hover { background: #d4ecf7; }

	@media (max-width: 768px) {
		.editor-grid {
			grid-template-columns: 1fr;
		}
	}
</style>
