<script lang="ts">
	const { data } = $props();

	const monthNames = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
		'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
</script>

<div class="page">
	<h1>Grid Alignment</h1>
	<p class="desc">Select a page to adjust grid lines and perspective correction.</p>

	{#if data.pages.length === 0}
		<p class="empty">No pages ingested yet.</p>
	{:else}
		<div class="page-list">
			{#each data.pages as p}
				<a href="/admin/grid-align/{p.id}" class="page-card">
					<span class="label">{monthNames[p.month]} {p.year}</span>
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
	.page-list {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.page-card {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 0.75rem 1rem;
		border: 1px solid #ddd;
		border-radius: 6px;
		background: #fff;
		text-decoration: none;
		color: inherit;
		transition: border-color 0.15s;
	}
	.page-card:hover {
		border-color: #888;
	}
	.label {
		font-weight: 600;
		font-size: 0.95rem;
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
