<script lang="ts">
	import { enhance } from '$lib/forms';
	import { invalidateAll } from '$app/navigation';
	import DecadeFolds from '$lib/components/admin/DecadeFolds.svelte';

	const { data } = $props();

	type ContentMode = 'full' | 'narrative' | 'days';

	interface ExportYearRow {
		year: number;
		accepted: number;
		total: number;
		percent: number;
		pending: boolean;
		hasPublishedNarrative: boolean;
		narrative: { by: string; published: boolean; changedAt: string } | null;
	}
	interface ExportListRow {
		id: number;
		year: string;
		byteSize: number;
		dayCount: number;
		createdAt: string;
		contentMode: ContentMode;
	}

	const CONTENT_MODE_LABELS: Record<ContentMode, string> = {
		full: 'Full history (days + narrative)',
		narrative: 'Narrative only',
		days: 'Days only'
	};

	// Decade sections (Gaylon, 2026-11-18). Generate: a decade starts open
	// while one of its PDFs is generating. Existing exports: the decade of
	// the newest PDF starts open. Both remembered per tab (DecadeFolds).
	const yearsWithPdf = $derived(new Set(data.exports.map((e) => Number(e.year))));

	// What each year already has, per kind of PDF: the newest export of each
	// (data.exports is newest first), so the Generate table shows what exists
	// without cross-referencing the Existing exports list.
	const MODES: ContentMode[] = ['full', 'narrative', 'days'];
	const SHORT_MODE_LABELS: Record<ContentMode, string> = {
		full: 'Full history',
		narrative: 'Narrative only',
		days: 'Days only'
	};
	const latestPdf = $derived.by(() => {
		const m = new Map<string, ExportListRow>();
		for (const e of data.exports as ExportListRow[]) {
			const key = `${e.year}:${e.contentMode}`;
			if (!m.has(key)) m.set(key, e);
		}
		return m;
	});
	/**
	 * Why a PDF may no longer match the archive. Days: how far the
	 * accepted-day count has moved since (not for narrative-only PDFs).
	 * Story: the year's text, or whether it is published, changed after the
	 * PDF was made (not for days-only PDFs, which have no story).
	 */
	function staleNotes(row: ExportYearRow, e: ExportListRow): string[] {
		const notes: string[] = [];
		if (e.contentMode !== 'narrative') {
			const diff = row.accepted - e.dayCount;
			if (diff > 0) notes.push(`${plural(diff, 'more day', 'more days')} accepted since`);
			if (diff < 0) notes.push(`${plural(-diff, 'fewer accepted day', 'fewer accepted days')} now`);
		}
		if (e.contentMode !== 'days' && row.narrative && new Date(row.narrative.changedAt) > new Date(e.createdAt)) {
			notes.push('story changed since');
		}
		return notes;
	}
	const shortDate = (ts: string) =>
		new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
	const newestExportId = $derived(data.exports[0]?.id ?? null);
	const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

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
			<DecadeFolds
				items={data.years}
				storageKey="admin.exports.generate.openDecades"
				startOpen={(list) => list.some((r) => r.pending)}
			>
				{#snippet summary(list)}
					{plural(list.length, 'year', 'years')} · {list.filter((r) => yearsWithPdf.has(r.year)).length} with a PDF
					{#if list.some((r) => r.pending)}
						<span class="generating">generating…</span>
					{/if}
				{/snippet}
				{#snippet children(list)}
					<table class="data-table gen-table">
						<thead>
							<tr>
								<th>Year</th>
								<th class="col-num">Accepted</th>
								<th>PDFs</th>
								<th class="col-actions">Content &amp; actions</th>
							</tr>
						</thead>
						<tbody>
							{#each list as row (row.year)}
								<tr>
									<td class="col-year">{row.year}</td>
									<td class="col-num">{row.accepted} / {row.total} ({row.percent}%)</td>
									<td class="col-pdfs">
										<p class="story-line">
											{#if row.narrative}
												<span class="pdf-kind">Story in use:</span> {row.narrative.by}
												&middot; {row.narrative.published ? 'published' : 'not published'}
											{:else}
												Story in use: none yet
											{/if}
										</p>
										<ul class="pdf-list" aria-label="PDFs for {row.year}">
											{#each MODES as mode (mode)}
												{@const e = latestPdf.get(`${row.year}:${mode}`)}
												<li class:none={!e}>
													<span class="pdf-kind">{SHORT_MODE_LABELS[mode]}{#if !e}: none yet{/if}</span>
													{#if e}
														&middot; {shortDate(e.createdAt)} &middot; {formatBytes(e.byteSize)}
														<a
															class="pdf-dl"
															href="/admin/exports/download/{e.id}"
															aria-label="Download the {row.year} {SHORT_MODE_LABELS[mode]} PDF from {shortDate(e.createdAt)}"
															>Download</a
														>
														{#each staleNotes(row, e) as note (note)}
															<span class="stale">⚠ {note}</span>
														{/each}
													{/if}
												</li>
											{/each}
										</ul>
									</td>
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
											<select name="contentMode" class="mode-select">
												<option value="full">{CONTENT_MODE_LABELS.full}</option>
												<option value="narrative" disabled={!row.hasPublishedNarrative}>
													{CONTENT_MODE_LABELS.narrative}{row.hasPublishedNarrative ? '' : ' (no published narrative)'}
												</option>
												<option value="days">{CONTENT_MODE_LABELS.days}</option>
											</select>
											<button type="submit" class="btn btn-sm btn-primary" disabled={row.pending}>
												{row.pending ? 'Generating…' : 'Generate PDF'}
											</button>
										</form>
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				{/snippet}
			</DecadeFolds>
		{/if}
	</section>

	<section>
		<h2>Existing exports</h2>
		{#if data.exports.length === 0}
			<p class="empty">No PDFs generated yet.</p>
		{:else}
			<DecadeFolds
				items={data.exports}
				storageKey="admin.exports.existing.openDecades"
				startOpen={(list) => list.some((r) => r.id === newestExportId)}
			>
				{#snippet summary(list)}
					{plural(list.length, 'PDF', 'PDFs')} · {formatBytes(list.reduce((n, r) => n + r.byteSize, 0))}
				{/snippet}
				{#snippet children(list)}
					<table class="data-table exist-table">
						<thead>
							<tr>
								<th>Year</th>
								<th>Content</th>
								<th class="col-num">Size</th>
								<th class="col-num">Days</th>
								<th>Created</th>
								<th class="col-actions">Actions</th>
							</tr>
						</thead>
						<tbody>
							{#each list as row (row.id)}
								<tr>
									<td class="col-year">{row.year}</td>
									<td class="col-content">{CONTENT_MODE_LABELS[row.contentMode]}</td>
									<td class="col-num" data-label="Size">{formatBytes(row.byteSize)}</td>
									<td class="col-num" data-label="Days">{row.dayCount}</td>
									<td class="col-meta" data-label="Created">{new Date(row.createdAt).toLocaleString()}</td>
									<td class="col-actions">
										<a class="btn btn-sm btn-secondary" href="/admin/exports/download/{row.id}">Download</a>
										<button class="btn btn-sm btn-danger" onclick={() => (deleteTarget = row)}>Delete</button>
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				{/snippet}
			</DecadeFolds>
		{/if}
	</section>
</div>

{#if deleteTarget !== null}
	<div class="modal-overlay" role="dialog" aria-modal="true" aria-label="Confirm delete">
		<div class="modal-content">
			<h3>Delete PDF export</h3>
			<p>
				Delete the {deleteTarget.year} {CONTENT_MODE_LABELS[deleteTarget.contentMode]} PDF
				({formatBytes(deleteTarget.byteSize)})? This removes the file from storage and cannot be
				undone. You can generate a new one later.
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
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
	}
	.generating {
		font-style: italic;
		color: #4a4a4a;
	}
	.story-line {
		margin: 0 0 0.2rem;
		font-size: 0.8rem;
		color: #333;
	}
	.pdf-list {
		list-style: none;
		margin: 0;
		padding: 0;
		font-size: 0.8rem;
		color: #333;
		line-height: 1.6;
	}
	.pdf-list li.none {
		color: #4a4a4a;
	}
	.pdf-kind {
		font-weight: 600;
	}
	.pdf-list li.none .pdf-kind {
		font-weight: 400;
	}
	.pdf-dl {
		margin-left: 0.3rem;
		color: #1f4d3d;
	}
	.stale {
		display: block;
		color: #7a4a00;
		font-size: 0.75rem;
	}
	/* Narrow screens: each year becomes a card instead of a wide row. */
	@media (max-width: 760px) {
		.gen-table thead {
			display: none;
		}
		.gen-table tr {
			display: block;
			padding: 0.6rem 0;
			border-bottom: 1px solid #e5e5e5;
		}
		.gen-table td {
			display: block;
			border: none;
			padding: 0.2rem 0.6rem;
			text-align: left;
		}
		.gen-table .col-year {
			font-weight: 700;
			font-size: 0.95rem;
		}
		.gen-table .col-actions {
			white-space: normal;
		}
		.gen-table .col-actions form {
			flex-wrap: wrap;
		}

		/* Existing exports: year + content as the card's heading, then
		   labelled size / days / created, then the buttons. */
		.exist-table thead {
			display: none;
		}
		.exist-table tr {
			display: block;
			padding: 0.6rem 0;
			border-bottom: 1px solid #e5e5e5;
		}
		.exist-table td {
			border: none;
			padding: 0.15rem 0.6rem;
			text-align: left;
			white-space: normal;
		}
		.exist-table .col-year,
		.exist-table .col-content {
			display: inline-block;
			font-weight: 700;
			font-size: 0.95rem;
			padding-right: 0;
		}
		.exist-table td[data-label] {
			display: block;
		}
		.exist-table td[data-label]::before {
			content: attr(data-label) ': ';
			color: #4a4a4a;
		}
		.exist-table .col-actions {
			display: block;
			padding-top: 0.4rem;
		}
	}
	.mode-select {
		font-size: 0.8rem;
		padding: 0.3rem 0.4rem;
		border: 1px solid #ccc;
		border-radius: 5px;
		background: #fff;
		color: #333;
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
