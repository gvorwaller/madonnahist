<script lang="ts">
	import { untrack } from 'svelte';
	import { page } from '$app/state';
	import { enhance } from '$lib/forms';
	import EntityPicker from './EntityPicker.svelte';
	import { withBack } from '$lib/return-to';

	/**
	 * The entries an entity is mentioned on, a page at a time, each with
	 * "Move to…": this day is about someone else (td-c6e871). Used on
	 * /admin/entities and /admin/entities/cleanup. Reads
	 * /admin/entities/[id]/mentions; moves through /admin/entities?/moveDay
	 * (src/lib/server/entity-graph.ts moveDay).
	 *
	 * Fetches when it mounts, so callers mount it only when it's opened, and
	 * again whenever the page's data reloads (any merge, alias or move on the
	 * page): a list showing where a day was just moved to picks it up
	 * (CODEX9 td-c6e871 #11).
	 */
	interface Option {
		id: number;
		display_name: string;
	}
	interface Props {
		entityId: number;
		/** Canonical names of the same kind: where a day can move to. */
		options: Option[];
		/** A day moved: the parent reloads its counts. */
		onmoved?: () => void;
		pageSize?: number;
		/** Where the day page's "Back to …" link returns (td-8a7e37); see $lib/return-to. */
		back?: string;
	}
	const { entityId, options, onmoved, pageSize = 15, back }: Props = $props();

	interface Mention {
		dayId: number;
		entryDate: string;
		human: boolean;
		via: string[];
		snippet: { where: 'text' | 'note' | 'none'; before: string; match: string; after: string };
	}

	let loading = $state(true);
	let loadingMore = $state(false);
	let loadError = $state('');
	let mentions = $state<Mention[]>([]);
	let next = $state<string | null>(null);
	let familyId = $state<number | null>(null);
	let displayName = $state('');
	let movingDay = $state<number | null>(null);
	let moveTarget = $state<number | null>(null);
	let moveError = $state('');

	async function load(after: string | null, limit = pageSize) {
		const qs = new URLSearchParams({ limit: String(limit) });
		if (after) qs.set('after', after);
		const res = await fetch(`/admin/entities/${entityId}/mentions?${qs}`);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		return (await res.json()) as { mentions: Mention[]; next: string | null; familyId: number; displayName: string };
	}

	// Each (re)load gets a number; an answer that arrives after a newer load
	// started is dropped, so a slow first fetch can't overwrite a fresh one.
	let seq = 0;
	// While a refresh rebuilds the list, "Show more" waits: a page appended
	// meanwhile would be overwritten by the refresh (CODEX9 re-review #5).
	let refreshing = $state(false);
	async function refresh() {
		const mine = ++seq;
		refreshing = true;
		// Keep as many entries showing as were: the endpoint gives at most 100
		// a page, so follow the cursor until the list is as deep as it was.
		const want = Math.max(pageSize, mentions.length);
		try {
			let body = await load(null, Math.min(100, want));
			const got = [...body.mentions];
			while (got.length < want && body.next) {
				if (mine !== seq) return;
				body = await load(body.next, Math.min(100, want - got.length));
				got.push(...body.mentions);
			}
			if (mine !== seq) return;
			mentions = got;
			next = body.next;
			familyId = body.familyId;
			displayName = body.displayName;
			loadError = '';
		} catch {
			if (mine === seq) loadError = 'Failed to load example entries';
		} finally {
			if (mine === seq) {
				loading = false;
				refreshing = false;
			}
		}
	}

	$effect(() => {
		void page.data;
		void entityId;
		untrack(() => void refresh());
	});

	async function more() {
		if (!next || refreshing) return;
		const mine = seq;
		loadingMore = true;
		try {
			const body = await load(next);
			if (mine !== seq) return;
			const seen = new Set(mentions.map((m) => m.dayId));
			mentions = [...mentions, ...body.mentions.filter((m) => !seen.has(m.dayId))];
			next = body.next;
		} catch {
			if (mine === seq) loadError = 'Failed to load more entries';
		} finally {
			loadingMore = false;
		}
	}

	const targets = $derived(options.filter((o) => o.id !== familyId));
	const label = (m: Mention) => (m.snippet.where === 'note' ? "In the day's note: " : '');
</script>

