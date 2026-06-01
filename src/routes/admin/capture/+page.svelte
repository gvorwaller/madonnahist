<script lang="ts">
	import { enhance } from '$app/forms';
	import { GRID_TEMPLATES, buildDayGrid } from '$lib/ingest/day-grid';
	import type { PageData, ActionData } from './$types';

	const templateKeys = Object.keys(GRID_TEMPLATES);

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// Per-row operator overrides (only set when the operator changes a field).
	let overrides = $state<Record<number, { year?: number; month?: number; template?: string }>>({});
	let checked = $state<Record<number, boolean>>({});
	let classifying = $state(false);
	let ingesting = $state(false);
	let showCompleted = $state(false);

	const months = [
		'January', 'February', 'March', 'April', 'May', 'June',
		'July', 'August', 'September', 'October', 'November', 'December'
	];
	const years = Array.from({ length: 71 }, (_, i) => 1960 + i);

	function previewUrl(session: string, filename: string, w = 400) {
		return `/admin/capture/preview/${session}/${filename}?w=${w}`;
	}

	function rowYear(r: PageData['active'][number]): number | '' {
		return overrides[r.id]?.year ?? r.approved_year ?? r.proposed_year ?? '';
	}
	function rowMonth(r: PageData['active'][number]): number | '' {
		return overrides[r.id]?.month ?? r.approved_month ?? r.proposed_month ?? '';
	}
	/** Does `template` have room for this year/month? Unknown date → don't prejudge. */
	function fits(template: string, year: number | '', month: number | ''): boolean {
		if (year === '' || month === '') return true;
		const layout = GRID_TEMPLATES[template];
		return layout ? buildDayGrid(Number(year), Number(month), layout).fits : false;
	}
	function rowTemplate(r: PageData['active'][number]): string {
		const chosen = overrides[r.id]?.template ?? r.grid_template_key;
		if (chosen) return chosen;
		// Default to the first template that fits the proposed date.
		const y = rowYear(r);
		const m = rowMonth(r);
		return templateKeys.find((k) => fits(k, y, m)) ?? templateKeys[0];
	}
	function setField(id: number, field: 'year' | 'month' | 'template', value: number | string | undefined) {
		const current = overrides[id] ?? {};
		if (value === undefined) {
			const { [field]: _, ...rest } = current;
			overrides[id] = rest;
		} else {
			overrides[id] = { ...current, [field]: value };
		}
	}

	const unclassifiedCount = $derived(data.active.filter((r) => r.status === 'unclassified').length);

	// Build the ingest payload from checked rows that have a valid year+month.
	const ingestItems = $derived(
		data.active
			.filter((r) => checked[r.id])
			.filter((r) => {
				// Exclude duplicates — they must use the Replace button, not batch ingest.
				const y = rowYear(r);
				const m = rowMonth(r);
				if (y !== '' && m !== '' && existingByYM.has(`${y}-${m}`)) return false;
				return true;
			})
			.map((r) => ({
				id: r.id,
				year: rowYear(r),
				month: rowMonth(r),
				templateKey: rowTemplate(r)
			}))
			.filter(
				(it) =>
					typeof it.year === 'number' && it.year >= 1960 && it.year <= 2030 &&
					typeof it.month === 'number' && it.month >= 1 && it.month <= 12 &&
					fits(it.templateKey, it.year, it.month)
			)
	);
	const ingestPayload = $derived(JSON.stringify(ingestItems));

	function confidenceLabel(c: string | null): string {
		if (c === 'high') return 'HIGH';
		if (c === 'medium') return 'MED';
		if (c === 'low') return 'LOW';
		return '—';
	}
	function qualityLabel(v: string): string {
		if (v === 'good') return 'GOOD';
		if (v === 'reshoot_advised') return '⚠ RESHOOT?';
		if (v === 'reshoot_required') return '⛔ RESHOOT';
		return 'PENDING';
	}

	// Build a lookup of existing pages by "year-month" for client-side duplicate detection.
	const existingByYM = $derived(
		new Map(data.existingPages.map((p) => [`${p.year}-${p.month}`, p]))
	);

	interface DupInfo { page_id: number; camera_filename: string | null; hasCorrections: boolean }

	function dupInfo(r: PageData['active'][number]): DupInfo | null {
		const y = rowYear(r);
		const m = rowMonth(r);
		if (y === '' || m === '') return null;
		const existing = existingByYM.get(`${y}-${m}`);
		if (!existing) return null;
		return { page_id: existing.page_id, camera_filename: existing.camera_filename, hasCorrections: existing.correction_count > 0 };
	}

	let replacing = $state<Record<number, boolean>>({});
