<script lang="ts">
	import { page } from '$app/state';
	import SearchBox from '$lib/components/viewer/SearchBox.svelte';
	import { currentFrom, withFrom } from '$lib/viewer/nav';

	const { data } = $props();

	type Key = 'q' | 'tag' | 'person' | 'place' | 'from_year' | 'to_year';

	/** This search with some params changed (null removes one); always back to page 1. */
	function hrefWith(changes: Partial<Record<Key, string | null>>): string {
		const cur: Record<Key, string | null> = {
			q: data.q || null,
			tag: data.tag,
			person: data.person,
			place: data.place,
			from_year: data.fromYear !== null ? String(data.fromYear) : null,
			to_year: data.toYear !== null ? String(data.toYear) : null
		};
		const next = { ...cur, ...changes };
		const params = new URLSearchParams();
		for (const k of ['q', 'person', 'place', 'tag', 'from_year', 'to_year'] as Key[]) {
			const v = next[k];
			if (v) params.set(k, v);
		}
		const qs = params.toString();
		return qs ? `/app/search?${qs}` : '/app/search';
	}

	function pageHref(n: number): string {
		const base = hrefWith({});
		if (n <= 1) return base;
		return `${base}${base.includes('?') ? '&' : '?'}page=${n}`;
	}

	// Picking a suggestion makes it a filter and clears the typed words,
	// which were only the start of its name.
	const filterHref = (kind: 'person' | 'place' | 'tag', slug: string) =>
		hrefWith({ [kind]: slug, q: null });

	const yearLabel = $derived.by(() => {
		const { fromYear: f, toYear: t } = data;
		if (f !== null && t !== null) return f === t ? `${f}` : `${f}–${t}`;
		if (f !== null) return `From ${f}`;
		if (t !== null) return `Up to ${t}`;
		return null;
	});

	interface Chip {
		key: string;
		icon: string;
		kind: string;
		label: string;
		href: string;
	}
	const chips = $derived.by((): Chip[] => {
		const out: Chip[] = [];
		if (data.person)
			out.push({
				key: 'person',
				icon: '👤',
				kind: 'Person',
				label: data.labels.person ?? data.person,
				href: hrefWith({ person: null })
			});
		if (data.place)
			out.push({
				key: 'place',
				icon: '📍',
				kind: 'Place',
				label: data.labels.place ?? data.place,
				href: hrefWith({ place: null })
			});
		if (data.tag)
			out.push({
				key: 'tag',
				icon: '🏷',
				kind: 'Tag',
				label: data.labels.tag ?? data.tag,
				href: hrefWith({ tag: null })
			});
		if (yearLabel)
			out.push({
				key: 'years',
				icon: '📅',
				kind: 'Years',
				label: yearLabel,
				href: hrefWith({ from_year: null, to_year: null })
			});
		return out;
	});
	const clearHref = $derived(
		hrefWith({ person: null, place: null, tag: null, from_year: null, to_year: null })
	);

	const from = $derived(currentFrom(page.url));
	const CHIPS_SHOWN = 4;
	const n = (x: number) => x.toLocaleString('en-US');

	// Leave empty fields out of the address (no bare `q=&to_year=`): disable
	// them while the form data is built, then turn them back on.
	function dropEmpty(e: SubmitEvent) {
		const form = e.currentTarget as HTMLFormElement;
		const off: (HTMLInputElement | HTMLSelectElement)[] = [];
		for (const el of form.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input[name], select[name]')) {
			if (el.value.trim() === '' && !el.disabled) {
				el.disabled = true;
				off.push(el);
			}
		}
		setTimeout(() => off.forEach((el) => (el.disabled = false)));
	}

	function submitOnChange(e: Event) {
		(e.currentTarget as HTMLSelectElement).form?.requestSubmit();
	}
</script>

<svelte:head>
	<title>Search — Vorwaller Family History</title>
</svelte:head>

