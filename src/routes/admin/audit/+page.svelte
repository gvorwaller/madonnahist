<script lang="ts">
	const { data } = $props();

	// Per-row expanded state for the before/after JSON details section —
	// same pattern as src/routes/admin/entities/+page.svelte's mentionsOpen.
	let expandedIds = $state<Set<number>>(new Set());

	function toggleExpanded(id: number) {
		const next = new Set(expandedIds);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		expandedIds = next;
	}

	function hasDetails(row: { beforeValue: unknown; afterValue: unknown }): boolean {
		return row.beforeValue !== null || row.afterValue !== null;
	}

	function pretty(value: unknown): string {
		return JSON.stringify(value, null, 2);
	}

	// Pager preserves every filter — same convention as
	// src/routes/app/search/+page.svelte's pageHref().
	function pageHref(targetPage: number): string {
		const params = new URLSearchParams();
		if (data.filters.action) params.set('action', data.filters.action);
		if (data.filters.user) params.set('user', String(data.filters.user));
		if (data.filters.entityType) params.set('entityType', data.filters.entityType);
		if (data.filters.from) params.set('from', data.filters.from);
		if (data.filters.to) params.set('to', data.filters.to);
		if (data.filters.q) params.set('q', data.filters.q);
		if (targetPage > 1) params.set('page', String(targetPage));
		const qs = params.toString();
		return qs ? `/admin/audit?${qs}` : '/admin/audit';
	}
</script>

<svelte:head>
	<title>Audit Log — madonnahist</title>
</svelte:head>

