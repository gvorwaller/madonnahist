<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';

	const { data } = $props();

	interface ExportYearRow {
		year: number;
		accepted: number;
		total: number;
		percent: number;
		pending: boolean;
	}
	interface ExportListRow {
		id: number;
		year: string;
		byteSize: number;
		dayCount: number;
		createdAt: string;
	}

	let actionError = $state('');
	let deleteTarget = $state<ExportListRow | null>(null);

	// Auto-refresh every 30s so a finished generation shows up without a
	// manual reload — same idea as /admin/narratives' polling.
	$effect(() => {
		const timer = setInterval(() => invalidateAll(), 30_000);
		return () => clearInterval(timer);
	});

	function formatBytes(n: number): string {
		if (!Number.isFinite(n) || n < 0) return '—';
		if (n < 1024) return `${n} B`;
		const units = ['KB', 'MB', 'GB'];
		let value = n / 1024;
		let unitIndex = 0;
		while (value >= 1024 && unitIndex < units.length - 1) {
			value /= 1024;
			unitIndex++;
		}
		return `${value.toFixed(1)} ${units[unitIndex]}`;
	}
</script>

<svelte:window
	onkeydown={(e) => {
		if (e.key === 'Escape' && deleteTarget !== null) deleteTarget = null;
	}}
/>

<div class="page">
	<header>
		<a href="/admin" class="back">Admin</a>
		<h1>PDF Exports</h1>
		<p class="subtitle">
			Generate a downloadable, printable PDF of a year's book view — images included, US Letter,
			page-numbered footer. Rendered by the enrichment worker via headless Chromium.
		</p>
	</header>

	{#if actionError}
		<div class="error-banner" role="alert">
			{actionError}
			<button class="error-dismiss" onclick={() => (actionError = '')}>Dismiss</button>
		</div>
	{/if}

	<section>
		<h2>Generate</h2>
		{#if data.years.length === 0}
			<p class="empty">No years have any accepted days yet.</p>
		{:else}
			<table class="data-table">
				<thead>
					<tr>
						<th>Year</th>
						<th class="col-num">Accepted</th>
						<th class="col-actions">Actions</th>
					</tr>
				</thead>
				<tbody>
					{#each data.years as row (row.year)}
						<tr>
							<td>{row.year}</td>
							<td class="col-num">{row.accepted} / {row.total} ({row.percent}%)</td>
							<td class="col-actions">
								<form
									method="POST"
									action="?/generate"
									use:enhance={() => {
										return ({ result, update }) => {
											if (result.type === 'failure') {
												actionError = (result.data as { error?: string })?.error ?? 'Generate failed';
											}
											update();
										};
									}}
								>
									<input type="hidden" name="year" value={row.year} />
									<button type="submit" class="btn btn-sm btn-primary" disabled={row.pending}>
										{row.pending ? 'Generating…' : 'Generate PDF'}
									</button>
								</form>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}
	</section>

	<section>
		<h2>Existing exports</h2>
		{#if data.exports.length === 0}
			<p class="empty">No PDFs generated yet.</p>
		{:else}
			<table class="data-table">
				<thead>
					<tr>
						<th>Year</th>
						<th class="col-num">Size</th>
						<th class="col-num">Days</th>
						<th>Created</th>
						<th class="col-actions">Actions</th>
					</tr>
				</thead>
				<tbody>
					{#each data.exports as row (row.id)}
						<tr>
							<td>{row.year}</td>
							<td class="col-num">{formatBytes(row.byteSize)}</td>
							<td class="col-num">{row.dayCount}</td>
							<td class="col-meta">{new Date(row.createdAt).toLocaleString()}</td>
							<td class="col-actions">
								<a class="btn btn-sm btn-secondary" href="/admin/exports/download/{row.id}">Download</a>
								<button class="btn btn-sm btn-danger" onclick={() => (deleteTarget = row)}>Delete</button>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}
	</section>
</div>

{#if deleteTarget !== null}
	<div class="modal-overlay" role="dialog" aria-modal="true" aria-label="Confirm delete">
		<div class="modal-content">
			<h3>Delete PDF export</h3>
			<p>
				Delete the {deleteTarget.year} PDF ({formatBytes(deleteTarget.byteSize)})? This removes the
				file from storage and cannot be undone. You can generate a new one later.
			</p>
			<div class="modal-actions">
				<button class="btn-cancel" onclick={() => (deleteTarget = null)}>Cancel</button>
				<form
					method="POST"
					action="?/delete"
					use:enhance={() => {
						return ({ result, update }) => {
							if (result.type === 'failure') {
								actionError = (result.data as { error?: string })?.error ?? 'Delete failed';
							}
							deleteTarget = null;
							update();
						};
					}}
				>
					<input type="hidden" name="id" value={deleteTarget.id} />
					<button type="submit" class="btn-danger">Delete</button>
				</form>
			</div>
		</div>
	</div>
{/if}

<style>
	.page {
		max-width: 960px;
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
		max-width: 640px;
	}
	section {
		margin-bottom: 2rem;
	}
	section h2 {
		font-size: 1.05rem;
		margin: 0 0 0.6rem;
	}
	.empty {
		color: #777;
		font-size: 0.85rem;
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
	.col-num {
		text-align: right;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}
	.col-meta {
		color: #666;
		white-space: nowrap;
	}
	.col-actions {
		white-space: nowrap;
	}
	.col-actions form {
		display: inline;
	}
	.btn {
		border: none;
		border-radius: 5px;
		cursor: pointer;
		font-size: 0.8rem;
		padding: 0.35rem 0.7rem;
	}
	.btn-sm {
		margin-right: 0.25rem;
	}
	.btn-primary {
		background: #2a5f4c;
		color: #fff;
	}
	.btn-secondary {
		background: #eee;
		color: #333;
		text-decoration: none;
		display: inline-block;
	}
	.btn-danger {
		background: #b3261e;
		color: #fff;
	}
	.btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.error-banner {
		background: #fdecea;
		border: 1px solid #f5c2c0;
		color: #7a1f1a;
		padding: 0.6rem 0.9rem;
		border-radius: 6px;
		margin-bottom: 1rem;
		font-size: 0.85rem;
		display: flex;
		justify-content: space-between;
		align-items: center;
	}
	.error-dismiss {
		background: none;
		border: none;
		color: #7a1f1a;
		text-decoration: underline;
		cursor: pointer;
		font-size: 0.8rem;
	}

	.modal-overlay {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.45);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 100;
	}
	.modal-content {
		background: #fff;
		border-radius: 8px;
		padding: 1.25rem 1.5rem;
		max-width: 460px;
		width: 90%;
	}
	.modal-content h3 {
		margin: 0 0 0.5rem;
		font-size: 1.05rem;
	}
	.modal-content p {
		margin: 0 0 1rem;
		font-size: 0.9rem;
		color: #444;
		line-height: 1.5;
	}
	.modal-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.6rem;
	}
	.btn-cancel {
		background: #eee;
		border: none;
		border-radius: 5px;
		padding: 0.4rem 0.9rem;
		cursor: pointer;
		font-size: 0.85rem;
	}
</style>
