<script lang="ts">
	const { data } = $props();

	const monthNames = ['', 'January', 'February', 'March', 'April', 'May', 'June',
		'July', 'August', 'September', 'October', 'November', 'December'];

	const correctedCount = $derived(data.days.filter(d => d.correction_status === 'accepted').length);
	const pendingWithDraft = $derived(data.days.filter(d => d.correction_status === 'pending' && d.has_draft).length);

	function statusLabel(s: string): string {
		if (s === 'accepted') return 'Corrected';
		if (s === 'in_progress') return 'Skipped';
		if (s === 'illegible') return 'Illegible';
		return 'Pending';
	}

	function statusClass(s: string): string {
		if (s === 'accepted') return 'done';
		if (s === 'illegible') return 'flag';
		if (s === 'in_progress') return 'skip';
		return 'pending';
	}
</script>

<div class="page">
	<header>
		<a href="/correct" class="back">Correction Home</a>
		<h1>{monthNames[data.month]} {data.year}</h1>
		<div class="summary">
			<span>{correctedCount} of {data.days.length} corrected</span>
			{#if pendingWithDraft > 0}
				<span class="sep">&middot;</span>
				<span>{pendingWithDraft} ready for correction</span>
			{/if}
		</div>
	</header>

	{#if data.days.length === 0}
		<p class="empty">No days found for this month.</p>
	{:else}
		<div class="day-list">
			{#each data.days as day}
				<a href="/correct/day/{day.entry_date}" class="day-row">
					<span class="day-num">{day.day_number}</span>
					<span class="day-status {statusClass(day.correction_status)}">{statusLabel(day.correction_status)}</span>
					<span class="day-preview">
						{#if day.correction_status === 'accepted' && day.corrected_text}
							{day.corrected_text.length > 80 ? day.corrected_text.slice(0, 80) + '...' : day.corrected_text}
						{:else if !day.has_draft}
							<span class="no-draft">No OCR draft</span>
						{:else}
							&nbsp;
						{/if}
					</span>
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
		margin-bottom: 1.5rem;
	}
	.back {
		font-size: 0.85rem;
		color: #555;
		text-decoration: none;
	}
	.back:hover { text-decoration: underline; }
	h1 {
		margin: 0.25rem 0 0.3rem;
		font-size: 1.5rem;
	}
	.summary {
		font-size: 0.9rem;
		color: #666;
	}
	.sep { margin: 0 0.25rem; }
	.empty {
		color: #666;
		text-align: center;
		padding: 2rem;
	}

	.day-list {
		display: flex;
		flex-direction: column;
		gap: 1px;
		background: #e0e0e0;
		border: 1px solid #e0e0e0;
		border-radius: 6px;
		overflow: hidden;
	}
	.day-row {
		display: flex;
		align-items: center;
		gap: 1rem;
		padding: 0.85rem 1rem;
		background: #fff;
		text-decoration: none;
		color: inherit;
		min-height: 52px;
	}
	.day-row:hover {
		background: #f5f8f5;
	}
	.day-num {
		font-size: 1.1rem;
		font-weight: 600;
		min-width: 2rem;
		text-align: right;
		color: #333;
	}
	.day-status {
		font-size: 0.75rem;
		font-weight: 600;
		padding: 0.15rem 0.5rem;
		border-radius: 4px;
		min-width: 70px;
		text-align: center;
	}
	.day-status.done { background: #e6f4e6; color: #1a7a1a; }
	.day-status.pending { background: #fff3cd; color: #856404; }
	.day-status.flag { background: #fde2e2; color: #c33; }
	.day-status.skip { background: #fff3cd; color: #b8860b; }
	.day-preview {
		flex: 1;
		font-size: 0.85rem;
		color: #666;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.no-draft {
		color: #aaa;
		font-style: italic;
	}
</style>