<div class="page">
	<header>
		<a href="/admin" class="back">Admin</a>
		<h1>Audit Log</h1>
		<p class="subtitle">
			Append-only record of who changed what and when. Read-only — viewing this page is not
			itself logged.
		</p>
	</header>

	<form method="GET" class="filter-form">
		<label class="filter-field">
			<span class="filter-label">Action</span>
			<select name="action" value={data.filters.action ?? ''}>
				<option value="">any action</option>
				{#each data.actionOptions as a (a)}
					<option value={a}>{a}</option>
				{/each}
			</select>
		</label>
		<label class="filter-field">
			<span class="filter-label">User</span>
			<select name="user" value={data.filters.user ?? ''}>
				<option value="">anyone</option>
				{#each data.userOptions as u (u.id)}
					<option value={u.id}>{u.display_name}</option>
				{/each}
			</select>
		</label>
		<label class="filter-field">
			<span class="filter-label">Entity type</span>
			<select name="entityType" value={data.filters.entityType ?? ''}>
				<option value="">any type</option>
				{#each data.entityTypeOptions as t (t)}
					<option value={t}>{t}</option>
				{/each}
			</select>
		</label>
		<label class="filter-field">
			<span class="filter-label">From</span>
			<input type="date" name="from" value={data.filters.from ?? ''} />
		</label>
		<label class="filter-field">
			<span class="filter-label">To</span>
			<input type="date" name="to" value={data.filters.to ?? ''} />
		</label>
		<label class="filter-field filter-field-wide">
			<span class="filter-label">Description contains</span>
			<input type="search" name="q" value={data.filters.q ?? ''} maxlength="200" placeholder="Search description…" />
		</label>
		<div class="filter-actions">
			<button type="submit" class="btn btn-primary">Filter</button>
			<a href="/admin/audit" class="btn btn-secondary">Clear</a>
		</div>
	</form>

	<p class="result-count">{data.total} entr{data.total === 1 ? 'y' : 'ies'}</p>

	{#if data.rows.length === 0}
		<p class="empty">No audit entries match these filters.</p>
	{:else}
		<table class="data-table">
			<thead>
				<tr>
					<th>Occurred</th>
					<th>User</th>
					<th>Action</th>
					<th>Entity</th>
					<th>Description</th>
					<th class="col-actions"></th>
				</tr>
			</thead>
			<tbody>
				{#each data.rows as row (row.id)}
					<tr>
						<td class="nowrap">{row.occurredAtDisplay}</td>
						<td>{row.userDisplayName}</td>
						<td class="mono">{row.action}</td>
						<td class="mono">{row.entityType}#{row.entityId}</td>
						<td>{row.description}</td>
						<td class="col-actions">
							{#if hasDetails(row)}
								<button
									class="detail-toggle"
									onclick={() => toggleExpanded(row.id)}
									aria-expanded={expandedIds.has(row.id)}
								>
									{expandedIds.has(row.id) ? 'Hide' : 'Details'}
								</button>
							{/if}
						</td>
					</tr>
					{#if expandedIds.has(row.id)}
						<tr class="details-row">
							<td colspan="6">
								{#if row.beforeValue !== null}
									<div class="detail-block">
										<p class="detail-label">Before</p>
										<pre class="detail-json">{pretty(row.beforeValue)}</pre>
									</div>
								{/if}
								{#if row.afterValue !== null}
									<div class="detail-block">
										<p class="detail-label">After</p>
										<pre class="detail-json">{pretty(row.afterValue)}</pre>
									</div>
								{/if}
							</td>
						</tr>
					{/if}
				{/each}
			</tbody>
		</table>

		{#if data.totalPages > 1}
			<nav class="pager" aria-label="Audit log pages">
				{#if data.page > 1}
					<a href={pageHref(data.page - 1)} class="pager-btn">&larr; Previous</a>
				{:else}
					<span class="pager-btn disabled">&larr; Previous</span>
				{/if}
				<span class="pager-status">Page {data.page} of {data.totalPages}</span>
				{#if data.page < data.totalPages}
					<a href={pageHref(data.page + 1)} class="pager-btn">Next &rarr;</a>
				{:else}
					<span class="pager-btn disabled">Next &rarr;</span>
				{/if}
			</nav>
		{/if}
	{/if}
</div>

<style>
	.page {
		max-width: 1000px;
		margin: 0 auto;
		padding: 1.5rem 1rem;
	}
	header {
		margin-bottom: 1.25rem;
	}
	.back {
		font-size: 0.85rem;
		color: #555;
		text-decoration: none;
	}
	.back:hover {
		text-decoration: underline;
	}
	h1 {
		margin: 0.25rem 0 0.2rem;
		font-size: 1.4rem;
	}
	.subtitle {
		margin: 0;
		color: #595959;
		font-size: 0.85rem;
	}

	.filter-form {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem 1rem;
		align-items: end;
		background: #fafafa;
		border: 1px solid #e5e5e5;
		border-radius: 8px;
		padding: 1rem;
		margin-bottom: 1.25rem;
	}
	.filter-field {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		font-size: 0.8rem;
	}
	.filter-field-wide {
		flex: 1 1 220px;
	}
	.filter-label {
		font-weight: 600;
		color: #444;
	}
	.filter-field select,
	.filter-field input {
		min-height: 44px;
		padding: 0.4rem 0.5rem;
		border: 1px solid #ccc;
		border-radius: 5px;
		font-size: 0.9rem;
	}
	.filter-actions {
		display: flex;
		gap: 0.5rem;
	}
	.btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: 44px;
		border: none;
		border-radius: 5px;
		cursor: pointer;
		font-size: 0.9rem;
		padding: 0.4rem 1rem;
		text-decoration: none;
	}
	.btn-primary {
		background: #2a5f4c;
		color: #fff;
	}
	.btn-secondary {
		background: #eee;
		color: #333;
	}

	.result-count {
		font-size: 0.85rem;
		color: #555;
		margin: 0 0 0.75rem;
	}
	.empty {
		color: #777;
		font-size: 0.9rem;
		font-style: italic;
	}

	.data-table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.85rem;
	}
	.data-table th,
	.data-table td {
		text-align: left;
		padding: 0.5rem 0.6rem;
		border-bottom: 1px solid #e5e5e5;
		vertical-align: middle;
	}
	.nowrap {
		white-space: nowrap;
	}
	.mono {
		font-family: ui-monospace, Menlo, monospace;
		font-size: 0.8rem;
		color: #444;
	}
	.col-actions {
		white-space: nowrap;
		text-align: right;
	}
	.detail-toggle {
		background: none;
		border: none;
		padding: 0.35rem 0.5rem;
		min-height: 44px;
		font: inherit;
		color: #1a4731;
		text-decoration: underline;
		cursor: pointer;
	}
	.detail-toggle:focus-visible {
		outline: 2px solid #1a4731;
		outline-offset: 2px;
	}
	.details-row td {
		background: #faf7f0;
		padding: 0.75rem 1rem;
	}
	.detail-block {
		margin-bottom: 0.75rem;
	}
	.detail-block:last-child {
		margin-bottom: 0;
	}
	.detail-label {
		margin: 0 0 0.25rem;
		font-size: 0.75rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.03em;
		color: #666;
	}
	.detail-json {
		margin: 0;
		font-family: ui-monospace, Menlo, monospace;
		font-size: 0.8rem;
		white-space: pre-wrap;
		word-break: break-word;
		background: #fff;
		border: 1px solid #e5e5e5;
		border-radius: 5px;
		padding: 0.5rem 0.6rem;
	}

	.pager {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		margin-top: 1.25rem;
	}
	.pager-btn {
		min-height: 44px;
		display: flex;
		align-items: center;
		padding: 0 0.75rem;
		border: 1px solid #ccc;
		border-radius: 6px;
		color: #2a5f4c;
		font-size: 0.85rem;
		text-decoration: none;
	}
	.pager-btn.disabled {
		color: #999;
		opacity: 0.6;
	}
	.pager-btn:focus-visible {
		outline: 2px solid #2a5f4c;
		outline-offset: 2px;
	}
	.pager-status {
		font-size: 0.85rem;
		color: #555;
	}
</style>
