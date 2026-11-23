<script lang="ts">
	import { onMount } from 'svelte';
	import { fold, initialOf, squash } from '$lib/name-fold';
	import Modal from '$lib/components/Modal.svelte';
	import { modalOpen } from '$lib/dialog-opener';
	import { enhance } from '$lib/forms';
	import EntityPicker from '$lib/components/EntityPicker.svelte';
	import EntityMentions from '$lib/components/EntityMentions.svelte';

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

	// Per-entity expandable example entries: curation aid. Read the actual
	// day text before deciding merge vs typo-fix (e.g. "Arvie" turned out to
	// be an uncorrected OCR error, not a person), and move a day that's about
	// someone else (td-c6e871).
	let mentionsOpen = $state<Record<number, boolean>>({});
	function toggleMentions(id: number) {
		const next = { ...mentionsOpen };
		if (next[id]) delete next[id];
		else next[id] = true;
		mentionsOpen = next;
	}

	// ── Finding your way in a long list: fold sections, search, jump by letter ──
	type Entity = (typeof data.entities)[number];
	const TYPES = ['person', 'place', 'event'] as const;
	type EntityType = (typeof TYPES)[number];
	const LETTERS = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '#'];

	const letterOf = initialOf;
	const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

	interface Row {
		e: Entity;
		letter: string;
		/** Name, slug and alias target, each folded, and each squashed: matched one at a time. */
		fields: string[];
		squashed: string[];
	}
	// A–Z then "#" (names starting with a digit or symbol), by name within a letter.
	const sorted = $derived.by(() => {
		const byType: Record<EntityType, Row[]> = { person: [], place: [], event: [] };
		for (const e of data.entities as Entity[]) {
			const fields = [e.display_name, e.slug, e.alias_of_display_name ?? ''].filter(Boolean).map(fold);
			byType[e.entity_type as EntityType]?.push({
				e,
				letter: letterOf(e.display_name),
				fields,
				squashed: fields.map(squash)
			});
		}
		for (const t of TYPES) {
			byType[t].sort(
				(a, b) =>
					LETTERS.indexOf(a.letter) - LETTERS.indexOf(b.letter) ||
					collator.compare(a.e.display_name, b.e.display_name)
			);
		}
		return byType;
	});

	let search = $state('');
	const needle = $derived(fold(search.trim()));
	const sections = $derived(
		TYPES.map((type) => {
			const all = sorted[type];
			const sq = squash(needle);
			const rows = needle
				? all.filter(
						(r) => r.fields.some((f) => f.includes(needle)) || (sq !== '' && r.squashed.some((f) => f.includes(sq)))
					)
				: all;
			const groups: { letter: string; rows: Entity[] }[] = [];
			for (const r of rows) {
				const last = groups[groups.length - 1];
				if (last?.letter === r.letter) last.rows.push(r.e);
				else groups.push({ letter: r.letter, rows: [r.e] });
			}
			return { type, total: all.length, count: rows.length, groups };
		})
	);
	const matchCount = $derived(sections.reduce((n, s) => n + s.count, 0));

	// Which sections are open. Remembered in this browser. While searching,
	// sections with a match open and the rest fold; either can be flipped for
	// that search (inSearch, forgotten when the search changes).
	const OPEN_KEY = 'admin-entities-open';
	let open = $state<Record<EntityType, boolean>>({ person: true, place: true, event: true });
	let inSearch = $state<Partial<Record<EntityType, boolean>>>({});
	onMount(() => {
		try {
			const saved = JSON.parse(localStorage.getItem(OPEN_KEY) ?? 'null');
			if (saved && typeof saved === 'object') {
				for (const t of TYPES) if (typeof saved[t] === 'boolean') open[t] = saved[t];
			}
		} catch {
			/* no storage: everything starts open */
		}
	});
	$effect(() => {
		void needle;
		inSearch = {};
	});
	function expanded(type: EntityType, count: number) {
		return needle ? (inSearch[type] ?? count > 0) : open[type];
	}
	function toggleSection(type: EntityType, count: number) {
		if (needle) {
			inSearch = { ...inSearch, [type]: !expanded(type, count) };
			return;
		}
		open[type] = !open[type];
		try {
			localStorage.setItem(OPEN_KEY, JSON.stringify(open));
		} catch {
			/* not remembered; still works */
		}
	}

	let barHeight = $state(0);
	let searchInput: HTMLInputElement | undefined = $state();
	/** Scroll a letter's heading to just under the search bar, and move focus there. */
	function jump(type: EntityType, letter: string) {
		const el = document.getElementById(`letter-${type}-${letter}`);
		if (!el) return;
		const top = el.getBoundingClientRect().top + window.scrollY - barHeight;
		window.scrollTo({ top });
		el.focus({ preventScroll: true });
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
		if (e.key === 'Escape' && !modalOpen()) {
			if (editingId !== null) cancelEdit();
			if (aliasEditingId !== null) cancelAlias();
		}
	}}
