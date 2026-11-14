<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidate } from '$app/navigation';
	import { googleMapsLink } from '$lib/viewer/maplinks';
	import type { SubmitFunction } from '@sveltejs/kit';

	const { data, form } = $props();

	type Row = (typeof data.rows)[number];
	type Tab = 'review' | 'auto' | 'confirmed' | 'several' | 'nomap' | 'new';

	const TABS: { id: Tab; label: string; test: (r: Row) => boolean }[] = [
		{ id: 'review', label: 'Needs a look', test: (r) => r.status === 'needs_review' },
		{ id: 'auto', label: 'Shown automatically', test: (r) => r.status === 'auto' },
		{ id: 'confirmed', label: 'Confirmed', test: (r) => r.status === 'confirmed' },
		{ id: 'several', label: 'Several matches', test: (r) => r.status === 'no_location' && r.reason === 'several' },
		{ id: 'nomap', label: 'No map', test: (r) => r.status === 'no_location' && r.reason !== 'several' },
		{ id: 'new', label: 'Not looked up yet', test: (r) => r.status === null }
	];

	let tab = $state<Tab>('review');
	let filter = $state('');
	let busy = $state(false);
	let message = $state('');
	let failure = $state('');

	const counts = $derived(Object.fromEntries(TABS.map((t) => [t.id, data.rows.filter(t.test).length])));
	const shown = $derived.by(() => {
		const t = TABS.find((x) => x.id === tab)!;
		const f = filter.trim().toLowerCase();
		return data.rows.filter((r) => t.test(r) && (!f || r.name.toLowerCase().includes(f)));
	});

	const REASON: Record<string, string> = {
		general: 'A general word or someone’s name, so it was never looked up',
		several: 'Several places share this name (a chain or a common name)',
		not_found: 'Nothing close was found',
		admin: 'You chose no map'
	};
	const regionLabel = (r: Row) => (r.region === 'utah' ? 'Utah years' : r.region === 'florida' ? 'Florida years' : '');
	const pct = (n: number | null) => (n === null ? '' : `${Math.round(n * 100)}% name match`);

	// While a lookup runs, refresh the counts every two seconds.
	$effect(() => {
		if (!data.run.running) return;
		const id = setInterval(() => invalidate('admin:places'), 2000);
		return () => clearInterval(id);
	});

	const submit: SubmitFunction = () => {
		busy = true;
		message = '';
		failure = '';
		return async ({ result, update }) => {
			busy = false;
			if (result.type === 'success') message = String(result.data?.message ?? 'Done');
			else if (result.type === 'failure') failure = String(result.data?.error ?? 'That didn’t work.');
			else if (result.type === 'error') failure = 'Something went wrong. Try again.';
			await update({ reset: false });
		};
	};
</script>

<svelte:head>
	<title>Place maps — Admin</title>
</svelte:head>

