<script lang="ts">
	import { tick } from 'svelte';
	import { enhance } from '$lib/forms';
	import Modal from '$lib/components/Modal.svelte';
	import EntityMentions from '$lib/components/EntityMentions.svelte';
	import { MAX_CHECK_CANDIDATES, type Verdict } from '$lib/entity-check';

	/**
	 * Find duplicates (td-c6e871). Groups of likely-duplicate names around a
	 * main name, with the evidence to decide, Claude's opinion on demand, and
	 * merge / alias / not-the-same / move-a-day. Nothing merges without a
	 * confirmed click.
	 */
	const { data, form } = $props();

	type Group = (typeof data.groups)[number];
	type Cand = Group['candidates'][number];

	const TABS = [
		{ type: 'person', label: 'People' },
		{ type: 'place', label: 'Places' },
		{ type: 'event', label: 'Events' }
	];
	const kindWord: Record<string, string> = { person: 'person', place: 'place', event: 'event' };
	const reasonText = (c: Cand, main: string) =>
		({
			'same-letters': `same letters as "${main}", spaced or punctuated differently`,
			'typo-of-common': `one letter off "${main}", which is far more common`,
			'one-letter': `one letter different from "${main}"`,
			'two-letters': `two letters different from "${main}"`,
			'first-word': `shares its first word with "${main}"`
		})[c.reason] ?? c.reason;

	// ── State from this visit ──
	// Claude answers and manual ticks are keyed by the pair AND its evidence
	// fingerprint (c.fp, from the loader). Anything that changes either name's
	// days, text, aliases or grouping changes the key, so an answer the server
	// has since discarded (a moved day) can't linger here, and a tick can't
	// follow a name into a different group (CODEX9 td-c6e871 #9).
	let live = $state<Record<string, { verdict: Verdict; reason: string } | 'busy' | 'changed'>>({});
	const key = (g: Group, c: Cand) => `${g.main.id}:${c.id}:${c.fp}`;
	function checkOf(g: Group, c: Cand): { verdict: Verdict; reason: string } | null {
		const l = live[key(g, c)];
		if (l && typeof l === 'object') return l;
		return c.check;
	}

	// ── Ticks: defaults unless the admin touched the box ──
	let touched = $state<Record<string, boolean>>({});
	function defaultTick(g: Group, c: Cand): boolean {
		if (c.outside > 0) return false; // some days look like someone else: decide by hand
		const k = checkOf(g, c);
		return k ? k.verdict === 'same' : c.tier === 'likely';
	}
	// The server said this pair's entries changed since the page loaded: it
	// can't be ticked, kept or merged from here until a reload shows the new
	// entries (CODEX9 final review #1). The server refuses such a merge too.
	const stale = (g: Group, c: Cand) => live[key(g, c)] === 'changed';
	const ticked = (g: Group, c: Cand) =>
		!stale(g, c) && (key(g, c) in touched ? touched[key(g, c)] : defaultTick(g, c));
	// The name that survives: the main name unless another one in the group
	// was chosen. A chosen name is always part of the merge: choosing it
	// ticks it, and unticking it gives "keep" back to the main name (CODEX9
	// #10). The choice is tied to the same pair-and-evidence key as its tick,
	// so when that evidence changes both lapse together and "keep" goes back
	// to the main name (CODEX9 re-review #4).
	let keepChoice = $state<Record<number, string>>({});
	const keepOf = (g: Group) => {
		const k = keepChoice[g.main.id];
		return g.candidates.find((c) => key(g, c) === k && !stale(g, c))?.id ?? g.main.id;
	};
	function chooseKeep(g: Group, c: Cand | null) {
		keepChoice = { ...keepChoice, [g.main.id]: c ? key(g, c) : '' };
		if (c) touched = { ...touched, [key(g, c)]: true };
	}
	function setTick(g: Group, c: Cand, on: boolean) {
		touched = { ...touched, [key(g, c)]: on };
		if (!on && keepOf(g) === c.id) keepChoice = { ...keepChoice, [g.main.id]: '' };
	}
	// Entry lists mount on first opening (CODEX9 #11).
	let opened = $state<Record<string, boolean>>({});
	const markOpened = (k: string, e: Event) => {
		if ((e.currentTarget as HTMLDetailsElement).open && !opened[k]) opened = { ...opened, [k]: true };
	};

	// ── Skipped this visit ──
	let skipped = $state<Record<number, boolean>>({});
	const visible = $derived(data.groups.filter((g) => !skipped[g.main.id]));
	const likely = $derived(visible.filter((g) => g.tier === 'likely'));
	const possible = $derived(visible.filter((g) => g.tier === 'possible'));
	let shown = $state(20);

	let message = $state('');
	let errorText = $state('');
	$effect(() => {
		if (form && 'error' in form && form.error) errorText = String(form.error);
	});

	// ── Checking with Claude ──
	let checking = $state<Record<number, boolean>>({});
	let groupError = $state<Record<number, string>>({});
	const unchecked = (g: Group) => g.candidates.filter((c) => !checkOf(g, c) && !stale(g, c));

	/** 'answered': Claude gave at least one answer; 'failed': an error; 'none': nothing new (busy, changed, or nothing to ask). */
	async function checkGroup(g: Group): Promise<'answered' | 'failed' | 'none'> {
		const ids = unchecked(g)
			.map((c) => c.id)
			.slice(0, MAX_CHECK_CANDIDATES);
		if (ids.length === 0) return 'none';
		// The keys these answers belong to, as of sending. The server answers
		// only for the evidence this page shows (the fingerprints sent), and
		// says 'changed' for any that moved on since.
		const sentKey = new Map(g.candidates.map((c) => [c.id, key(g, c)]));
		const fingerprints = Object.fromEntries(g.candidates.filter((c) => ids.includes(c.id)).map((c) => [c.id, c.fp]));
		checking = { ...checking, [g.main.id]: true };
		groupError = { ...groupError, [g.main.id]: '' };
		try {
			const res = await fetch('/admin/entities/cleanup/check', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ mainId: g.main.id, candidateIds: ids, fingerprints })
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok) {
				groupError = { ...groupError, [g.main.id]: body.error ?? "Couldn't check this group." };
				return 'failed';
			}
			const next = { ...live };
			let answered = false;
			for (const r of body.results as { candidateId: number; state: string; verdict?: Verdict; reason?: string }[]) {
				const k = sentKey.get(r.candidateId);
				if (!k) continue;
				if ((r.state === 'done' || r.state === 'cached') && r.verdict && r.reason) {
					next[k] = { verdict: r.verdict, reason: r.reason };
					answered = true;
				} else if (r.state === 'busy' || r.state === 'changed') next[k] = r.state;
			}
			live = next;
			return answered ? 'answered' : 'none';
		} catch {
			groupError = { ...groupError, [g.main.id]: "Couldn't reach the server." };
			return 'failed';
		} finally {
			checking = { ...checking, [g.main.id]: false };
		}
	}

	let batch = $state<{ list: Group[]; done: number; stop: boolean } | null>(null);
	async function checkNext() {
		errorText = ''; // a fresh batch: an earlier batch's failure banner no longer applies
		const list = visible.filter((g) => unchecked(g).length > 0).slice(0, 20);
		if (list.length === 0) {
			const anyStale = visible.some((g) => g.candidates.some((c) => stale(g, c)));
			message = anyStale
				? "Nothing left to check here. Some names' entries changed since this page loaded: reload the page to see and check them."
				: 'Every group shown here has been checked.';
			return;
		}
		batch = { list, done: 0, stop: false };
		// Count what actually happened, so a failure never reads as "checked"
		// (CODEX9 final review #2).
		const tally = { answered: 0, failed: 0, none: 0 };
		for (const g of list) {
			if (!batch || batch.stop) break;
			tally[await checkGroup(g)] += 1;
			if (batch) batch.done += 1;
		}
		batch = null;
		const groups = (n: number) => `${n} ${n === 1 ? 'group' : 'groups'}`;
		const parts = [`Checked ${groups(tally.answered)} with Claude.`];
		if (tally.failed) parts.push(`${groups(tally.failed)} couldn't be checked.`);
		if (tally.none) parts.push(`${groups(tally.none)} had nothing new to ask (changed, or being checked in another tab).`);
		message = parts.join(' ');
		if (tally.failed) errorText = `${groups(tally.failed)} couldn't be checked with Claude. Try those again later.`;
	}

	// ── Confirm dialogs ──
	let mergeAsk = $state<{
		g: Group;
		keepId: number;
		ids: number[];
		keepName: string;
		names: string[];
		/** The evidence fingerprint shown for each name merged, besides the main name. */
		fps: { id: number; fp: string }[];
	} | null>(null);
	let deleteAsk = $state<{ id: number; name: string } | null>(null);

	function askMerge(g: Group) {
		const keepId = keepOf(g);
		const participants = [
			{ id: g.main.id, name: g.main.name },
			...g.candidates.filter((c) => ticked(g, c) || c.id === keepId).map((c) => ({ id: c.id, name: c.name }))
		];
		const keepName = participants.find((p) => p.id === keepId)!.name;
		const rest = participants.filter((p) => p.id !== keepId);
		const fps = g.candidates.filter((c) => participants.some((p) => p.id === c.id)).map((c) => ({ id: c.id, fp: c.fp }));
		mergeAsk = { g, keepId, keepName, ids: rest.map((p) => p.id), names: rest.map((p) => p.name), fps };
	}

	/** After an action removes a card, put focus on the next card (or the section). */
	async function refocus(index: number) {
		await tick();
		const cards = [...document.querySelectorAll<HTMLElement>('[data-group-heading]')];
		const el = cards[Math.min(index, cards.length - 1)] ?? document.getElementById('groups-heading');
		el?.focus({ preventScroll: false });
	}

	/** Form callback: show the outcome, reload, and keep focus near the card the action was on. */
	const result = (cardIndex = -1, after?: () => void) => {
		const idx = cardIndex;
		return async ({ result, update }: { result: { type: string; data?: Record<string, unknown> }; update: (o?: { reset?: boolean }) => Promise<void> }) => {
			if (result.type === 'failure') {
				errorText = String(result.data?.error ?? 'That did not work.');
				message = '';
			} else if (result.type === 'success') {
				errorText = '';
				message = String(result.data?.done ?? 'Done.');
			}
			after?.();
			await update({ reset: false });
			if (result.type === 'success' && idx >= 0) await refocus(idx);
		};
	};
