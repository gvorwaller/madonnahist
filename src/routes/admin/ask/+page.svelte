<script lang="ts">
	import { enhance } from '$app/forms';
	import EntityPicker from '$lib/components/EntityPicker.svelte';

	const { data } = $props();

	interface AskResult {
		question: string;
		subsetSummary: string;
		subsetDefinition: unknown;
		dayCount: number;
		narrativeText: string;
		modelName: string;
	}

	interface SavedRow {
		id: number;
		question: string;
		subset_definition: unknown;
		narrative_text: string;
		day_count: number;
		model_name: string;
		created_at: string;
		created_by_name: string;
	}

	let entityId = $state<number | null>(null);
	let asking = $state(false);
	let actionError = $state('');
	let askResult = $state<AskResult | null>(null);
	let expandedSavedId = $state<number | null>(null);
	let deleteTarget = $state<{ id: number; question: string } | null>(null);

	function paragraphs(text: string): string[] {
		return text
			.split(/\n{2,}/)
			.map((p) => p.trim())
			.filter((p) => p.length > 0);
	}

	function subsetSummaryOf(row: SavedRow): string {
		const sd = row.subset_definition as { subsetSummary?: string } | null | undefined;
		return sd?.subsetSummary ?? 'the entire accepted archive';
	}
</script>

<svelte:window
	onkeydown={(e) => {
		if (e.key === 'Escape' && deleteTarget !== null) deleteTarget = null;
	}}
/>

