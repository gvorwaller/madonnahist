import sharp from 'sharp';
import { query } from '$lib/db';
import { cropObjectKey, uploadObject, getObject, deleteObject } from '$lib/ingest/spaces-upload';

export interface CropGenerationResult {
	generated: number;
	skipped: number;
	errors: string[];
}

export async function generateCropsForPage(pageId: number): Promise<CropGenerationResult> {
	const pageRes = await query<{
		page_image_path: string;
		warped_image_path: string | null;
		grid_version: number;
	}>(`SELECT page_image_path, warped_image_path, grid_version
	      FROM calendar_pages WHERE id = $1`, [pageId]);

	if (!pageRes.rows[0]) return { generated: 0, skipped: 0, errors: ['Page not found'] };
	const page = pageRes.rows[0];

	const dayRes = await query<{
		id: number;
		entry_date: string;
		crop_bounds: { x: number; y: number; width: number; height: number } | null;
		day_image_path: string | null;
	}>(`SELECT id, entry_date::text AS entry_date, crop_bounds, day_image_path
	      FROM calendar_days WHERE page_id = $1 ORDER BY entry_date`, [pageId]);

	const days = dayRes.rows.filter(d => d.crop_bounds !== null);
	if (days.length === 0) return { generated: 0, skipped: 0, errors: [] };

	const imageKey = page.warped_image_path ?? page.page_image_path;
	const raw = await getObject(imageKey);
	const normalized = await sharp(raw).rotate().toBuffer();
	const meta = await sharp(normalized).metadata();
	const imgW = meta.width ?? 0;
	const imgH = meta.height ?? 0;

	const result: CropGenerationResult = { generated: 0, skipped: 0, errors: [] };

	for (const day of days) {
		const raw_bounds = day.crop_bounds!;
		const bounds = {
			x: Math.max(0, raw_bounds.x),
			y: Math.max(0, raw_bounds.y),
			width: Math.min(raw_bounds.width, imgW - Math.max(0, raw_bounds.x)),
			height: Math.min(raw_bounds.height, imgH - Math.max(0, raw_bounds.y))
		};
		if (bounds.width <= 0 || bounds.height <= 0) {
			result.errors.push(`${day.entry_date}: invalid crop bounds (${bounds.width}x${bounds.height})`);
			continue;
		}
		const key = cropObjectKey(day.entry_date, page.grid_version);

		if (day.day_image_path === key) {
			result.skipped++;
			continue;
		}

		try {
			const cropBuffer = await sharp(normalized)
				.extract({ left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height })
				.jpeg({ quality: 95 })
				.toBuffer();

			await uploadObject(key, cropBuffer);

			await query(
				`UPDATE calendar_days SET day_image_path = $2 WHERE id = $1`,
				[day.id, key]
			);

			if (day.day_image_path && day.day_image_path !== key) {
				await deleteObject(day.day_image_path);
			}

			result.generated++;
		} catch (err) {
			result.errors.push(`${day.entry_date}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	return result;
}

/** Read crop object keys for a page (without deleting). */
export async function getCropKeysForPage(pageId: number): Promise<string[]> {
	const res = await query<{ day_image_path: string }>(
		`SELECT day_image_path FROM calendar_days WHERE page_id = $1 AND day_image_path IS NOT NULL`,
		[pageId]
	);
	return res.rows.map(r => r.day_image_path);
}

/** Delete crop objects for a page. Must be called BEFORE day rows are deleted. */
export async function deleteCropsForPage(pageId: number): Promise<void> {
	const keys = await getCropKeysForPage(pageId);
	for (const key of keys) {
		await deleteObject(key);
	}
}

/** Delete a list of crop object keys (best-effort). */
export async function deleteCropKeys(keys: string[]): Promise<void> {
	for (const key of keys) {
		try { await deleteObject(key); } catch { /* best-effort */ }
	}
}

/**
 * Clear day_image_path and return the old keys so the caller can delete
 * the objects after the transaction commits.
 */
export async function clearCropPaths(client: import('pg').PoolClient, pageId: number): Promise<string[]> {
	const res = await client.query<{ day_image_path: string }>(
		`UPDATE calendar_days SET day_image_path = NULL
		  WHERE page_id = $1 AND day_image_path IS NOT NULL
		  RETURNING day_image_path`,
		[pageId]
	);
	return res.rows.map(r => r.day_image_path);
}
