/**
 * Calendar grid math: map a (year, month, layout) to the set of day cells on a
 * scanned page, plus the pixel bounds of each cell for naive day-cell cropping.
 *
 * All family calendars are Sunday-start. Layouts vary in row count; some 4-row
 * calendars wrap the final day(s) into the cell directly above (two dates
 * sharing one cell). See docs/2026-05-29-capture-intake-pipeline.md
 * § 4-Row Calendar Handling. Refined per-template geometry is Phase 2; this is
 * the naive even-division crop with a reserved header band.
 */

export interface GridLayout {
	rows: number; // day rows (excludes the header band)
	cols: number; // 7 for Sunday..Saturday
	startDay: 'sunday';
	wrappedRows: boolean; // overflow days share the cell above
	headerPosition: 'top' | 'bottom';
	/** Fraction of page height reserved for the printed month header. */
	headerFraction: number;
}

// A non-wrapped Sunday-start grid only fits a month when first-weekday + days
// ≤ rows×cols. That's a minority of months at 5 rows (e.g. a 31-day month
// starting Saturday needs slot 36 > 35), so we offer wrapped variants and a
// 6-row grid (42 slots) that fits every possible month. The operator picks the
// template matching the physically printed calendar; ingest blocks (with a
// message) if the chosen template can't hold the month.
export const GRID_TEMPLATES: Record<string, GridLayout> = {
	'5-row-wrapped': {
		rows: 5,
		cols: 7,
		startDay: 'sunday',
		wrappedRows: true,
		headerPosition: 'top',
		headerFraction: 0.12
	},
	'5-row-standard': {
		rows: 5,
		cols: 7,
		startDay: 'sunday',
		wrappedRows: false,
		headerPosition: 'top',
		headerFraction: 0.12
	},
	'6-row-standard': {
		rows: 6,
		cols: 7,
		startDay: 'sunday',
		wrappedRows: false,
		headerPosition: 'top',
		headerFraction: 0.12
	},
	'4-row-wrapped': {
		rows: 4,
		cols: 7,
		startDay: 'sunday',
		wrappedRows: true,
		headerPosition: 'top',
		headerFraction: 0.12
	}
};

export interface DayCell {
	row: number; // 0-based within the day grid
	col: number; // 0-based; 0 = Sunday
	/** Dates assigned to this cell (1 normally; 2 when a wrapped day shares it). */
	dates: string[]; // 'YYYY-MM-DD'
}

export interface DayGrid {
	cells: DayCell[];
	/** False when the dates don't fit the layout even after wrapping — caller blocks ingest. */
	fits: boolean;
}

function daysInMonth(year: number, month: number): number {
	// month is 1-12; day 0 of next month = last day of this month.
	return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Weekday of the 1st (0 = Sunday .. 6 = Saturday). */
function firstWeekday(year: number, month: number): number {
	return new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
}

function isoDate(year: number, month: number, day: number): string {
	const m = String(month).padStart(2, '0');
	const d = String(day).padStart(2, '0');
	return `${year}-${m}-${d}`;
}

/**
 * Build the date→cell mapping for a month under a given layout.
 * Day d (1-based) occupies flat slot index = firstWeekday + d - 1. When a slot
 * exceeds the grid and the layout wraps, the day is folded up one row (same
 * column) to share that cell. fits=false if it still doesn't land in-grid.
 */
export function buildDayGrid(year: number, month: number, layout: GridLayout): DayGrid {
	const totalSlots = layout.rows * layout.cols;
	const offset = firstWeekday(year, month);
	const n = daysInMonth(year, month);

	const byCell = new Map<number, string[]>(); // slotIndex → dates
	let fits = true;

	for (let day = 1; day <= n; day++) {
		let slot = offset + day - 1;
		if (slot >= totalSlots) {
			if (!layout.wrappedRows) {
				fits = false;
				continue;
			}
			slot -= layout.cols; // fold up one row into the cell above
			if (slot >= totalSlots || slot < 0) {
				fits = false;
				continue;
			}
		}
		const dateStr = isoDate(year, month, day);
		const existing = byCell.get(slot);
		if (existing) existing.push(dateStr);
		else byCell.set(slot, [dateStr]);
	}

	const cells: DayCell[] = [];
	for (const [slot, dates] of byCell) {
		cells.push({ row: Math.floor(slot / layout.cols), col: slot % layout.cols, dates });
	}
	cells.sort((a, b) => a.row * layout.cols + a.col - (b.row * layout.cols + b.col));

	return { cells, fits };
}

export interface CellBounds {
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * Pixel bounds of grid cell (row, col) on a page of the given dimensions,
 * reserving the header band at top or bottom. Dimensions are EXIF-normalized
 * pixel dimensions (post-`.rotate()`).
 */
export function cellBounds(
	layout: GridLayout,
	pageWidth: number,
	pageHeight: number,
	row: number,
	col: number
): CellBounds {
	const headerPx = Math.floor(pageHeight * layout.headerFraction);
	const gridTop = layout.headerPosition === 'top' ? headerPx : 0;
	const gridHeight = pageHeight - headerPx;

	const cellW = Math.floor(pageWidth / layout.cols);
	const cellH = Math.floor(gridHeight / layout.rows);

	return {
		x: col * cellW,
		y: gridTop + row * cellH,
		width: cellW,
		height: cellH
	};
}
