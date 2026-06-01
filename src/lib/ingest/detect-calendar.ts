/**
 * Locate the calendar within a capture frame and deskew it.
 *
 * The tripod is fixed but calendars vary in physical size, so each lands in a
 * different region of the frame, surrounded by dark background and tilted a few
 * degrees. Everything downstream (quality scoring, month/year classification,
 * day-cell cropping) must operate on the calendar itself, not the whole frame.
 *
 * Approach (pure Sharp + JS — captures are favorable: bright paper on a dark
 * background, near-flat, small in-plane rotation):
 *   1. Downscale + grayscale; Otsu threshold → binary "bright paper" mask.
 *   2. Largest bright connected component = the calendar; collect its pixels.
 *   3. Convex hull → minimum-area rotated rectangle (rotating calipers) gives
 *      the calendar's center, size, and skew angle.
 *   4. Map the rect to full-res, rotate the original to upright, crop.
 *
 * This handles in-plane rotation (the dominant skew here). Strong perspective
 * would need a 4-point warp (future work) — flagged via `cornerSpread`.
 */
import sharp from 'sharp';

const DETECT_LONG_EDGE = 1000; // working resolution for mask + geometry

export interface Point {
	x: number;
	y: number;
}

export interface DetectResult {
	found: boolean;
	/** Calendar quad corners in full-res (EXIF-normalized) coordinates. */
	corners: Point[];
	/** In-plane skew angle in degrees (what we rotate by to make it upright). */
	angleDeg: number;
	/** Axis-aligned bounding box of the quad in full-res coordinates. */
	box: { x: number; y: number; width: number; height: number };
	/** Fraction of the frame the calendar occupies (area). */
	frameCoverage: number;
	/** Deskewed, cropped calendar image (JPEG). Empty if !found. */
	deskewed: Buffer;
}

// ───────────────────────── Otsu threshold ─────────────────────────
function otsu(gray: Uint8Array): number {
	const hist = new Array(256).fill(0);
	for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
	const total = gray.length;
	let sum = 0;
	for (let t = 0; t < 256; t++) sum += t * hist[t];
	let sumB = 0;
	let wB = 0;
	let maxVar = -1;
	let threshold = 127;
	for (let t = 0; t < 256; t++) {
		wB += hist[t];
		if (wB === 0) continue;
		const wF = total - wB;
		if (wF === 0) break;
		sumB += t * hist[t];
		const mB = sumB / wB;
		const mF = (sum - sumB) / wF;
		const between = wB * wF * (mB - mF) * (mB - mF);
		if (between > maxVar) {
			maxVar = between;
			threshold = t;
		}
	}
	return threshold;
}

// ──────────────── Largest bright connected component ────────────────
function largestComponent(mask: Uint8Array, w: number, h: number): Point[] {
	const labels = new Int32Array(w * h).fill(-1);
	const stack: number[] = [];
	let bestPoints: Point[] = [];
	let bestSize = 0;

	for (let start = 0; start < w * h; start++) {
		if (mask[start] === 0 || labels[start] !== -1) continue;
		// BFS/DFS flood fill this component.
		stack.length = 0;
		stack.push(start);
		labels[start] = start;
		const points: Point[] = [];
		while (stack.length > 0) {
			const idx = stack.pop()!;
			const x = idx % w;
			const y = (idx - x) / w;
			points.push({ x, y });
			// 4-connectivity
			if (x > 0) {
				const n = idx - 1;
				if (mask[n] === 1 && labels[n] === -1) {
					labels[n] = start;
					stack.push(n);
				}
			}
			if (x < w - 1) {
				const n = idx + 1;
				if (mask[n] === 1 && labels[n] === -1) {
					labels[n] = start;
					stack.push(n);
				}
			}
			if (y > 0) {
				const n = idx - w;
				if (mask[n] === 1 && labels[n] === -1) {
					labels[n] = start;
					stack.push(n);
				}
			}
			if (y < h - 1) {
				const n = idx + w;
				if (mask[n] === 1 && labels[n] === -1) {
					labels[n] = start;
					stack.push(n);
				}
			}
		}
		if (points.length > bestSize) {
			bestSize = points.length;
			bestPoints = points;
		}
	}
	return bestPoints;
}

