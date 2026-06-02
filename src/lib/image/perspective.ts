import sharp from 'sharp';

export interface Point {
	x: number;
	y: number;
}

/**
 * Compute a 3x3 projective (homography) matrix that maps 4 source points
 * to 4 destination points. Returns the 9 matrix entries [h1..h9] where
 * h9 is normalized to 1.
 *
 * For each destination pixel (u,v), the source pixel is:
 *   w = h7*u + h8*v + h9
 *   x = (h1*u + h2*v + h3) / w
 *   y = (h4*u + h5*v + h6) / w
 */
function computeHomography(
	src: [Point, Point, Point, Point],
	dst: [Point, Point, Point, Point]
): number[] {
	// 8x9 augmented matrix (8 equations, 8 unknowns + RHS)
	// For each point pair (x,y) → (u,v):
	//   x*h1 + y*h2 + h3 + 0 + 0 + 0 - u*x*h7 - u*y*h8 = u
	//   0 + 0 + 0 + x*h4 + y*h5 + h6 - v*x*h7 - v*y*h8 = v
	const A: number[][] = [];

	for (let i = 0; i < 4; i++) {
		const { x, y } = src[i];
		const { x: u, y: v } = dst[i];
		A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
		A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
	}

	// Gaussian elimination with partial pivoting on 8x9 augmented matrix
	const n = 8;
	for (let col = 0; col < n; col++) {
		let maxRow = col;
		let maxVal = Math.abs(A[col][col]);
		for (let row = col + 1; row < n; row++) {
			if (Math.abs(A[row][col]) > maxVal) {
				maxVal = Math.abs(A[row][col]);
				maxRow = row;
			}
		}
		[A[col], A[maxRow]] = [A[maxRow], A[col]];

		const pivot = A[col][col];
		if (Math.abs(pivot) < 1e-10) throw new Error('Degenerate point configuration');

		for (let row = col + 1; row < n; row++) {
			const factor = A[row][col] / pivot;
			for (let j = col; j <= n; j++) {
				A[row][j] -= factor * A[col][j];
			}
		}
	}

	// Back-substitution
	const h = new Array(n);
	for (let row = n - 1; row >= 0; row--) {
		let sum = A[row][n]; // RHS
		for (let col = row + 1; col < n; col++) {
			sum -= A[row][col] * h[col];
		}
		h[row] = sum / A[row][row];
	}

	// h = [h1, h2, h3, h4, h5, h6, h7, h8], h9 = 1
	return [...h, 1];
}

function applyHomography(H: number[], p: Point): Point {
	const w = H[6] * p.x + H[7] * p.y + H[8];
	return {
		x: (H[0] * p.x + H[1] * p.y + H[2]) / w,
		y: (H[3] * p.x + H[4] * p.y + H[5]) / w
	};
}

/**
 * Compute the forward homography (original → warped) and transform
 * line positions from original-image coordinates to warped coordinates.
 */
export function transformLinesToWarped(
	srcCorners: [Point, Point, Point, Point],
	warpedWidth: number,
	warpedHeight: number,
	xLines: number[],
	yLines: number[]
): { xLines: number[]; yLines: number[] } {
	const dstCorners: [Point, Point, Point, Point] = [
		{ x: 0, y: 0 },
		{ x: warpedWidth - 1, y: 0 },
		{ x: warpedWidth - 1, y: warpedHeight - 1 },
		{ x: 0, y: warpedHeight - 1 }
	];

	// Forward homography: original → warped
	const H = computeHomography(srcCorners, dstCorners);

	// Transform each xLine: use the midpoint Y of the original grid
	const midY = (srcCorners[0].y + srcCorners[3].y) / 2;
	const newXLines = xLines.map(x => {
		const warped = applyHomography(H, { x, y: midY });
		return Math.round(Math.max(0, Math.min(warpedWidth, warped.x)));
	});

	// Transform each yLine: use the midpoint X of the original grid
	const midX = (srcCorners[0].x + srcCorners[1].x) / 2;
	const newYLines = yLines.map(y => {
		const warped = applyHomography(H, { x: midX, y });
		return Math.round(Math.max(0, Math.min(warpedHeight, warped.y)));
	});

	return { xLines: newXLines, yLines: newYLines };
}

