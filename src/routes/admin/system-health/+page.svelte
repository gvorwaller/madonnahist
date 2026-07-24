<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { onMount } from 'svelte';

	const { data } = $props();

	onMount(() => {
		const interval = setInterval(() => invalidateAll(), 30_000);
		return () => clearInterval(interval);
	});

	function formatUptime(seconds: number): string {
		const d = Math.floor(seconds / 86400);
		const h = Math.floor((seconds % 86400) / 3600);
		const m = Math.floor((seconds % 3600) / 60);
		if (d > 0) return `${d}d ${h}h ${m}m`;
		if (h > 0) return `${h}h ${m}m`;
		return `${m}m`;
	}

	function formatAge(seconds: number): string {
		if (seconds < 60) return `${seconds}s ago`;
		const mins = Math.floor(seconds / 60);
		if (mins < 60) return `${mins}m ago`;
		return `${Math.floor(mins / 60)}h ${mins % 60}m ago`;
	}

	const workerOnline = $derived(
		data.worker?.age_seconds !== undefined ? data.worker.age_seconds < 420 : false
	);
	const enrichmentWorkerOnline = $derived(
		data.enrichmentWorker?.age_seconds !== undefined ? data.enrichmentWorker.age_seconds < 420 : false
	);
</script>

<div class="page">
	<header>
		<a href="/admin" class="back">Admin</a>
		<h1>System Health</h1>
		<p class="subtitle">Auto-refreshes every 30 seconds</p>
	</header>

	<div class="grid">
		<section class="card">
			<h2>DB Backup</h2>
			{#if data.dbBackup}
				<dl>
					<dt>Status</dt>
					<dd>
						{#if data.dbBackup.stale}
							STALE — no run in over 26h (check cron / log)
						{:else}
							{data.dbBackup.status === 'ok' ? 'OK' : `FAILED${data.dbBackup.error ? ` — ${data.dbBackup.error}` : ''}`}
						{/if}
					</dd>
					<dt>Last run</dt><dd>{new Date(data.dbBackup.at).toLocaleString()}</dd>
					{#if data.dbBackup.dump_bytes}
						<dt>Dump size</dt><dd>{(data.dbBackup.dump_bytes / 1048576).toFixed(1)} MB</dd>
					{/if}
					{#if data.dbBackup.nightly_count}
						<dt>Nightlies kept</dt><dd>{data.dbBackup.nightly_count}</dd>
					{/if}
				</dl>
			{:else}
				<p class="muted-note">No backup has reported yet (nightly cron; see docs/db-backup-runbook.md).</p>
			{/if}
		</section>

		<section class="card">
			<h2>Web Process</h2>
			<dl>
				<dt>RSS</dt><dd>{data.process.rss} MB</dd>
				<dt>Heap</dt><dd>{data.process.heapUsed} / {data.process.heapTotal} MB</dd>
				<dt>External</dt><dd>{data.process.external} MB</dd>
				<dt>Uptime</dt><dd>{formatUptime(data.process.uptime)}</dd>
			</dl>
		</section>

		<section class="card">
			<h2>System</h2>
			<dl>
				<dt>CPUs</dt><dd>{data.system.cpus}</dd>
				<dt>Memory</dt><dd>{data.system.freeMem} / {data.system.totalMem} MB free</dd>
				{#if data.system.memAvailable !== null}
					<dt>Available</dt><dd>{data.system.memAvailable} MB</dd>
				{/if}
				{#if data.system.swapTotal !== null}
					<dt>Swap</dt><dd>{data.system.swapFree} / {data.system.swapTotal} MB free</dd>
				{/if}
				<dt>Load</dt><dd>{data.system.loadAvg.join(' / ')}</dd>
			</dl>
		</section>

		<section class="card">
			<h2>OCR Worker</h2>
			{#if data.worker}
				<dl>
					<dt>Status</dt>
					<dd>
						<span class="status-dot" class:online={workerOnline} class:offline={!workerOnline}></span>
						{workerOnline ? 'Online' : 'Offline'}
					</dd>
					<dt>PID</dt><dd>{data.worker.pid}</dd>
					<dt>RSS</dt><dd>{data.worker.rss_mb} MB</dd>
					<dt>Last Poll</dt><dd>{formatAge(data.worker.age_seconds)}</dd>
				</dl>
			{:else}
				<p class="empty">No heartbeat received yet</p>
			{/if}
		</section>

		<section class="card">
			<h2>Enrichment Worker</h2>
			{#if data.enrichmentWorker}
				<dl>
					<dt>Status</dt>
					<dd>
						<span class="status-dot" class:online={enrichmentWorkerOnline} class:offline={!enrichmentWorkerOnline}></span>
						{enrichmentWorkerOnline ? 'Online' : 'Offline'}
					</dd>
					<dt>PID</dt><dd>{data.enrichmentWorker.pid}</dd>
					<dt>RSS</dt><dd>{data.enrichmentWorker.rss_mb} MB</dd>
					<dt>Last Poll</dt><dd>{formatAge(data.enrichmentWorker.age_seconds)}</dd>
				</dl>
			{:else}
				<p class="empty">No heartbeat received yet</p>
			{/if}
		</section>

		<section class="card">
			<h2>Job Queue</h2>
			<dl>
				<dt>Pending</dt><dd>{data.jobs.pending}</dd>
				<dt>In Progress</dt><dd>{data.jobs.in_progress}</dd>
				<dt>Done</dt><dd>{data.jobs.done}</dd>
				<dt>Failed</dt><dd>{data.jobs.failed}</dd>
				<dt>Canceled</dt><dd>{data.jobs.canceled}</dd>
				{#if data.jobs.last_completed}
					<dt>Last Completed</dt><dd>{new Date(data.jobs.last_completed).toLocaleString()}</dd>
				{/if}
			</dl>
		</section>

		<section class="card">
			<h2>Ingestion</h2>
			<dl>
				<dt>Pages</dt><dd>{data.ingestion.total_pages}</dd>
				<dt>Days</dt><dd>{data.ingestion.total_days}</dd>
				<dt>With OCR</dt><dd>{data.ingestion.days_with_ocr}</dd>
				<dt>Pre-gen Crops</dt><dd>{data.ingestion.days_with_crops}</dd>
				<dt>Corrected</dt><dd>{data.ingestion.days_with_corrections}</dd>
			</dl>
		</section>
	</div>
</div>

<style>
	.page {
		max-width: 900px;
		margin: 0 auto;
		padding: 1.5rem;
	}
	header { margin-bottom: 1.5rem; }
	.back {
		font-size: 0.85rem;
		color: #555;
		text-decoration: none;
	}
	.back:hover { text-decoration: underline; }
	h1 {
		margin: 0.25rem 0 0.2rem;
		font-size: 1.4rem;
	}
	.subtitle {
		margin: 0;
		color: #595959;
		font-size: 0.8rem;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
		gap: 1rem;
	}
	.card {
		border: 1px solid #e0e0e0;
		border-radius: 6px;
		padding: 1rem 1.25rem;
		background: #fff;
	}
	.muted-note {
		font-size: 0.85rem;
		font-style: italic;
		color: #555; /* 7:1 on white */
		margin: 0;
	}
	.card h2 {
		margin: 0 0 0.75rem;
		font-size: 1rem;
		color: #333;
	}
	dl {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 0.3rem 1rem;
		margin: 0;
		font-size: 0.85rem;
	}
	dt {
		color: #595959;
		font-weight: 500;
	}
	dd {
		margin: 0;
		color: #1a1a1a;
		font-variant-numeric: tabular-nums;
	}
	.status-dot {
		display: inline-block;
		width: 8px;
		height: 8px;
		border-radius: 50%;
		margin-right: 0.3rem;
		vertical-align: middle;
	}
	.status-dot.online { background: #1a7a1a; }
	.status-dot.offline { background: #c33; }
	.empty {
		color: #595959;
		font-size: 0.85rem;
		font-style: italic;
	}
</style>
