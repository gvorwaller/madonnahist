<script lang="ts">
	const { data } = $props();

	const monthNames = ['', 'January', 'February', 'March', 'April', 'May', 'June',
		'July', 'August', 'September', 'October', 'November', 'December'];
</script>

<div class="page">
	<header>
		<h1>Correction Queue</h1>
		{#if data.resumeDate}
			<a href="/correct/day/{data.resumeDate}" class="resume-btn">Resume Correcting</a>
		{:else}
			<p class="all-done">All available days have been corrected.</p>
		{/if}
	</header>

	{#if data.months.length === 0}
		<p class="empty">No ingested pages found.</p>
	{:else}
		<div class="month-list">
			{#each data.months as m}
				{@const pct = m.total_days > 0 ? Math.round((m.corrected_count / m.total_days) * 100) : 0}
				{@const ready = m.draft_ready_count > 0 && m.pending_count > 0}
				<a
					href={m.first_pending_date ? `/correct/day/${m.first_pending_date}` : '#'}
					class="month-card"
					class:disabled={!m.first_pending_date}
				>
					<h2>{monthNames[m.month]} {m.year}</h2>
					<div class="progress-bar">
						<div class="progress-fill" style="width: {pct}%"></div>
					</div>
					<div class="stats">
						<span class="stat">
							<span class="value">{m.corrected_count}/{m.total_days}</span>
							<span class="label">corrected</span>
						</span>
						{#if m.illegible_count > 0}
							<span class="stat">
								<span class="value flag">{m.illegible_count}</span>
								<span class="label">illegible</span>
							</span>
						{/if}
						{#if m.skipped_count > 0}
							<span class="stat">
								<span class="value skip">{m.skipped_count}</span>
								<span class="label">skipped</span>
							</span>
						{/if}
						{#if ready}
							<span class="stat">
								<span class="value pending">{m.pending_count}</span>
								<span class="label">pending</span>
							</span>
						{:else if m.draft_ready_count === 0}
							<span class="stat">
								<span class="value pending">no drafts</span>
								<span class="label">OCR needed</span>
							</span>
						{/if}
					</div>
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
	header {
		margin-bottom: 2rem;
	}
	h1 {
		margin: 0 0 1rem;
		font-size: 1.5rem;
	}
	.resume-btn {
		display: inline-block;
		padding: 0.85rem 2rem;
		background: #1a7a1a;
		color: #fff;
		font-size: 1.15rem;
		font-weight: 600;
		border-radius: 6px;
		text-decoration: none;
		min-height: 58px;
		line-height: 1;
		display: inline-flex;
		align-items: center;
	}
	.resume-btn:hover {
		background: #156215;
	}
	.all-done {
		color: #1a7a1a;
		font-weight: 600;
	}
	.empty {
		color: #666;
		text-align: center;
		padding: 2rem;
	}
	.month-list {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
		gap: 1rem;
	}
	.month-card {
		display: block;
		border: 1px solid #ccc;
		border-radius: 6px;
		padding: 1.25rem;
		text-decoration: none;
		color: inherit;
		transition: border-color 0.15s;
	}
	.month-card:hover:not(.disabled) {
		border-color: #1a7a1a;
	}
	.month-card.disabled {
		opacity: 0.5;
		pointer-events: none;
	}
	.month-card h2 {
		margin: 0 0 0.75rem;
		font-size: 1.15rem;
	}
	.progress-bar {
		height: 8px;
		background: #e8e8e8;
		border-radius: 4px;
		overflow: hidden;
		margin-bottom: 0.75rem;
	}
	.progress-fill {
		height: 100%;
		background: #1a7a1a;
		border-radius: 4px;
		transition: width 0.3s;
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
		gap: 0.1rem;
	}
	.stat .label {
		font-size: 0.7rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: #888;
	}
	.stat .value {
		font-size: 1.05rem;
		font-weight: 600;
	}
	.stat .value.flag { color: #c33; }
	.stat .value.skip { color: #b8860b; }
	.stat .value.pending { color: #666; }
</style>
