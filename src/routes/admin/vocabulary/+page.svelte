<script lang="ts">
	import { enhance } from '$app/forms';

	const { data } = $props();

	const categories = ['person', 'activity', 'place', 'term'] as const;
	const categoryLabels: Record<string, string> = {
		person: 'Names', activity: 'Activities', place: 'Places', term: 'Terms'
	};
	const categorySingular: Record<string, string> = {
		person: 'name', activity: 'activity', place: 'place', term: 'term'
	};

	let deleteTarget = $state<{ type: 'vocab' | 'lexicon'; id: number; label: string } | null>(null);
	let promoteTarget = $state<{ id: number; token: string } | null>(null);
	let promoteCategory = $state('person');
	let editingVocab = $state<number | null>(null);
	let editTerm = $state('');
	let editNote = $state('');
	let addCategory = $state<string | null>(null);
	let addTerm = $state('');
	let addNote = $state('');
	let actionError = $state('');

	function vocabByCategory(cat: string) {
		return data.vocabulary.filter((v: { category: string }) => v.category === cat);
	}

	function startEdit(v: { id: number; term: string; context_note: string | null }) {
		editingVocab = v.id;
		editTerm = v.term;
		editNote = v.context_note ?? '';
	}

	function cancelEdit() {
		editingVocab = null;
		editTerm = '';
		editNote = '';
	}

	function startAdd(cat: string) {
		addCategory = cat;
		addTerm = '';
		addNote = '';
	}

	function cancelAdd() {
		addCategory = null;
		addTerm = '';
		addNote = '';
	}

	const activeLexicon = $derived(data.lexicon.filter((l: { is_active: boolean }) => l.is_active));
	const suppressedLexicon = $derived(data.lexicon.filter((l: { is_active: boolean }) => !l.is_active));
</script>

<svelte:window onkeydown={(e) => {
	if (e.key === 'Escape') {
		if (deleteTarget) deleteTarget = null;
		if (promoteTarget) promoteTarget = null;
		if (editingVocab !== null) cancelEdit();
		if (addCategory !== null) cancelAdd();
	}
}} />

