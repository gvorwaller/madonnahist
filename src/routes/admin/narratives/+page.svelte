<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';

	const { data } = $props();

	interface NarrativeYearRow {
		year: number;
		accepted: number;
		total: number;
		percent: number;
		status: 'none' | 'draft' | 'published';
		narrative: {
			id: number;
			scope_key: string;
			summary_text: string;
			generated_by: string;
			generated_at: string;
			is_published: boolean;
		} | null;
		pendingJob: boolean;
	}

	let actionError = $state('');
	let expandedYear = $state<number | null>(null);
	let editingYear = $state<number | null>(null);
	let editText = $state('');
	let publishTarget = $state<number | null>(null);
	let unpublishTarget = $state<number | null>(null);
	let regenerateTarget = $state<number | null>(null);

	const statusLabels: Record<string, string> = { none: 'None', draft: 'Draft', published: 'Published' };

	// Auto-refresh every 30s (same idea as the OCR review screen's polling)
	// so a finished generation shows up without a manual reload. Paused while
	// a draft is being edited so a refresh never races the textarea.
	$effect(() => {
		const timer = setInterval(() => {
			if (editingYear === null) invalidateAll();
		}, 30_000);
		return () => clearInterval(timer);
	});

	function toggleExpand(year: number) {
		expandedYear = expandedYear === year ? null : year;
		if (editingYear !== year) cancelEdit();
	}

	function startEdit(row: NarrativeYearRow) {
		editingYear = row.year;
		editText = row.narrative?.summary_text ?? '';
	}
	function cancelEdit() {
		editingYear = null;
		editText = '';
	}

	function paragraphs(text: string): string[] {
		return text.split(/\n{2,}/).map((p) => p.trim()).filter((p) => p.length > 0);
	}
</script>

<svelte:window
	onkeydown={(e) => {
		if (e.key === 'Escape') {
			if (publishTarget !== null) publishTarget = null;
			if (unpublishTarget !== null) unpublishTarget = null;
			if (regenerateTarget !== null) regenerateTarget = null;
		}
	}}
/>

