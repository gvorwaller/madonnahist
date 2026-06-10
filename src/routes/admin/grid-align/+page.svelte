<script lang="ts">
	const { data } = $props();

	const monthNames = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
		'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

	const pagesByYear = $derived(() => {
		const map = new Map<number, typeof data.pages>();
		for (const p of data.pages) {
			if (!map.has(p.year)) map.set(p.year, []);
			map.get(p.year)!.push(p);
		}
		return [...map.entries()].sort((a, b) => a[0] - b[0]);
	});

	// eslint-disable-next-line svelte/valid-compile -- intentional one-time capture of initial data
	let expandedYears = $state((() => new Set(data.pages.filter(p => !p.has_warp || !p.has_grid).map(p => p.year)))());

	function toggleYear(year: number) {
		const next = new Set(expandedYears);
		if (next.has(year)) next.delete(year);
		else next.add(year);
		expandedYears = next;
	}
</script>

<div class="page">
	<h1>Grid Alignment</h1>
	<p class="desc">Select a page to adjust grid lines and perspective correction.</p>

	{#if data.pages.length === 0}
		<p class="empty">No pages ingested yet.</p>
	{:else}
		<div class="year-list">
			{#each pagesByYear() as [year, pages] (year)}
				{@const done = pages.filter(p => p.has_warp && p.has_grid).length}
				{@const pending = pages.length - done}
				<div class="year-section">
					<button
						class="year-bar"
						aria-expanded={expandedYears.has(year)}
						onclick={() => toggleYear(year)}
					>
						<span class="year-label">{year}</span>
						<span class="year-stats">
							{done}/{pages.length} done
							{#if pending > 0}
								<span class="pending-count">{pending} pending</span>
							{/if}
						</span>
						<span class="chevron">{expandedYears.has(year) ? '▴' : '▾'}</span>
					</button>
					{#if expandedYears.has(year)}
						<div class="month-list">
							{#each pages as p}
								<a href="/admin/grid-align/{p.id}" class="page-card">
									<span class="label">{monthNames[p.month]}</span>
									<span class="badges">
										{#if p.has_warp}
											<span class="badge warp">Warped</span>
										{/if}
										{#if p.has_grid}
											<span class="badge grid">Grid set</span>
										{:else}
											<span class="badge none">No grid</span>
										{/if}
									</span>
								</a>
							{/each}
						</div>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</div>

<style>
	.page {
		max-width: 700px;
		margin: 0 auto;
		padding: 1.5rem 1rem;
	}
	h1 {
		font-size: 1.4rem;
		margin: 0 0 0.3rem;
	}
	.desc {
		color: #555;
		font-size: 0.85rem;
		margin: 0 0 1.5rem;
	}
	.empty {
		color: #888;
		text-align: center;
		padding: 2rem;
	}
	.year-list {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}
	.year-section {
		border: 1px solid #e0e0e0;
		border-radius: 6px;
		overflow: hidden;
	}
	.year-bar {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		width: 100%;
		padding: 0.65rem 1rem;
		background: #f5f5f5;
		border: none;
		cursor: pointer;
		font: inherit;
		font-weight: 600;
		font-size: 0.95rem;
		color: #333;
		text-align: left;
	}
	.year-bar:hover { background: #ebebeb; }
	.year-label { min-width: 3rem; }
	.year-stats {
		flex: 1;
		font-weight: 400;
		font-size: 0.8rem;
		color: #666;
	}
	.pending-count {
		margin-left: 0.5rem;
		color: #b8860b;
		font-weight: 600;
	}
	.chevron { font-size: 0.75rem; color: #888; }
	.month-list {
		display: flex;
		flex-direction: column;
	}
	.page-card {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 0.6rem 1rem;
		border-top: 1px solid #eee;
		background: #fff;
		text-decoration: none;
		color: inherit;
	}
	.page-card:hover {
		background: #f9f9f9;
	}
	.label {
		font-weight: 600;
		font-size: 0.95rem;
		min-width: 3rem;
	}
	.badges {
		display: flex;
		gap: 0.4rem;
	}
	.badge {
		font-size: 0.7rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.03em;
		padding: 0.15rem 0.4rem;
		border-radius: 3px;
	}
	.badge.warp {
		background: #e0e8f8;
		color: #335;
	}
	.badge.grid {
		background: #e6f4e6;
		color: #1a7a1a;
	}
	.badge.none {
		background: #f0f0f0;
		color: #888;
	}
</style>
