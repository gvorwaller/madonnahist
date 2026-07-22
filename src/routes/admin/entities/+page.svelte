<script lang="ts">
	import { enhance } from '$app/forms';
	import EntityPicker from '$lib/components/EntityPicker.svelte';

	const { data } = $props();

	const typeLabels: Record<string, string> = { person: 'People', place: 'Places', event: 'Events' };

	let actionError = $state('');
	let deleteTarget = $state<{ id: number; label: string } | null>(null);
	let mergeTarget = $state<{ id: number; label: string; entityType: string } | null>(null);
	let mergeDestination = $state<number | null>(null);
	let editingId = $state<number | null>(null);
	let editName = $state('');
	let aliasEditingId = $state<number | null>(null);
	let aliasTargetId = $state<number | null>(null);

	interface Mention {
		entryDate: string;
		source: string;
		confidence: number | null;
		snippet: { before: string; match: string; after: string };
	}
	interface MentionsState {
		loading: boolean;
		mentions: Mention[];
		truncated: boolean;
		error?: string;
	}
	// Per-entity expandable example entries — curation aid: read the actual
	// day text before deciding merge vs typo-fix (e.g. "Arvie" turned out to
	// be an uncorrected OCR error, not a person).
	let mentionsOpen = $state<Record<number, MentionsState>>({});

	async function toggleMentions(id: number) {
		if (mentionsOpen[id]) {
			const next = { ...mentionsOpen };
			delete next[id];
			mentionsOpen = next;
			return;
		}
		mentionsOpen = { ...mentionsOpen, [id]: { loading: true, mentions: [], truncated: false } };
		try {
			const res = await fetch(`/admin/entities/${id}/mentions`);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const body = await res.json();
			mentionsOpen = {
				...mentionsOpen,
				[id]: { loading: false, mentions: body.mentions, truncated: body.truncated }
			};
		} catch {
			mentionsOpen = {
				...mentionsOpen,
				[id]: { loading: false, mentions: [], truncated: false, error: 'Failed to load example entries' }
			};
		}
	}

	function entitiesByType(type: string) {
		return data.entities.filter((e: { entity_type: string }) => e.entity_type === type);
	}

	function startEdit(e: { id: number; display_name: string }) {
		editingId = e.id;
		editName = e.display_name;
	}
	function cancelEdit() {
		editingId = null;
		editName = '';
	}

	function startAlias(e: { id: number; alias_of_entity_id: number | null }) {
		aliasEditingId = e.id;
		aliasTargetId = e.alias_of_entity_id;
	}
	function cancelAlias() {
		aliasEditingId = null;
		aliasTargetId = null;
	}

	function canonicalOptionsFor(type: string, excludeId: number) {
		const list = (data.canonicalByType as Record<string, Array<{ id: number; display_name: string }>>)[type] ?? [];
		return list.filter((c) => c.id !== excludeId);
	}
</script>

<svelte:window
	onkeydown={(e) => {
		if (e.key === 'Escape') {
			if (deleteTarget) deleteTarget = null;
			if (mergeTarget) mergeTarget = null;
			if (editingId !== null) cancelEdit();
			if (aliasEditingId !== null) cancelAlias();
		}
	}}
/>

