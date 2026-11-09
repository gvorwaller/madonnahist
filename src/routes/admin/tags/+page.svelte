<script lang="ts">
	import { enhance } from '$app/forms';
	import EntityPicker from '$lib/components/EntityPicker.svelte';

	const { data } = $props();

	type Status = 'approved' | 'hidden' | 'merged' | null;
	type Tab = 'undecided' | 'approved' | 'hidden' | 'merged' | 'all';
	type Kind = 'approve' | 'hide' | 'merge' | 'undo' | 'rename';

	const PAGE = 100;

	let tab = $state<Tab>('undecided');
	let filterText = $state('');
	let sort = $state<'days' | 'az'>('days');
	let shown = $state(PAGE);
	let selected = $state<Set<string>>(new Set());
	let statusMessage = $state('');
	let actionError = $state('');

	// The action waiting for confirmation (rendered in the sticky confirm bar).
	let pending = $state<{
		kind: Kind;
		slugs: string[];
		target?: string;
		label?: string;
		text: string;
	} | null>(null);

	// Row-level inline editors.
	let mergeFor = $state<string[] | null>(null);
	let mergeTargetId = $state<number | null>(null);
	let renameSlug = $state<string | null>(null);
	let renameText = $state('');

	const bySlug = $derived(new Map(data.tags.map((t) => [t.slug, t])));
	const approved = $derived(
		data.tags.filter((t) => t.status === 'approved').sort((a, b) => a.label.localeCompare(b.label))
	);
	// EntityPicker wants numeric ids; index into the approved list.
	const approvedOptions = $derived(approved.map((t, i) => ({ id: i, display_name: t.label })));
	const mergedInCount = $derived.by(() => {
		const m = new Map<string, number>();
		for (const t of data.tags)
			if (t.mergedInto) m.set(t.mergedInto, (m.get(t.mergedInto) ?? 0) + 1);
		return m;
	});

	function statusOf(s: Status): Exclude<Tab, 'all'> {
		return s ?? 'undecided';
	}

	const counts = $derived.by(() => {
		const c = { undecided: 0, approved: 0, hidden: 0, merged: 0, all: data.tags.length };
		for (const t of data.tags) c[statusOf(t.status)]++;
		return c;
	});

	const filtered = $derived.by(() => {
		const q = filterText.trim().toLowerCase();
		const list = data.tags.filter(
			(t) =>
				(tab === 'all' || statusOf(t.status) === tab) &&
				(q === '' || t.label.toLowerCase().includes(q) || t.slug.includes(q))
		);
		if (sort === 'az') list.sort((a, b) => a.label.localeCompare(b.label));
		return list;
	});
	const visible = $derived(filtered.slice(0, shown));

	function daysOf(slugs: string[]): number {
		return slugs.reduce((n, s) => n + (bySlug.get(s)?.acceptedDays ?? 0), 0);
	}
	function labelOf(slug: string): string {
		return bySlug.get(slug)?.label ?? slug;
	}
	function describe(slugs: string[]): string {
		return slugs.length === 1 ? `“${labelOf(slugs[0])}”` : `${slugs.length} tags`;
	}
	function plural(n: number, word: string) {
		return `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
	}

	function ask(kind: Kind, slugs: string[], extra: { target?: string; label?: string } = {}) {
		actionError = '';
		const days = daysOf(slugs);
		let text = '';
		if (kind === 'approve')
			text = `Show ${describe(slugs)} to the family on ${plural(days, 'day')}?`;
		if (kind === 'hide') text = `Hide ${describe(slugs)} (${plural(days, 'day')}) from the family?`;
		if (kind === 'undo') text = `Reset ${describe(slugs)} to undecided?`;
		if (kind === 'merge')
			text = `Merge ${describe(slugs)} (${plural(days, 'day')}) into “${labelOf(extra.target!)}”?`;
		if (kind === 'rename') text = `Rename “${labelOf(slugs[0])}” to “${extra.label}”?`;
		pending = { kind, slugs, ...extra, text };
	}

	function startMerge(slugs: string[]) {
		mergeFor = slugs;
		mergeTargetId = null;
	}
	function confirmMergeTarget() {
		if (!mergeFor || mergeTargetId === null) return;
		const target = approved[mergeTargetId]?.slug;
		if (!target) return;
		ask('merge', mergeFor, { target });
		mergeFor = null;
	}

	function toggle(slug: string) {
		const next = new Set(selected);
		if (next.has(slug)) next.delete(slug);
		else next.add(slug);
		selected = next;
	}
	const allVisibleSelected = $derived(
		visible.length > 0 && visible.every((t) => selected.has(t.slug))
	);
	function toggleAllVisible() {
		const next = new Set(selected);
		if (allVisibleSelected) for (const t of visible) next.delete(t.slug);
		else for (const t of visible) next.add(t.slug);
		selected = next;
	}

	function setTab(t: Tab) {
		tab = t;
		shown = PAGE;
		selected = new Set();
	}

	// Example days per slug (lazy).
	let examples = $state<
		Record<
			string,
			{
				loading: boolean;
				days: { entryDate: string; source: string; snippet: string }[];
				truncated: boolean;
				error?: string;
			}
		>
	>({});
	async function toggleExamples(slug: string) {
		if (examples[slug]) {
			const next = { ...examples };
			delete next[slug];
			examples = next;
			return;
		}
		examples = { ...examples, [slug]: { loading: true, days: [], truncated: false } };
		try {
			const res = await fetch(`/admin/tags/${encodeURIComponent(slug)}/days`);
			if (!res.ok) throw new Error(String(res.status));
			const body = await res.json();
			examples = {
				...examples,
				[slug]: { loading: false, days: body.days, truncated: body.truncated }
			};
		} catch {
			examples = {
				...examples,
				[slug]: { loading: false, days: [], truncated: false, error: 'Could not load example days' }
			};
		}
	}

	const statusText: Record<Exclude<Tab, 'all'>, string> = {
		undecided: 'Undecided',
		approved: 'Shown to family',
		hidden: 'Hidden',
		merged: 'Merged'
	};
</script>

<svelte:window
	onkeydown={(e) => {
		if (e.key === 'Escape') {
			if (pending) pending = null;
			else if (mergeFor) mergeFor = null;
			else if (renameSlug) renameSlug = null;
		}
	}}
/>

<div class="page">
	<header>
		<a href="/admin" class="back">Admin</a>
		<h1>Tags</h1>
		<p class="subtitle">
			Decide once per tag name. <strong>Show to family</strong> turns a name on for every day that
			carries it, including days the AI tags later. <strong>Merge</strong> folds a near-duplicate into
			a name that's already shown. Tags a person added on a day always show. Nothing here changes who
			added a tag.
		</p>
	</header>

	<p class="status-line" role="status" aria-live="polite">{statusMessage}</p>
	{#if actionError}
		<div class="error-banner" role="alert">
			{actionError}
			<button class="link-btn" onclick={() => (actionError = '')}>Dismiss</button>
		</div>
	{/if}

	<div class="tabs" role="tablist" aria-label="Filter by decision">
		{#each [['undecided', 'Undecided'], ['approved', 'Shown to family'], ['hidden', 'Hidden'], ['merged', 'Merged'], ['all', 'All']] as [key, label] (key)}
			<button
				type="button"
				role="tab"
				aria-selected={tab === key}
				class="tab"
				class:active={tab === key}
				onclick={() => setTab(key as Tab)}
			>
				{label} <span class="tab-count">{counts[key as Tab].toLocaleString()}</span>
			</button>
		{/each}
	</div>

	<div class="controls">
		<label class="filter">
			<span class="sr-only">Filter tags</span>
			<input
				type="search"
				placeholder="Filter by name…"
				bind:value={filterText}
				oninput={() => (shown = PAGE)}
			/>
		</label>
		<label class="sort">
			Sort
			<select bind:value={sort}>
				<option value="days">Most days</option>
				<option value="az">A–Z</option>
			</select>
		</label>
	</div>

	{#if selected.size > 0}
		{@const sel = [...selected]}
		<div class="bulk-bar">
			<span><strong>{selected.size}</strong> selected · {plural(daysOf(sel), 'day')}</span>
			<button class="btn btn-primary" onclick={() => ask('approve', sel)}>Show to family</button>
			<button class="btn btn-secondary" onclick={() => ask('hide', sel)}>Hide</button>
			<button
				class="btn btn-secondary"
				onclick={() => startMerge(sel)}
				disabled={approved.length === 0}>Merge into…</button
			>
			<button class="btn btn-secondary" onclick={() => ask('undo', sel)}>Undo</button>
			<button class="link-btn" onclick={() => (selected = new Set())}>Clear</button>
		</div>
	{/if}

	{#if mergeFor}
		<div class="merge-panel">
			<p>
				Merge {describe(mergeFor)} into which tag? (Only tags shown to the family can be targets.)
			</p>
			<div class="edit-row">
				<EntityPicker
					options={approvedOptions}
					bind:selectedId={mergeTargetId}
					placeholder="Type a shown tag…"
					inputLabel="Merge target"
				/>
				<button
					class="btn btn-primary"
					onclick={confirmMergeTarget}
					disabled={mergeTargetId === null}>Continue</button
				>
				<button class="btn btn-secondary" onclick={() => (mergeFor = null)}>Cancel</button>
			</div>
		</div>
	{/if}

	{#if filtered.length === 0}
		<p class="empty">
			{#if data.tags.length === 0}No tags yet.{:else if tab === 'undecided' && filterText === ''}Every
				tag name has a decision.{:else}No tags match.{/if}
		</p>
	{:else}
		<div class="table-wrap">
			<table class="data-table">
				<thead>
					<tr>
						<th class="col-check">
							<input
								type="checkbox"
								checked={allVisibleSelected}
								onchange={toggleAllVisible}
								aria-label="Select all shown rows"
							/>
						</th>
						<th>Tag</th>
						<th class="col-num">Days</th>
						<th class="col-num">Family sees</th>
						<th>Decision</th>
						<th class="col-actions">Actions</th>
					</tr>
				</thead>
				<tbody>
					{#each visible as t (t.slug)}
						{@const st = statusOf(t.status)}
						<tr class:is-selected={selected.has(t.slug)}>
							<td class="col-check">
								<input
									type="checkbox"
									checked={selected.has(t.slug)}
									onchange={() => toggle(t.slug)}
									aria-label="Select {t.label}"
								/>
							</td>
							<td>
								{#if renameSlug === t.slug}
									<div class="edit-row">
										<input
											class="input"
											bind:value={renameText}
											maxlength="40"
											aria-label="New label for {t.label}"
										/>
										<button
											class="btn btn-primary"
											disabled={renameText.trim() === '' || renameText.trim() === t.label}
											onclick={() => {
												ask('rename', [t.slug], { label: renameText.trim() });
												renameSlug = null;
											}}>Save</button
										>
										<button class="btn btn-secondary" onclick={() => (renameSlug = null)}
											>Cancel</button
										>
									</div>
								{:else}
									<span class="tag-label">{t.label}</span>
									<span class="slug">{t.slug}</span>
								{/if}
								{#if t.acceptedDays > 0}
									<button
										class="link-btn examples-toggle"
										aria-expanded={Boolean(examples[t.slug])}
										onclick={() => toggleExamples(t.slug)}
									>
										{examples[t.slug] ? 'Hide example days' : 'Example days'}
									</button>
								{/if}
							</td>
							<td class="col-num">
								{t.acceptedDays.toLocaleString()}
								<span class="breakdown"
									>AI {t.aiDays} · person {t.humanDays}{#if t.pendingDays > 0}
										· +{t.pendingDays} not accepted{/if}</span
								>
							</td>
							<td class="col-num">
								{t.familyDays.toLocaleString()}
								{#if (mergedInCount.get(t.slug) ?? 0) > 0}
									<span class="breakdown"
										>incl. {mergedInCount.get(t.slug)} merged name{mergedInCount.get(t.slug) === 1
											? ''
											: 's'}</span
									>
								{/if}
							</td>
							<td>
								<span class="badge badge-{st}">{statusText[st]}</span>
								{#if t.status === 'merged' && t.mergedInto}
									<span class="merged-to">→ {labelOf(t.mergedInto)}</span>
								{/if}
							</td>
							<td class="col-actions">
								{#if st !== 'approved'}
									<button class="btn btn-primary" onclick={() => ask('approve', [t.slug])}
										>Show</button
									>
								{/if}
								{#if st !== 'hidden'}
									<button class="btn btn-secondary" onclick={() => ask('hide', [t.slug])}
										>Hide</button
									>
								{/if}
								{#if st !== 'merged'}
									<button
										class="btn btn-secondary"
										onclick={() => startMerge([t.slug])}
										disabled={approved.filter((a) => a.slug !== t.slug).length === 0}>Merge…</button
									>
								{/if}
								{#if st !== 'undecided'}
									<button
										class="btn btn-secondary"
										onclick={() => {
											renameSlug = t.slug;
											renameText = t.label;
										}}>Rename</button
									>
									<button class="btn btn-secondary" onclick={() => ask('undo', [t.slug])}
										>Undo</button
									>
								{/if}
							</td>
						</tr>
						{#if examples[t.slug]}
							{@const ex = examples[t.slug]}
							<tr class="examples-row">
								<td></td>
								<td colspan="5">
									{#if ex.loading}
										<p class="note">Loading…</p>
									{:else if ex.error}
										<p class="note">{ex.error}</p>
									{:else}
										<ul class="examples">
											{#each ex.days as d (d.entryDate)}
												<li>
													<a href="/correct/day/{d.entryDate}" class="ex-date">{d.entryDate}</a>
													<span class="ex-source">{d.source === 'human' ? 'person' : 'AI'}</span>
													{d.snippet}
												</li>
											{/each}
										</ul>
										{#if ex.truncated}<p class="note">
												Showing the 8 most recent accepted days.
											</p>{/if}
									{/if}
								</td>
							</tr>
						{/if}
					{/each}
				</tbody>
			</table>
		</div>
		{#if filtered.length > shown}
			<button class="btn btn-secondary more" onclick={() => (shown += PAGE)}>
				Show {Math.min(PAGE, filtered.length - shown)} more of {filtered.length - shown}
			</button>
		{/if}
	{/if}
</div>

{#if pending}
	<div class="confirm-bar" role="region" aria-label="Confirm tag change">
		<p>{pending.text}</p>
		<form
			method="POST"
			action="/admin/tags?/{pending.kind}"
			use:enhance={() => {
				return async ({ result, update }) => {
					if (result.type === 'failure') {
						actionError =
							(result.data as { error?: string })?.error ?? 'That change could not be saved';
						statusMessage = '';
					} else if (result.type === 'success') {
						statusMessage = (result.data as { message?: string })?.message ?? 'Saved.';
						selected = new Set();
					}
					pending = null;
					await update({ reset: false });
				};
			}}
		>
			{#each pending.slugs as s (s)}
				<input type="hidden" name="slug" value={s} />
			{/each}
			{#if pending.target}<input type="hidden" name="target" value={pending.target} />{/if}
			{#if pending.label}<input type="hidden" name="label" value={pending.label} />{/if}
			<button type="submit" class="btn btn-primary">Confirm</button>
			<button type="button" class="btn btn-secondary" onclick={() => (pending = null)}
				>Cancel</button
			>
		</form>
	</div>
{/if}

<style>
	.page {
		max-width: 1100px;
		margin: 0 auto;
		padding: 1.5rem 1rem 7rem;
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
		margin: 0.25rem 0 0.2rem;
		font-size: 1.4rem;
	}
	.subtitle {
		margin: 0;
		color: #4a4a4a;
		font-size: 0.85rem;
		max-width: 70ch;
		line-height: 1.5;
	}
	.status-line {
		min-height: 1.3em;
		margin: 0 0 0.5rem;
		color: #1a4731;
		font-size: 0.85rem;
		font-weight: 600;
	}
	.tabs {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
		margin-bottom: 0.75rem;
	}
	.tab {
		min-height: 44px;
		padding: 0 0.9rem;
		border: 1px solid #ccc;
		border-radius: 999px;
		background: #fff;
		color: #333;
		font: inherit;
		font-size: 0.85rem;
		cursor: pointer;
	}
	.tab.active {
		background: #2a5f4c;
		border-color: #2a5f4c;
		color: #fff;
	}
	.tab-count {
		font-variant-numeric: tabular-nums;
		font-weight: 700;
		margin-left: 0.2rem;
	}
	.controls {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
		align-items: center;
		margin-bottom: 0.75rem;
	}
	.filter input {
		min-height: 44px;
		min-width: 16rem;
		padding: 0 0.7rem;
		border: 1px solid #bbb;
		border-radius: 6px;
		font-size: 1rem;
	}
	.sort {
		font-size: 0.85rem;
		color: #4a4a4a;
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}
	.sort select {
		min-height: 44px;
		font-size: 0.9rem;
	}
	.bulk-bar,
	.merge-panel {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		align-items: center;
		padding: 0.6rem 0.8rem;
		margin-bottom: 0.75rem;
		background: #eef5f1;
		border: 1px solid #b9d3c6;
		border-radius: 8px;
		font-size: 0.85rem;
	}
	.merge-panel {
		flex-direction: column;
		align-items: stretch;
	}
	.merge-panel p {
		margin: 0;
	}
	.table-wrap {
		overflow-x: auto;
		-webkit-overflow-scrolling: touch;
	}
	.data-table {
		width: 100%;
		min-width: 760px;
		border-collapse: collapse;
		font-size: 0.85rem;
	}
	.data-table th,
	.data-table td {
		text-align: left;
		padding: 0.5rem 0.6rem;
		border-bottom: 1px solid #e5e5e5;
		vertical-align: top;
	}
	tr.is-selected td {
		background: #f4f9f6;
	}
	.col-check {
		width: 2.5rem;
	}
	.col-check input {
		width: 20px;
		height: 20px;
	}
	.col-num {
		text-align: right;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}
	.col-actions {
		white-space: nowrap;
	}
	.col-actions .btn {
		margin: 0 0.2rem 0.25rem 0;
	}
	.tag-label {
		font-weight: 600;
	}
	.slug {
		display: block;
		color: #555;
		font-family: ui-monospace, monospace;
		font-size: 0.75rem;
	}
	.breakdown {
		display: block;
		color: #555;
		font-size: 0.75rem;
	}
	.badge {
		display: inline-block;
		padding: 0.1rem 0.5rem;
		border-radius: 999px;
		font-size: 0.75rem;
		font-weight: 700;
		white-space: nowrap;
	}
	.badge-undecided {
		background: #f1f1f1;
		color: #333;
	}
	.badge-approved {
		background: #d8ebe1;
		color: #0f3a27;
	}
	.badge-hidden {
		background: #f6e3e1;
		color: #6b1d16;
	}
	.badge-merged {
		background: #fbefcf;
		color: #4f3600;
	}
	.merged-to {
		display: block;
		font-size: 0.8rem;
		color: #333;
		margin-top: 0.2rem;
	}
	.edit-row {
		display: flex;
		gap: 0.4rem;
		align-items: center;
		flex-wrap: wrap;
	}
	.input {
		font-size: 0.9rem;
		padding: 0.35rem 0.5rem;
		border: 1px solid #bbb;
		border-radius: 4px;
	}
	.btn {
		border: none;
		border-radius: 5px;
		cursor: pointer;
		font-size: 0.8rem;
		min-height: 36px;
		padding: 0.35rem 0.75rem;
		touch-action: manipulation;
	}
	.btn-primary {
		background: #2a5f4c;
		color: #fff;
	}
	.btn-secondary {
		background: #eee;
		color: #222;
	}
	.btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.btn:focus-visible,
	.tab:focus-visible,
	.link-btn:focus-visible {
		outline: 2px solid #1a4731;
		outline-offset: 2px;
	}
	.link-btn {
		background: none;
		border: none;
		padding: 0.2rem 0;
		color: #1a4731;
		text-decoration: underline;
		cursor: pointer;
		font: inherit;
		font-size: 0.8rem;
	}
	.examples-toggle {
		display: block;
		margin-top: 0.15rem;
	}
	.examples-row td {
		background: #faf7f0;
	}
	.examples {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}
	.examples li {
		font-size: 0.85rem;
		line-height: 1.45;
	}
	.ex-date {
		font-family: ui-monospace, Menlo, monospace;
		margin-right: 0.4rem;
		color: #1a4731;
	}
	.ex-source {
		font-size: 0.7rem;
		font-weight: 700;
		text-transform: uppercase;
		color: #4a4a4a;
		margin-right: 0.4rem;
	}
	.note,
	.empty {
		color: #555;
		font-size: 0.85rem;
		font-style: italic;
		margin: 0.3rem 0;
	}
	.more {
		margin-top: 0.75rem;
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
		gap: 1rem;
		align-items: center;
	}
	.confirm-bar {
		position: fixed;
		left: 0;
		right: 0;
		bottom: 0;
		z-index: 50;
		display: flex;
		flex-wrap: wrap;
		gap: 0.6rem 1rem;
		align-items: center;
		justify-content: center;
		padding: 0.8rem 1rem calc(0.8rem + env(safe-area-inset-bottom));
		background: #fff;
		border-top: 2px solid #2a5f4c;
		box-shadow: 0 -4px 16px rgba(0, 0, 0, 0.12);
	}
	.confirm-bar p {
		margin: 0;
		font-weight: 600;
	}
	.confirm-bar form {
		display: flex;
		gap: 0.5rem;
	}
	.confirm-bar .btn {
		min-height: 44px;
		font-size: 0.9rem;
		padding: 0 1.1rem;
	}
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
	}
</style>
