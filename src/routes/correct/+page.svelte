<script lang="ts">
	const { data } = $props();

	const monthNames = ['', 'January', 'February', 'March', 'April', 'May', 'June',
		'July', 'August', 'September', 'October', 'November', 'December'];

	const yearGroups = $derived.by(() => {
		const groups = new Map<number, typeof data.months>();
		for (const m of data.months) {
			if (!groups.has(m.year)) groups.set(m.year, []);
			groups.get(m.year)!.push(m);
		}
		return [...groups.entries()]
			.sort(([a], [b]) => a - b)
			.map(([year, months]) => ({
				year,
				months,
				totalDays: months.reduce((s, m) => s + m.total_days, 0),
				correctedCount: months.reduce((s, m) => s + m.corrected_count, 0),
				pendingCount: months.reduce((s, m) => s + m.pending_count, 0),
			}));
	});

	const resumeYear = $derived(
		data.resumeDate ? parseInt(data.resumeDate.slice(0, 4)) : null
	);

	let expandedYears: Set<number> = $state(new Set());
	let initialized = false;

	$effect(() => {
		if (initialized) return;
		initialized = true;
		const yearsWithWork = yearGroups.filter(g => g.pendingCount > 0).map(g => g.year);
		if (yearsWithWork.length <= 10) {
			expandedYears = new Set(yearsWithWork);
		} else if (resumeYear) {
			expandedYears = new Set([resumeYear]);
		}
	});

	function toggleYear(year: number) {
		const next = new Set(expandedYears);
		if (next.has(year)) next.delete(year);
		else next.add(year);
		expandedYears = next;
	}

	let jumpTarget = $state('');

	function handleJump(e: Event) {
		const year = Number((e.target as HTMLSelectElement).value);
		if (!year) return;
		const next = new Set(expandedYears);
		next.add(year);
		expandedYears = next;
		jumpTarget = '';
		requestAnimationFrame(() => {
			document.getElementById(`year-${year}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
		});
	}
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
		{#if yearGroups.length > 3}
			<div class="jump-to">
				<label>
					<span class="jump-label">Jump to year</span>
					<select bind:value={jumpTarget} onchange={handleJump}>
						<option value="">Select year...</option>
						{#each yearGroups as g}
							<option value={g.year}>{g.year}</option>
						{/each}
					</select>
				</label>
			</div>
		{/if}

		<div class="year-list">
			{#each yearGroups as group (group.year)}
				{@const yearPct = group.totalDays > 0 ? Math.round((group.correctedCount / group.totalDays) * 100) : 0}
				{@const isExpanded = expandedYears.has(group.year)}
				<section class="year-section" id="year-{group.year}">
					<button
						class="year-bar"
						aria-expanded={isExpanded}
						aria-controls="year-content-{group.year}"
						onclick={() => toggleYear(group.year)}
					>
						<span class="year-name">{group.year}</span>
						<div class="year-progress">
							<div class="year-progress-fill" style="width: {yearPct}%"></div>
						</div>
						<span class="year-stats">{group.correctedCount}/{group.totalDays}</span>
						{#if group.pendingCount > 0}
							<span class="year-pending">{group.pendingCount} pending</span>
						{/if}
						<span class="chevron" class:open={isExpanded}>&#9662;</span>
					</button>

					{#if isExpanded}
						<div class="year-content" id="year-content-{group.year}">
							<div class="month-list">
								{#each group.months as m}
									{@const pct = m.total_days > 0 ? Math.round((m.corrected_count / m.total_days) * 100) : 0}
									{@const ready = m.draft_ready_count > 0 && m.pending_count > 0}
									{@const monthKey = `${m.year}-${String(m.month).padStart(2, '0')}`}
									<a href="/correct/month/{monthKey}" class="month-card">
										<h2>{monthNames[m.month]}</h2>
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
											{:else if m.draft_ready_count === 0 && m.pending_count > 0}
												<span class="stat">
													<span class="value pending">{m.pending_count}</span>
													<span class="label">manual entry</span>
												</span>
											{/if}
										</div>
									</a>
								{/each}
							</div>
						</div>
					{/if}
				</section>
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
		display: inline-flex;
		align-items: center;
		padding: 0.85rem 2rem;
		background: #1a7a1a;
		color: #fff;
		font-size: 1.15rem;
		font-weight: 600;
		border-radius: 6px;
		text-decoration: none;
		min-height: 58px;
		line-height: 1;
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

	.jump-to {
		margin-bottom: 1.5rem;
	}
	.jump-label {
		display: block;
		font-size: 0.8rem;
		font-weight: 600;
		color: #555;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		margin-bottom: 0.3rem;
	}
	.jump-to select {
		font-size: 1rem;
		padding: 0.6rem 1rem;
		border-radius: 6px;
		border: 1px solid #ccc;
		min-height: 48px;
		min-width: 140px;
		background: #fff;
		font-family: inherit;
	}

	.year-list {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.year-bar {
		display: flex;
		align-items: center;
		gap: 1rem;
		width: 100%;
		padding: 1rem 1.25rem;
		min-height: 58px;
		background: #f5f5f3;
		border: 1px solid #ddd;
		border-radius: 6px;
		cursor: pointer;
		font: inherit;
		text-align: left;
		transition: background 0.15s;
	}
	.year-bar:hover {
		background: #eee;
	}
	.year-bar:focus-visible {
		outline: 2px solid #1a7a1a;
		outline-offset: 2px;
	}
	.year-name {
		font-size: 1.25rem;
		font-weight: 700;
		min-width: 3.5rem;
		color: #1a1a1a;
	}
	.year-progress {
		flex: 1;
		height: 8px;
		background: #e8e8e8;
		border-radius: 4px;
		overflow: hidden;
	}
	.year-progress-fill {
		height: 100%;
		background: #1a7a1a;
		border-radius: 4px;
	}
	.year-stats {
		font-size: 0.9rem;
		color: #333;
		font-weight: 600;
		white-space: nowrap;
	}
	.year-pending {
		font-size: 0.75rem;
		color: #666;
		white-space: nowrap;
	}
	.chevron {
		font-size: 1rem;
		transition: transform 0.2s;
		color: #666;
	}
	.chevron.open {
		transform: rotate(180deg);
	}

	.year-content {
		padding: 1rem 0 0.5rem;
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
	.month-card:hover {
		border-color: #1a7a1a;
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