// ──────────────── Convex hull (Andrew's monotone chain) ────────────────
function convexHull(points: Point[]): Point[] {
	if (points.length < 3) return points;
	const pts = points.slice().sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
	const cross = (o: Point, a: Point, b: Point) =>
		(a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

	const lower: Point[] = [];
	for (const p of pts) {
		while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0)
			lower.pop();
		lower.push(p);
	}
	const upper: Point[] = [];
	for (let i = pts.length - 1; i >= 0; i--) {
		const p = pts[i];
		while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0)
			upper.pop();
		upper.push(p);
	}
	lower.pop();
	upper.pop();
	return lower.concat(upper);
}

interface RotatedRect {
	center: Point;
	width: number;
	height: number;
	angleDeg: number; // rotation to make upright, in (-45, 45]
	corners: Point[];
}

// ──────────── Minimum-area rectangle via rotating calipers ────────────
function minAreaRect(hull: Point[]): RotatedRect {
	let best: RotatedRect | null = null;
	const n = hull.length;
	for (let i = 0; i < n; i++) {
		const p1 = hull[i];
		const p2 = hull[(i + 1) % n];
		const ex = p2.x - p1.x;
		const ey = p2.y - p1.y;
		const len = Math.hypot(ex, ey) || 1;
		const ux = ex / len;
		const uy = ey / len; // edge direction
		// perpendicular: (-uy, ux)
		let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
		for (const p of hull) {
			const du = p.x * ux + p.y * uy;
			const dv = -p.x * uy + p.y * ux;
			if (du < minU) minU = du;
			if (du > maxU) maxU = du;
			if (dv < minV) minV = dv;
			if (dv > maxV) maxV = dv;
		}
		const w = maxU - minU;
		const h = maxV - minV;
		const area = w * h;
		if (!best || area < best.width * best.height) {
			// Rectangle corners in (u,v) space → back to (x,y).
			const toXY = (du: number, dv: number): Point => ({
				x: du * ux - dv * uy,
				y: du * uy + dv * ux
			});
			const corners = [
				toXY(minU, minV),
				toXY(maxU, minV),
				toXY(maxU, maxV),
				toXY(minU, maxV)
			];
			const cu = (minU + maxU) / 2;
			const cv = (minV + maxV) / 2;
			const center = toXY(cu, cv);
			let angle = (Math.atan2(uy, ux) * 180) / Math.PI;
			// Normalize the edge angle into (-45, 45] so we deskew by the smallest turn.
			while (angle <= -45) angle += 90;
			while (angle > 45) angle -= 90;
			best = { center, width: w, height: h, angleDeg: angle, corners };
		}
	}
	return best!;
}

function rotatePoint(p: Point, cx: number, cy: number, rad: number): Point {
	const dx = p.x - cx;
	const dy = p.y - cy;
	return {
		x: cx + dx * Math.cos(rad) - dy * Math.sin(rad),
		y: cy + dx * Math.sin(rad) + dy * Math.cos(rad)
	};
}

export interface DetectOptions {
	/** Minimum frame-area coverage to accept a detection (else found=false). */
	minCoverage?: number;
	/** Margin (fraction of crop size) added around the detected rectangle. */
	margin?: number;
	/**
	 * Blur sigma (on the downscaled detection image) applied before thresholding.
	 * Bridges thin dark marks (handwriting, grid lines) so the paper reads as one
	 * connected component instead of fragmenting. 0 disables.
	 */
	blurSigma?: number;
}