<div class="page">
	<header>
		<a href="/admin" class="back">Admin</a>
		<h1>Ask the Archive</h1>
		<p class="subtitle">
			Pick a subset of accepted, transcribed days — by date range, person or place, tag, and/or a
			search term — then ask a freeform question. The AI answers using only that subset; results
			are shown once and are not saved unless you choose to save them.
		</p>
	</header>

	{#if actionError}
		<div class="error-banner" role="alert">
			{actionError}
			<button class="error-dismiss" onclick={() => (actionError = '')}>Dismiss</button>
		</div>
	{/if}

	<form
		method="POST"
		action="?/ask"
		class="ask-form"
		use:enhance={() => {
			asking = true;
			askResult = null;
			return async ({ result, update }) => {
				asking = false;
				if (result.type === 'failure') {
					actionError = (result.data as { error?: string } | undefined)?.error ?? 'Ask failed';
				} else if (result.type === 'success') {
					actionError = '';
					const returned = result.data as { askResult?: AskResult } | undefined;
					askResult = returned?.askResult ?? null;
				}
				await update({ invalidateAll: false });
			};
		}}
	>
		<div class="field">
			<label for="question">Question</label>
			<textarea id="question" name="question" rows="3" maxlength="500" required
				placeholder="e.g. What were the summers like when Rebekah visited?"></textarea>
		</div>

		<div class="filters-grid">
			<div class="field">
				<label for="yearFrom">From year</label>
				<input id="yearFrom" name="yearFrom" type="number" min="1900" max="2100" placeholder="e.g. 1975" />
			</div>
			<div class="field">
				<label for="yearTo">To year</label>
				<input id="yearTo" name="yearTo" type="number" min="1900" max="2100" placeholder="e.g. 1979" />
			</div>
			<div class="field">
				<span id="entity-label" class="field-label">Person or place</span>
				<input type="hidden" name="entityId" value={entityId ?? ''} />
				<EntityPicker
					options={data.entityOptions}
					bind:selectedId={entityId}
					placeholder="Type a name to search…"
					inputLabel="Filter by person or place"
				/>
			</div>
			<div class="field">
				<label for="tagSlug">Tag</label>
				<select id="tagSlug" name="tagSlug">
					<option value="">Any tag</option>
					{#each data.tagOptions as t (t.slug)}
						<option value={t.slug}>{t.label}</option>
					{/each}
				</select>
			</div>
			<div class="field field-wide">
				<label for="searchTerm">Search term</label>
				<input id="searchTerm" name="searchTerm" type="text" maxlength="200" placeholder="e.g. thanksgiving" />
			</div>
		</div>

		<button type="submit" class="btn btn-primary" disabled={asking}>
			{asking ? 'Asking…' : 'Ask'}
		</button>
		{#if asking}
			<p class="pending-note" role="status">
				Generating an answer from the matching entries — this can take a little while.
			</p>
		{/if}
	</form>

	{#if askResult}
		<section class="result-card">
			<p class="result-label">
				AI-generated — from {askResult.dayCount} transcribed
				{askResult.dayCount === 1 ? 'day' : 'days'} matching: {askResult.subsetSummary}
			</p>
			<div class="result-text">
				{#each paragraphs(askResult.narrativeText) as para, i (i)}
					<p>{para}</p>
				{/each}
			</div>
			<form
				method="POST"
				action="?/save"
				use:enhance={() => {
					return async ({ result, update }) => {
						if (result.type === 'failure') {
							actionError = (result.data as { error?: string } | undefined)?.error ?? 'Save failed';
						} else if (result.type === 'success') {
							actionError = '';
							askResult = null;
						}
						await update();
					};
				}}
			>
				<input type="hidden" name="question" value={askResult.question} />
				<input type="hidden" name="narrativeText" value={askResult.narrativeText} />
				<input type="hidden" name="modelName" value={askResult.modelName} />
				<input type="hidden" name="dayCount" value={askResult.dayCount} />
				<input type="hidden" name="subsetDefinition" value={JSON.stringify(askResult.subsetDefinition)} />
				<button type="submit" class="btn btn-secondary">Save this answer</button>
			</form>
		</section>
	{/if}

	<section class="saved-section">
		<h2>Saved Answers</h2>
		{#if data.saved.length === 0}
			<p class="empty">No saved answers yet.</p>
		{:else}
			<ul class="saved-list">
				{#each data.saved as row (row.id)}
					<li class="saved-row">
						<div class="saved-header">
							<div>
								<p class="saved-question">{row.question}</p>
								<p class="saved-meta">
									{subsetSummaryOf(row)} &middot; {row.day_count}
									{row.day_count === 1 ? 'day' : 'days'} &middot;
									{new Date(row.created_at).toLocaleString()} &middot; {row.created_by_name}
								</p>
							</div>
							<div class="saved-actions">
								<button
									class="btn btn-sm btn-secondary"
									onclick={() => (expandedSavedId = expandedSavedId === row.id ? null : row.id)}
								>
									{expandedSavedId === row.id ? 'Hide' : 'View'}
								</button>
								<button
									class="btn btn-sm btn-danger"
									onclick={() => (deleteTarget = { id: row.id, question: row.question })}
								>
									Delete
								</button>
							</div>
						</div>
						{#if expandedSavedId === row.id}
							<div class="saved-text">
								{#each paragraphs(row.narrative_text) as para, i (i)}
									<p>{para}</p>
								{/each}
							</div>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</section>
</div>

{#if deleteTarget}
	<div class="modal-overlay" role="dialog" aria-modal="true" aria-label="Confirm delete">
		<div class="modal-content">
			<h3>Delete saved answer</h3>
			<p>Delete the saved answer to "{deleteTarget.question}"? This cannot be undone.</p>
			<div class="modal-actions">
				<button class="btn-cancel" onclick={() => (deleteTarget = null)}>Cancel</button>
				<form
					method="POST"
					action="?/delete"
					use:enhance={() => {
						return async ({ result, update }) => {
							if (result.type === 'failure') {
								actionError = (result.data as { error?: string } | undefined)?.error ?? 'Delete failed';
							}
							deleteTarget = null;
							await update();
						};
					}}
				>
					<input type="hidden" name="id" value={deleteTarget.id} />
					<button type="submit" class="btn-danger">Delete</button>
				</form>
			</div>
		</div>
	</div>
{/if}

<style>
	.page {
		max-width: 860px;
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
		max-width: 680px;
		line-height: 1.5;
	}
	.ask-form {
		background: #fafafa;
		border: 1px solid #ddd;
		border-radius: 8px;
		padding: 1rem 1.1rem;
		margin-bottom: 1.5rem;
	}
	.field {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		margin-bottom: 0.9rem;
	}
	.field-label,
	label {
		font-size: 0.82rem;
		font-weight: 600;
		color: #333;
	}
	textarea,
	input[type='text'],
	input[type='number'],
	select {
		font: inherit;
		font-size: 0.9rem;
		padding: 0.45rem 0.55rem;
		border: 1px solid #999;
		border-radius: 4px;
		box-sizing: border-box;
		width: 100%;
	}
	textarea:focus-visible,
	input:focus-visible,
	select:focus-visible {
		outline: 2px solid #1a4731;
		outline-offset: 1px;
	}
	.filters-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
		gap: 0.6rem 1rem;
		margin-bottom: 0.5rem;
	}
	.field-wide {
		grid-column: 1 / -1;
	}
	.btn {
		border: none;
		border-radius: 5px;
		cursor: pointer;
		font-size: 0.85rem;
		padding: 0.5rem 1rem;
	}
	.btn-sm {
		font-size: 0.8rem;
		padding: 0.35rem 0.7rem;
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
		opacity: 0.55;
		cursor: not-allowed;
	}
	.pending-note {
		margin: 0.5rem 0 0;
		font-size: 0.82rem;
		font-style: italic;
		color: #555;
	}
	.result-card {
		background: #f4f8f5;
		border: 1px solid #bcd6c4;
		border-radius: 8px;
		padding: 1rem 1.1rem;
		margin-bottom: 1.5rem;
	}
	.result-label {
		margin: 0 0 0.7rem;
		font-size: 0.8rem;
		font-weight: 600;
		color: #1c5a33;
		text-transform: uppercase;
		letter-spacing: 0.02em;
	}
	.result-text p,
	.saved-text p {
		font-family: Georgia, 'Iowan Old Style', serif;
		font-size: 0.95rem;
		line-height: 1.6;
		color: #2b2620;
		margin: 0 0 0.85rem;
	}
	.result-card form {
		margin-top: 0.6rem;
	}
	.saved-section h2 {
		font-size: 1.05rem;
		margin: 0 0 0.6rem;
	}
	.empty {
		color: #777;
		font-size: 0.85rem;
		font-style: italic;
	}
	.saved-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
	}
	.saved-row {
		border: 1px solid #e0e0e0;
		border-radius: 6px;
		padding: 0.7rem 0.9rem;
	}
	.saved-header {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 0.75rem;
		flex-wrap: wrap;
	}
	.saved-question {
		margin: 0 0 0.2rem;
		font-size: 0.92rem;
		font-weight: 600;
		color: #222;
	}
	.saved-meta {
		margin: 0;
		font-size: 0.78rem;
		color: #666;
	}
	.saved-actions {
		display: flex;
		gap: 0.4rem;
		flex-shrink: 0;
	}
	.saved-text {
		margin-top: 0.7rem;
		padding-top: 0.7rem;
		border-top: 1px solid #eee;
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