function dist(a: Point, b: Point): number {
	return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

/**
 * Perspective-warp an image so that the quadrilateral defined by `srcCorners`
 * becomes a rectangle. Returns a sharp Buffer of the warped image.
 *
 * srcCorners order: [topLeft, topRight, bottomRight, bottomLeft]
 */
export async function perspectiveWarp(
	imageBuffer: Buffer,
	srcCorners: [Point, Point, Point, Point]
): Promise<{ buffer: Buffer; width: number; height: number }> {
	const [tl, tr, br, bl] = srcCorners;

	// Output dimensions: preserve max resolution
	const outWidth = Math.round(Math.max(dist(tl, tr), dist(bl, br)));
	const outHeight = Math.round(Math.max(dist(tl, bl), dist(tr, br)));

	// Destination corners (the output rectangle)
	const dstCorners: [Point, Point, Point, Point] = [
		{ x: 0, y: 0 },
		{ x: outWidth - 1, y: 0 },
		{ x: outWidth - 1, y: outHeight - 1 },
		{ x: 0, y: outHeight - 1 }
	];

	// Homography: dst → src (for inverse mapping)
	const H = computeHomography(dstCorners, srcCorners);

	// Read source image as raw RGBA — caller must EXIF-normalize before calling
	const { data: srcData, info: srcInfo } = await sharp(imageBuffer)
		.ensureAlpha()
		.raw()
		.toBuffer({ resolveWithObject: true });
	const srcW = srcInfo.width;
	const srcH = srcInfo.height;

	// Allocate output buffer (RGBA)
	const outData = Buffer.alloc(outWidth * outHeight * 4);

	for (let oy = 0; oy < outHeight; oy++) {
		for (let ox = 0; ox < outWidth; ox++) {
			// Map output pixel to source using homography
			const w = H[6] * ox + H[7] * oy + H[8];
			const sx = (H[0] * ox + H[1] * oy + H[2]) / w;
			const sy = (H[3] * ox + H[4] * oy + H[5]) / w;

			// Bilinear interpolation
			const x0 = Math.floor(sx);
			const y0 = Math.floor(sy);
			const x1 = x0 + 1;
			const y1 = y0 + 1;

			if (x0 < 0 || y0 < 0 || x1 >= srcW || y1 >= srcH) continue;

			const dx = sx - x0;
			const dy = sy - y0;
			const w00 = (1 - dx) * (1 - dy);
			const w10 = dx * (1 - dy);
			const w01 = (1 - dx) * dy;
			const w11 = dx * dy;

			const outIdx = (oy * outWidth + ox) * 4;
			const i00 = (y0 * srcW + x0) * 4;
			const i10 = (y0 * srcW + x1) * 4;
			const i01 = (y1 * srcW + x0) * 4;
			const i11 = (y1 * srcW + x1) * 4;

			for (let c = 0; c < 4; c++) {
				outData[outIdx + c] = Math.round(
					srcData[i00 + c] * w00 +
					srcData[i10 + c] * w10 +
					srcData[i01 + c] * w01 +
					srcData[i11 + c] * w11
				);
			}
		}
	}

	const buffer = await sharp(outData, {
		raw: { width: outWidth, height: outHeight, channels: 4 }
	}).jpeg({ quality: 92 }).toBuffer();

	return { buffer, width: outWidth, height: outHeight };
}

function cross2d(ox: number, oy: number, ax: number, ay: number, bx: number, by: number): number {
	return (ax - ox) * (by - oy) - (ay - oy) * (bx - ox);
}

export function validateCorners(
	corners: [Point, Point, Point, Point],
	imageWidth: number,
	imageHeight: number
): string | null {
	const [tl, tr, br, bl] = corners;
	const pts = [tl, tr, br, bl];

	for (const p of pts) {
		if (p.x < 0 || p.y < 0 || p.x > imageWidth || p.y > imageHeight) {
			return `Corner (${p.x}, ${p.y}) is outside image bounds`;
		}
	}

	// Convexity: all cross products of consecutive edges must have the same sign
	const signs: number[] = [];
	for (let i = 0; i < 4; i++) {
		const a = pts[i];
		const b = pts[(i + 1) % 4];
		const c = pts[(i + 2) % 4];
		signs.push(cross2d(a.x, a.y, b.x, b.y, c.x, c.y));
	}
	const allPos = signs.every(s => s > 0);
	const allNeg = signs.every(s => s < 0);
	if (!allPos && !allNeg) {
		return 'Corners do not form a convex quadrilateral (edges may be crossing)';
	}

	// Minimum output dimensions
	const outWidth = Math.max(dist(tl, tr), dist(bl, br));
	const outHeight = Math.max(dist(tl, bl), dist(tr, br));
	if (outWidth < 100 || outHeight < 100) {
		return `Output dimensions too small (${Math.round(outWidth)}×${Math.round(outHeight)}), minimum 100×100`;
	}

	return null;
}