<div class="page">
	<header>
		<h1>OCR Vocabulary &amp; Correction Lexicon</h1>
		<p class="subtitle">Manage the vocabulary that feeds the OCR cleanup prompt, and curate auto-learned correction pairs.</p>
	</header>

	{#if actionError}
		<div class="error-banner" role="alert">
			{actionError}
			<button class="error-dismiss" onclick={() => actionError = ''}>Dismiss</button>
		</div>
	{/if}

	<!-- Section A: OCR Vocabulary -->
	<section class="section">
		<h2>OCR Vocabulary</h2>
		<p class="section-desc">Terms fed into the Claude cleanup prompt. Toggle inactive to exclude without deleting.</p>

		{#each categories as cat}
			<div class="category-group">
				<h3>{categoryLabels[cat]}</h3>
				<table class="data-table">
					<thead>
						<tr>
							<th>Term</th>
							<th>Note</th>
							<th class="col-active">Active</th>
							<th class="col-actions">Actions</th>
						</tr>
					</thead>
					<tbody>
						{#each vocabByCategory(cat) as v (v.id)}
							{#if editingVocab === v.id}
								<tr>
									<td colspan="4">
										<form method="POST" action="?/updateVocab" use:enhance={() => {
											return ({ result, update }) => {
												if (result.type === 'failure') {
													actionError = (result.data as { error?: string })?.error ?? 'Update failed';
												} else {
													cancelEdit();
													update();
												}
											};
										}}>
											<input type="hidden" name="id" value={v.id} />
											<div class="edit-row">
												<input type="text" name="term" bind:value={editTerm} class="input" placeholder="Term" />
												<input type="text" name="contextNote" bind:value={editNote} class="input" placeholder="Context note (optional)" />
												<button type="submit" class="btn btn-sm btn-primary">Save</button>
												<button type="button" class="btn btn-sm btn-secondary" onclick={cancelEdit}>Cancel</button>
											</div>
										</form>
									</td>
								</tr>
							{:else}
								<tr class:muted={!v.is_active}>
									<td>{v.term}</td>
									<td class="note-cell">{v.context_note ?? ''}</td>
									<td class="col-active">
										<form method="POST" action="?/toggleVocab" use:enhance={() => {
											return ({ update }) => { update(); };
										}}>
											<input type="hidden" name="id" value={v.id} />
											<button type="submit" class="toggle-btn" title={v.is_active ? 'Deactivate' : 'Activate'}>
												{v.is_active ? 'Yes' : 'No'}
											</button>
										</form>
									</td>
									<td class="col-actions">
										<button class="btn btn-sm btn-secondary" onclick={() => startEdit(v)}>Edit</button>
										<button class="btn btn-sm btn-danger" onclick={() => deleteTarget = { type: 'vocab', id: v.id, label: v.term }}>Delete</button>
									</td>
								</tr>
							{/if}
						{/each}
						{#if addCategory === cat}
							<tr>
								<td colspan="4">
									<form method="POST" action="?/addVocab" use:enhance={() => {
										return ({ result, update }) => {
											if (result.type === 'failure') {
												actionError = (result.data as { error?: string })?.error ?? 'Add failed';
											} else {
												cancelAdd();
												update();
											}
										};
									}}>
										<input type="hidden" name="category" value={cat} />
										<div class="edit-row">
											<input type="text" name="term" bind:value={addTerm} class="input" placeholder="New term" />
											<input type="text" name="contextNote" bind:value={addNote} class="input" placeholder="Context note (optional)" />
											<button type="submit" class="btn btn-sm btn-primary" disabled={addTerm.trim() === ''}>Add</button>
											<button type="button" class="btn btn-sm btn-secondary" onclick={cancelAdd}>Cancel</button>
										</div>
									</form>
								</td>
							</tr>
						{:else}
							<tr>
								<td colspan="4">
									<button class="btn btn-sm btn-secondary add-btn" onclick={() => startAdd(cat)}>+ Add {categorySingular[cat]}</button>
								</td>
							</tr>
						{/if}
					</tbody>
				</table>
			</div>
		{/each}
	</section>

	<!-- Section B: Correction Lexicon -->
	<section class="section">
		<h2>Correction Lexicon</h2>
		<p class="section-desc">Auto-learned OCR substitution pairs from Madonna's corrections. Suppress junk, promote good entries to vocabulary.</p>

		{#if data.lexicon.length === 0}
			<p class="empty">No lexicon entries yet. Entries appear as Madonna corrects OCR drafts.</p>
		{:else}
			<table class="data-table">
				<thead>
					<tr>
						<th>OCR Token</th>
						<th>Corrected</th>
						<th class="col-num">Freq</th>
						<th>First Seen</th>
						<th>Last Seen</th>
						<th class="col-actions">Actions</th>
					</tr>
				</thead>
				<tbody>
					{#each activeLexicon as l (l.id)}
						<tr>
							<td class="token">{l.ocr_token}</td>
							<td class="token">{l.corrected_token}</td>
							<td class="col-num">{l.frequency}</td>
							<td class="date-cell">{l.first_seen}</td>
							<td class="date-cell">{l.last_seen}</td>
							<td class="col-actions">
								<button class="btn btn-sm btn-secondary" onclick={() => { promoteTarget = { id: l.id, token: l.corrected_token }; promoteCategory = 'person'; }}>Promote</button>
								<button class="btn btn-sm btn-danger" onclick={() => deleteTarget = { type: 'lexicon', id: l.id, label: `"${l.ocr_token}" → "${l.corrected_token}"` }}>Suppress</button>
							</td>
						</tr>
					{/each}
					{#if suppressedLexicon.length > 0}
						<tr class="suppressed-header"><td colspan="6">Suppressed ({suppressedLexicon.length})</td></tr>
						{#each suppressedLexicon as l (l.id)}
							<tr class="muted">
								<td class="token">{l.ocr_token}</td>
								<td class="token">{l.corrected_token}</td>
								<td class="col-num">{l.frequency}</td>
								<td class="date-cell">{l.first_seen}</td>
								<td class="date-cell">{l.last_seen}</td>
								<td class="col-actions">
									<form method="POST" action="?/restoreLexicon" use:enhance={() => {
										return ({ update }) => { update(); };
									}}>
										<input type="hidden" name="id" value={l.id} />
										<button type="submit" class="btn btn-sm btn-secondary">Restore</button>
									</form>
								</td>
							</tr>
						{/each}
					{/if}
				</tbody>
			</table>
		{/if}
	</section>
</div>

<!-- Delete/Suppress confirmation modal -->
{#if deleteTarget}
	<div class="modal-overlay" role="dialog" aria-label="Confirm deletion">
		<div class="modal">
			<h2>{deleteTarget.type === 'vocab' ? 'Delete Vocabulary Entry' : 'Suppress Lexicon Pair'}</h2>
			<p>
				{#if deleteTarget.type === 'vocab'}
					Permanently delete <strong>{deleteTarget.label}</strong> from the vocabulary?
				{:else}
					Suppress <strong>{deleteTarget.label}</strong>? It will be excluded from the OCR prompt but kept in history.
				{/if}
			</p>
			<div class="modal-actions">
				<button class="btn btn-secondary" onclick={() => deleteTarget = null}>Cancel</button>
				{#if deleteTarget.type === 'vocab'}
					<form method="POST" action="?/deleteVocab" use:enhance={() => {
						const t = deleteTarget;
						return ({ result, update }) => {
							deleteTarget = null;
							if (result.type === 'failure') {
								actionError = (result.data as { error?: string })?.error ?? 'Delete failed';
							} else {
								update();
							}
						};
					}}>
						<input type="hidden" name="id" value={deleteTarget.id} />
						<button type="submit" class="btn btn-danger">Delete</button>
					</form>
				{:else}
					<form method="POST" action="?/suppressLexicon" use:enhance={() => {
						const t = deleteTarget;
						return ({ result, update }) => {
							deleteTarget = null;
							if (result.type === 'failure') {
								actionError = (result.data as { error?: string })?.error ?? 'Suppress failed';
							} else {
								update();
							}
						};
					}}>
						<input type="hidden" name="id" value={deleteTarget.id} />
						<button type="submit" class="btn btn-danger">Suppress</button>
					</form>
				{/if}
			</div>
		</div>
	</div>
{/if}

<!-- Promote to vocabulary modal -->
{#if promoteTarget}
	<div class="modal-overlay" role="dialog" aria-label="Promote to vocabulary">
		<div class="modal">
			<h2>Promote to Vocabulary</h2>
			<p>Add <strong>{promoteTarget.token}</strong> to the OCR vocabulary.</p>
			<form method="POST" action="?/promoteToVocab" use:enhance={() => {
				return ({ result, update }) => {
					promoteTarget = null;
					if (result.type === 'failure') {
						actionError = (result.data as { error?: string })?.error ?? 'Promote failed';
					} else {
						update();
					}
				};
			}}>
				<input type="hidden" name="lexiconId" value={promoteTarget.id} />
				<div class="form-group">
					<label for="promote-category">Category</label>
					<select id="promote-category" name="category" bind:value={promoteCategory} class="input">
						{#each categories as cat}
							<option value={cat}>{categoryLabels[cat]}</option>
						{/each}
					</select>
				</div>
				<div class="modal-actions">
					<button type="button" class="btn btn-secondary" onclick={() => promoteTarget = null}>Cancel</button>
					<button type="submit" class="btn btn-primary">Promote</button>
				</div>
			</form>
		</div>
	</div>
{/if}

<style>
	.page {
		max-width: 1000px;
		margin: 0 auto;
		padding: 1rem;
	}
	header {
		margin-bottom: 1.5rem;
	}
	h1 {
		margin: 0;
		font-size: 1.4rem;
	}
	.subtitle {
		color: #555;
		font-size: 0.85rem;
		margin: 0.3rem 0 0;
	}

	.section {
		margin-bottom: 2.5rem;
	}
	h2 {
		font-size: 1.15rem;
		margin: 0 0 0.25rem;
		border-bottom: 2px solid #333;
		padding-bottom: 0.3rem;
	}
	.section-desc {
		color: #555;
		font-size: 0.8rem;
		margin: 0.25rem 0 1rem;
	}
	.category-group {
		margin-bottom: 1.5rem;
	}
	h3 {
		font-size: 0.95rem;
		margin: 0 0 0.4rem;
		color: #333;
	}
	.empty {
		color: #666;
		font-style: italic;
		padding: 1rem 0;
	}

	.data-table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.85rem;
	}
	.data-table th {
		text-align: left;
		padding: 0.4rem 0.5rem;
		border-bottom: 1px solid #999;
		font-weight: 600;
		color: #333;
		font-size: 0.75rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.data-table td {
		padding: 0.35rem 0.5rem;
		border-bottom: 1px solid #e0e0e0;
		vertical-align: middle;
	}
	.data-table tr.muted td {
		color: #999;
	}
	.col-active {
		width: 60px;
		text-align: center;
	}
	.col-actions {
		width: 160px;
		text-align: right;
		white-space: nowrap;
	}
	.col-num {
		width: 50px;
		text-align: center;
	}
	.note-cell {
		color: #666;
		font-size: 0.8rem;
	}
	.date-cell {
		font-size: 0.8rem;
		color: #666;
	}
	.token {
		font-family: monospace;
		font-size: 0.85rem;
	}
	.suppressed-header td {
		padding-top: 0.75rem;
		font-weight: 600;
		font-size: 0.8rem;
		color: #888;
		border-bottom: 1px solid #ccc;
	}

	.toggle-btn {
		background: none;
		border: 1px solid #ccc;
		border-radius: 3px;
		padding: 0.15rem 0.5rem;
		cursor: pointer;
		font-size: 0.75rem;
		color: #333;
	}
	.toggle-btn:hover {
		border-color: #666;
	}

	.btn {
		border: none;
		border-radius: 4px;
		padding: 0.4rem 0.8rem;
		font-size: 0.85rem;
		font-weight: 600;
		cursor: pointer;
	}
	.btn-sm {
		padding: 0.2rem 0.5rem;
		font-size: 0.75rem;
	}
	.btn-primary {
		background: #1a7a1a;
		color: #fff;
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
	.btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.add-btn {
		margin: 0.25rem 0;
	}

	.edit-row {
		display: flex;
		gap: 0.5rem;
		align-items: center;
		padding: 0.25rem 0;
	}
	.input {
		padding: 0.3rem 0.5rem;
		border: 1px solid #ccc;
		border-radius: 4px;
		font-size: 0.85rem;
		font-family: inherit;
	}
	.edit-row .input:first-child {
		flex: 1;
	}
	.edit-row .input:nth-child(2) {
		flex: 1.5;
	}

	.form-group {
		margin: 1rem 0;
	}
	.form-group label {
		display: block;
		font-size: 0.8rem;
		font-weight: 600;
		margin-bottom: 0.3rem;
		color: #555;
	}
	.form-group select {
		width: 100%;
	}

	.error-banner {
		padding: 0.6rem 1rem;
		background: #fde2e2;
		border: 1px solid #c33;
		border-radius: 4px;
		color: #c33;
		font-size: 0.85rem;
		font-weight: 600;
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 1rem;
	}
	.error-dismiss {
		background: none;
		border: none;
		color: #c33;
		cursor: pointer;
		font-size: 0.8rem;
		text-decoration: underline;
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
		max-width: 420px;
		width: 90%;
	}
	.modal h2 {
		margin: 0 0 0.5rem;
		font-size: 1.1rem;
		border: none;
		padding: 0;
	}
	.modal p {
		margin: 0 0 1rem;
		color: #555;
		font-size: 0.9rem;
	}
	.modal-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
		margin-top: 1rem;
	}
	.modal-actions .btn {
		min-height: 40px;
		min-width: 80px;
	}
</style>
