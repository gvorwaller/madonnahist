<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto, invalidateAll } from '$app/navigation';
	import { untrack } from 'svelte';
	import type { SubmitFunction } from '@sveltejs/kit';
	import DecadeFolds from '$lib/components/admin/DecadeFolds.svelte';
	import { narrativeModelLabel } from '$lib/narrative-models';

	const { data } = $props();

	type YearRow = (typeof data.years)[number];
	type Draft = NonNullable<typeof data.open>['drafts'][number];

	const ACTION = '/admin/narratives';

	// Decade sections (Gaylon, 2026-11-18): a decade starts open when it has
	// something waiting on you: a draft to review, new candidates, a
	// narrative generating, or a fully transcribed year with no narrative yet.
	const waiting = (r: YearRow) =>
		r.status === 'draft' || r.pendingJob || r.newDrafts || (r.status === 'none' && r.percent === 100);
	const count = (list: YearRow[], status: YearRow['status']) => list.filter((r) => r.status === status).length;

	let actionError = $state('');
	let notice = $state('');

	// ── House style (global guidance) ───────────────────────────────────
	let styleOpen = $state(false);
	let styleText = $state('');
	let styleBase: string | null = null;
	$effect(() => {
		const saved = data.styleGuidance;
		// Take the saved value unless the admin has unsaved typing.
		if (styleBase === null || untrack(() => styleText) === styleBase) styleText = saved;
		styleBase = saved;
	});
	const styleDirty = $derived(styleText.trim() !== data.styleGuidance.trim());

	// ── The open year (?open=YYYY) ──────────────────────────────────────
	const openYear = $derived(data.open ? Number(data.open.year) : null);
	let notesText = $state('');
	// The saved notes the textarea started from. Sent with Generate so the
	// server can tell untouched notes (keep what's saved, even if another tab
	// changed it since) from notes typed here (save them).
	let notesBase = $state('');
	let notesFor: string | null = null;
	// Unsaved notes for years you switched away from, restored when you
	// open the year again (until the page is left).
	const unsavedNotes = new Map<string, string>();
	let selectedModels = $state<string[]>([]);
	let mode = $state<'fresh' | 'revise'>('fresh');
	let viewing = $state<string[]>([]);
	let compareIds = $state<string[]>([]);
	let editingYear = $state<number | null>(null);
	let editText = $state('');

	$effect(() => {
		const y = data.open?.year ?? null;
		const saved = data.open?.notes ?? '';
		const typed = untrack(() => notesText);
		const base = untrack(() => notesBase);
		if (y === notesFor) {
			// Same year, refreshed: adopt notes saved elsewhere unless the
			// admin has unsaved typing here.
			if (saved !== base) {
				if (typed.trim() === base.trim()) notesText = saved;
				notesBase = saved;
			}
		} else {
			if (notesFor !== null) {
				if (typed.trim() !== base.trim()) unsavedNotes.set(notesFor, typed);
				else unsavedNotes.delete(notesFor);
			}
			notesFor = y;
			const stashed = y === null ? undefined : unsavedNotes.get(y);
			if (y !== null) unsavedNotes.delete(y);
			notesText = stashed ?? saved;
			notesBase = saved;
			selectedModels = [data.defaultModel];
			mode = 'fresh';
			viewing = [];
			compareIds = [];
			editingYear = null;
		}
	});
	const notesDirty = $derived(!!data.open && notesText.trim() !== data.open.notes.trim());

	// The draft each dialog/edit was opened on, sent back so the server can
	// refuse if another tab changed the text meanwhile.
	let publishTarget = $state<{ year: number; draftId: string | null } | null>(null);
	let editDraftId = $state<string | null>(null);
	let unpublishTarget = $state<number | null>(null);
	let useTarget = $state<{ year: number; draft: Draft } | null>(null);

	const statusLabels: Record<string, string> = { none: 'None', draft: 'Draft', published: 'Published' };
	const modeLabels: Record<string, string> = {
		fresh: 'Fresh',
		revise: 'Revision',
		imported: 'Earlier narrative',
		edit: 'Hand edit'
	};

	// Auto-refresh every 30s so finished drafts show up without a reload.
	// Paused while anything typed is unsaved or a dialog is open, judged by
	// content rather than focus: tapping a checkbox on iPad blurs the
	// textarea, and a refresh then must not wipe the notes.
	const busy = $derived(
		editingYear !== null || styleDirty || notesDirty || useTarget !== null || publishTarget !== null || unpublishTarget !== null
	);
	$effect(() => {
		const timer = setInterval(() => {
			if (!busy) invalidateAll();
		}, 30_000);
		return () => clearInterval(timer);
	});

	function openYearRow(year: number | null) {
		goto(year === null ? ACTION : `${ACTION}?open=${year}`, { replaceState: true, noScroll: true, keepFocus: true });
	}

	function toggleView(id: string) {
		viewing = viewing.includes(id) ? viewing.filter((v) => v !== id) : [...viewing, id];
	}

	function toggleCompare(id: string) {
		if (compareIds.includes(id)) compareIds = compareIds.filter((c) => c !== id);
		else compareIds = [...compareIds.slice(-1), id];
	}

	function paragraphs(text: string): string[] {
		return text.split(/\n{2,}/).map((p) => p.trim()).filter((p) => p.length > 0);
	}

	function when(ts: string): string {
		return new Date(ts).toLocaleString();
	}

	function tokens(d: Draft): string {
		if (d.input_tokens === null && d.output_tokens === null) return '';
		const f = (n: number | null) => (n === null ? '?' : n.toLocaleString());
		return `${f(d.input_tokens)} in · ${f(d.output_tokens)} out`;
	}

	type SubmitInput = Parameters<SubmitFunction>[0];

	/**
	 * Shared submit handler: show failures, keep form values, refresh data.
	 * The callbacks get the submit input, so a form with a second submit
	 * button (formaction) can tell which one was pressed.
	 */
	function handled(
		fallback: string | ((input: SubmitInput) => string),
		onSuccess?: (input: SubmitInput) => void,
		onDone?: () => void
	): SubmitFunction {
		return (input) =>
			async ({ result, update }) => {
				onDone?.();
				if (result.type === 'failure') {
					actionError =
						(result.data as { error?: string } | undefined)?.error ??
						(typeof fallback === 'string' ? fallback : fallback(input));
				} else if (result.type === 'success' || result.type === 'redirect') {
					actionError = '';
					onSuccess?.(input);
				}
				await update({ reset: false });
			};
	}

	const isSaveNotes = (input: SubmitInput) => input.action.search.includes('saveNotes');