</script>

<div class="capture-page">
	<header>
		<h1>Capture Intake</h1>
		<p class="subtitle">
			{data.active.length} active &middot; {data.completed.length} ingested
			{#if !data.tetherExists}<span class="warn-inline"> &middot; tether folder not found</span>{/if}
		</p>
	</header>

	{#if form && 'error' in form && form.error}
		<div class="banner error">{form.error}</div>
	{/if}
	{#if form && 'classified' in form}
		<div class="banner success">Classified {form.classified} image{form.classified === 1 ? '' : 's'}.</div>
	{/if}
	{#if form && 'ingested' in form}
		<div class="banner success">Ingested {form.ingested} page{form.ingested === 1 ? '' : 's'}.</div>
	{/if}
	{#if form && 'replaced' in form}
		<div class="banner success">Replaced existing page (now page #{form.pageId}).</div>
	{/if}
	{#if form && 'errors' in form && form.errors && form.errors.length > 0}
		<div class="banner error">
			<strong>{form.errors.length} problem{form.errors.length === 1 ? '' : 's'}:</strong>
			<ul>
				{#each form.errors as e (e.id)}<li>#{e.id}: {e.error}</li>{/each}
			</ul>
		</div>
	{/if}

	<div class="toolbar">
		<form
			method="POST"
			action="?/classify"
			use:enhance={() => {
				classifying = true;
				return async ({ update }) => {
					await update();
					classifying = false;
				};
			}}
		>
			<button type="submit" class="btn primary" disabled={classifying || unclassifiedCount === 0}>
				{classifying ? 'Classifying…' : `Classify All (${unclassifiedCount})`}
			</button>
		</form>

		<form
			method="POST"
			action="?/ingest"
			use:enhance={() => {
				ingesting = true;
				return async ({ update }) => {
					await update();
					ingesting = false;
					checked = {};
				};
			}}
		>
			<input type="hidden" name="items" value={ingestPayload} />
			<button type="submit" class="btn primary" disabled={ingesting || ingestItems.length === 0}>
				{ingesting ? 'Ingesting…' : `Ingest Selected (${ingestItems.length})`}
			</button>
		</form>
	</div>

	{#if data.active.length === 0}
		<p class="empty">No active images. Shoot pages into the tether folder, then reload.</p>
	{/if}

	<div class="grid">
		{#each data.active as r (r.id)}
			{@const dup = dupInfo(r)}
			<div class="card" class:reshoot={r.status === 'reshoot'} class:errored={!!r.ingest_error} class:duplicate={dup !== null}>
				<label class="select-box">
					<input type="checkbox" bind:checked={checked[r.id]} disabled={r.status === 'reshoot' || (dup !== null && dup.hasCorrections)} />
				</label>

				<img src={previewUrl(r.tether_session, r.camera_filename)} alt={r.camera_filename} loading="lazy" />

				<div class="card-body">
					<div class="filename">{r.camera_filename}</div>
					<div class="badges">
						<span class="badge conf-{r.classification_confidence ?? 'none'}">
							{confidenceLabel(r.classification_confidence)}
						</span>
						<span class="badge qual-{r.quality_verdict}">{qualityLabel(r.quality_verdict)}</span>
						{#if r.status === 'reshoot'}<span class="badge reshoot-badge">RESHOOT</span>{/if}
					</div>

					{#if r.quality_notes}<div class="notes">{r.quality_notes}</div>{/if}
					{#if r.ingest_error}<div class="notes err-note">Ingest failed: {r.ingest_error}</div>{/if}

					<div class="fields">
						<select
							aria-label="Year"
							value={rowYear(r)}
							onchange={(e) => {
								const v = e.currentTarget.value;
								setField(r.id, 'year', v === '' ? undefined : Number(v));
							}}
						>
							<option value="">Year</option>
							{#each years as y (y)}<option value={y}>{y}</option>{/each}
						</select>
						<select
							aria-label="Month"
							value={rowMonth(r)}
							onchange={(e) => {
								const v = e.currentTarget.value;
								setField(r.id, 'month', v === '' ? undefined : Number(v));
							}}
						>
							<option value="">Month</option>
							{#each months as m, i (m)}<option value={i + 1}>{m}</option>{/each}
						</select>
						<select
							aria-label="Layout"
							value={rowTemplate(r)}
							onchange={(e) => setField(r.id, 'template', e.currentTarget.value)}
						>
							{#each templateKeys as t (t)}
								{@const ok = fits(t, rowYear(r), rowMonth(r))}
								<option value={t} disabled={!ok}>{t}{ok ? '' : ' — won’t fit'}</option>
							{/each}
						</select>
					</div>
					{#if !fits(rowTemplate(r), rowYear(r), rowMonth(r))}
						<div class="notes err-note">Selected layout can’t hold this month — pick another.</div>
					{/if}

					{#if dup}
						<div class="notes dup-note">
							{months[(rowMonth(r) as number) - 1]} {rowYear(r)} already ingested
							{#if dup.camera_filename}({dup.camera_filename}, page #{dup.page_id}){:else}(page #{dup.page_id}){/if}
							{#if dup.hasCorrections}
								— has corrections, cannot replace from here
							{:else}
								— no corrections yet
							{/if}
						</div>
						{#if !dup.hasCorrections}
							<form method="POST" action="?/replace" use:enhance={() => {
								replacing[r.id] = true;
								return async ({ update }) => {
									await update();
									replacing[r.id] = false;
								};
							}}>
								<input type="hidden" name="intakeId" value={r.id} />
								<input type="hidden" name="replacePageId" value={dup.page_id} />
								<input type="hidden" name="year" value={rowYear(r)} />
								<input type="hidden" name="month" value={rowMonth(r)} />
								<input type="hidden" name="templateKey" value={rowTemplate(r)} />
								<button type="submit" class="btn small replace-btn" disabled={replacing[r.id]}>
									{replacing[r.id] ? 'Replacing…' : 'Replace Existing'}
								</button>
							</form>
						{/if}
					{/if}

					<div class="card-actions">
						<form method="POST" action="?/setStatus" use:enhance>
							<input type="hidden" name="id" value={r.id} />
							<input type="hidden" name="status" value={r.status === 'reshoot' ? 'unclassified' : 'reshoot'} />
							<button type="submit" class="btn small">
								{r.status === 'reshoot' ? 'Un-flag' : 'Reshoot'}
							</button>
						</form>
						<form method="POST" action="?/setStatus" use:enhance>
							<input type="hidden" name="id" value={r.id} />
							<input type="hidden" name="status" value="rejected" />
							<button type="submit" class="btn small danger">Reject</button>
						</form>
					</div>
				</div>
			</div>
		{/each}
	</div>

	{#if data.completed.length > 0}
		<section class="completed">
			<button class="completed-toggle" onclick={() => (showCompleted = !showCompleted)}>
				{showCompleted ? '▾' : '▸'} Completed ({data.completed.length})
			</button>
			{#if showCompleted}
				<ul class="completed-list">
					{#each data.completed as r (r.id)}
						<li>
							<span class="mono">{r.camera_filename}</span>
							→ {r.approved_year}-{String(r.approved_month).padStart(2, '0')}
							<span class="muted">(page #{r.page_id})</span>
						</li>
					{/each}
				</ul>
			{/if}
		</section>
	{/if}
</div>

<style>
	.capture-page {
		max-width: 1280px;
		margin: 0 auto;
		padding: 1.5rem;
		font-family: -apple-system, 'Helvetica Neue', Helvetica, Arial, sans-serif;
		color: #1a1a1a;
	}
	header { margin-bottom: 1rem; }
	h1 { font-size: 1.4rem; margin: 0 0 0.25rem; }
	.subtitle { margin: 0; color: #555; font-size: 0.9rem; }
	.warn-inline { color: #8a5a00; font-weight: 600; }

	.banner { padding: 0.6rem 1rem; border-radius: 4px; margin-bottom: 0.75rem; font-size: 0.9rem; }
	.banner.error { background: #fde8e8; border: 1px solid #c00; color: #7a0000; }
	.banner.success { background: #e8f5e9; border: 1px solid #2e7d32; color: #14431a; }
	.banner ul { margin: 0.4rem 0 0; padding-left: 1.1rem; }

	.toolbar { display: flex; gap: 0.75rem; margin-bottom: 1rem; }
	.btn {
		padding: 0.5rem 1rem; font: inherit; font-weight: 600; border-radius: 4px;
		border: 1px solid #bbb; background: #fff; cursor: pointer;
	}
	.btn.primary { background: #1a73e8; border-color: #1a73e8; color: #fff; }
	.btn.primary:disabled { opacity: 0.5; cursor: not-allowed; }
	.btn.small { padding: 0.3rem 0.6rem; font-size: 0.8rem; }
	.btn.danger { color: #900; border-color: #d99; }

	.empty { color: #555; font-style: italic; padding: 2rem 0; }

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
		gap: 1rem;
	}
	.card {
		position: relative;
		border: 2px solid #ddd; border-radius: 8px; background: #fff; overflow: hidden;
		display: flex; flex-direction: column;
	}
	.card.reshoot { border-color: #b8860b; background: #fff8e6; }
	.card.errored { border-color: #c00; }
	.card.duplicate { border-color: #b8860b; }
	.card img {
		width: 100%; height: 180px; object-fit: cover; background: #eee; display: block;
	}
	.select-box {
		position: absolute; top: 6px; left: 6px; z-index: 1;
		background: rgba(255, 255, 255, 0.9); border-radius: 4px; padding: 2px 5px;
	}
	.select-box input { width: 18px; height: 18px; }
	.card-body { padding: 0.6rem 0.75rem 0.75rem; display: flex; flex-direction: column; gap: 0.4rem; }
	.filename { font-size: 0.85rem; font-weight: 600; }

	.badges { display: flex; gap: 0.35rem; flex-wrap: wrap; }
	.badge {
		font-size: 0.7rem; font-weight: 700; padding: 0.1rem 0.4rem; border-radius: 3px;
		border: 1px solid; letter-spacing: 0.02em;
	}
	.conf-high { background: #e8f5e9; color: #14431a; border-color: #2e7d32; }
	.conf-medium { background: #fff4e0; color: #6b3b00; border-color: #b8860b; }
	.conf-low, .conf-none { background: #f0f0f0; color: #444; border-color: #999; }
	.qual-good { background: #e8f5e9; color: #14431a; border-color: #2e7d32; }
	.qual-reshoot_advised { background: #fff4e0; color: #6b3b00; border-color: #b8860b; }
	.qual-reshoot_required { background: #fde8e8; color: #7a0000; border-color: #c00; }
	.qual-pending { background: #f0f0f0; color: #444; border-color: #999; }
	.reshoot-badge { background: #fff4e0; color: #6b3b00; border-color: #b8860b; }

	.notes { font-size: 0.75rem; color: #555; line-height: 1.3; }
	.err-note { color: #7a0000; }
	.dup-note { color: #6b3b00; background: #fff8e6; padding: 0.3rem 0.5rem; border-radius: 3px; border: 1px solid #b8860b; }
	.replace-btn { color: #6b3b00; border-color: #b8860b; background: #fff8e6; }

	.fields { display: flex; gap: 0.35rem; flex-wrap: wrap; }
	.fields select {
		padding: 0.3rem 0.4rem; font-size: 0.8rem; border: 1px solid #ccc; border-radius: 4px; background: #fff;
		flex: 1; min-width: 80px;
	}

	.card-actions { display: flex; gap: 0.4rem; }

	.completed { margin-top: 1.5rem; border-top: 1px solid #ddd; padding-top: 0.75rem; }
	.completed-toggle {
		background: none; border: none; font: inherit; font-weight: 600; cursor: pointer; color: #333; padding: 0;
	}
	.completed-list { list-style: none; margin: 0.5rem 0 0; padding: 0; font-size: 0.85rem; color: #555; }
	.completed-list li { padding: 0.15rem 0; }
	.mono { font-family: ui-monospace, monospace; }
	.muted { color: #888; }
</style>