</script>

<svelte:head>
	<title>Find duplicates — Admin</title>
</svelte:head>

<div class="page">
	<header>
		<a href="/admin/entities" class="back">Entities &amp; Aliases</a>
		<h1>Find duplicates</h1>
		<p class="subtitle">
			Names the extractor may have split in two: typos, nicknames, fuller names. Read the entries, tick the ones
			that are the same {kindWord[data.type]}, then merge. Nothing changes until you confirm.
		</p>
	</header>

	<nav class="tabs" aria-label="Kind of name">
		{#each TABS as t (t.type)}
			<a href="/admin/entities/cleanup?type={t.type}" class="tab" aria-current={t.type === data.type ? 'page' : undefined}
				>{t.label}</a
			>
		{/each}
	</nav>

	<div class="status" role="status">
		{#if message}<p class="ok">{message}</p>{/if}
	</div>
	{#if errorText}
		<div class="error-banner" role="alert">
			{errorText}
			<button type="button" class="link" onclick={() => (errorText = '')}>Dismiss</button>
		</div>
	{/if}

	<div class="toolbar">
		{#if batch}
			<span>Checking with Claude: {batch.done} of {batch.list.length} groups done…</span>
			<button type="button" class="btn" onclick={() => batch && (batch.stop = true)} disabled={batch.stop}>
				{batch.stop ? 'Stopping after this group…' : 'Stop'}
			</button>
		{:else}
			<button type="button" class="btn" onclick={checkNext}>Check the next 20 groups with Claude</button>
			<span class="hint">Claude reads a few entries for each name and suggests which are the same. About a cent per group.</span>
		{/if}
	</div>

	<h2 id="groups-heading" tabindex="-1">
		Very likely the same <span class="count">{likely.length}</span>, possibly the same
		<span class="count">{possible.length}</span>
	</h2>

	{#if visible.length === 0}
		<p class="empty">No likely duplicates among these {TABS.find((t) => t.type === data.type)?.label.toLowerCase()}.</p>
	{/if}

	{#each visible.slice(0, shown) as g, gi (g.main.id)}
		{@const mainChecking = checking[g.main.id]}
		<section class="card" data-group aria-labelledby="g-{g.main.id}">
			<div class="card-head">
				<h3 id="g-{g.main.id}" data-group-heading tabindex="-1">
					{g.main.name}
					<span class="meta">{g.main.count} {g.main.count === 1 ? 'day' : 'days'}{g.main.years ? `, ${g.main.years}` : ''}</span>
				</h3>
				<span class="tier {g.tier}">{g.tier === 'likely' ? 'Very likely' : 'Possibly'}</span>
			</div>
			<details class="entries" ontoggle={(e) => markOpened(`m${g.main.id}`, e)}>
				<summary>Entries for {g.main.name}</summary>
				{#if opened[`m${g.main.id}`]}<EntityMentions entityId={g.main.id} options={data.canonical} />{/if}
			</details>

			<ul class="cands">
				{#each g.candidates as c (c.id)}
					{@const k = checkOf(g, c)}
					{@const l = live[key(g, c)]}
					<li class="cand">
						<div class="cand-row">
							<label class="tick">
								<input
									type="checkbox"
									checked={ticked(g, c)}
									disabled={stale(g, c)}
									onchange={(e) => setTick(g, c, e.currentTarget.checked)}
								/>
								<span class="cand-name">{c.name}</span>
							</label>
							<span class="meta">{c.count} {c.count === 1 ? 'day' : 'days'}{c.years ? `, ${c.years}` : ''}</span>
						</div>
						<p class="why">Suggested because: {reasonText(c, g.main.name)}.</p>
						{#if c.outside > 0}
							<p class="warn">
								⚠ {c.outside} of {c.count} {c.count === 1 ? 'day is' : 'days are'} well outside {g.main.name}'s years ({g.main.years}).
								It may be someone else on those days: read them, and move those days instead of merging.
							</p>
						{/if}
						{#if k}
							<p class="verdict {k.verdict}">
								Claude: <strong>{k.verdict === 'same' ? 'Same' : k.verdict === 'different' ? 'Different' : 'Not sure'}</strong>
								— {k.reason}
							</p>
						{:else if l === 'busy'}
							<p class="verdict">Claude: being checked in another tab.</p>
						{:else if l === 'changed'}
							<p class="verdict">
								The entries for this name changed since this page loaded. Reload the page to see them; it can't be
								merged from here until then.
							</p>
						{/if}
						<details class="entries" ontoggle={(e) => markOpened(`c${g.main.id}:${c.id}`, e)}>
							<summary>Entries for {c.name}</summary>
							{#if opened[`c${g.main.id}:${c.id}`]}<EntityMentions entityId={c.id} options={data.canonical} />{/if}
						</details>
						<div class="cand-actions">
							<label class="keep">
								<input
									type="radio"
									name="keep-{g.main.id}"
									checked={keepOf(g) === c.id}
									disabled={stale(g, c)}
									onchange={() => chooseKeep(g, c)}
								/>
								Keep this name
							</label>
							<form method="POST" action="/admin/entities/cleanup?/alias" use:enhance={() => result(gi)}>
								<input type="hidden" name="id" value={c.id} />
								<input type="hidden" name="targetId" value={g.main.id} />
								<button type="submit" class="btn small">Alias of {g.main.name}</button>
							</form>
							<form method="POST" action="/admin/entities/cleanup?/notSame" use:enhance={() => result(gi)}>
								<input type="hidden" name="a" value={g.main.id} />
								<input type="hidden" name="b" value={c.id} />
								<button type="submit" class="btn small">Not the same</button>
							</form>
						</div>
					</li>
				{/each}
			</ul>

			<div class="card-actions">
				<label class="keep">
					<input
						type="radio"
						name="keep-{g.main.id}"
						checked={keepOf(g) === g.main.id}
						onchange={() => chooseKeep(g, null)}
					/>
					Keep "{g.main.name}"
				</label>
				<button
					type="button"
					class="btn primary"
					disabled={!g.candidates.some((c) => ticked(g, c))}
					onclick={() => askMerge(g)}>Merge ticked…</button
				>
				<button type="button" class="btn" onclick={() => checkGroup(g)} disabled={mainChecking || unchecked(g).length === 0}>
					{mainChecking ? 'Checking…' : unchecked(g).length === 0 ? 'Checked' : 'Check with Claude'}
				</button>
				<button
					type="button"
					class="btn"
					onclick={async () => {
						skipped = { ...skipped, [g.main.id]: true };
						await refocus(gi);
					}}>Skip for now</button
				>
			</div>
			{#if groupError[g.main.id]}<p class="error" role="alert">{groupError[g.main.id]}</p>{/if}
		</section>
	{/each}

	{#if visible.length > shown}
		<button type="button" class="btn" onclick={() => (shown += 20)}>Show 20 more groups ({visible.length - shown} left)</button>
	{/if}

	<h2>Unused <span class="count">{data.unused.length}</span></h2>
	{#if data.unused.length === 0}
		<p class="empty">None: every name is mentioned, aliased, or has a map decision or a "not the same" mark.</p>
	{:else}
		<p class="hint">Mentioned on no day, with no aliases, moved days, map decision or "not the same" mark.</p>
		<ul class="plain">
			{#each data.unused as u (u.id)}
				<li>
					{u.name}
					<button type="button" class="btn small danger" onclick={() => (deleteAsk = { id: u.id, name: u.name })}>Delete…</button>
				</li>
			{/each}
		</ul>
	{/if}

	<h2>Marked not the same <span class="count">{data.notSame.length}</span></h2>
	{#if data.notSame.length === 0}
		<p class="empty">None yet.</p>
	{:else}
		<ul class="plain">
			{#each data.notSame as p (`${p.a.id}:${p.b.id}`)}
				<li>
					"{p.a.name}" and "{p.b.name}"
					<form method="POST" action="/admin/entities/cleanup?/undoNotSame" use:enhance={() => result()}>
						<input type="hidden" name="a" value={p.a.id} />
						<input type="hidden" name="b" value={p.b.id} />
						<button type="submit" class="btn small">Undo</button>
					</form>
				</li>
			{/each}
		</ul>
	{/if}
</div>

{#if mergeAsk}
	<Modal labelledby="merge-h" onclose={() => (mergeAsk = null)}>
		<div class="modal-overlay">
			<div class="modal-content">
				<h3 id="merge-h">Merge into "{mergeAsk.keepName}"?</h3>
				<p>
					{mergeAsk.names.map((n) => `"${n}"`).join(', ')}
					{mergeAsk.names.length === 1 ? 'becomes' : 'become'} part of "{mergeAsk.keepName}": their days move to it and
					the names are kept as aliases. This can't be undone.
				</p>
				<div class="modal-actions">
					<button type="button" class="btn" onclick={() => (mergeAsk = null)}>Cancel</button>
					<form
						method="POST"
						action="/admin/entities/cleanup?/mergeGroup"
						use:enhance={() => {
							const t = mergeAsk;
							// By id: mergeAsk is $state, so t.g is a proxy, never === a list item.
							return result(t ? visible.findIndex((x) => x.main.id === t.g.main.id) : -1, () => {
								if (mergeAsk === t) mergeAsk = null;
							});
						}}
					>
						<input type="hidden" name="keepId" value={mergeAsk.keepId} />
						{#each mergeAsk.ids as id (id)}<input type="hidden" name="id" value={id} />{/each}
						<input type="hidden" name="mainId" value={mergeAsk.g.main.id} />
						{#each mergeAsk.fps as f (f.id)}<input type="hidden" name="fp:{f.id}" value={f.fp} />{/each}
						<button type="submit" class="btn primary">Merge</button>
					</form>
				</div>
			</div>
		</div>
	</Modal>
{/if}

{#if deleteAsk}
	<Modal labelledby="del-h" onclose={() => (deleteAsk = null)}>
		<div class="modal-overlay">
			<div class="modal-content">
				<h3 id="del-h">Delete "{deleteAsk.name}"?</h3>
				<p>It isn't mentioned anywhere. This can't be undone.</p>
				<div class="modal-actions">
					<button type="button" class="btn" onclick={() => (deleteAsk = null)}>Cancel</button>
					<form
						method="POST"
						action="/admin/entities/cleanup?/deleteUnused"
						use:enhance={() => {
							const t = deleteAsk;
							return result(-1, () => {
								if (deleteAsk === t) deleteAsk = null;
							});
						}}
					>
						<input type="hidden" name="id" value={deleteAsk.id} />
						<button type="submit" class="btn danger">Delete</button>
					</form>
				</div>
			</div>
		</div>
	</Modal>
{/if}

<style>
	.page {
		max-width: 900px;
		margin: 0 auto;
		padding: 1.5rem 1rem 3rem;
	}
	.back {
		font-size: 0.85rem;
		color: #1a4731;
	}
	h1 {
		margin: 0.25rem 0 0.2rem;
		font-size: 1.4rem;
	}
	h2 {
		font-size: 1.05rem;
		margin: 1.5rem 0 0.6rem;
	}
	h2:focus,
	h3:focus {
		outline: 2px solid #1a4731;
		outline-offset: 2px;
	}
	.subtitle,
	.hint {
		color: #4a4a4a;
		font-size: 0.85rem;
		margin: 0.2rem 0;
	}
	.count {
		font-weight: 400;
		color: #3d3d3d;
	}
	.tabs {
		display: flex;
		gap: 0.4rem;
		margin: 1rem 0 0.5rem;
		flex-wrap: wrap;
	}
	.tab {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		padding: 0 1rem;
		border: 1px solid #bbb;
		border-radius: 6px;
		color: #1a4731;
		text-decoration: none;
		font-weight: 600;
	}
	.tab[aria-current='page'] {
		background: #2a5f4c;
		border-color: #2a5f4c;
		color: #fff;
	}
	.status .ok {
		margin: 0.4rem 0;
		color: #1a4731;
		font-weight: 600;
	}
	.toolbar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem 0.8rem;
		margin: 0.6rem 0;
	}
	.btn {
		min-height: 44px;
		padding: 0.3rem 0.9rem;
		border: 1px solid #bbb;
		border-radius: 6px;
		background: #fff;
		color: #1a4731;
		font: inherit;
		font-size: 0.9rem;
		cursor: pointer;
	}
	.btn.small {
		font-size: 0.85rem;
	}
	.btn.primary {
		background: #2a5f4c;
		border-color: #2a5f4c;
		color: #fff;
	}
	.btn.danger {
		background: #b3261e;
		border-color: #b3261e;
		color: #fff;
	}
	.btn:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}
	.btn:focus-visible,
	.tab:focus-visible,
	.link:focus-visible {
		outline: 2px solid #1a4731;
		outline-offset: 2px;
	}
	.link {
		background: none;
		border: none;
		color: inherit;
		text-decoration: underline;
		cursor: pointer;
		min-height: 44px;
		font: inherit;
	}
	.card {
		border: 1px solid #ddd;
		border-radius: 8px;
		background: #fff;
		padding: 0.8rem 1rem;
		margin: 0 0 1rem;
	}
	.card-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.5rem;
		flex-wrap: wrap;
	}
	.card h3 {
		margin: 0;
		font-size: 1.1rem;
	}
	.meta {
		font-weight: 400;
		font-size: 0.85rem;
		color: #3d3d3d;
	}
	.tier {
		font-size: 0.8rem;
		font-weight: 600;
		padding: 0.1rem 0.5rem;
		border-radius: 4px;
		border: 1px solid #999;
		color: #222;
	}
	.tier.likely {
		background: #e3efe8;
		border-color: #2a5f4c;
	}
	.entries {
		margin: 0.4rem 0;
	}
	.entries summary {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		cursor: pointer;
		color: #1a4731;
		font-size: 0.9rem;
	}
	.cands {
		list-style: none;
		margin: 0.4rem 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
	}
	.cand {
		border-top: 1px solid #eee;
		padding-top: 0.6rem;
	}
	.cand-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.3rem 0.8rem;
	}
	.tick {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		min-height: 44px;
		cursor: pointer;
	}
	.tick input,
	.keep input {
		width: 22px;
		height: 22px;
	}
	.cand-name {
		font-weight: 700;
	}
	.why,
	.warn,
	.verdict {
		margin: 0.15rem 0;
		font-size: 0.85rem;
		color: #333;
	}
	.warn {
		color: #6b3d00;
	}
	.verdict.different {
		color: #7a1f1a;
	}
	.cand-actions,
	.card-actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.4rem 0.6rem;
		margin-top: 0.3rem;
	}
	.card-actions {
		border-top: 1px solid #eee;
		padding-top: 0.6rem;
	}
	.keep {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		min-height: 44px;
		font-size: 0.85rem;
		cursor: pointer;
	}
	.plain {
		list-style: none;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}
	.plain li {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		flex-wrap: wrap;
	}
	.empty {
		color: #555;
		font-style: italic;
		font-size: 0.9rem;
	}
	.error,
	.error-banner {
		color: #7a1f1a;
		font-size: 0.9rem;
	}
	.error-banner {
		background: #fdecea;
		border: 1px solid #f5c2c0;
		padding: 0.4rem 0.8rem;
		border-radius: 6px;
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 0.5rem;
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
