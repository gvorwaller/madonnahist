<script lang="ts">
	import { page } from '$app/state';
	import type { EntityProfile } from '$lib/server/entities';

	const { profile }: { profile: EntityProfile | null } = $props();

	const earliest = $derived(profile && profile.days.length > 0 ? profile.days[0] : null);
	const mostRecent = $derived(
		profile && profile.days.length > 0 ? profile.days[profile.days.length - 1] : null
	);
	// Back-navigation memory for day links (see /app/day back handling).
	const fromSuffix = $derived(`?from=${encodeURIComponent(page.url.pathname)}`);
</script>

<div class="entity-page">
	<a href="/app" class="back-link">&larr; Back</a>

	{#if !profile}
		<div class="not-found">
			<h1>Not found</h1>
			<p>There's no one or nowhere by that name in the archive yet.</p>
		</div>
	{:else}
		<h1>{profile.displayName}</h1>

		{#if profile.mentionCount === 0}
			<p class="summary">No accepted days mention {profile.displayName} yet.</p>
		{:else}
			<p class="summary">
				{profile.mentionCount} day{profile.mentionCount === 1 ? '' : 's'} mention {profile.displayName}
				{#if profile.firstYear && profile.lastYear}
					<br />
					{profile.firstYear}{profile.firstYear !== profile.lastYear ? ` — ${profile.lastYear}` : ''}
				{/if}
			</p>

			<section class="earliest-recent">
				{#if earliest}
					<div class="highlight-block">
						<p class="label">Earliest</p>
						<a class="day-card" href="/app/day/{earliest.entryDate}{fromSuffix}">
							<div class="date">{earliest.dateLabel}</div>
							<p class="snippet">{earliest.snippet}</p>
						</a>
					</div>
				{/if}
				{#if mostRecent && mostRecent !== earliest}
					<div class="highlight-block">
						<p class="label">Most recent</p>
						<a class="day-card" href="/app/day/{mostRecent.entryDate}{fromSuffix}">
							<div class="date">{mostRecent.dateLabel}</div>
							<p class="snippet">{mostRecent.snippet}</p>
						</a>
					</div>
				{/if}
			</section>

			{#if profile.yearCounts.length > 0}
				<section class="by-year">
					<p class="label">By year</p>
					<ul class="year-list">
						{#each profile.yearCounts as yc (yc.year)}
							<li>
								<span class="year">{yc.year}</span>
								<span class="count">{yc.count} mention{yc.count === 1 ? '' : 's'}</span>
							</li>
						{/each}
					</ul>
				</section>
			{/if}

			<section class="all-days">
				<p class="label">All days</p>
				<ul class="day-list">
					{#each profile.days as d (d.entryDate)}
						<li><a href="/app/day/{d.entryDate}{fromSuffix}">{d.dateLabel}</a></li>
					{/each}
				</ul>
			</section>
		{/if}
	{/if}
</div>

<style>
	.entity-page {
		padding: 1rem;
	}
	.back-link {
		display: flex;
		align-items: center;
		min-height: 48px;
		margin-bottom: 0.5rem;
		font-family: var(--font-sans);
		font-size: 0.9rem;
		color: var(--color-evergreen-dark);
		text-decoration: none;
	}
	.back-link:hover {
		text-decoration: underline;
	}
	.back-link:focus-visible {
		outline: 2px solid var(--color-evergreen-dark);
		outline-offset: 2px;
	}
	h1 {
		font-family: var(--font-sans);
		font-size: 1.4rem;
		margin: 0 0 0.5rem;
		color: var(--color-ink);
		text-align: center;
	}
	.not-found {
		background: var(--color-paper);
		border: 1px solid var(--color-border);
		border-radius: 10px;
		padding: 1.5rem 1.25rem;
		text-align: center;
	}
	.not-found p {
		font-family: var(--font-serif);
		font-size: 1.05rem;
		color: var(--color-ink-muted);
		margin: 0;
	}
	.summary {
		font-family: var(--font-serif);
		font-size: 1.05rem;
		line-height: 1.6;
		color: var(--color-ink-muted);
		text-align: center;
		margin: 0 0 1.5rem;
	}
	.label {
		font-family: var(--font-sans);
		font-size: 0.8rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--color-ink-muted);
		margin: 0 0 0.5rem;
	}
	.earliest-recent {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		margin-bottom: 1.5rem;
	}
	.day-card {
		display: block;
		background: var(--color-paper);
		border: 1px solid var(--color-border);
		border-radius: 8px;
		padding: 0.85rem 1rem;
		text-decoration: none;
		color: inherit;
	}
	.day-card:focus-visible {
		outline: 2px solid var(--color-evergreen-dark);
		outline-offset: 2px;
	}
	.date {
		font-family: var(--font-sans);
		font-weight: 700;
		font-size: 0.95rem;
		color: var(--color-evergreen-dark);
		margin-bottom: 0.35rem;
	}
	.snippet {
		font-family: var(--font-serif);
		font-size: 1rem;
		line-height: 1.55;
		color: var(--color-ink);
		margin: 0;
	}
	.by-year {
		margin-bottom: 1.5rem;
	}
	.year-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}
	.year-list li {
		display: flex;
		justify-content: space-between;
		font-family: var(--font-sans);
		font-size: 0.95rem;
		background: var(--color-paper);
		border: 1px solid var(--color-border);
		border-radius: 6px;
		padding: 0.5rem 0.75rem;
	}
	.year-list .year {
		font-weight: 700;
		color: var(--color-ink);
	}
	.year-list .count {
		color: var(--color-ink-muted);
	}
	.all-days .day-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}
	.all-days .day-list a {
		display: flex;
		align-items: center;
		min-height: 44px;
		font-family: var(--font-sans);
		font-size: 0.95rem;
		color: var(--color-evergreen-dark);
		text-decoration: none;
		border-bottom: 1px solid var(--color-border);
	}
	.all-days .day-list a:hover {
		text-decoration: underline;
	}
	.all-days .day-list a:focus-visible {
		outline: 2px solid var(--color-evergreen-dark);
		outline-offset: 2px;
	}
</style>