<div class="page">
	<header>
		<a href="/admin" class="back">Admin</a>
		<h1>Entities &amp; Aliases</h1>
		<p class="subtitle">
			People, places, and events extracted by the enrichment worker. Rename, alias duplicates
			together, merge, or delete unused entries.
		</p>
	</header>

	{#if actionError}
		<div class="error-banner" role="alert">
			{actionError}
			<button class="error-dismiss" onclick={() => (actionError = '')}>Dismiss</button>
		</div>
	{/if}

	{#each ['person', 'place', 'event'] as type (type)}
		<section class="section">
			<h2>{typeLabels[type]}</h2>
			{#if entitiesByType(type).length === 0}
				<p class="empty">None yet.</p>
			{:else}
				<table class="data-table">
					<thead>
						<tr>
							<th>Name</th>
							<th>Slug</th>
							<th class="col-num">Mentions</th>
							<th>Alias of</th>
							<th class="col-actions">Actions</th>
						</tr>
					</thead>
					<tbody>
						{#each entitiesByType(type) as e (e.id)}
							<tr>
								<td>
									{#if editingId === e.id}
										<form
											method="POST"
											action="?/rename"
											use:enhance={() => {
												return ({ result, update }) => {
													if (result.type === 'failure') {
														actionError = (result.data as { error?: string })?.error ?? 'Rename failed';
													} else {
														cancelEdit();
														update();
													}
												};
											}}
										>
											<input type="hidden" name="id" value={e.id} />
											<div class="edit-row">
												<input type="text" name="displayName" bind:value={editName} class="input" />
												<button type="submit" class="btn btn-sm btn-primary">Save</button>
												<button type="button" class="btn btn-sm btn-secondary" onclick={cancelEdit}>Cancel</button>
											</div>
										</form>
									{:else}
										{e.display_name}
									{/if}
								</td>
								<td class="slug-cell">{e.slug}</td>
								<td class="col-num">
									{#if e.mention_count > 0}
										<button
											class="mention-toggle"
											onclick={() => toggleMentions(e.id)}
											aria-expanded={Boolean(mentionsOpen[e.id])}
											title="Show example entries mentioning this name"
										>
											{e.mention_count} {mentionsOpen[e.id] ? '▴' : '▾'}
										</button>
									{:else}
										{e.mention_count}
									{/if}
								</td>
								<td>
									{#if aliasEditingId === e.id}
										<form
											method="POST"
											action="?/setAlias"
											use:enhance={() => {
												return ({ result, update }) => {
													if (result.type === 'failure') {
														actionError = (result.data as { error?: string })?.error ?? 'Set alias failed';
													} else {
														cancelAlias();
														update();
													}
												};
											}}
										>
											<input type="hidden" name="id" value={e.id} />
											<div class="edit-row">
												<input type="hidden" name="targetId" value={aliasTargetId ?? ''} />
												<EntityPicker
													options={canonicalOptionsFor(type, e.id)}
													bind:selectedId={aliasTargetId}
													placeholder="Type a name to search…"
													inputLabel="Alias target for {e.display_name}"
												/>
												<button type="submit" class="btn btn-sm btn-primary" disabled={!aliasTargetId}>Save</button>
												<button type="button" class="btn btn-sm btn-secondary" onclick={cancelAlias}>Cancel</button>
											</div>
										</form>
									{:else if e.alias_of_display_name}
										&rarr; {e.alias_of_display_name}
									{:else}
										<span class="canonical-tag">canonical</span>
									{/if}
								</td>
								<td class="col-actions">
									{#if editingId !== e.id && aliasEditingId !== e.id}
										<button class="btn btn-sm btn-secondary" onclick={() => startEdit(e)}>Rename</button>
										{#if !e.alias_of_display_name}
											<button class="btn btn-sm btn-secondary" onclick={() => startAlias(e)}>Set alias</button>
											{#if canonicalOptionsFor(type, e.id).length > 0}
												<button
													class="btn btn-sm btn-secondary"
													onclick={() => {
														mergeTarget = { id: e.id, label: e.display_name, entityType: type };
														mergeDestination = null;
													}}
												>
													Merge into…
												</button>
											{/if}
										{/if}
										{#if e.mention_count === 0}
											<button
												class="btn btn-sm btn-danger"
												onclick={() => (deleteTarget = { id: e.id, label: e.display_name })}
											>
												Delete
											</button>
										{:else}
											<span
												class="delete-na"
												title="Only zero-mention entities can be deleted — use Merge into… to combine duplicates"
											>
												in&nbsp;use
											</span>
										{/if}
									{/if}
								</td>
							</tr>
							{#if mentionsOpen[e.id]}
								<tr class="mentions-row">
									<td colspan="5">
										{#if mentionsOpen[e.id].loading}
											<p class="mentions-note">Loading example entries…</p>
										{:else if mentionsOpen[e.id].error}
											<p class="mentions-note">{mentionsOpen[e.id].error}</p>
										{:else if mentionsOpen[e.id].mentions.length === 0}
											<p class="mentions-note">No entries found.</p>
										{:else}
											<ul class="mentions-list">
												{#each mentionsOpen[e.id].mentions as m (m.entryDate)}
													<li>
														<a
															class="mention-date"
															href={`/correct/day/${m.entryDate}`}
															title="Open this day in the correction editor (fix typos at the source — re-accepting re-runs extraction)"
														>{m.entryDate}</a>
														<span class="mention-snippet"
															>{m.snippet.before}{#if m.snippet.match}<mark>{m.snippet.match}</mark>{/if}{m.snippet.after}</span>
													</li>
												{/each}
											</ul>
											{#if mentionsOpen[e.id].truncated}
												<p class="mentions-note">Showing the first 15 entries.</p>
											{/if}
										{/if}
									</td>
								</tr>
							{/if}
						{/each}
					</tbody>
				</table>
			{/if}
		</section>
	{/each}
</div>

{#if deleteTarget}
	<div class="modal-overlay" role="dialog" aria-modal="true" aria-label="Confirm delete">
		<div class="modal-content">
			<h3>Delete entity</h3>
			<p>
				Delete "{deleteTarget.label}"? This cannot be undone. Only entities with zero mentions can
				be deleted.
			</p>
			<div class="modal-actions">
				<button class="btn-cancel" onclick={() => (deleteTarget = null)}>Cancel</button>
				<form
					method="POST"
					action="?/delete"
					use:enhance={() => {
						return ({ result, update }) => {
							if (result.type === 'failure') {
								actionError = (result.data as { error?: string })?.error ?? 'Delete failed';
							}
							deleteTarget = null;
							update();
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

{#if mergeTarget}
	<div class="modal-overlay" role="dialog" aria-modal="true" aria-label="Confirm merge">
		<div class="modal-content">
			<h3>Merge entity</h3>
			<p>
				Merge "{mergeTarget.label}" into another entity? All of its day mentions move to the
				target, and it becomes an alias of the target (kept, not deleted). This cannot be undone.
			</p>
			<div class="merge-select-label">
				Merge into:
				<EntityPicker
					options={canonicalOptionsFor(mergeTarget.entityType, mergeTarget.id)}
					bind:selectedId={mergeDestination}
					placeholder="Type a name to search…"
					inputLabel="Merge target"
				/>
			</div>
			<div class="modal-actions">
				<button class="btn-cancel" onclick={() => (mergeTarget = null)}>Cancel</button>
				<form
					method="POST"
					action="?/mergeInto"
					use:enhance={() => {
						return ({ result, update }) => {
							if (result.type === 'failure') {
								actionError = (result.data as { error?: string })?.error ?? 'Merge failed';
							}
							mergeTarget = null;
							update();
						};
					}}
				>
					<input type="hidden" name="sourceId" value={mergeTarget.id} />
					<input type="hidden" name="targetId" value={mergeDestination ?? ''} />
					<button type="submit" class="btn-danger" disabled={!mergeDestination}>Merge</button>
				</form>
			</div>
		</div>
	</div>
{/if}

<style>
	.page {
		max-width: 900px;
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
	}
	.section {
		margin-bottom: 2rem;
	}
	.section h2 {
		font-size: 1.05rem;
		margin: 0 0 0.6rem;
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
	}
	.col-actions {
		white-space: nowrap;
	}
	.slug-cell {
		color: #777;
		font-family: ui-monospace, monospace;
		font-size: 0.8rem;
	}
	.canonical-tag {
		color: #999;
		font-style: italic;
	}
	.edit-row {
		display: flex;
		gap: 0.4rem;
		align-items: center;
		flex-wrap: wrap;
	}
	.input {
		font-size: 0.85rem;
		padding: 0.3rem 0.5rem;
		border: 1px solid #ccc;
		border-radius: 4px;
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
	/* Rendered instead of a Delete button for entities that cannot be
	   deleted (they have mentions) — a disabled-but-red button read as
	   clickable-and-broken. #555 keeps 7:1 AAA contrast on white. */
	.delete-na {
		color: #555;
		font-size: 0.85rem;
		font-style: italic;
	}
	.mention-toggle {
		background: none;
		border: none;
		padding: 0.25rem 0.4rem;
		font: inherit;
		color: #1a4731;
		text-decoration: underline;
		cursor: pointer;
	}
	.mention-toggle:focus-visible {
		outline: 2px solid #1a4731;
		outline-offset: 2px;
	}
	.mentions-row td {
		background: #faf7f0;
		padding: 0.5rem 1rem 0.75rem;
	}
	.mentions-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}
	.mentions-list li {
		font-size: 0.9rem;
		line-height: 1.45;
	}
	.mention-date {
		font-family: ui-monospace, Menlo, monospace;
		font-size: 0.85rem;
		margin-right: 0.6rem;
		color: #1a4731;
	}
	.mention-snippet mark {
		background: #f5d78e;
		color: #2b2417;
		padding: 0 0.1em;
	}
	.mentions-note {
		margin: 0.4rem 0 0;
		font-size: 0.85rem;
		font-style: italic;
		color: #555;
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
		max-width: 420px;
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
	.merge-select-label {
		display: block;
		font-size: 0.85rem;
		color: #444;
		margin-bottom: 1rem;
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
