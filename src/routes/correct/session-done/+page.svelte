<script lang="ts">
	const { data } = $props();

	const monthNames = ['', 'January', 'February', 'March', 'April', 'May', 'June',
		'July', 'August', 'September', 'October', 'November', 'December'];

	const monthLabel = $derived(data.month ? `${monthNames[data.month]} ${data.year}` : null);

	const elapsedMinutes = $derived(
		Math.max(0, Math.round((Date.now() - new Date(data.startedAt).getTime()) / 60_000))
	);
</script>

<div class="page">
	<h1>Nice work.</h1>

	<div class="summary-card">
		<h2>This session</h2>
		<ul class="summary-list">
			<li>
				<span class="summary-icon done" aria-hidden="true">&check;</span>
				{data.correctedCount} day{data.correctedCount === 1 ? '' : 's'} corrected
			</li>
			{#if data.flaggedCount > 0}
				<li>
					<span class="summary-icon flag" aria-hidden="true">&#9873;</span>
					{data.flaggedCount} flagged for another look
				</li>
			{/if}
			{#if data.skippedCount > 0}
				<li>
					<span class="summary-icon skip" aria-hidden="true">&#8617;</span>
					{data.skippedCount} skipped
				</li>
			{/if}
		</ul>

		{#if monthLabel}
			<p class="summary-detail">Month: {monthLabel}</p>
		{/if}
		<p class="summary-detail">Time: {elapsedMinutes} minute{elapsedMinutes === 1 ? '' : 's'}</p>
	</div>

	<div class="actions">
		<a href="/correct" class="btn-primary">Correction Home</a>
		{#if data.monthKey}
			<a href="/correct/month/{data.monthKey}" class="btn-secondary">Keep Going</a>
		{/if}
	</div>
</div>

<style>
	.page {
		max-width: 560px;
		margin: 0 auto;
		padding: 3rem 1.5rem;
		text-align: center;
	}
	h1 {
		margin: 0 0 1.5rem;
		font-size: 1.6rem;
		color: #1a1a1a;
	}
	.summary-card {
		background: #f8f8f4;
		border: 1px solid #e0ddd0;
		border-radius: 10px;
		padding: 1.75rem;
		text-align: left;
		margin-bottom: 2rem;
	}
	.summary-card h2 {
		margin: 0 0 1rem;
		font-size: 0.85rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: #666;
	}
	.summary-list {
		list-style: none;
		margin: 0 0 1rem;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
	}
	.summary-list li {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		font-size: 1.05rem;
		color: #333;
	}
	.summary-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.6rem;
		height: 1.6rem;
		font-size: 1rem;
		font-weight: 700;
		border-radius: 50%;
		flex-shrink: 0;
	}
	.summary-icon.done { background: #e6f4e6; color: #1a7a1a; }
	.summary-icon.flag { background: #fde2e2; color: #c33; }
	.summary-icon.skip { background: #fff3cd; color: #b8860b; }
	.summary-detail {
		margin: 0.2rem 0 0;
		font-size: 0.9rem;
		color: #666;
	}
	.actions {
		display: flex;
		justify-content: center;
		gap: 1rem;
		flex-wrap: wrap;
	}
	.btn-primary, .btn-secondary {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: 52px;
		padding: 0.75rem 1.75rem;
		border-radius: 6px;
		font-size: 1rem;
		font-weight: 600;
		text-decoration: none;
	}
	.btn-primary {
		background: #1a7a1a;
		color: #fff;
	}
	.btn-primary:hover { background: #156215; }
	.btn-secondary {
		background: #fff;
		color: #333;
		border: 1px solid #ccc;
	}
	.btn-secondary:hover { border-color: #999; }
</style>