{#if loading}
	<p class="note">Loading example entries…</p>
{:else if loadError && mentions.length === 0}
	<p class="note">{loadError}</p>
{:else if mentions.length === 0}
	<p class="note">No entries found.</p>
{:else}
	<ul class="mentions">
		{#each mentions as m (m.dayId)}
			<li>
				<div class="line">
					<a class="date" href={withBack(`/correct/day/${m.entryDate}`, back)}>{m.entryDate}</a>
					<span class="text">
						{label(m)}{#if m.snippet.where === 'none'}<em>(name not found in the text)</em>
						{/if}{m.snippet.before}{#if m.snippet.match}<mark>{m.snippet.match}</mark>{/if}{m.snippet.after}
					</span>
					{#if m.via.length > 0}<span class="tag">as {m.via.join(', ')}</span>{/if}
					{#if m.human}<span class="tag">linked by hand</span>{/if}
					{#if movingDay !== m.dayId && familyId !== null && targets.length > 0}
						<button
							type="button"
							class="move"
							onclick={() => {
								movingDay = m.dayId;
								moveTarget = null;
								moveError = '';
							}}>Not this one → move to…</button
						>
					{/if}
				</div>
				{#if movingDay === m.dayId && familyId !== null}
					<form
						method="POST"
						action="/admin/entities?/moveDay"
						class="move-form"
						use:enhance={() => {
							const day = m.dayId;
							return async ({ result, update }) => {
								if (result.type === 'failure') {
									moveError = (result.data as { error?: string })?.error ?? 'Move failed';
									return;
								}
								if (result.type === 'success') {
									mentions = mentions.filter((x) => x.dayId !== day);
									if (movingDay === day) movingDay = null;
									await update({ reset: false, invalidateAll: true });
									onmoved?.();
								} else {
									await update();
								}
							};
						}}
					>
						<input type="hidden" name="dayId" value={m.dayId} />
						<input type="hidden" name="fromId" value={familyId} />
						<input type="hidden" name="toId" value={moveTarget ?? ''} />
						<span class="move-label">Move {m.entryDate} from "{displayName}" to:</span>
						<EntityPicker
							options={targets}
							bind:selectedId={moveTarget}
							inline
							placeholder="Type a name…"
							inputLabel="Move {m.entryDate} to"
						/>
						<div class="move-actions">
							<button type="submit" class="btn primary" disabled={!moveTarget}>Move</button>
							<button type="button" class="btn" onclick={() => (movingDay = null)}>Cancel</button>
						</div>
						{#if moveError}<p class="error" role="alert">{moveError}</p>{/if}
					</form>
				{/if}
			</li>
		{/each}
	</ul>
	{#if next}
		<button type="button" class="btn" onclick={more} disabled={loadingMore || refreshing}>
			{loadingMore ? 'Loading…' : 'Show more entries'}
		</button>
	{/if}
	{#if loadError}<p class="note">{loadError}</p>{/if}
{/if}

<style>
	.mentions {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.line {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.25rem 0.6rem;
		font-size: 0.9rem;
		line-height: 1.45;
	}
	.date {
		font-family: ui-monospace, Menlo, monospace;
		font-size: 0.85rem;
		color: #1a4731;
	}
	.text {
		flex: 1 1 20rem;
		color: #222;
	}
	.text em {
		color: #444;
		margin-right: 0.3rem;
	}
	mark {
		background: #f5d78e;
		color: #2b2417;
		padding: 0 0.1em;
	}
	.tag {
		font-size: 0.8rem;
		color: #3d3d3d;
		background: #eee;
		border-radius: 4px;
		padding: 0.05rem 0.4rem;
	}
	.move,
	.btn {
		min-height: 44px;
		padding: 0.3rem 0.8rem;
		border: 1px solid #bbb;
		border-radius: 6px;
		background: #fff;
		color: #1a4731;
		font: inherit;
		font-size: 0.85rem;
		cursor: pointer;
	}
	.btn.primary {
		background: #2a5f4c;
		border-color: #2a5f4c;
		color: #fff;
	}
	.btn:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}
	.move:focus-visible,
	.btn:focus-visible {
		outline: 2px solid #1a4731;
		outline-offset: 2px;
	}
	.move-form {
		margin: 0.4rem 0 0.2rem;
		padding: 0.6rem;
		border: 1px solid #ddd;
		border-radius: 6px;
		background: #fff;
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		max-width: 30rem;
	}
	.move-label {
		font-size: 0.85rem;
		color: #333;
	}
	.move-actions {
		display: flex;
		gap: 0.4rem;
	}
	.note {
		margin: 0.4rem 0 0;
		font-size: 0.85rem;
		font-style: italic;
		color: #555;
	}
	.error {
		margin: 0;
		color: #7a1f1a;
		font-size: 0.85rem;
	}
</style>