export async function detectCalendar(
	image: Buffer,
	opts: DetectOptions = {}
): Promise<DetectResult> {
	const minCoverage = opts.minCoverage ?? 0.1;
	const margin = opts.margin ?? 0.01;
	const blurSigma = opts.blurSigma ?? 6;

	// Full-res, EXIF-normalized reference.
	const full = await sharp(image).rotate().toBuffer();
	const fullMeta = await sharp(full).metadata();
	const FW = fullMeta.width ?? 0;
	const FH = fullMeta.height ?? 0;

	// Downscaled grayscale for detection. Blur bridges handwriting/grid-line
	// gaps so the paper is one connected bright region (see blurSigma).
	let pipeline = sharp(full)
		.resize({ width: DETECT_LONG_EDGE, height: DETECT_LONG_EDGE, fit: 'inside' })
		.grayscale();
	if (blurSigma > 0) pipeline = pipeline.blur(blurSigma);
	const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
	const dw = info.width;
	const dh = info.height;
	const gray = new Uint8Array(data.buffer, data.byteOffset, dw * dh);

	const thr = otsu(gray);
	const mask = new Uint8Array(dw * dh);
	for (let i = 0; i < gray.length; i++) mask[i] = gray[i] > thr ? 1 : 0;

	const comp = largestComponent(mask, dw, dh);
	const emptyBox = { x: 0, y: 0, width: FW, height: FH };
	if (comp.length === 0) {
		return { found: false, corners: [], angleDeg: 0, box: emptyBox, frameCoverage: 0, deskewed: Buffer.alloc(0) };
	}

	const rect = minAreaRect(convexHull(comp));
	const coverage = (rect.width * rect.height) / (dw * dh);

	// Scale geometry from detection space back to full-res.
	const scale = FW / dw; // uniform (fit:'inside' preserves aspect, both axes share scale)
	const cornersFull = rect.corners.map((p) => ({ x: p.x * scale, y: p.y * scale }));
	const xs = cornersFull.map((p) => p.x);
	const ys = cornersFull.map((p) => p.y);
	const box = {
		x: Math.max(0, Math.floor(Math.min(...xs))),
		y: Math.max(0, Math.floor(Math.min(...ys))),
		width: Math.ceil(Math.min(...xs) >= 0 ? Math.max(...xs) - Math.min(...xs) : Math.max(...xs)),
		height: Math.ceil(Math.max(...ys) - Math.min(...ys))
	};

	if (coverage < minCoverage) {
		return { found: false, corners: cornersFull, angleDeg: rect.angleDeg, box, frameCoverage: coverage, deskewed: Buffer.alloc(0) };
	}

	// Deskew: rotate the full image so the calendar is upright, then crop the rect.
	const cropW = rect.width * scale;
	const cropH = rect.height * scale;
	const cx = rect.center.x * scale;
	const cy = rect.center.y * scale;
	const rad = (-rect.angleDeg * Math.PI) / 180;

	// Sharp .rotate(deg) rotates clockwise and expands the canvas; the original
	// image center maps to the new canvas center. Compute the new canvas size
	// and where the rect center lands so we can extract it.
	const absCos = Math.abs(Math.cos(rad));
	const absSin = Math.abs(Math.sin(rad));
	const newW = Math.ceil(FW * absCos + FH * absSin);
	const newH = Math.ceil(FW * absSin + FH * absCos);

	const rotated = await sharp(full)
		.rotate(-rect.angleDeg, { background: { r: 0, g: 0, b: 0 } })
		.toBuffer();
	const rotMeta = await sharp(rotated).metadata();
	const rW = rotMeta.width ?? newW;
	const rH = rotMeta.height ?? newH;

	// Map rect center through the same rotation about the original center.
	const mapped = rotatePoint({ x: cx, y: cy }, FW / 2, FH / 2, rad);
	const newCx = mapped.x + (rW - FW) / 2;
	const newCy = mapped.y + (rH - FH) / 2;

	const mx = cropW * margin;
	const my = cropH * margin;
	const left = Math.max(0, Math.round(newCx - cropW / 2 - mx));
	const top = Math.max(0, Math.round(newCy - cropH / 2 - my));
	const ew = Math.min(rW - left, Math.round(cropW + 2 * mx));
	const eh = Math.min(rH - top, Math.round(cropH + 2 * my));

	const deskewed = await sharp(rotated)
		.extract({ left, top, width: Math.max(1, ew), height: Math.max(1, eh) })
		.jpeg({ quality: 92 })
		.toBuffer();

	return {
		found: true,
		corners: cornersFull,
		angleDeg: rect.angleDeg,
		box,
		frameCoverage: coverage,
		deskewed
	};
}