/>

<div class="page" style="--bar: {barHeight}px">
	<header>
		<a href="/admin" class="back">Admin</a>
		<h1>Entities &amp; Aliases</h1>
		<p class="subtitle">
			People, places, and events extracted by the enrichment worker. Rename, alias duplicates
			together, merge, or delete unused entries.
		</p>
		<p class="subtitle">
			<a href="/admin/entities/cleanup" class="cleanup-link">Find duplicates →</a> groups likely duplicates with their
			entries, so you don't have to scan this list by eye.
		</p>
	</header>

	{#if actionError}
		<div class="error-banner" role="alert">
			{actionError}
			<button class="error-dismiss" onclick={() => (actionError = '')}>Dismiss</button>
		</div>
	{/if}

	<div class="toolbar" bind:offsetHeight={barHeight}>
		<label class="search-label" for="entity-search">Find a name</label>
		<div class="search-row">
			<input
				id="entity-search"
				class="search-input"
				type="search"
				autocomplete="off"
				spellcheck="false"
				placeholder="e.g. Rebekah, kmart"
				bind:value={search}
				bind:this={searchInput}
			/>
			{#if search}
				<button type="button" class="btn btn-secondary search-clear" onclick={() => {
						search = '';
						searchInput?.focus();
					}}>Clear</button
				>
			{/if}
		</div>
		<p class="search-status" role="status">
			{#if needle}{matchCount === 0 ? 'No names match.' : `${matchCount} ${matchCount === 1 ? 'match' : 'matches'}`}{/if}
		</p>
	</div>

	{#each sections as s (s.type)}
		{@const type = s.type}
		{@const isOpen = expanded(type, s.count)}
		<section class="section" aria-labelledby="heading-{type}">
			<h2 id="heading-{type}">
				<button
					type="button"
					class="section-toggle"
					aria-expanded={isOpen}
					aria-controls="body-{type}"
					onclick={() => toggleSection(type, s.count)}
				>
					<span class="chevron" aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
					{typeLabels[type]}
					<span class="section-count">{needle ? `${s.count} of ${s.total}` : s.total}</span>
				</button>
			</h2>
			<!-- Kept in the page while folded, so the toggle's aria-controls points at something. -->
			<div class="section-body" id="body-{type}" hidden={!isOpen}>
			{#if !isOpen}
				<!-- folded: rows not rendered -->
			{:else if s.count === 0}
				<p class="empty">{needle ? 'No matches here.' : 'None yet.'}</p>
			{:else}
				{#if s.groups.length > 1}
					<nav class="locator" aria-label="Jump to {typeLabels[type]} by first letter">
						{#each s.groups as g (g.letter)}
							<button
								type="button"
								class="locator-letter"
								aria-label="{typeLabels[type]} starting with {g.letter === '#' ? 'other initials (numbers, symbols, other letters)' : g.letter}"
								onclick={() => jump(type, g.letter)}>{g.letter}</button
							>
						{/each}
					</nav>
				{/if}
				<div class="table-wrap">
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
					{#each s.groups as g (g.letter)}
					<tbody>
						<tr class="letter-row">
							<th colspan="5" scope="rowgroup" id="letter-{type}-{g.letter}" tabindex="-1">{g.letter}</th>
						</tr>
						{#each g.rows as e (e.id)}
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
													inline
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
										{#if e.mention_count === 0 && !e.alias_of_display_name}
											<button
												class="btn btn-sm btn-danger"
												onclick={() => (deleteTarget = { id: e.id, label: e.display_name })}
											>
												Delete
											</button>
										{:else}
											<span class="delete-na">{e.alias_of_display_name ? 'kept spelling' : 'in\u00a0use'}</span>
										{/if}
									{/if}
								</td>
							</tr>
							{#if mentionsOpen[e.id]}
								<tr class="mentions-row">
									<td colspan="5">
										<EntityMentions entityId={e.id} options={canonicalOptionsFor(type, -1)} />
									</td>
								</tr>
							{/if}
						{/each}
					</tbody>
					{/each}
				</table>
				</div>
			{/if}
			</div>
		</section>
	{/each}
</div>

{#if deleteTarget}
	<Modal label="Confirm delete" onclose={() => (deleteTarget = null)}>
		<div class="modal-overlay">
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
							const t = deleteTarget;
							return ({ result, update }) => {
								if (result.type === 'failure') {
									actionError = (result.data as { error?: string })?.error ?? 'Delete failed';
								}
								if (deleteTarget === t) deleteTarget = null;
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
	</Modal>
{/if}

{#if mergeTarget}
	<Modal label="Confirm merge" onclose={() => (mergeTarget = null)}>
		<div class="modal-overlay">
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
							const t = mergeTarget;
							return ({ result, update }) => {
								if (result.type === 'failure') {
									actionError = (result.data as { error?: string })?.error ?? 'Merge failed';
								}
								if (mergeTarget === t) mergeTarget = null;
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
	</Modal>
{/if}

<style>
	.page {
		max-width: 1020px;
		margin: 0 auto;
		padding: 1.5rem 1rem;
	}
	/* Search stays at the top while the long lists scroll under it. */
	.toolbar {
		position: sticky;
		top: 0;
		z-index: 5;
		background: #fafaf8; /* the page's own background (root layout) */
		padding: 0.6rem 0 0.4rem;
		margin-bottom: 0.75rem;
		border-bottom: 1px solid #e5e5e5;
	}
	.search-label {
		display: block;
		font-size: 0.85rem;
		font-weight: 600;
		color: #333;
		margin-bottom: 0.3rem;
	}
	.search-row {
		display: flex;
		gap: 0.5rem;
		align-items: center;
	}
	.search-input {
		flex: 1;
		max-width: 420px;
		min-height: 44px;
		box-sizing: border-box;
		font-size: 1rem;
		padding: 0.4rem 0.7rem;
		border: 1px solid #767676;
		border-radius: 6px;
	}
	.search-input::placeholder {
		color: #595959;
	}
	.search-clear {
		min-height: 44px;
		min-width: 44px;
	}
	.search-status {
		margin: 0.3rem 0 0;
		min-height: 1.2em;
		font-size: 0.85rem;
		color: #555;
	}
	.section-toggle {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		min-height: 44px;
		padding: 0.3rem 0.4rem;
		background: #f4f4f4;
		border: 1px solid #ddd;
		border-radius: 6px;
		font: inherit;
		font-weight: 700;
		color: #222;
		text-align: left;
		cursor: pointer;
	}
	.section-toggle:focus-visible,
	.locator-letter:focus-visible {
		outline: 2px solid #1a4731;
		outline-offset: 2px;
	}
	.chevron {
		width: 1.1em;
		color: #444;
	}
	.section-count {
		margin-left: auto;
		font-weight: 400;
		font-size: 0.85rem;
		color: #3d3d3d; /* AAA on the #f4f4f4 header */
		font-variant-numeric: tabular-nums;
	}
	/* The table, with the letter locator beside it on the right. */
	.section-body {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 0 0.75rem;
		margin-top: 0.6rem;
	}
	.section-body[hidden] {
		display: none;
	}
	/* First in the markup, so Tab reaches the letters before hundreds of rows;
	   shown to the right of the table. */
	.section-body > .locator {
		grid-column: 2;
		grid-row: 1;
	}
	.section-body > .table-wrap {
		grid-column: 1;
		grid-row: 1;
	}
	.table-wrap {
		min-width: 0;
		overflow-x: auto;
	}
	.letter-row th {
		background: #efece4;
		color: #222;
		font-size: 0.9rem;
		padding: 0.3rem 0.6rem;
	}
	.letter-row th:focus {
		outline: 2px solid #1a4731;
		outline-offset: -2px;
	}
	.locator {
		position: sticky;
		top: calc(var(--bar) + 4px);
		align-self: start;
		display: grid;
		grid-template-columns: repeat(2, 44px);
		gap: 2px;
		max-height: calc(100vh - var(--bar) - 12px);
		overflow-y: auto;
	}
	.locator-letter {
		width: 44px;
		height: 44px;
		border: 1px solid #ccc;
		border-radius: 6px;
		background: #fff;
		color: #1a4731;
		font: inherit;
		font-weight: 700;
		cursor: pointer;
	}
	.locator-letter:hover {
		background: #efece4;
	}
	/* Narrow screens: letters in a row above the table instead. */
	@media (max-width: 700px) {
		.section-body {
			grid-template-columns: minmax(0, 1fr);
		}
		.section-body > .locator,
		.section-body > .table-wrap {
			grid-column: 1;
			grid-row: auto;
		}
		.locator {
			position: static;
			display: flex;
			flex-wrap: wrap;
			max-height: none;
			margin-bottom: 0.5rem;
		}
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
	.cleanup-link {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		font-weight: 700;
		color: #1a4731;
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
		margin: 0;
	}
	.empty {
		color: #555;
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