<div class="page">
	<header>
		<a href="/admin" class="back">← Admin</a>
		<h1>Place maps</h1>
		<p class="subtitle">
			Each place is looked up on Google. Lookups favour Utah for Aug 1976 – May 1979 and May 1984 –
			May 1986, and Florida otherwise. Confident matches get Map and Directions links on the place
			page right away. You only need to check <b>Needs a look</b>, and anything that looks wrong.
		</p>
	</header>

	<section class="runbox" aria-label="Lookups">
		{#if !data.configured}
			<p class="warn">No Google key is configured, so lookups can't run.</p>
		{:else if data.run.running}
			<p class="running" role="status">
				Looking up places… {data.run.done} of {data.run.total} done{data.run.failed
					? `, ${data.run.failed} failed`
					: ''}.
			</p>
		{:else}
			<form method="POST" action="/admin/places?/run" use:enhance={submit}>
				<button type="submit" class="btn primary" disabled={busy || data.pending === 0}>
					{data.pending === 0 ? 'Nothing new to look up' : `Look up ${data.pending} new ${data.pending === 1 ? 'place' : 'places'}`}
				</button>
			</form>
			<p class="note">New places are also looked up automatically every hour.</p>
			{#if data.run.finishedAt && data.run.total > 0}
				<p class="note">
					Last run: {data.run.done} looked up{data.run.failed ? `, ${data.run.failed} failed (${data.run.lastError})` : ''}.
				</p>
			{/if}
		{/if}
	</section>

	<p class="status-line" role="status">{message}</p>
	{#if failure}<p class="error-line" role="alert">{failure}</p>{/if}
	{#if form?.error && !failure}<p class="error-line" role="alert">{form.error}</p>{/if}

	<div class="tabs" role="group" aria-label="Show">
		{#each TABS as t (t.id)}
			<button type="button" class="tab" class:active={tab === t.id} aria-pressed={tab === t.id} onclick={() => (tab = t.id)}>
				{t.label} <span class="tab-count">{counts[t.id]}</span>
			</button>
		{/each}
	</div>
	<label class="filter">
		<span class="sr">Filter places</span>
		<input type="search" placeholder="Filter by name" bind:value={filter} />
	</label>

	{#if shown.length === 0}
		<p class="empty">{tab === 'review' ? 'Nothing needs a look right now.' : 'No places here.'}</p>
	{:else}
		<ul class="list">
			{#each shown as r (r.entityId)}
				<li class="card">
					<div class="head">
						<h2><a href="/app/place/{r.slug}" target="_blank" rel="noopener">{r.name}</a></h2>
						<span class="meta"
							>{r.days} {r.days === 1 ? 'day' : 'days'} · {r.firstYear === r.lastYear
								? r.firstYear
								: `${r.firstYear}–${r.lastYear}`}{regionLabel(r) ? ` · ${regionLabel(r)}` : ''}</span
						>
					</div>
					{#if r.renamed}<p class="note">Renamed since it was looked up.</p>{/if}

					{#if (r.status === 'auto' || r.status === 'confirmed') && r.lat !== null && r.lon !== null}
						<p class="match">
							<b>{r.status === 'auto' ? 'Shown automatically' : 'Confirmed'}:</b>
							{r.matchedName}{r.address ? `, ${r.address}` : ''}
							<a
								href={googleMapsLink({ name: r.matchedName ?? r.name, lat: r.lat, lon: r.lon, placeId: r.placeId })}
								target="_blank"
								rel="noopener">Check on Google Maps ↗</a
							>
						</p>
						{#if r.decidedBy}<p class="note">By {r.decidedBy}.</p>{/if}
					{:else if r.status === 'no_location'}
						<p class="match"><b>No map:</b> {REASON[r.reason ?? ''] ?? ''}</p>
					{:else if r.status === 'needs_review'}
						<p class="match">
							<b>Not sure.</b>
							{r.query && r.query !== r.name ? `Searched for “${r.query}”.` : ''} Pick the right one, search
							again, or choose no map.
						</p>
					{/if}

					{#if r.status !== 'auto' && r.status !== 'confirmed' && r.candidates.length > 0}
						<ol class="cands">
							{#each r.candidates as c, i (i)}
								<li>
									<span class="cname"><b>{c.name}</b>{c.address ? `, ${c.address}` : ''}</span>
									<span class="cmeta">{pct(c.score)}</span>
									<a href={googleMapsLink({ name: c.name, lat: c.lat, lon: c.lon, placeId: c.placeId })} target="_blank" rel="noopener"
										>Check ↗</a
									>
									<form method="POST" action="/admin/places?/choose" use:enhance={submit}>
										<input type="hidden" name="entity_id" value={r.entityId} />
										<input type="hidden" name="index" value={i} />
										<button type="submit" class="btn small" disabled={busy}>Use this</button>
									</form>
								</li>
							{/each}
						</ol>
					{/if}

					<div class="actions">
						{#if r.status === 'auto'}
							<form method="POST" action="/admin/places?/confirm" use:enhance={submit}>
								<input type="hidden" name="entity_id" value={r.entityId} />
								<button type="submit" class="btn" disabled={busy}>Looks right</button>
							</form>
						{/if}
						{#if r.status === 'auto' || r.status === 'confirmed'}
							<form method="POST" action="/admin/places?/wrong" use:enhance={submit}>
								<input type="hidden" name="entity_id" value={r.entityId} />
								<button type="submit" class="btn" disabled={busy}>Wrong place</button>
							</form>
						{/if}
						{#if !(r.status === 'no_location' && r.reason === 'admin')}
							<form method="POST" action="/admin/places?/nomap" use:enhance={submit}>
								<input type="hidden" name="entity_id" value={r.entityId} />
								<button type="submit" class="btn" disabled={busy}>No map for this place</button>
							</form>
						{/if}
						{#if r.status !== null}
							<form method="POST" action="/admin/places?/again" use:enhance={submit}>
								<input type="hidden" name="entity_id" value={r.entityId} />
								<button type="submit" class="btn" disabled={busy}>Undo: look up again</button>
							</form>
						{/if}
					</div>

					<form class="again" method="POST" action="/admin/places?/search" use:enhance={submit}>
						<input type="hidden" name="entity_id" value={r.entityId} />
						<label>
							<span class="sr">Search again for {r.name}</span>
							<input
								type="search"
								name="q"
								maxlength="200"
								placeholder="Search again, e.g. “{r.name}, {r.region === 'utah' ? 'Salt Lake City UT' : 'Jacksonville FL'}”"
							/>
						</label>
						<button type="submit" class="btn" disabled={busy}>Search</button>
					</form>
				</li>
			{/each}
		</ul>
	{/if}
</div>

<style>
	.page {
		max-width: 1000px;
		margin: 0 auto;
		padding: 1.5rem 1rem 5rem;
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
	.subtitle {
		margin: 0 0 1rem;
		color: #4a4a4a;
		font-size: 0.9rem;
		max-width: 75ch;
		line-height: 1.5;
	}
	.runbox {
		padding: 0.9rem 1rem;
		border: 1px solid #ddd;
		border-radius: 8px;
		background: #fff;
		margin-bottom: 0.75rem;
	}
	.runbox form {
		margin: 0;
	}
	.warn {
		margin: 0;
		color: #7a1f1f;
		font-weight: 600;
	}
	.running {
		margin: 0;
		font-weight: 600;
		color: #1a4731;
	}
	.note {
		margin: 0.35rem 0 0;
		font-size: 0.85rem;
		color: #4a4a4a;
	}
	.status-line {
		min-height: 1.3em;
		margin: 0 0 0.25rem;
		color: #1a4731;
		font-size: 0.9rem;
		font-weight: 600;
	}
	.error-line {
		margin: 0 0 0.5rem;
		color: #7a1f1f;
		font-weight: 600;
	}
	.tabs {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
		margin-bottom: 0.6rem;
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
		font-weight: 700;
		margin-left: 0.2rem;
	}
	.filter input {
		min-height: 44px;
		width: min(100%, 22rem);
		padding: 0 0.7rem;
		border: 1px solid #888;
		border-radius: 6px;
		font-size: 1rem;
		margin-bottom: 0.75rem;
	}
	.sr {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
	}
	.empty {
		color: #4a4a4a;
	}
	.list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.75rem;
	}
	.card {
		padding: 0.85rem 1rem;
		border: 1px solid #ddd;
		border-radius: 8px;
		background: #fff;
	}
	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.25rem 0.75rem;
	}
	.head h2 {
		margin: 0;
		font-size: 1.05rem;
	}
	.head h2 a {
		color: #1a4731;
	}
	.meta {
		font-size: 0.85rem;
		color: #4a4a4a;
	}
	.match {
		margin: 0.4rem 0 0;
		font-size: 0.92rem;
		line-height: 1.5;
	}
	.match a,
	.cands a {
		color: #1a4731;
		font-weight: 600;
		white-space: nowrap;
	}
	.cands {
		margin: 0.5rem 0 0;
		padding-left: 1.4rem;
		display: grid;
		gap: 0.35rem;
	}
	.cands li {
		font-size: 0.9rem;
	}
	.cands li > * {
		margin-right: 0.6rem;
	}
	.cands form {
		display: inline;
	}
	.cmeta {
		color: #4a4a4a;
		font-size: 0.85rem;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		margin-top: 0.6rem;
	}
	.actions form {
		margin: 0;
	}
	.btn {
		min-height: 44px;
		padding: 0 0.9rem;
		border: 1px solid #888;
		border-radius: 6px;
		background: #fff;
		color: #222;
		font: inherit;
		font-size: 0.88rem;
		cursor: pointer;
	}
	.btn:hover:not(:disabled) {
		border-color: #333;
	}
	.btn.primary {
		background: #2a5f4c;
		border-color: #2a5f4c;
		color: #fff;
		font-weight: 700;
	}
	.btn.small {
		min-height: 44px;
		padding: 0 0.7rem;
	}
	.btn:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}
	.again {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		margin-top: 0.5rem;
	}
	.again label {
		flex: 1 1 16rem;
	}
	.again input {
		width: 100%;
		min-height: 44px;
		padding: 0 0.6rem;
		border: 1px solid #888;
		border-radius: 6px;
		font-size: 1rem;
	}
</style>
