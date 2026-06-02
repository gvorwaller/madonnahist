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

// ─────────────────────────────────────────────────────────────────
// Grid-lines model (grid alignment UI)
// ─────────────────────────────────────────────────────────────────

export interface GridCorners {
	topLeft: [number, number];
	topRight: [number, number];
	bottomLeft: [number, number];
	bottomRight: [number, number];
}

export interface GridLines {
	coordinateSpace: 'original' | 'warped';
	corners: GridCorners;
	xLines: number[];
	yLines: number[];
}

function lerp(a: number, b: number, t: number): number {
	return a + (b - a) * t;
}

export function subdivideCornersToLines(
	corners: GridCorners,
	rows: number,
	cols: number
): { xLines: number[]; yLines: number[] } {
	const xLines: number[] = [];
	for (let c = 0; c <= cols; c++) {
		const t = c / cols;
		const xTop = lerp(corners.topLeft[0], corners.topRight[0], t);
		const xBot = lerp(corners.bottomLeft[0], corners.bottomRight[0], t);
		xLines.push(Math.round((xTop + xBot) / 2));
	}

	const yLines: number[] = [];
	for (let r = 0; r <= rows; r++) {
		const t = r / rows;
		const yLeft = lerp(corners.topLeft[1], corners.bottomLeft[1], t);
		const yRight = lerp(corners.topRight[1], corners.bottomRight[1], t);
		yLines.push(Math.round((yLeft + yRight) / 2));
	}

	return { xLines, yLines };
}

export function defaultGridLines(
	imageWidth: number,
	imageHeight: number,
	rows: number,
	cols: number
): GridLines {
	const left = Math.round(imageWidth * 0.06);
	const right = Math.round(imageWidth * 0.94);
	const top = Math.round(imageHeight * 0.25);
	const bottom = Math.round(imageHeight * 0.95);

	const corners: GridCorners = {
		topLeft: [left, top],
		topRight: [right, top],
		bottomLeft: [left, bottom],
		bottomRight: [right, bottom]
	};

	const { xLines, yLines } = subdivideCornersToLines(corners, rows, cols);
	return { coordinateSpace: 'original', corners, xLines, yLines };
}

export function cellBoundsFromGridLines(
	gridLines: GridLines,
	row: number,
	col: number
): CellBounds {
	const x = gridLines.xLines[col];
	const y = gridLines.yLines[row];
	const width = gridLines.xLines[col + 1] - x;
	const height = gridLines.yLines[row + 1] - y;
	return { x, y, width, height };
}

export function validateGridLines(
	gridLines: GridLines,
	imageWidth: number,
	imageHeight: number,
	rows: number,
	cols: number
): string | null {
	if (!gridLines.corners || !gridLines.xLines || !gridLines.yLines) {
		return 'Missing corners, xLines, or yLines';
	}
	if (gridLines.xLines.length !== cols + 1) {
		return `Expected ${cols + 1} xLines, got ${gridLines.xLines.length}`;
	}
	if (gridLines.yLines.length !== rows + 1) {
		return `Expected ${rows + 1} yLines, got ${gridLines.yLines.length}`;
	}
	for (let i = 1; i < gridLines.xLines.length; i++) {
		if (gridLines.xLines[i] <= gridLines.xLines[i - 1]) {
			return `xLines not monotonically increasing at index ${i}`;
		}
	}
	for (let i = 1; i < gridLines.yLines.length; i++) {
		if (gridLines.yLines[i] <= gridLines.yLines[i - 1]) {
			return `yLines not monotonically increasing at index ${i}`;
		}
	}
	if (gridLines.xLines[0] < 0 || gridLines.xLines[gridLines.xLines.length - 1] > imageWidth) {
		return 'xLines extend beyond image bounds';
	}
	if (gridLines.yLines[0] < 0 || gridLines.yLines[gridLines.yLines.length - 1] > imageHeight) {
		return 'yLines extend beyond image bounds';
	}
	return null;
}
