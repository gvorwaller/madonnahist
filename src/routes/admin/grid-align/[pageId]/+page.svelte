<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { untrack } from 'svelte';

	const { data } = $props();

	const monthNames = ['', 'January', 'February', 'March', 'April', 'May', 'June',
		'July', 'August', 'September', 'October', 'November', 'December'];

	let dirty = $state(false);
	let rerunOcr = $state(true);
	let showConfirmWarning = $state(false);
	let processing = $state(false);
	let savingGrid = $state(false);

	const isWarped = $derived(data.isWarped);
	const initialGridLines = $derived(data.gridLines);
	const rows = $derived(data.rows);
	const cols = $derived(data.cols);

	let corners = $state(untrack(() => structuredClone(initialGridLines.corners)));
	let xLines = $state(untrack(() => [...initialGridLines.xLines]));
	let yLines = $state(untrack(() => [...initialGridLines.yLines]));

	const title = $derived(`${monthNames[data.page.month]} ${data.page.year} — Grid Align`);
	const saved = $derived(page.url.searchParams.get('saved') === '1');

	// The active image dimensions depend on warp state
	const activeWidth = $derived(isWarped ? (data.page.warpedWidth ?? data.page.imageWidth) : data.page.imageWidth);
	const activeHeight = $derived(isWarped ? (data.page.warpedHeight ?? data.page.imageHeight) : data.page.imageHeight);

	// Image container binding and scale
	let container: HTMLDivElement | undefined = $state(undefined);
	let containerWidth = $state(0);
	let imgLoaded = $state(false);

	const scale = $derived(containerWidth > 0 ? containerWidth / activeWidth : 1);
	const displayHeight = $derived(Math.round(activeHeight * scale));

	function updateContainerWidth() {
		if (container) containerWidth = container.getBoundingClientRect().width;
	}

	$effect(() => {
		if (!container) return;
		updateContainerWidth();
		const observer = new ResizeObserver(() => updateContainerWidth());
		observer.observe(container);
		return () => observer.disconnect();
	});

	// Recompute lines from corners (only used in State 1 for preview)
	function recomputeLines() {
		const newXLines: number[] = [];
		for (let c = 0; c <= cols; c++) {
			const t = c / cols;
			const xTop = corners.topLeft[0] + (corners.topRight[0] - corners.topLeft[0]) * t;
			const xBot = corners.bottomLeft[0] + (corners.bottomRight[0] - corners.bottomLeft[0]) * t;
			newXLines.push(Math.round((xTop + xBot) / 2));
		}
		const newYLines: number[] = [];
		for (let r = 0; r <= rows; r++) {
			const t = r / rows;
			const yL = corners.topLeft[1] + (corners.bottomLeft[1] - corners.topLeft[1]) * t;
			const yR = corners.topRight[1] + (corners.bottomRight[1] - corners.topRight[1]) * t;
			newYLines.push(Math.round((yL + yR) / 2));
		}
		xLines = newXLines;
		yLines = newYLines;
		dirty = true;
	}

	// Drag state
	type DragTarget =
		| { type: 'corner'; key: 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight' }
		| { type: 'xLine'; index: number }
		| { type: 'yLine'; index: number }
		| { type: 'translate'; startX: number; startY: number; origCorners: typeof corners; origXLines: number[]; origYLines: number[] };

	let dragTarget: DragTarget | null = $state(null);

	function toOriginal(displayPx: number): number {
		return Math.round(displayPx / scale);
	}

	function onPointerDown(e: PointerEvent, target: DragTarget) {
		e.preventDefault();
		(e.currentTarget as SVGElement).setPointerCapture(e.pointerId);
		dragTarget = target;
	}

	function onPointerMove(e: PointerEvent) {
		if (!dragTarget || !container) return;

		const rect = container.getBoundingClientRect();
		const displayX = e.clientX - rect.left;
		const displayY = e.clientY - rect.top;
		const ox = toOriginal(displayX);
		const oy = toOriginal(displayY);

		if (dragTarget.type === 'corner' && !isWarped) {
			corners[dragTarget.key] = [
				Math.max(0, Math.min(data.page.imageWidth, ox)),
				Math.max(0, Math.min(data.page.imageHeight, oy))
			];
			recomputeLines();
		} else if (dragTarget.type === 'xLine') {
			xLines[dragTarget.index] = Math.max(0, Math.min(activeWidth, ox));
			xLines = [...xLines];
			dirty = true;
		} else if (dragTarget.type === 'yLine') {
			yLines[dragTarget.index] = Math.max(0, Math.min(activeHeight, oy));
			yLines = [...yLines];
			dirty = true;
		} else if (dragTarget.type === 'translate' && !isWarped) {
			const dx = toOriginal(displayX) - toOriginal(dragTarget.startX);
			const dy = toOriginal(displayY) - toOriginal(dragTarget.startY);
			corners = {
				topLeft: [dragTarget.origCorners.topLeft[0] + dx, dragTarget.origCorners.topLeft[1] + dy],
				topRight: [dragTarget.origCorners.topRight[0] + dx, dragTarget.origCorners.topRight[1] + dy],
				bottomLeft: [dragTarget.origCorners.bottomLeft[0] + dx, dragTarget.origCorners.bottomLeft[1] + dy],
				bottomRight: [dragTarget.origCorners.bottomRight[0] + dx, dragTarget.origCorners.bottomRight[1] + dy]
			};
			recomputeLines();
		}
	}

	function onPointerUp() {
		dragTarget = null;
	}

	function onGridAreaPointerDown(e: PointerEvent) {
		if (dragTarget || isWarped) return;
		const rect = container!.getBoundingClientRect();
		dragTarget = {
			type: 'translate',
			startX: e.clientX - rect.left,
			startY: e.clientY - rect.top,
			origCorners: structuredClone(corners),
			origXLines: [...xLines],
			origYLines: [...yLines]
		};
		(e.currentTarget as SVGElement).setPointerCapture(e.pointerId);
	}

	// Keyboard nudge
	let selectedCorner: string | null = $state(null);
	let selectedLine: { axis: 'x' | 'y'; index: number } | null = $state(null);

	function onKeyDown(e: KeyboardEvent) {
		const step = e.shiftKey ? 10 : 1;
		const dx = e.key === 'ArrowRight' ? step : e.key === 'ArrowLeft' ? -step : 0;
		const dy = e.key === 'ArrowDown' ? step : e.key === 'ArrowUp' ? -step : 0;
		if (dx === 0 && dy === 0) return;

		e.preventDefault();
		if (selectedCorner && !isWarped) {
			const key = selectedCorner as keyof typeof corners;
			corners[key] = [corners[key][0] + dx, corners[key][1] + dy];
			recomputeLines();
		} else if (selectedLine && isWarped) {
			if (selectedLine.axis === 'x') {
				xLines[selectedLine.index] += dx;
				xLines = [...xLines];
			} else {
				yLines[selectedLine.index] += dy;
				yLines = [...yLines];
			}
			dirty = true;
		}
	}

	function resetGrid() {
		if (isWarped) {
			// Reset to even spacing on the warped image
			const w = data.page.warpedWidth ?? activeWidth;
			const h = data.page.warpedHeight ?? activeHeight;
			for (let c = 0; c <= cols; c++) xLines[c] = Math.round((c / cols) * w);
			for (let r = 0; r <= rows; r++) yLines[r] = Math.round((r / rows) * h);
			xLines = [...xLines];
			yLines = [...yLines];
			dirty = true;
		} else {
			corners = structuredClone(initialGridLines.corners);
			xLines = [...initialGridLines.xLines];
			yLines = [...initialGridLines.yLines];
			dirty = false;
		}
	}

	function copyFromPrevious() {
		if (!data.previousGrid) return;
		const prev = data.previousGrid.gridLines;
		corners = structuredClone(prev.corners);
		xLines = [...prev.xLines];
		yLines = [...prev.yLines];
		dirty = true;
	}

	// Day label map: (row,col) → day numbers
	const dayLabels = $derived.by(() => {
		const map = new Map<string, string[]>();
		for (const day of data.days) {
			if (day.grid_row === null || day.grid_col === null) continue;
			const key = `${day.grid_row},${day.grid_col}`;
			const dayNum = String(new Date(day.entry_date + 'T00:00:00').getDate());
			const arr = map.get(key) ?? [];
			arr.push(dayNum);
			map.set(key, arr);
		}
		return map;
	});

	// Live crop preview — 5 sample cells
	const previewDays = $derived.by(() => {
		const withPos = data.days.filter(d => d.grid_row !== null && d.grid_col !== null);
		if (withPos.length === 0) return [];
		const picks: typeof withPos = [];
		picks.push(withPos[0]);
		if (withPos.length > 2) picks.push(withPos[Math.floor(withPos.length / 4)]);
		if (withPos.length > 4) picks.push(withPos[Math.floor(withPos.length / 2)]);
		if (withPos.length > 6) picks.push(withPos[Math.floor(withPos.length * 3 / 4)]);
		if (withPos.length > 1) picks.push(withPos[withPos.length - 1]);
		return picks;
	});

	// Image source: warped state shows warped, corners state shows original
	// Cache-bust with grid version to prevent browser serving stale image after warp
	const imageSrc = $derived(
		isWarped
			? `/admin/grid-align/${data.page.id}/page-image?v=${data.page.gridVersion}`
			: `/admin/grid-align/${data.page.id}/page-image?original=1&v=${data.page.gridVersion}`
	);

	// Serialized data for form submission
	const cornersJson = $derived(JSON.stringify(corners));
	const gridLinesJson = $derived(JSON.stringify({
		coordinateSpace: isWarped ? 'warped' : 'original',
		corners,
		xLines,
		yLines
	}));
</script>

<svelte:window onkeydown={onKeyDown} />

<div class="page">
	<header>
		<a href="/admin/ocr-review/{data.page.id}" class="back">Back to OCR Review</a>
		<h1>{title}</h1>
		<div class="toolbar">
			{#if isWarped}
				<span class="state-badge warped">Warped</span>
				<span class="meta">Rows: {rows} &middot; Cols: {cols} &middot; v{data.page.gridVersion}</span>
				<span class="meta hint">Drag lines to match actual grid</span>
			{:else}
				<span class="state-badge corners">Place Corners</span>
				<span class="meta">Rows: {rows} &middot; Cols: {cols} &middot; v{data.page.gridVersion}</span>
				{#if data.previousGrid}
					<button class="btn-secondary" onclick={copyFromPrevious}>
						Copy from {monthNames[data.previousGrid.month]} {data.previousGrid.year}
					</button>
				{/if}
			{/if}
			<button class="btn-secondary" onclick={resetGrid}>Reset</button>
		</div>
		{#if saved}
			<div class="saved-banner">Grid saved and crop bounds updated.</div>
		{/if}
	</header>

	<div
		class="image-container"
		bind:this={container}
		onpointermove={onPointerMove}
		onpointerup={onPointerUp}
		role="application"
		aria-label="Grid alignment editor"
	>
		<img
			src={imageSrc}
			alt="Calendar page"
			onload={() => { imgLoaded = true; updateContainerWidth(); }}
			draggable="false"
		/>

		{#if imgLoaded && containerWidth > 0}
			<svg class="overlay" width={containerWidth} height={displayHeight}>
				<!-- State 1: translate quad area -->
				{#if !isWarped}
					<polygon
						points="{corners.topLeft[0]*scale},{corners.topLeft[1]*scale} {corners.topRight[0]*scale},{corners.topRight[1]*scale} {corners.bottomRight[0]*scale},{corners.bottomRight[1]*scale} {corners.bottomLeft[0]*scale},{corners.bottomLeft[1]*scale}"
						fill="transparent"
						stroke="none"
						style="cursor: move"
						role="none"
						onpointerdown={onGridAreaPointerDown}
					/>
				{/if}

				<!-- Vertical lines -->
				{#each xLines as x, i}
					{@const dx = x * scale}
					{@const isEdge = i === 0 || i === xLines.length - 1}
					<line
						x1={dx} y1={yLines[0] * scale}
						x2={dx} y2={yLines[yLines.length - 1] * scale}
						stroke={isEdge ? 'rgba(255,50,50,0.8)' : 'rgba(255,100,100,0.6)'}
						stroke-width={isEdge ? 3 : 2.5}
						stroke-dasharray={isWarped ? 'none' : '6 4'}
					/>
					{#if isWarped}
						<line
							x1={dx} y1={yLines[0] * scale}
							x2={dx} y2={yLines[yLines.length - 1] * scale}
							stroke="transparent" stroke-width="14"
							style="cursor: col-resize"
							role="none"
							onpointerdown={(e) => {
								selectedLine = { axis: 'x', index: i };
								onPointerDown(e, { type: 'xLine', index: i });
							}}
						/>
					{/if}
				{/each}

				<!-- Horizontal lines -->
				{#each yLines as y, i}
					{@const dy = y * scale}
					{@const isEdge = i === 0 || i === yLines.length - 1}
					<line
						x1={xLines[0] * scale} y1={dy}
						x2={xLines[xLines.length - 1] * scale} y2={dy}
						stroke={isEdge ? 'rgba(255,50,50,0.8)' : 'rgba(255,100,100,0.6)'}
						stroke-width={isEdge ? 3 : 2.5}
						stroke-dasharray={isWarped ? 'none' : '6 4'}
					/>
					{#if isWarped}
						<line
							x1={xLines[0] * scale} y1={dy}
							x2={xLines[xLines.length - 1] * scale} y2={dy}
							stroke="transparent" stroke-width="14"
							style="cursor: row-resize"
							role="none"
							onpointerdown={(e) => {
								selectedLine = { axis: 'y', index: i };
								onPointerDown(e, { type: 'yLine', index: i });
							}}
						/>
					{/if}
				{/each}

				<!-- Day number labels -->
				{#each { length: rows } as _, r}
					{#each { length: cols } as _, c}
						{@const label = dayLabels.get(`${r},${c}`)}
						{#if label}
							{@const cx = ((xLines[c] + xLines[c + 1]) / 2) * scale}
							{@const cy = (yLines[r] * scale) + 16}
							<text x={cx} y={cy} text-anchor="middle"
								fill="rgba(255,255,255,0.9)" font-size="13" font-weight="700"
								stroke="rgba(0,0,0,0.5)" stroke-width="3" paint-order="stroke"
							>{label.join(' / ')}</text>
						{/if}
					{/each}
				{/each}

				<!-- Corner handles (State 1 only) -->
				{#if !isWarped}
					{#each ['topLeft', 'topRight', 'bottomLeft', 'bottomRight'] as key}
						{@const pt = corners[key as keyof typeof corners]}
						<circle
							cx={pt[0] * scale} cy={pt[1] * scale} r="10"
							fill={selectedCorner === key ? 'rgba(255,220,50,0.9)' : 'rgba(255,80,80,0.85)'}
							stroke="#fff" stroke-width="2"
							style="cursor: grab"
							role="none"
							onpointerdown={(e) => {
								selectedCorner = key;
								onPointerDown(e, { type: 'corner', key: key as 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight' });
							}}
						/>
					{/each}
				{/if}
			</svg>
		{/if}
	</div>

	<!-- Live crop preview (warped state only — in corners state the preview isn't meaningful) -->
	{#if isWarped && previewDays.length > 0 && imgLoaded}
		<div class="preview-section">
			<h2>Live Crop Preview</h2>
			<div class="preview-strip">
				{#each previewDays as day}
					{@const dayNum = new Date(day.entry_date + 'T00:00:00').getDate()}
					{@const r = day.grid_row!}
					{@const c = day.grid_col!}
					{@const cropX = xLines[c]}
					{@const cropY = yLines[r]}
					{@const cropW = xLines[c + 1] - cropX}
					{@const cropH = yLines[r + 1] - cropY}
					{@const previewScale = 150 / cropW}
					<div class="preview-cell">
						<span class="preview-label">Day {dayNum}</span>
						<div class="preview-clip" style="width:150px;height:{Math.round(cropH * previewScale)}px;overflow:hidden">
							<img
								src={imageSrc}
								alt="Day {dayNum} crop"
								draggable="false"
								style="
									width:{Math.round(activeWidth * previewScale)}px;
									height:{Math.round(activeHeight * previewScale)}px;
									margin-left:-{Math.round(cropX * previewScale)}px;
									margin-top:-{Math.round(cropY * previewScale)}px;
								"
							/>
						</div>
					</div>
				{/each}
			</div>
		</div>
	{/if}

	<!-- Actions -->
	<div class="actions-bar">
		{#if !isWarped}
			<!-- State 1: Apply Warp -->
			<form method="POST" action="?/applyWarp" use:enhance={() => {
				processing = true;
				return ({ update }) => { processing = false; update(); };
			}}>
				<input type="hidden" name="corners" value={cornersJson} />
				<button type="submit" class="btn-primary" disabled={processing}>
					{processing ? 'Processing warp...' : 'Apply Warp'}
				</button>
			</form>
		{:else}
			<!-- State 2: Save Grid + Re-place Corners -->
			<form method="POST" action="?/saveGrid" use:enhance={() => {
				if (data.hasAcceptedCorrections && !showConfirmWarning) {
					showConfirmWarning = true;
					return ({ update }) => { update({ reset: false }); };
				}
				savingGrid = true;
				return ({ update }) => { savingGrid = false; update(); };
			}}>
				<input type="hidden" name="gridLines" value={gridLinesJson} />
				<input type="hidden" name="rows" value={rows} />
				<input type="hidden" name="cols" value={cols} />
				<input type="hidden" name="rerunOcr" value={String(rerunOcr)} />

				<label class="checkbox-label">
					<input type="checkbox" bind:checked={rerunOcr} />
					Re-run OCR after save
				</label>

				{#if showConfirmWarning}
					<div class="warning-banner">
						This page has accepted human corrections. Saving a new grid will update crop bounds but
						will NOT change corrected text.
						<button type="submit" class="btn-primary">Confirm and Save</button>
						<button type="button" class="btn-secondary" onclick={() => showConfirmWarning = false}>Cancel</button>
					</div>
				{:else}
					<button type="submit" class="btn-primary" disabled={savingGrid || !dirty}>
						{savingGrid ? 'Saving grid...' : 'Apply Grid'}
					</button>
				{/if}
			</form>

			<form method="POST" action="?/resetWarp">
				<button type="submit" class="btn-secondary btn-danger">Re-place Corners</button>
			</form>
		{/if}
	</div>
</div>

<style>
	.page {
		max-width: 1400px;
		margin: 0 auto;
		padding: 1rem;
	}
	header {
		margin-bottom: 1rem;
	}
	.back {
		font-size: 0.85rem;
		color: #555;
		text-decoration: none;
	}
	.back:hover { text-decoration: underline; }
	h1 {
		margin: 0.25rem 0 0.5rem;
		font-size: 1.4rem;
	}
	.toolbar {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		flex-wrap: wrap;
		margin-bottom: 0.5rem;
	}
	.state-badge {
		padding: 0.2rem 0.6rem;
		border-radius: 4px;
		font-size: 0.8rem;
		font-weight: 600;
	}
	.state-badge.corners {
		background: #fff3cd;
		color: #856404;
	}
	.state-badge.warped {
		background: #e6f4e6;
		color: #1a7a1a;
	}
	.meta {
		font-size: 0.85rem;
		color: #666;
	}
	.meta.hint {
		font-style: italic;
	}
	.btn-primary {
		padding: 0.45rem 1.2rem;
		border: none;
		border-radius: 4px;
		background: #1a7a1a;
		color: #fff;
		cursor: pointer;
		font-size: 0.9rem;
		font-weight: 600;
	}
	.btn-primary:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
	.btn-secondary {
		padding: 0.35rem 0.8rem;
		border: 1px solid #ccc;
		border-radius: 4px;
		background: #fff;
		cursor: pointer;
		font-size: 0.8rem;
	}
	.btn-danger {
		color: #c33;
		border-color: #c33;
	}
	.saved-banner {
		margin-top: 0.5rem;
		padding: 0.5rem 0.75rem;
		background: #e6f4e6;
		color: #1a7a1a;
		border-radius: 4px;
		font-size: 0.85rem;
		font-weight: 600;
	}
	.image-container {
		position: relative;
		width: 100%;
		user-select: none;
		touch-action: none;
	}
	.image-container img {
		width: 100%;
		display: block;
	}
	.overlay {
		position: absolute;
		top: 0;
		left: 0;
		pointer-events: none;
	}
	.overlay line,
	.overlay circle,
	.overlay polygon {
		pointer-events: auto;
	}

	.preview-section {
		margin-top: 1.25rem;
	}
	.preview-section h2 {
		font-size: 1rem;
		margin: 0 0 0.5rem;
	}
	.preview-strip {
		display: flex;
		gap: 1rem;
		overflow-x: auto;
		padding: 0.5rem 0;
	}
	.preview-cell {
		flex-shrink: 0;
	}
	.preview-label {
		display: block;
		font-size: 0.8rem;
		font-weight: 600;
		margin-bottom: 0.25rem;
	}
	.preview-clip {
		border: 1px solid #ccc;
		border-radius: 3px;
		position: relative;
	}
	.preview-clip img {
		position: absolute;
		top: 0;
		left: 0;
	}

	.actions-bar {
		margin-top: 1.25rem;
		padding: 1rem 0;
		border-top: 1px solid #ddd;
		display: flex;
		align-items: center;
		gap: 1rem;
	}
	.actions-bar form {
		display: flex;
		align-items: center;
		gap: 1rem;
		flex-wrap: wrap;
	}
	.checkbox-label {
		font-size: 0.85rem;
		display: flex;
		align-items: center;
		gap: 0.35rem;
		cursor: pointer;
	}
	.warning-banner {
		padding: 0.75rem 1rem;
		background: #fff3cd;
		border: 1px solid #ffc107;
		border-radius: 4px;
		font-size: 0.85rem;
		display: flex;
		align-items: center;
		gap: 0.75rem;
		flex-wrap: wrap;
	}
</style>
