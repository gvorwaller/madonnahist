<script lang="ts">
	/**
	 * Person / place profile (V3 Slice 1): stat strip, mentions by year,
	 * earliest and most recent, and every day grouped by year with a
	 * snippet. Slice 4 adds co-mentions: "Often mentioned with" and
	 * "Places linked to …" on a person, "Who was here" on a place. Back returns to wherever the reader came from (?from=).
	 * Accepted-only data comes from loadEntityProfile().
	 */
	import { page } from '$app/state';
	import type { EntityProfile, EntityDay, RelatedEntity } from '$lib/server/entities';
	import { backLabel, backTarget, withFrom } from '$lib/viewer/nav';
	import { appleMapsLink, googleDirectionsLink, googleMapsLink } from '$lib/viewer/maplinks';

	const { profile, kind }: { profile: EntityProfile | null; kind: 'person' | 'place' } = $props();

	const PER_YEAR = 12;

	const listPath = $derived(kind === 'person' ? '/app/people' : '/app/places');
	const backHref = $derived(backTarget(page.url.searchParams.get('from'), listPath));
	const backText = $derived(backLabel(backHref));
	// Day links come back to this profile (path only, so from= never nests).
	const here = $derived(page.url.pathname);

	const earliest = $derived(profile && profile.days.length > 0 ? profile.days[0] : null);
	const latest = $derived(
		profile && profile.days.length > 1 ? profile.days[profile.days.length - 1] : null
	);

	// Days grouped by year, newest year first.
	const byYear = $derived.by(() => {
		const map = new Map<number, EntityDay[]>();
		for (const d of profile?.days ?? []) {
			const y = Number(d.entryDate.slice(0, 4));
			const list = map.get(y);
			if (list) list.push(d);
			else map.set(y, [d]);
		}
		return [...map.entries()].sort((a, b) => b[0] - a[0]).map(([year, days]) => ({ year, days }));
	});
	const maxCount = $derived(Math.max(1, ...(profile?.yearCounts ?? []).map((y) => y.count)));

	// Folds render their rows only while open, so a person with 1,000+ days
	// doesn't put every row in the page at once. The newest year starts open.
	let openYears = $state<Record<number, boolean>>({});
	let showAll = $state<Record<number, boolean>>({});
	const isOpen = (year: number, i: number) => openYears[year] ?? i === 0;

	const dayHref = (d: EntityDay) => withFrom(`/app/day/${d.entryDate}`, here);
	const shortDay = (d: EntityDay) =>
		new Date(d.entryDate + 'T00:00:00Z').toLocaleDateString('en-US', {
			month: 'short',
			timeZone: 'UTC'
		});
	const n = (x: number) => x.toLocaleString('en-US');
	const searchParam = $derived(kind === 'person' ? 'person' : 'place');
	// Map links (td-085e19): the matched name helps Apple/Google label the pin.
	const mapPlace = $derived(
		profile?.location
			? {
					name: profile.location.name || profile.displayName,
					lat: profile.location.lat,
					lon: profile.location.lon,
					placeId: profile.location.placeId
				}
			: null
	);
	const relHref = (r: RelatedEntity) => withFrom(`/app/${r.entityType}/${r.slug}`, here);
	// Slice 4: a person shows who they're often mentioned with and the places
	// linked to them; a place shows who was there (plan: AGY2 #7).
	const relatedSections = $derived.by(() => {
		if (!profile) return [];
		const out: { id: string; title: string; items: RelatedEntity[]; together: boolean }[] = [];
		if (kind === 'person') {
			out.push({ id: 'with-h', title: 'Often mentioned with', items: profile.related.people, together: true });
			out.push({
				id: 'places-h',
				title: `Places linked to ${profile.displayName}`,
				items: profile.related.places,
				together: false
			});
		} else {
			out.push({ id: 'who-h', title: 'Who was here', items: profile.related.people, together: false });
		}
		return out.filter((s) => s.items.length > 0);
	});
</script>