<div class="v-page wide">
	<div class="layout">
		<div class="controls">
			<h1 class="v-title">Search</h1>
			<form method="GET" action="/app/search" role="search" onsubmit={dropEmpty}>
				<SearchBox value={data.q} {filterHref} />
				{#if data.person}<input type="hidden" name="person" value={data.person} />{/if}
				{#if data.place}<input type="hidden" name="place" value={data.place} />{/if}
				{#if data.tag}<input type="hidden" name="tag" value={data.tag} />{/if}

				<fieldset class="range">
					<legend>Years</legend>
					<select
						name="from_year"
						aria-label="From year"
						value={data.fromYear ?? ''}
						onchange={submitOnChange}
					>
						<option value="">Earliest</option>
						{#each data.years as y (y)}<option value={y}>{y}</option>{/each}
					</select>
					<span aria-hidden="true">to</span>
					<select
						name="to_year"
						aria-label="To year"
						value={data.toYear ?? ''}
						onchange={submitOnChange}
					>
						<option value="">Latest</option>
						{#each data.years as y (y)}<option value={y}>{y}</option>{/each}
					</select>
				</fieldset>
				<button type="submit" class="v-btn primary go">Search</button>
			</form>

			{#if chips.length > 0}
				<ul class="v-chips" aria-label="Active filters">
					{#each chips as c (c.key)}
						<li>
							<a class="v-chip removable" href={c.href} aria-label="Remove filter: {c.kind}, {c.label}">
								<span class="v-chip-kind" aria-hidden="true">{c.icon}</span>
								<span class="v-chip-label">{c.label}</span>
								<span class="x" aria-hidden="true">✕</span>
							</a>
						</li>
					{/each}
				</ul>
			{/if}
		</div>

		<section class="results-col" aria-labelledby="results-h">
			{#if !data.searched}
				<h2 id="results-h" class="v-sr">Results</h2>
				<div class="hint">
					<p>
						Search sixty years of Madonna's calendars. Start typing a name, a place or a word, and
						pick from the suggestions, or press Search to look for the words themselves.
					</p>
					<p>
						Or browse <a href="/app/people">people</a>, <a href="/app/places">places</a> or the
						<a href="/app/timeline">timeline</a>.
					</p>
				</div>
			{:else}
				<div class="v-section-h head">
					<h2 id="results-h">
						{n(data.total)}
						{data.total === 1 ? 'day' : 'days'}
					</h2>
					{#if chips.length > 0}<a href={clearHref}>Clear filters</a>{/if}
				</div>
				{#if data.q && data.total > 1}
					<p class="order">Best match first</p>
				{:else if !data.q && data.total > 1}
					<p class="order">Newest first</p>
				{/if}

				{#if data.results.length === 0}
					<div class="v-empty">
						<div class="icon" aria-hidden="true">🔎</div>
						<h2>Nothing found</h2>
						<p>
							{#if data.q}No transcribed days match “{data.q}”{chips.length > 0
									? ' with these filters'
									: ''}.{:else}No transcribed days match these filters yet.{/if}
							{#if chips.length > 0}Try removing a filter.{:else}Try another word or a name.{/if}
						</p>
					</div>
				{:else}
					<ul class="results">
						{#each data.results as r (r.entryDate)}
							<li class="v-card result">
								<a class="hit" href={withFrom(`/app/day/${r.entryDate}`, from)}>
									<span class="top">
										<span class="date">{r.dateLabel}</span>
										{#if r.hasMemory}<span class="v-mem-flag">🗨 Madonna remembers</span>{/if}
									</span>
									<span class="snip">
										{#each r.segments as seg, i (i)}
											{#if seg.highlight}<mark>{seg.text}</mark>{:else}{seg.text}{/if}
										{/each}
									</span>
								</a>
								{#if r.chips.length > 0}
									<ul class="v-chips small" aria-label="People and places">
										{#each r.chips.slice(0, CHIPS_SHOWN) as c (c.entityType + c.slug)}
											<li>
												<a class="v-chip" href={withFrom(`/app/${c.entityType}/${c.slug}`, from)}>
													<span class="v-chip-kind" aria-hidden="true"
														>{c.entityType === 'person' ? '👤' : '📍'}</span
													>
													<span class="v-sr">{c.entityType === 'person' ? 'Person:' : 'Place:'}</span>
													<span class="v-chip-label">{c.name}</span>
												</a>
											</li>
										{/each}
										{#if r.chips.length > CHIPS_SHOWN}
											<li class="more">+{r.chips.length - CHIPS_SHOWN} more</li>
										{/if}
									</ul>
								{/if}
							</li>
						{/each}
					</ul>

					{#if data.totalPages > 1}
						<nav class="pager" aria-label="Result pages">
							{#if data.page > 1}
								<a class="v-btn secondary" href={pageHref(data.page - 1)}>◂ Previous</a>
							{:else}
								<span class="v-btn secondary off" aria-hidden="true">◂ Previous</span>
							{/if}
							<span class="status">Page {data.page} of {data.totalPages}</span>
							{#if data.page < data.totalPages}
								<a class="v-btn secondary" href={pageHref(data.page + 1)}>Next ▸</a>
							{:else}
								<span class="v-btn secondary off" aria-hidden="true">Next ▸</span>
							{/if}
						</nav>
					{/if}
				{/if}
			{/if}
		</section>
	</div>
</div>

<style>
	.layout {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 8px 36px;
	}
	@media (min-width: 1024px) {
		.layout {
			grid-template-columns: minmax(0, 360px) minmax(0, 1fr);
			align-items: start;
		}
		.controls {
			position: sticky;
			top: calc(var(--topbar-h) + 16px);
		}
		.results-col .head {
			margin-top: 8px;
		}
	}
	form {
		display: grid;
		gap: 12px;
		margin-top: 10px;
	}
	.range {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		margin: 0;
		padding: 0;
		border: 0;
	}
	.range legend {
		float: left;
		margin-right: 6px;
		padding: 0;
		font-size: 16px;
		font-weight: 700;
	}
	.range select {
		min-height: 48px;
		padding: 0 10px;
		border: 1px solid var(--color-ink-muted);
		border-radius: 10px;
		background: var(--color-paper);
		color: var(--color-ink);
	}
	.range span {
		color: var(--color-ink-muted);
	}
	.go {
		justify-self: start;
	}
	.removable {
		background: var(--color-evergreen-soft);
		color: var(--color-evergreen-dark);
	}
	.removable .x {
		flex: none;
		font-size: 14px;
	}

	.hint {
		margin-top: 18px;
		font-family: var(--font-serif);
		font-size: 19px;
		line-height: 1.6;
		color: var(--color-ink-muted);
	}
	.hint p {
		margin: 0 0 12px;
	}
	.hint a {
		color: var(--color-evergreen);
		font-weight: 700;
	}
	.order {
		margin: -4px 0 10px;
		font-size: 15px;
		color: var(--color-ink-muted);
	}
	.results {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 12px;
	}
	.results .result {
		padding: 0;
		overflow: hidden;
	}
	.hit {
		display: block;
		padding: 14px 16px 12px;
		color: inherit;
		text-decoration: none;
	}
	.hit:hover .date {
		text-decoration: underline;
	}
	.top {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px 12px;
		margin-bottom: 4px;
	}
	.date {
		font-weight: 700;
		color: var(--color-evergreen-dark);
	}
	.snip {
		display: block;
		font-family: var(--font-serif);
		font-size: 18px;
		line-height: 1.55;
		overflow-wrap: anywhere;
	}
	.snip mark {
		background: var(--color-highlight-bg);
		color: var(--color-ink);
		border-radius: 2px;
		padding: 0 2px;
	}
	.v-chips.small {
		margin: 0;
		padding: 0 16px 12px;
	}
	.more {
		align-self: center;
		font-size: 15px;
		color: var(--color-ink-muted);
	}
	.pager {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		margin-top: 18px;
	}
	.pager .off {
		visibility: hidden;
	}
	.pager .status {
		font-size: 15px;
		color: var(--color-ink-muted);
	}
</style>
