<script lang="ts">
	const { data } = $props();

	const monthNames = ['', 'January', 'February', 'March', 'April', 'May', 'June',
		'July', 'August', 'September', 'October', 'November', 'December'];
</script>

<div class="page">
	<h1>OCR Review</h1>
	<p class="subtitle">Select a page to review OCR results</p>

	{#if data.pages.length === 0}
		<p class="empty">No ingested pages found. Ingest a page first via <a href="/admin/capture">/admin/capture</a>.</p>
	{:else}
		<div class="page-list">
			{#each data.pages as p}
				<a href="/admin/ocr-review/{p.id}" class="page-card">
					<h2>{monthNames[p.month]} {p.year}</h2>
					<div class="stats">
						<span class="stat">
							<span class="label">OCR</span>
							<span class="value">{p.ocr_complete}/{p.total_days}</span>
						</span>
						{#if p.avg_confidence !== null}
							<span class="stat">
								<span class="label">Avg Conf</span>
								<span class="value" class:conf-high={p.avg_confidence >= 0.7}
									class:conf-med={p.avg_confidence >= 0.4 && p.avg_confidence < 0.7}
									class:conf-low={p.avg_confidence < 0.4}>
									{(p.avg_confidence * 100).toFixed(0)}%
								</span>
							</span>
						{/if}
						{#if p.flagged_count > 0}
							<span class="stat">
								<span class="label">Flagged</span>
								<span class="value conf-low">{p.flagged_count}</span>
							</span>
						{/if}
						{#if p.failed_count > 0}
							<span class="stat">
								<span class="label">Failed</span>
								<span class="value conf-low">{p.failed_count}</span>
							</span>
						{/if}
					</div>
					{#if p.ocr_complete === 0}
						<p class="pending-note">OCR not yet run</p>
					{:else if p.ocr_complete < p.total_days}
						<p class="pending-note">{p.total_days - p.ocr_complete} days pending</p>
					{/if}
				</a>
			{/each}
		</div>
	{/if}
</div>

<style>
	.page {
		max-width: 900px;
		margin: 0 auto;
		padding: 2rem;
	}
	h1 {
		margin: 0 0 0.25rem;
		font-size: 1.5rem;
	}
	.subtitle {
		color: #666;
		margin: 0 0 2rem;
	}
	.empty {
		color: #666;
		padding: 2rem;
		text-align: center;
	}
	.page-list {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
		gap: 1rem;
	}
	.page-card {
		display: block;
		border: 1px solid #ccc;
		border-radius: 6px;
		padding: 1.25rem;
		text-decoration: none;
		color: inherit;
		transition: border-color 0.15s;
	}
	.page-card:hover {
		border-color: #666;
	}
	.page-card h2 {
		margin: 0 0 0.75rem;
		font-size: 1.15rem;
	}
	.stats {
		display: flex;
		gap: 1rem;
		flex-wrap: wrap;
	}
	.stat {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.15rem;
	}
	.stat .label {
		font-size: 0.7rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: #888;
	}
	.stat .value {
		font-size: 1.1rem;
		font-weight: 600;
	}
	.conf-high { color: #1a7a1a; }
	.conf-med { color: #b8860b; }
	.conf-low { color: #c33; }
	.pending-note {
		margin: 0.75rem 0 0;
		font-size: 0.85rem;
		color: #888;
	}
</style>