<div class="v-page wide">
	<a class="v-back" href={backHref}>◂ {backText}</a>

	{#if !profile}
		<div class="v-empty">
			<h1 class="v-title">Not found</h1>
			<p>There's no one or nowhere by that name in the archive yet.</p>
			<a class="v-btn primary" href={listPath}>{kind === 'person' ? 'All people' : 'All places'}</a>
		</div>
	{:else}
		<p class="v-eyebrow">{kind === 'person' ? 'Person' : 'Place'}</p>
		<h1 class="v-title">{profile.displayName}</h1>

		{#if profile.mentionCount === 0}
			<p class="v-sub">No transcribed days mention {profile.displayName} yet.</p>
		{:else}
			<div class="v-stats">
				<div>
					<b>{n(profile.mentionCount)}</b><span>{profile.mentionCount === 1 ? 'day' : 'days'}</span>
				</div>
				<div><b>{profile.firstYear}</b><span>first</span></div>
				<div><b>{profile.lastYear}</b><span>latest</span></div>
			</div>
			<div class="v-actions">
				<a class="v-btn primary" href="/app/search?{searchParam}={profile.slug}">
					🔍 Search {kind === 'person' ? 'their' : 'its'} days
				</a>
				{#if kind === 'person'}
					<button type="button" class="v-btn" disabled aria-describedby="pdf-later">
						🖨 Printable history
					</button>
					<span id="pdf-later" class="later">Coming later</span>
				{/if}
			</div>
			{#if mapPlace}
				<div class="maps" role="group" aria-label="Open {profile.displayName} in a map app">
					{#if profile.location?.address}<p class="addr">📍 {profile.location.address}</p>{/if}
					<div class="map-links">
						<a class="v-btn secondary" href={googleMapsLink(mapPlace)} target="_blank" rel="noopener"
							>🗺 Map<span class="v-sr"> (Google Maps, opens a new tab)</span></a
						>
						<a class="v-btn secondary" href={appleMapsLink(mapPlace)} target="_blank" rel="noopener"
							>Apple Maps<span class="v-sr"> (opens a new tab)</span></a
						>
						<a class="v-btn secondary" href={googleDirectionsLink(mapPlace)} target="_blank" rel="noopener"
							>↗ Directions<span class="v-sr"> (Google Maps, opens a new tab)</span></a
						>
					</div>
				</div>
			{/if}

			<div class="profile-grid">
				<div>
					<div class="v-section-h">
						<h2>{kind === 'person' ? 'Mentions' : 'Visits'} by year</h2>
					</div>
					<ul class="v-card bars">
						{#each profile.yearCounts as yc (yc.year)}
							<li>
								<span class="yy">{yc.year}</span>
								<span class="track" aria-hidden="true"
									><span class="fill" style="width: {Math.max(2, (yc.count / maxCount) * 100)}%"
									></span></span
								>
								<span class="num">{yc.count}<span class="v-sr"> days</span></span>
							</li>
						{/each}
					</ul>

					{#each relatedSections as sec (sec.id)}
						<section aria-labelledby={sec.id}>
							<div class="v-section-h"><h2 id={sec.id}>{sec.title}</h2></div>
							<ul class="v-card with">
								{#each sec.items as r, i (r.entityType + r.slug)}
									<li>
										<a href={relHref(r)}>
											<span class="who"
												><span aria-hidden="true">{r.entityType === 'person' ? '👤' : '📍'}</span>
												{r.name}</span
											>
											<span class="cnt"
												>{n(r.days)}{i === 0 && sec.together
													? ` ${r.days === 1 ? 'day' : 'days'} together`
													: ` ${r.days === 1 ? 'day' : 'days'}`}</span
											>
										</a>
									</li>
								{/each}
							</ul>
						</section>
					{/each}

					<div class="v-section-h"><h2>First and latest</h2></div>
					{#if earliest}
						<a class="v-card hl" href={dayHref(earliest)}>
							<span class="v-eyebrow">Earliest</span>
							<span class="date">{earliest.dateLabel}</span>
							<span class="snip">{earliest.snippet}</span>
						</a>
					{/if}
					{#if latest}
						<a class="v-card hl" href={dayHref(latest)}>
							<span class="v-eyebrow">Most recent</span>
							<span class="date">{latest.dateLabel}</span>
							<span class="snip">{latest.snippet}</span>
						</a>
					{/if}
				</div>

				<div>
					<div class="v-section-h">
						<h2>
							{kind === 'person' ? 'Their days' : 'Days here'}
							<span class="v-count">{n(profile.mentionCount)}</span>
						</h2>
					</div>
					{#each byYear as g, i (g.year)}
						<details
							class="v-fold"
							open={isOpen(g.year, i)}
							ontoggle={(e) =>
								(openYears = {
									...openYears,
									[g.year]: (e.currentTarget as HTMLDetailsElement).open
								})}
						>
							<summary>{g.year} <span class="v-count">{g.days.length}</span></summary>
							{#if isOpen(g.year, i)}
								<div class="v-fold-body">
									<ul class="rows">
										{#each showAll[g.year] ? g.days : g.days.slice(0, PER_YEAR) as d (d.entryDate)}
											<li>
												<a href={dayHref(d)}>
													<span class="d"
														>{Number(d.entryDate.slice(8, 10))}<small>{shortDay(d)}</small></span
													>
													<span class="snip">{d.snippet || d.dateLabel}</span>
												</a>
											</li>
										{/each}
									</ul>
									{#if g.days.length > PER_YEAR && !showAll[g.year]}
										<button
											type="button"
											class="show-all"
											onclick={() => (showAll = { ...showAll, [g.year]: true })}
										>
											Show all {g.days.length} days in {g.year} ▾
										</button>
									{/if}
								</div>
							{/if}
						</details>
					{/each}
				</div>
			</div>
		{/if}
	{/if}
</div>

<style>
	.maps {
		margin: 14px 0 0;
	}
	.addr {
		margin: 0 0 6px;
		font-size: 16px;
		color: var(--color-ink-muted);
		overflow-wrap: anywhere;
	}
	.map-links {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
	.later {
		align-self: center;
		font-size: 15px;
		color: var(--color-ink-muted);
	}
	.profile-grid {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 0 28px;
	}
	@media (min-width: 1024px) {
		.profile-grid {
			grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr);
			align-items: start;
		}
	}
	.bars {
		list-style: none;
		margin: 0;
		display: grid;
		gap: 4px;
	}
	.bars li {
		display: grid;
		grid-template-columns: 48px minmax(0, 1fr) 40px;
		gap: 8px;
		align-items: center;
		font-size: 15px;
	}
	.bars .yy {
		color: var(--color-ink-muted);
		font-weight: 600;
	}
	.bars .track {
		height: 14px;
		background: var(--color-chip-bg);
		border-radius: 4px;
		overflow: hidden;
	}
	.bars .fill {
		display: block;
		height: 100%;
		background: var(--color-evergreen);
	}
	.bars .num {
		text-align: right;
		font-weight: 700;
	}
	ul.with {
		list-style: none;
		margin: 0;
		padding: 2px 16px;
	}
	.with li + li {
		border-top: 1px solid var(--color-border);
	}
	.with a {
		display: flex;
		align-items: center;
		gap: 10px;
		min-height: 48px;
		color: inherit;
		text-decoration: none;
	}
	.with a:hover .who {
		text-decoration: underline;
	}
	.with .who {
		flex: 1;
		min-width: 0;
		font-weight: 700;
		color: var(--color-evergreen-dark);
		overflow-wrap: anywhere;
	}
	.with .cnt {
		flex: none;
		font-size: 15px;
		color: var(--color-ink-muted);
	}
	.hl {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.hl .date {
		font-weight: 700;
		color: var(--color-evergreen-dark);
	}
	.snip {
		font-family: var(--font-serif);
		line-height: 1.5;
		overflow-wrap: anywhere;
	}
	.rows {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.rows a {
		display: grid;
		grid-template-columns: 48px minmax(0, 1fr);
		gap: 10px;
		padding: 10px 0;
		min-height: 52px;
		border-top: 1px solid var(--color-border);
		color: inherit;
		text-decoration: none;
	}
	.rows li:first-child a {
		border-top: 0;
	}
	.rows a:hover .snip {
		text-decoration: underline;
	}
	.rows .d {
		font-family: var(--font-serif);
		font-weight: 700;
		font-size: 21px;
		color: var(--color-evergreen-dark);
		text-align: center;
		line-height: 1.1;
	}
	.rows .d small {
		display: block;
		font-family: var(--font-sans);
		font-size: 15px;
		font-weight: 600;
		color: var(--color-ink-muted);
	}
	.show-all {
		min-height: 48px;
		margin-top: 6px;
		padding: 0 4px;
		border: 0;
		background: none;
		color: var(--color-evergreen);
		font-weight: 700;
		cursor: pointer;
	}
	.show-all:hover {
		text-decoration: underline;
	}
</style>