</script>

<svelte:window
	onkeydown={(e) => {
		if (e.key === 'Escape') {
			publishTarget = null;
			unpublishTarget = null;
			useTarget = null;
		}
	}}
/>

{#snippet draftText(text: string)}
	<div class="preview">
		{#each paragraphs(text) as para, i (i)}
			<p>{para}</p>
		{/each}
	</div>
{/snippet}

{#snippet useButton(row: YearRow, d: Draft)}
	{#if row.narrative?.source_draft_id === d.id}
		<span class="in-use">In use</span>
	{:else if row.status === 'published'}
		<button class="btn btn-primary" onclick={() => (useTarget = { year: row.year, draft: d })}>Use this</button>
	{:else}
		<form method="POST" action="{ACTION}?/useDraft" use:enhance={handled('Could not use that draft', () => (notice = `Draft #${d.id} is now the ${row.year} text.`))}>
			<input type="hidden" name="year" value={row.year} />
			<input type="hidden" name="draftId" value={d.id} />
			<button type="submit" class="btn btn-primary">Use this</button>
		</form>
	{/if}
{/snippet}

{#snippet yearDetail(row: YearRow)}
	{@const open = data.open!}
	<div class="detail">
		<section>
			<h3>Current text</h3>
			{#if row.narrative}
				<p class="provenance">
					{#if row.narrative.source_draft_id}
						From draft #{row.narrative.source_draft_id} &middot; {narrativeModelLabel(row.narrative.generated_by)} &middot;
						{when(row.narrative.generated_at)}
					{:else}
						{narrativeModelLabel(row.narrative.generated_by)} &middot; {when(row.narrative.generated_at)}
					{/if}
				</p>
				{#if editingYear === row.year}
					<form method="POST" action="{ACTION}?/saveEdit" use:enhance={handled('Save failed', () => (editingYear = null))}>
						<input type="hidden" name="year" value={row.year} />
						<input type="hidden" name="expectedDraftId" value={editDraftId ?? ''} />
						<label class="sr-only" for="edit-{row.year}">Narrative text for {row.year}</label>
						<textarea id="edit-{row.year}" name="summaryText" bind:value={editText} rows="14" class="edit-textarea"></textarea>
						<div class="button-row">
							<button type="submit" class="btn btn-primary">Save</button>
							<button type="button" class="btn btn-secondary" onclick={() => (editingYear = null)}>Cancel</button>
						</div>
					</form>
				{:else}
					{@render draftText(row.narrative.summary_text)}
					<button
						class="btn btn-secondary"
						onclick={() => {
							editingYear = row.year;
							editDraftId = row.narrative?.source_draft_id ?? null;
							editText = row.narrative?.summary_text ?? '';
						}}>Edit by hand</button
					>
				{/if}
			{:else}
				<p class="empty">No text yet. Generate a draft below, then choose one with "Use this".</p>
			{/if}
		</section>

		<section>
			<h3>Generate a new draft</h3>
			{#if !row.canGenerate}
				<p class="hint">
					{row.year} has no accepted days right now, so there is nothing to write from. Its text and drafts are kept.
				</p>
			{/if}
			<form
				method="POST"
				action="{ACTION}?/generate"
				use:enhance={handled(
					(input) => (isSaveNotes(input) ? 'Could not save the notes' : 'Generate failed'),
					(input) =>
						(notice = isSaveNotes(input)
							? `Notes for ${row.year} saved.`
							: 'Queued. New drafts appear here in a minute or two.')
				)}
			>
				<input type="hidden" name="year" value={row.year} />
				<input type="hidden" name="notesBase" value={notesBase} />
				<fieldset>
					<legend>Models (tick two to compare)</legend>
					{#each data.models as m (m.id)}
						{@const pending = row.pendingModels.includes(m.id)}
						<label class="choice">
							<input type="checkbox" name="model" value={m.id} bind:group={selectedModels} disabled={pending} />
							{m.label}
							{#if pending}<span class="pending-tag">generating…</span>{/if}
						</label>
					{/each}
				</fieldset>
				<fieldset>
					<legend>Start from</legend>
					<label class="choice">
						<input type="radio" name="mode" value="fresh" bind:group={mode} />
						The entries (fresh draft)
					</label>
					<label class="choice">
						<input type="radio" name="mode" value="revise" bind:group={mode} disabled={!row.narrative} />
						The current text (revise it using the notes)
					</label>
				</fieldset>
				<label class="notes-label" for="notes-{row.year}">Notes for {row.year}</label>
				<p class="hint">
					Corrections, who people are, what to emphasize. Saved with the year and used for every draft.
					Treated as fact by the writer, so keep them accurate.
				</p>
				<textarea id="notes-{row.year}" name="notes" bind:value={notesText} rows="6" maxlength={data.maxGuidanceLength} class="notes-textarea"></textarea>
				{#each open.lastFailures as f (f.model)}
					<p class="job-error" role="status">
						Last {narrativeModelLabel(f.model)} run failed ({when(f.at)}): {f.error}
					</p>
				{/each}
				<div class="button-row">
					<button
						type="submit"
						class="btn btn-primary"
						disabled={!row.canGenerate || selectedModels.filter((m) => !row.pendingModels.includes(m)).length === 0}
						>Generate</button
					>
					<button type="submit" class="btn btn-secondary" formaction="{ACTION}?/saveNotes" disabled={!notesDirty}>Save notes</button>
					{#if notesDirty}<span class="unsaved">Unsaved notes</span>{/if}
				</div>
			</form>
		</section>

		<section>
			<h3>Drafts ({open.drafts.length})</h3>
			{#if open.drafts.length === 0}
				<p class="empty">No drafts yet.</p>
			{:else}
				{#if compareIds.length === 2}
					{@const pair = compareIds.map((id) => open.drafts.find((d) => d.id === id)).filter((d) => d !== undefined)}
					<div class="compare" aria-label="Comparing two drafts">
						{#each pair as d (d.id)}
							<div class="compare-col">
								<h4>#{d.id} &middot; {narrativeModelLabel(d.model_name)}</h4>
								<p class="meta">{modeLabels[d.mode]} &middot; {when(d.created_at)}</p>
								{@render draftText(d.draft_text)}
								{@render useButton(row, d)}
							</div>
						{/each}
					</div>
					<button class="btn btn-secondary" onclick={() => (compareIds = [])}>Close comparison</button>
				{:else if compareIds.length === 1}
					<p class="hint">Tick one more draft to compare.</p>
				{/if}

				<ul class="drafts">
					{#each open.drafts as d (d.id)}
						<li class="draft">
							<div class="draft-head">
								<div>
									<strong>#{d.id} &middot; {narrativeModelLabel(d.model_name)}</strong>
									{#if d.mode !== 'edit'}<span class="mode-tag">{modeLabels[d.mode]}</span>{/if}
									<p class="meta">
										{when(d.created_at)}
										{#if d.requested_by_name}&middot; by {d.requested_by_name}{/if}
										{#if d.day_count}&middot; {d.day_count} days{/if}
										{#if tokens(d)}&middot; {tokens(d)}{/if}
									</p>
								</div>
								<div class="button-row">
									<button class="btn btn-secondary" onclick={() => toggleView(d.id)} aria-expanded={viewing.includes(d.id)}>
										{viewing.includes(d.id) ? 'Hide' : 'Read'}
									</button>
									<label class="choice compare-pick">
										<input type="checkbox" checked={compareIds.includes(d.id)} onchange={() => toggleCompare(d.id)} />
										Compare
									</label>
									{@render useButton(row, d)}
								</div>
							</div>
							{#if d.year_guidance || d.style_guidance}
								<details class="used">
									<summary>Guidance used</summary>
									{#if d.style_guidance}<p><b>House style:</b> {d.style_guidance}</p>{/if}
									{#if d.year_guidance}<p><b>Notes:</b> {d.year_guidance}</p>{/if}
								</details>
							{/if}
							{#if viewing.includes(d.id)}
								{@render draftText(d.draft_text)}
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</section>
	</div>
{/snippet}

<div class="page">
	<header>
		<a href="/admin" class="back">Admin</a>
		<h1>Year Narratives</h1>
		<p class="subtitle">
			AI-written year stories, drafted by the enrichment worker from accepted transcriptions. Every draft is kept;
			choose one with "Use this". Nothing is visible to the family until you publish it.
		</p>
	</header>

	{#if actionError}
		<div class="banner banner-error" role="alert">
			<span>{actionError}</span>
			<button class="banner-dismiss" onclick={() => (actionError = '')}>Dismiss</button>
		</div>
	{:else if notice}
		<div class="banner banner-notice" role="status">
			<span>{notice}</span>
			<button class="banner-dismiss" onclick={() => (notice = '')}>Dismiss</button>
		</div>
	{/if}

	<details class="style" bind:open={styleOpen}>
		<summary>
			House style for every year
			{#if data.styleGuidance}<span class="set-tag">set</span>{/if}
			{#if styleDirty}<span class="unsaved">Unsaved</span>{/if}
		</summary>
		<form method="POST" action="{ACTION}?/saveStyle" use:enhance={handled('Could not save the house style', () => (notice = 'House style saved.'))}>
			<p class="hint">
				Voice, tone, length and structure, e.g. "Shorter, about 300 words. Simple sentences. Mention Grandpa Joe's work
				when the entries do." It shapes how the story is told, never what happened. Used for every new draft.
			</p>
			<label class="sr-only" for="style-text">House style</label>
			<textarea id="style-text" name="style" bind:value={styleText} rows="6" maxlength={data.maxGuidanceLength} class="notes-textarea"></textarea>
			<div class="button-row">
				<button type="submit" class="btn btn-primary" disabled={!styleDirty}>Save house style</button>
			</div>
		</form>
	</details>

	{#if data.years.length === 0}
		<p class="empty">No years have any accepted days yet.</p>
	{:else}
		<DecadeFolds items={data.years} storageKey="admin.narratives.openDecades" startOpen={(list) => list.some(waiting)}>
			{#snippet summary(list)}
				{list.length} {list.length === 1 ? 'year' : 'years'} · {count(list, 'published')} published
				{#if count(list, 'draft') > 0}
					<span class="status-tag status-draft">{count(list, 'draft')} {count(list, 'draft') === 1 ? 'draft' : 'drafts'} to review</span>
				{/if}
				{#if list.some((r) => r.newDrafts)}
					<span class="status-tag status-new">new drafts</span>
				{/if}
				{#if list.some((r) => r.pendingJob)}
					<span class="pending-tag">generating…</span>
				{/if}
			{/snippet}
			{#snippet children(list)}
				<table class="data-table">
					<thead>
						<tr>
							<th>Year</th>
							<th class="col-num">Accepted</th>
							<th>Status</th>
							<th>Current text</th>
							<th class="col-actions">Actions</th>
						</tr>
					</thead>
					<tbody>
						{#each list as row (row.year)}
							<tr class:open-row={openYear === row.year}>
								<td>{row.year}</td>
								<td class="col-num">{row.accepted} / {row.total} ({row.percent}%)</td>
								<td>
									<span class="status-tag status-{row.status}">{statusLabels[row.status]}</span>
									{#if row.newDrafts}<span class="status-tag status-new">new drafts</span>{/if}
									{#if row.pendingJob}<span class="pending-tag">generating…</span>{/if}
								</td>
								<td class="col-meta">
									{#if row.narrative}
										{narrativeModelLabel(row.narrative.generated_by)}
										{#if row.draftCount > 0}&middot;{/if}
									{:else if row.draftCount === 0}
										&mdash;
									{/if}
									{#if row.draftCount > 0}{row.draftCount} {row.draftCount === 1 ? 'draft' : 'drafts'}{/if}
								</td>
								<td class="col-actions">
									<button
										class="btn btn-secondary"
										aria-expanded={openYear === row.year}
										onclick={() => openYearRow(openYear === row.year ? null : row.year)}
									>
										{openYear === row.year ? 'Close' : 'Open'}
									</button>
									{#if row.status === 'draft'}
										<button
											class="btn btn-primary"
											onclick={() => (publishTarget = { year: row.year, draftId: row.narrative?.source_draft_id ?? null })}
											>Publish</button
										>
									{:else if row.status === 'published'}
										<button class="btn btn-secondary" onclick={() => (unpublishTarget = row.year)}>Unpublish</button>
									{/if}
								</td>
							</tr>
							{#if openYear === row.year && data.open}
								<tr class="detail-row">
									<td colspan="5">{@render yearDetail(row)}</td>
								</tr>
							{/if}
						{/each}
					</tbody>
				</table>
			{/snippet}
		</DecadeFolds>
	{/if}
</div>

{#if publishTarget !== null}
	<div class="modal-overlay" role="dialog" aria-modal="true" aria-label="Confirm publish">
		<div class="modal-content">
			<h3>Publish narrative</h3>
			<p>
				Publish the {publishTarget.year} narrative{publishTarget.draftId ? ` (draft #${publishTarget.draftId})` : ''}? It
				will immediately become visible to every family viewer on the {publishTarget.year} year page, labeled as
				AI-written.
			</p>
			<div class="modal-actions">
				<button class="btn btn-secondary" onclick={() => (publishTarget = null)}>Cancel</button>
				<form
					method="POST"
					action="{ACTION}?/publish"
					use:enhance={handled('Publish failed', undefined, () => (publishTarget = null))}
				>
					<input type="hidden" name="year" value={publishTarget.year} />
					<input type="hidden" name="expectedDraftId" value={publishTarget.draftId ?? ''} />
					<button type="submit" class="btn btn-danger">Publish</button>
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
				Unpublish the {unpublishTarget} narrative? It will immediately disappear from the family viewer. The text and
				all drafts are kept, and you can publish it again later.
			</p>
			<div class="modal-actions">
				<button class="btn btn-secondary" onclick={() => (unpublishTarget = null)}>Cancel</button>
				<form method="POST" action="{ACTION}?/unpublish" use:enhance={handled('Unpublish failed', () => (unpublishTarget = null))}>
					<input type="hidden" name="year" value={unpublishTarget} />
					<button type="submit" class="btn btn-danger">Unpublish</button>
				</form>
			</div>
		</div>
	</div>
{/if}

{#if useTarget !== null}
	<div class="modal-overlay" role="dialog" aria-modal="true" aria-label="Confirm replacing published text">
		<div class="modal-content">
			<h3>Replace the published text?</h3>
			<p>
				The {useTarget.year} narrative is published. Using draft #{useTarget.draft.id}
				({narrativeModelLabel(useTarget.draft.model_name)}) changes what the family sees right away. The current text stays in
				the drafts list, so you can switch back.
			</p>
			<div class="modal-actions">
				<button class="btn btn-secondary" onclick={() => (useTarget = null)}>Cancel</button>
				<form
					method="POST"
					action="{ACTION}?/useDraft"
					use:enhance={handled('Could not use that draft', () => {
						notice = `Draft #${useTarget?.draft.id} is now the published ${useTarget?.year} text.`;
						useTarget = null;
					})}
				>
					<input type="hidden" name="year" value={useTarget.year} />
					<input type="hidden" name="draftId" value={useTarget.draft.id} />
					<input type="hidden" name="confirmPublished" value="1" />
					<button type="submit" class="btn btn-danger">Replace published text</button>
				</form>
			</div>
		</div>
	</div>
{/if}

<style>
	/* All text meets WCAG AAA (7:1) on its background; buttons and
	   checkbox/radio labels are at least 44px tall for iPad. */
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
		color: #4a4a4a;
		text-decoration: none;
	}
	.back:hover {
		text-decoration: underline;
	}
	h1 {
		margin: 0.25rem 0 0.2rem;
		font-size: 1.4rem;
	}
	h3 {
		margin: 0 0 0.5rem;
		font-size: 1rem;
	}
	h4 {
		margin: 0;
		font-size: 0.95rem;
	}
	.subtitle {
		margin: 0;
		color: #4a4a4a;
		font-size: 0.85rem;
		max-width: 640px;
	}
	.empty {
		color: #4a4a4a;
		font-size: 0.85rem;
		font-style: italic;
	}
	.hint,
	.meta,
	.provenance {
		color: #4a4a4a;
		font-size: 0.8rem;
		margin: 0.15rem 0 0.4rem;
	}
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
	}

	.style {
		border: 1px solid #ddd;
		border-radius: 6px;
		padding: 0 0.9rem;
		margin-bottom: 1.25rem;
		background: #fafafa;
	}
	.style summary {
		cursor: pointer;
		font-weight: 600;
		min-height: 44px;
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.style form {
		padding-bottom: 0.9rem;
	}
	.set-tag {
		font-size: 0.75rem;
		font-weight: 600;
		color: #144927;
		background: #e1f0e6;
		padding: 0.1rem 0.45rem;
		border-radius: 999px;
	}
	.unsaved {
		font-size: 0.78rem;
		font-weight: 600;
		color: #5c3e00;
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
	.open-row td {
		background: #f3f6f4;
	}
	.col-num {
		text-align: right;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}
	.col-meta {
		color: #4a4a4a;
	}
	.col-actions {
		white-space: nowrap;
	}
	.status-tag {
		display: inline-block;
		padding: 0.15rem 0.5rem;
		border-radius: 999px;
		font-size: 0.75rem;
		font-weight: 600;
		margin-right: 0.25rem;
	}
	.status-none {
		background: #eee;
		color: #333;
	}
	.status-draft {
		background: #fdf1d6;
		color: #5c3e00;
	}
	.status-published {
		background: #e1f0e6;
		color: #144927;
	}
	.status-new {
		background: #e3ecf7;
		color: #173a63;
	}
	.pending-tag {
		margin-left: 0.4rem;
		font-size: 0.75rem;
		font-style: italic;
		color: #4a4a4a;
	}

	.detail-row td {
		background: #fafafa;
		padding: 1rem;
	}
	.detail {
		display: grid;
		gap: 1.5rem;
	}
	.detail section + section {
		border-top: 1px solid #e0e0e0;
		padding-top: 1rem;
	}
	.preview {
		max-width: 68ch;
	}
	.preview p {
		font-family: Georgia, 'Iowan Old Style', serif;
		font-size: 0.95rem;
		line-height: 1.6;
		color: #2b2620;
		margin: 0 0 0.85rem;
		overflow-wrap: break-word;
	}
	fieldset {
		border: none;
		padding: 0;
		margin: 0 0 0.75rem;
		display: flex;
		flex-wrap: wrap;
		gap: 0 1.25rem;
	}
	legend {
		font-weight: 600;
		font-size: 0.85rem;
		margin-bottom: 0.2rem;
		padding: 0;
	}
	.choice {
		display: inline-flex;
		align-items: center;
		gap: 0.45rem;
		min-height: 44px;
		font-size: 0.9rem;
		cursor: pointer;
	}
	.choice input {
		width: 1.15rem;
		height: 1.15rem;
	}
	.notes-label {
		font-weight: 600;
		font-size: 0.85rem;
		display: block;
	}
	.edit-textarea,
	.notes-textarea {
		width: 100%;
		box-sizing: border-box;
		font-size: 0.9rem;
		padding: 0.6rem;
		border: 1px solid #999;
		border-radius: 6px;
		resize: vertical;
		font-family: inherit;
	}
	.edit-textarea {
		font-family: ui-monospace, monospace;
		font-size: 0.85rem;
	}
	.job-error {
		margin: 0.5rem 0 0;
		font-size: 0.82rem;
		color: #7a1f1a;
		background: #fdecea;
		border-radius: 5px;
		padding: 0.45rem 0.6rem;
		overflow-wrap: anywhere;
	}
	.button-row {
		margin-top: 0.5rem;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
	}
	.button-row form {
		display: inline;
	}

	.drafts {
		list-style: none;
		padding: 0;
		margin: 0.75rem 0 0;
		display: grid;
		gap: 0.75rem;
	}
	.draft {
		border: 1px solid #ddd;
		border-radius: 6px;
		padding: 0.6rem 0.8rem;
		background: #fff;
	}
	.draft-head {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		gap: 0.5rem;
	}
	.draft-head .button-row {
		margin-top: 0;
	}
	.mode-tag {
		margin-left: 0.4rem;
		font-size: 0.75rem;
		color: #333;
		background: #eee;
		border-radius: 999px;
		padding: 0.1rem 0.45rem;
	}
	.compare-pick {
		font-size: 0.85rem;
	}
	.in-use {
		font-size: 0.8rem;
		font-weight: 600;
		color: #144927;
		background: #e1f0e6;
		border-radius: 999px;
		padding: 0.3rem 0.7rem;
	}
	.used {
		margin-top: 0.4rem;
		font-size: 0.82rem;
	}
	.used summary {
		cursor: pointer;
		min-height: 44px;
		display: flex;
		align-items: center;
		color: #333;
	}
	.used p {
		margin: 0.2rem 0;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.compare {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 1rem;
		margin-bottom: 0.75rem;
	}
	.compare-col {
		min-width: 0;
		border: 1px solid #ccd;
		border-radius: 6px;
		padding: 0.6rem 0.8rem;
		background: #fff;
	}
	@media (max-width: 760px) {
		.compare {
			grid-template-columns: minmax(0, 1fr);
		}
	}

	.btn {
		border: none;
		border-radius: 5px;
		cursor: pointer;
		font-size: 0.85rem;
		padding: 0.4rem 0.85rem;
		min-height: 44px;
		min-width: 44px;
		margin-right: 0.25rem;
	}
	.btn-primary {
		background: #2a5f4c;
		color: #fff;
	}
	.btn-secondary {
		background: #e8e8e8;
		color: #222;
	}
	.btn-danger {
		background: #9b1c15;
		color: #fff;
	}
	.btn:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}
	.banner {
		padding: 0.6rem 0.9rem;
		border-radius: 6px;
		margin-bottom: 1rem;
		font-size: 0.85rem;
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 0.75rem;
	}
	.banner-error {
		background: #fdecea;
		border: 1px solid #f5c2c0;
		color: #7a1f1a;
	}
	.banner-notice {
		background: #e1f0e6;
		border: 1px solid #b9dcc5;
		color: #144927;
	}
	.banner-dismiss {
		background: none;
		border: none;
		color: inherit;
		text-decoration: underline;
		cursor: pointer;
		font-size: 0.8rem;
		min-height: 44px;
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
		color: #333;
		line-height: 1.5;
	}
	.modal-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.6rem;
	}
</style>
