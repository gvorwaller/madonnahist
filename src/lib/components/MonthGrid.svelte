<script lang="ts">
	/**
	 * Sunday-start micro-grid of day numbers for one month, per
	 * docs/ui-mockups-V2.md §B3 (year browse). Accepted days are tappable
	 * links; everything else (no ingested day, or ingested-but-not-accepted)
	 * renders as a plain non-interactive number — visually distinct by more
	 * than color (muted + no underline vs. bold/underlined link), per the
	 * AAA "color + text" rule.
	 *
	 * Reusable: the /correct surfaces could adopt this later for a compact
	 * month view (`hrefBase` + `describe` let a caller repoint links and
	 * relabel accessible names without forking the grid math).
	 */
	interface Props {
		year: number;
		/** 1-12 */
		month: number;
		/** Day-of-month numbers (1-31) that are accepted and should be tappable. */
		acceptedDays: number[];
		/** Link target prefix; day gets appended as /YYYY-MM-DD. */
		hrefBase?: string;
		/** Optional query suffix appended to day links (e.g. ?from=<path> for back-navigation memory). */
		linkSuffix?: string;
		/**
		 * Optional href for the month title itself (e.g. /app/year/[year] links
		 * each month name to /app/month/[monthKey] — td-852d99). Omitted by
		 * the month page's own use of this component, which would otherwise
		 * link to itself.
		 */
		titleHref?: string;
	}

	const {
		year,
		month,
		acceptedDays,
		hrefBase = '/app/day',
		linkSuffix = '',
		titleHref
	}: Props = $props();

	const monthNames = [
		'January', 'February', 'March', 'April', 'May', 'June',
		'July', 'August', 'September', 'October', 'November', 'December'
	];
	const weekdayLabels = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

	function daysInMonth(y: number, m: number): number {
		return new Date(Date.UTC(y, m, 0)).getUTCDate();
	}

	function firstWeekday(y: number, m: number): number {
		return new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
	}

	function pad(n: number): string {
		return String(n).padStart(2, '0');
	}

	interface Cell {
		day: number | null;
		accepted: boolean;
		date: string;
	}

	const acceptedSet = $derived(new Set(acceptedDays));

	const cells = $derived.by(() => {
		const n = daysInMonth(year, month);
		const offset = firstWeekday(year, month);
		const out: Cell[] = [];
		for (let i = 0; i < offset; i++) {
			out.push({ day: null, accepted: false, date: '' });
		}
		for (let day = 1; day <= n; day++) {
			out.push({
				day,
				accepted: acceptedSet.has(day),
				date: `${year}-${pad(month)}-${pad(day)}`
			});
		}
		// Pad the tail so the grid always ends on a full week — keeps every
		// month's box the same visual height in the year-browse list.
		while (out.length % 7 !== 0) {
			out.push({ day: null, accepted: false, date: '' });
		}
		return out;
	});
</script>

<div class="month-grid">
	<h3 class="month-title">
		{#if titleHref}
			<a href={titleHref} class="month-title-link"
				>{monthNames[month - 1]}
				<span class="title-hint">page photo &#9656;</span></a
			>
		{:else}
			{monthNames[month - 1]}
		{/if}
	</h3>
	<div class="grid" role="grid" aria-label="{monthNames[month - 1]} {year}">
		{#each weekdayLabels as label (label)}
			<span class="weekday-label" aria-hidden="true">{label}</span>
		{/each}
		{#each cells as cell, i (i)}
			{#if cell.day === null}
				<span class="cell empty"></span>
			{:else if cell.accepted}
				<a href="{hrefBase}/{cell.date}{linkSuffix}" class="cell day-cell accepted">{cell.day}</a>
			{:else}
				<span class="cell day-cell pending">{cell.day}</span>
			{/if}
		{/each}
	</div>
</div>

<style>
	.month-grid {
		margin-bottom: 1.5rem;
	}
	.month-title {
		font-family: var(--font-sans);
		font-size: 0.95rem;
		font-weight: 700;
		color: var(--color-ink);
		margin: 0 0 0.5rem;
		padding-bottom: 0.3rem;
		border-bottom: 1px solid var(--color-border);
	}
	.month-title-link {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		color: var(--color-evergreen-dark);
		text-decoration: underline;
		text-underline-offset: 2px;
	}
	.title-hint {
		font-size: 0.7rem;
		font-weight: 600;
		color: var(--color-evergreen-dark);
		text-decoration: underline;
		margin-left: 0.35rem;
		white-space: nowrap;
	}
	.month-title-link:hover {
		background: var(--color-chip-bg);
	}
	.month-title-link:focus-visible {
		outline: 2px solid var(--color-evergreen-dark);
		outline-offset: 2px;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(7, 1fr);
		/* Kept intentionally tight: at a 375px viewport with the standard
		   1rem page gutter (see src/routes/app/year/[year]/+page.svelte),
		   7 columns only clears the 48px tap-target floor with a ~1px gap
		   — see docs/2026-07-21-next-phases-search-viewer-narrative-plan.md
		   Phase C deliverable 1. Cells stay visually distinct via
		   background fill (accepted) vs. transparent (pending), not the
		   gap. */
		gap: 1px;
	}
	.weekday-label {
		font-family: var(--font-sans);
		font-size: 0.65rem;
		font-weight: 600;
		text-align: center;
		color: var(--color-ink-muted);
		padding-bottom: 0.15rem;
	}
	.cell {
		display: flex;
		align-items: center;
		justify-content: center;
		box-sizing: border-box;
		min-height: 48px;
		border-radius: 6px;
		font-family: var(--font-sans);
		font-size: 0.85rem;
	}
	.cell.empty {
		background: transparent;
	}
	.day-cell.pending {
		color: var(--color-ink-muted);
		font-weight: 400;
		background: transparent;
	}
	.day-cell.accepted {
		color: var(--color-evergreen-dark);
		font-weight: 700;
		text-decoration: underline;
		text-underline-offset: 2px;
		background: var(--color-chip-bg);
	}
	.day-cell.accepted:hover {
		background: var(--color-highlight-bg);
	}
	.day-cell.accepted:focus-visible {
		outline: 2px solid var(--color-evergreen-dark);
		outline-offset: 2px;
	}
</style>
