import sharp from 'sharp';
import { readFile } from 'node:fs/promises';

export interface GridConfig {
	rows: number;
	cols: number;
	marginPct?: number;
}

export interface CropResult {
	row: number;
	col: number;
	buffer: Buffer;
	bounds: { x: number; y: number; width: number; height: number };
}

async function toBuffer(image: Buffer | string): Promise<Buffer> {
	if (Buffer.isBuffer(image)) return image;
	return readFile(image);
}

export async function cropGrid(
	image: Buffer | string,
	config: GridConfig
): Promise<CropResult[]> {
	const buf = await toBuffer(image);
	const meta = await sharp(buf).metadata();
	const width = meta.width!;
	const height = meta.height!;

	const cellW = Math.floor(width / config.cols);
	const cellH = Math.floor(height / config.rows);
	const margin = config.marginPct ?? 0;
	const insetX = Math.floor(cellW * margin);
	const insetY = Math.floor(cellH * margin);

	const results: CropResult[] = [];

	for (let r = 0; r < config.rows; r++) {
		for (let c = 0; c < config.cols; c++) {
			const x = c * cellW + insetX;
			const y = r * cellH + insetY;
			const w = cellW - 2 * insetX;
			const h = cellH - 2 * insetY;

			const cellBuf = await sharp(buf)
				.extract({ left: x, top: y, width: w, height: h })
				.jpeg({ quality: 95 })
				.toBuffer();

			results.push({
				row: r,
				col: c,
				buffer: cellBuf,
				bounds: { x, y, width: w, height: h }
			});
		}
	}

	return results;
}

export async function resizePage(
	image: Buffer | string,
	maxLongEdge: number
): Promise<Buffer> {
	const buf = await toBuffer(image);
	const meta = await sharp(buf).metadata();
	const width = meta.width!;
	const height = meta.height!;

	if (width <= maxLongEdge && height <= maxLongEdge) {
		return sharp(buf).jpeg({ quality: 95 }).toBuffer();
	}

	const opts =
		width >= height
			? { width: maxLongEdge }
			: { height: maxLongEdge };

	return sharp(buf).resize(opts).jpeg({ quality: 95 }).toBuffer();
}

export async function cropRegion(
	image: Buffer | string,
	bounds: { x: number; y: number; width: number; height: number }
): Promise<Buffer> {
	const buf = await toBuffer(image);
	return sharp(buf)
		.extract({ left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height })
		.jpeg({ quality: 95 })
		.toBuffer();
}
