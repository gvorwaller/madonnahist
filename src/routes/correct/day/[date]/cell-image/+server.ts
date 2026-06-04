import { query } from '$lib/db';
import { cropRegion } from '$lib/image/crop';
import { getPageBuffer } from '$lib/image/page-cache';
import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params }) => {
	const entryDate = params.date;
	if (!/^\d{4}-\d{2}-\d{2}$/.test(entryDate)) error(400, 'Invalid date');

	const res = await query<{
		crop_bounds: { x: number; y: number; width: number; height: number };
		page_image_path: string;
		warped_image_path: string | null;
	}>(`
		SELECT cd.crop_bounds, cp.page_image_path, cp.warped_image_path
		  FROM calendar_days cd
		  JOIN calendar_pages cp ON cp.id = cd.page_id
		 WHERE cd.entry_date = $1
	`, [entryDate]);

	if (!res.rows[0]) error(404, 'Day not found');
	const { crop_bounds, page_image_path, warped_image_path } = res.rows[0];
	if (!crop_bounds) error(404, 'No crop bounds for this day');

	const imageKey = warped_image_path ?? page_image_path;
	const pageBuffer = await getPageBuffer(imageKey, true);
	const cropped = await cropRegion(pageBuffer, crop_bounds);

	return new Response(cropped as unknown as BodyInit, {
		headers: {
			'Content-Type': 'image/jpeg',
			'Cache-Control': 'private, max-age=3600'
		}
	});
};
