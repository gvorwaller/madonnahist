<script lang="ts">
	/**
	 * People / Places index (V3 Slice 1). One accepted-only list from the
	 * server (getEntityDirectory); filtering happens here as you type, with
	 * no Search button. Long names truncate inside their row, never the page.
	 */
	import { withFrom } from '$lib/viewer/nav';
	import type { DirectoryEntry } from '$lib/server/entities';

	const { kind, entries }: { kind: 'person' | 'place'; entries: DirectoryEntry[] } = $props();

	const listPath = $derived(kind === 'person' ? '/app/people' : '/app/places');
	const noun = $derived(kind === 'person' ? 'person' : 'place');

	let filter = $state('');

	// Case- and accent-insensitive match ("jose" finds "José").
	const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

	const filtered = $derived.by(() => {
		const f = fold(filter.trim());
		return f ? entries.filter((e) => fold(e.name).includes(f)) : entries;
	});

	const top = $derived([...entries].sort((a, b) => b.days - a.days).slice(0, 8));

	const groups = $derived.by(() => {
		const out: { letter: string; items: DirectoryEntry[] }[] = [];
		for (const e of filtered) {
			const first = fold(e.name).charAt(0).toUpperCase();
			const letter = /[A-Z]/.test(first) ? first : '#';
			const last = out[out.length - 1];
			if (last && last.letter === letter) last.items.push(e);
			else out.push({ letter, items: [e] });
		}
		return out;
	});

	const years = (e: DirectoryEntry) =>
		e.firstYear === e.lastYear ? `${e.firstYear}` : `${e.firstYear}–${e.lastYear}`;
	const href = (e: DirectoryEntry) => withFrom(`/app/${kind}/${e.slug}`, listPath);
	const n = (x: number) => x.toLocaleString('en-US');
</script>

<div class="v-page wide">
	<nav class="v-segmented" aria-label="People or places">
		<a href="/app/people" aria-current={kind === 'person' ? 'page' : undefined}>People</a>
		<a href="/app/places" aria-current={kind === 'place' ? 'page' : undefined}>Places</a>
	</nav>
	<h1 class="v-sr">{kind === 'person' ? 'People' : 'Places'}</h1>

	<label class="v-searchbox">
		<span aria-hidden="true">🔍</span>
		<input
			type="search"
			bind:value={filter}
			placeholder="Find a {noun}…"
			aria-label="Find a {noun}"
			autocomplete="off"
			autocapitalize="off"
			spellcheck="false"
		/>
	</label>

	{#if entries.length === 0}
		<div class="v-empty" style="margin-top: 16px">
			<h2>No {kind === 'person' ? 'people' : 'places'} yet</h2>
			<p>Names appear here as the calendars are transcribed.</p>
		</div>
	{:else}
		<div class="index-grid">
			{#if !filter.trim()}
				<section aria-labelledby="top-h">
					<div class="v-section-h"><h2 id="top-h">Most mentioned</h2></div>
					<ul class="top">
						{#each top as e (e.slug)}
							<li>
								<a class="top-card" href={href(e)}>
									<span class="avatar" aria-hidden="true">{e.name.charAt(0).toUpperCase()}</span>
									<b>{e.name}</b>
									<span>{n(e.days)} {e.days === 1 ? 'day' : 'days'}</span>
								</a>
							</li>
						{/each}
					</ul>
				</section>
			{/if}

			<section aria-labelledby="az-h">
				<div class="v-section-h">
					<h2 id="az-h">
						{filter.trim() ? 'Matches' : kind === 'person' ? 'Everyone, A–Z' : 'Every place, A–Z'}
						<span class="v-count">{n(filtered.length)}</span>
					</h2>
				</div>
				{#if filtered.length === 0}
					<p class="v-muted">No {noun} matches “{filter.trim()}”.</p>
				{:else}
					<ul class="az">
						{#each groups as g (g.letter)}
							<li class="letter" aria-hidden="true">{g.letter}</li>
							{#each g.items as e (e.slug)}
								<li>
									<a href={href(e)}>
										<span class="nm">{e.name}</span>
										<span class="yrs">{years(e)}</span>
										<span class="v-count" aria-label="{e.days} days">{n(e.days)}</span>
									</a>
								</li>
							{/each}
						{/each}
					</ul>
				{/if}
			</section>
		</div>
	{/if}
</div>

<style>
	.index-grid {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 0 28px;
	}
	@media (min-width: 1024px) {
		.index-grid {
			grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr);
			align-items: start;
		}
	}
	.top {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 10px;
	}
	@media (min-width: 640px) {
		.top {
			grid-template-columns: repeat(4, minmax(0, 1fr));
		}
	}
	@media (min-width: 1024px) {
		.top {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}
	.top-card {
		display: block;
		min-height: 96px;
		padding: 12px;
		background: var(--color-paper);
		border: 1px solid var(--color-border);
		border-radius: var(--radius);
		text-decoration: none;
		color: var(--color-ink);
	}
	.top-card:hover {
		border-color: var(--color-ink-muted);
	}
	.top-card .avatar {
		width: 40px;
		height: 40px;
		border-radius: 50%;
		display: grid;
		place-items: center;
		margin-bottom: 6px;
		background: var(--color-evergreen-soft);
		color: var(--color-evergreen-dark);
		font-weight: 700;
	}
	.top-card b {
		display: block;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.top-card span:last-child {
		font-size: 15px;
		color: var(--color-ink-muted);
	}
	.az {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.az .letter {
		position: sticky;
		top: var(--topbar-h);
		z-index: 1;
		padding: 6px 2px;
		background: var(--color-cream);
		border-bottom: 1px solid var(--color-border);
		font-weight: 700;
		color: var(--color-evergreen-dark);
	}
	.az a {
		display: flex;
		align-items: center;
		gap: 10px;
		min-height: 52px;
		padding: 0 4px;
		border-bottom: 1px solid var(--color-border);
		text-decoration: none;
		color: var(--color-ink);
	}
	.az a:hover .nm {
		text-decoration: underline;
	}
	.az .nm {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-weight: 600;
	}
	.az .yrs {
		font-size: 15px;
		color: var(--color-ink-muted);
		white-space: nowrap;
	}
</style>