<div class="page">
	<header>
		<a href="/admin" class="back">Admin</a>
		<h1>Year Narratives</h1>
		<p class="subtitle">
			AI-generated year summaries, drafted by the enrichment worker from accepted transcriptions.
			Drafts are invisible to the family viewer until published.
		</p>
	</header>

	{#if actionError}
		<div class="error-banner" role="alert">
			{actionError}
			<button class="error-dismiss" onclick={() => (actionError = '')}>Dismiss</button>
		</div>
	{/if}

	{#if data.years.length === 0}
		<p class="empty">No years have any accepted days yet.</p>
	{:else}
		<table class="data-table">
			<thead>
				<tr>
					<th>Year</th>
					<th class="col-num">Accepted</th>
					<th>Status</th>
					<th>Generated</th>
					<th class="col-actions">Actions</th>
				</tr>
			</thead>
			<tbody>
				{#each data.years as row (row.year)}
					<tr>
						<td>{row.year}</td>
						<td class="col-num">{row.accepted} / {row.total} ({row.percent}%)</td>
						<td>
							<span class="status-tag status-{row.status}">{statusLabels[row.status]}</span>
							{#if row.pendingJob}
								<span class="pending-tag">generating…</span>
							{/if}
						</td>
						<td class="col-meta">
							{#if row.narrative}
								{new Date(row.narrative.generated_at).toLocaleString()} &middot; {row.narrative.generated_by}
							{:else}
								&mdash;
							{/if}
						</td>
						<td class="col-actions">
							{#if row.narrative}
								<button class="btn btn-sm btn-secondary" onclick={() => toggleExpand(row.year)}>
									{expandedYear === row.year ? 'Hide' : 'Review'}
								</button>
							{/if}

							{#if row.status === 'none' || row.status === 'draft'}
								<form
									method="POST"
									action="?/generate"
									use:enhance={() => {
										return ({ result, update }) => {
											if (result.type === 'failure') {
												actionError = (result.data as { error?: string })?.error ?? 'Generate failed';
											}
											update();
										};
									}}
								>
									<input type="hidden" name="year" value={row.year} />
									<button type="submit" class="btn btn-sm btn-primary" disabled={row.pendingJob}>
										{row.status === 'none' ? 'Generate' : 'Regenerate'}
									</button>
								</form>
							{:else}
								<button
									class="btn btn-sm btn-primary"
									disabled
									title='Published — use "Unpublish & Regenerate" to replace the visible text'
								>
									Regenerate
								</button>
							{/if}

							{#if row.status === 'draft'}
								<button class="btn btn-sm btn-primary" onclick={() => (publishTarget = row.year)}>Publish</button>
							{:else if row.status === 'published'}
								<button class="btn btn-sm btn-secondary" onclick={() => (unpublishTarget = row.year)}>
									Unpublish
								</button>
								<button class="btn btn-sm btn-danger" onclick={() => (regenerateTarget = row.year)} disabled={row.pendingJob}>
									Unpublish &amp; Regenerate
								</button>
							{/if}
						</td>
					</tr>

					{#if expandedYear === row.year && row.narrative}
						<tr class="detail-row">
							<td colspan="5">
								{#if editingYear === row.year}
									<form
										method="POST"
										action="?/saveEdit"
										use:enhance={() => {
											return ({ result, update }) => {
												if (result.type === 'failure') {
													actionError = (result.data as { error?: string })?.error ?? 'Save failed';
												} else {
													cancelEdit();
												}
												update();
											};
										}}
									>
										<input type="hidden" name="year" value={row.year} />
										<textarea name="summaryText" bind:value={editText} rows="14" class="edit-textarea"></textarea>
										<div class="edit-actions">
											<button type="submit" class="btn btn-sm btn-primary">Save</button>
											<button type="button" class="btn btn-sm btn-secondary" onclick={cancelEdit}>Cancel</button>
										</div>
									</form>
								{:else}
									<div class="preview">
										{#each paragraphs(row.narrative.summary_text) as para, i (i)}
											<p>{para}</p>
										{/each}
									</div>
									<button class="btn btn-sm btn-secondary" onclick={() => startEdit(row)}>Edit</button>
								{/if}
							</td>
						</tr>
					{/if}
				{/each}
			</tbody>
		</table>
	{/if}
</div>

{#if publishTarget !== null}
	<div class="modal-overlay" role="dialog" aria-modal="true" aria-label="Confirm publish">
		<div class="modal-content">
			<h3>Publish narrative</h3>
			<p>
				Publish the {publishTarget} narrative? It will immediately become visible to every family
				viewer on the {publishTarget} year page, labeled as AI-generated.
			</p>
			<div class="modal-actions">
				<button class="btn-cancel" onclick={() => (publishTarget = null)}>Cancel</button>
				<form
					method="POST"
					action="?/publish"
					use:enhance={() => {
						return ({ result, update }) => {
							if (result.type === 'failure') {
								actionError = (result.data as { error?: string })?.error ?? 'Publish failed';
							}
							publishTarget = null;
							update();
						};
					}}
				>
					<input type="hidden" name="year" value={publishTarget} />
					<button type="submit" class="btn-danger">Publish</button>
				</form>
			</div>
		</div>
	</div>
{/if}

{#if unpublishTarget !== null}
	<div class="modal-overlay" role="dialog" aria-modal="true" aria-label="Confirm unpublish">
		<div class="modal-content">
			<h3>Unpublish narrative</h3>
			<p>
				Unpublish the {unpublishTarget} narrative? It will immediately disappear from the family
				viewer. The draft text is kept and can be republished later.
			</p>
			<div class="modal-actions">
				<button class="btn-cancel" onclick={() => (unpublishTarget = null)}>Cancel</button>
				<form
					method="POST"
					action="?/unpublish"
					use:enhance={() => {
						return ({ result, update }) => {
							if (result.type === 'failure') {
								actionError = (result.data as { error?: string })?.error ?? 'Unpublish failed';
							}
							unpublishTarget = null;
							update();
						};
					}}
				>
					<input type="hidden" name="year" value={unpublishTarget} />
					<button type="submit" class="btn-danger">Unpublish</button>
				</form>
			</div>
		</div>
	</div>
{/if}

{#if regenerateTarget !== null}
	<div class="modal-overlay" role="dialog" aria-modal="true" aria-label="Confirm unpublish and regenerate">
		<div class="modal-content">
			<h3>Unpublish &amp; regenerate</h3>
			<p>
				This immediately unpublishes the {regenerateTarget} narrative — it disappears from the
				family viewer right away — and queues a brand-new AI draft to replace the current text.
				The new draft will NOT be visible to anyone until you review and publish it again. This
				cannot be undone.
			</p>
			<div class="modal-actions">
				<button class="btn-cancel" onclick={() => (regenerateTarget = null)}>Cancel</button>
				<form
					method="POST"
					action="?/unpublishAndRegenerate"
					use:enhance={() => {
						return ({ result, update }) => {
							if (result.type === 'failure') {
								actionError = (result.data as { error?: string })?.error ?? 'Unpublish & regenerate failed';
							}
							regenerateTarget = null;
							update();
						};
					}}
				>
					<input type="hidden" name="year" value={regenerateTarget} />
					<button type="submit" class="btn-danger">Unpublish &amp; Regenerate</button>
				</form>
			</div>
		</div>
	</div>
{/if}

<style>
	.page {
		max-width: 960px;
		margin: 0 auto;
		padding: 1.5rem 1rem;
	}
	header {
		margin-bottom: 1.25rem;
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
		margin: 0.25rem 0 0.2rem;
		font-size: 1.4rem;
	}
	.subtitle {
		margin: 0;
		color: #595959;
		font-size: 0.85rem;
		max-width: 640px;
	}
	.empty {
		color: #777;
		font-size: 0.85rem;
		font-style: italic;
	}
	.data-table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.85rem;
	}
	.data-table th,
	.data-table td {
		text-align: left;
		padding: 0.5rem 0.6rem;
		border-bottom: 1px solid #e5e5e5;
		vertical-align: middle;
	}
	.col-num {
		text-align: right;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}
	.col-meta {
		color: #666;
		white-space: nowrap;
	}
	.col-actions {
		white-space: nowrap;
	}
	.col-actions form {
		display: inline;
	}
	.status-tag {
		display: inline-block;
		padding: 0.15rem 0.5rem;
		border-radius: 999px;
		font-size: 0.75rem;
		font-weight: 600;
	}
	.status-none {
		background: #eee;
		color: #555;
	}
	.status-draft {
		background: #fdf1d6;
		color: #7a5300;
	}
	.status-published {
		background: #e1f0e6;
		color: #1c5a33;
	}
	.pending-tag {
		margin-left: 0.4rem;
		font-size: 0.75rem;
		font-style: italic;
		color: #777;
	}
	.detail-row td {
		background: #fafafa;
		padding: 1rem;
	}
	.preview p {
		font-family: Georgia, 'Iowan Old Style', serif;
		font-size: 0.95rem;
		line-height: 1.6;
		color: #2b2620;
		margin: 0 0 0.85rem;
	}
	.edit-textarea {
		width: 100%;
		font-family: ui-monospace, monospace;
		font-size: 0.85rem;
		padding: 0.6rem;
		border: 1px solid #ccc;
		border-radius: 6px;
		resize: vertical;
	}
	.edit-actions {
		margin-top: 0.5rem;
		display: flex;
		gap: 0.5rem;
	}
	.btn {
		border: none;
		border-radius: 5px;
		cursor: pointer;
		font-size: 0.8rem;
		padding: 0.35rem 0.7rem;
	}
	.btn-sm {
		margin-right: 0.25rem;
	}
	.btn-primary {
		background: #2a5f4c;
		color: #fff;
	}
	.btn-secondary {
		background: #eee;
		color: #333;
	}
	.btn-danger {
		background: #b3261e;
		color: #fff;
	}
	.btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.error-banner {
		background: #fdecea;
		border: 1px solid #f5c2c0;
		color: #7a1f1a;
		padding: 0.6rem 0.9rem;
		border-radius: 6px;
		margin-bottom: 1rem;
		font-size: 0.85rem;
		display: flex;
		justify-content: space-between;
		align-items: center;
	}
	.error-dismiss {
		background: none;
		border: none;
		color: #7a1f1a;
		text-decoration: underline;
		cursor: pointer;
		font-size: 0.8rem;
	}

	.modal-overlay {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.45);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 100;
	}
	.modal-content {
		background: #fff;
		border-radius: 8px;
		padding: 1.25rem 1.5rem;
		max-width: 460px;
		width: 90%;
	}
	.modal-content h3 {
		margin: 0 0 0.5rem;
		font-size: 1.05rem;
	}
	.modal-content p {
		margin: 0 0 1rem;
		font-size: 0.9rem;
		color: #444;
		line-height: 1.5;
	}
	.modal-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.6rem;
	}
	.btn-cancel {
		background: #eee;
		border: none;
		border-radius: 5px;
		padding: 0.4rem 0.9rem;
		cursor: pointer;
		font-size: 0.85rem;
	}
</style>
