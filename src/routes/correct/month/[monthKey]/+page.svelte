<script lang="ts">
	import { enhance } from '$app/forms';
	const { data } = $props();

	const monthNames = ['', 'January', 'February', 'March', 'April', 'May', 'June',
		'July', 'August', 'September', 'October', 'November', 'December'];

	const monthKey = $derived(`${data.year}-${String(data.month).padStart(2, '0')}`);
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

	function relativeTime(iso: string): string {
		const diff = Date.now() - new Date(iso).getTime();
		const mins = Math.floor(diff / 60_000);
		if (mins < 1) return 'just now';
		if (mins < 60) return `${mins}m ago`;
		const hrs = Math.floor(mins / 60);
		if (hrs < 24) return `${hrs}h ago`;
		const days = Math.floor(hrs / 24);
		return `${days}d ago`;
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
			{#if data.hasClaim}
				<span class="sep">&middot;</span>
				<!-- Absolute action: a relative "?/release" resolves against whatever
				     URL the browser is on, and after back/forward navigation that can
				     be a day page (no release action there → 404, seen 2026-07-22). -->
				<form method="POST" action="/correct/month/{monthKey}?/release" use:enhance class="release-form">
					<button type="submit" class="release-link">Release claim</button>
				</form>
			{/if}
		</div>
		{#if data.hasClaim}
			<form method="POST" action="/correct/month/{monthKey}?/pause" use:enhance class="done-for-now-form">
				<button type="submit" class="done-for-now-btn">Done for now</button>
			</form>
		{/if}
	</header>

	{#if data.otherClaim}
		<div class="claim-banner">
			<p class="claim-banner-text">
				<strong>{data.otherClaim.displayName}</strong> is working on this month
				(active {relativeTime(data.otherClaim.lastActivity)}).
				Nothing is locked — you can still open and edit any day with
				<em>Continue Anyway</em>; this is just a heads-up so you don't both
				work the same days at once.
			</p>
			<div class="claim-banner-actions">
				<a href="/correct" class="btn-back">Go Back</a>
				<form method="POST" action="/correct/month/{monthKey}?/takeover" use:enhance>
					<button type="submit" class="btn-takeover">Continue Anyway</button>
				</form>
				{#if data.isAdmin}
					<form method="POST" action="/correct/month/{monthKey}?/release" use:enhance>
						<button type="submit" class="btn-release">Release Claim</button>
					</form>
				{/if}
			</div>
		</div>
	{/if}

	{#if data.days.length === 0}
		<p class="empty">No days found for this month.</p>
	{:else}
		<div class="day-list">
			{#each data.days as day}
				<a href="/correct/day/{day.entry_date}" class="day-row">
					<span class="day-num">{day.day_number}</span>
					<span class="day-status {statusClass(day.correction_status)}">{statusLabel(day.correction_status)}</span>
					{#if day.has_narrative}
						<span class="narrative-dot" title="Has narrative">N</span>
					{/if}
					<span class="day-preview">
						{#if day.correction_status === 'accepted' && day.corrected_text}
							{day.corrected_text.length > 80 ? day.corrected_text.slice(0, 80) + '...' : day.corrected_text}
						{:else if !day.has_draft}
							<span class="no-draft">Manual entry</span>
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
	.narrative-dot {
		font-size: 0.65rem;
		font-weight: 700;
		color: #8b7355;
		background: #f5f0e8;
		border-radius: 3px;
		padding: 0.1rem 0.35rem;
		flex-shrink: 0;
	}
	.no-draft {
		color: #aaa;
		font-style: italic;
	}

	.claim-banner {
		background: #fff8e1;
		border: 1px solid #e6c54a;
		border-radius: 6px;
		padding: 1rem 1.25rem;
		margin-bottom: 1.5rem;
	}
	.claim-banner-text {
		margin: 0 0 0.75rem;
		font-size: 0.95rem;
		color: #5d4200;
	}
	.claim-banner-actions {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		flex-wrap: wrap;
	}
	.btn-back {
		display: inline-flex;
		align-items: center;
		padding: 0.6rem 1.25rem;
		background: #1a7a1a;
		color: #fff;
		font-size: 0.9rem;
		font-weight: 600;
		border-radius: 5px;
		text-decoration: none;
		min-height: 44px;
	}
	.btn-back:hover { background: #156215; }
	.btn-takeover {
		padding: 0.6rem 1.25rem;
		background: #fff;
		border: 1px solid #ccc;
		color: #333;
		font-size: 0.9rem;
		font-weight: 500;
		border-radius: 5px;
		cursor: pointer;
		font-family: inherit;
		min-height: 44px;
	}
	.btn-takeover:hover { background: #f5f5f5; border-color: #999; }
	.btn-release {
		padding: 0.6rem 1.25rem;
		background: transparent;
		border: 1px solid #c33;
		color: #c33;
		font-size: 0.85rem;
		font-weight: 500;
		border-radius: 5px;
		cursor: pointer;
		font-family: inherit;
		min-height: 44px;
	}
	.btn-release:hover { background: #fde2e2; }

	.release-form {
		display: inline;
	}
	.release-link {
		background: none;
		border: none;
		padding: 0;
		font: inherit;
		font-size: 0.9rem;
		color: #888;
		cursor: pointer;
		text-decoration: underline;
	}
	.release-link:hover { color: #555; }

	.done-for-now-form {
		margin-top: 0.75rem;
	}
	.done-for-now-btn {
		min-height: 44px;
		padding: 0.5rem 1.1rem;
		background: #fff;
		border: 1px solid #ccc;
		border-radius: 6px;
		color: #333;
		font-size: 0.9rem;
		font-weight: 500;
		font-family: inherit;
		cursor: pointer;
	}
	.done-for-now-btn:hover {
		border-color: #999;
		background: #f5f5f5;
	}
</style>
