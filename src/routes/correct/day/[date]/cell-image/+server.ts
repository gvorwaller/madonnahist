import { query } from '$lib/db';
import { cropRegion } from '$lib/image/crop';
import { getPageBuffer } from '$lib/image/page-cache';
import { getObject } from '$lib/ingest/spaces-upload';
import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, url }) => {
	const entryDate = params.date;
	if (!/^\d{4}-\d{2}-\d{2}$/.test(entryDate)) error(400, 'Invalid date');

	const padPct = Math.min(Math.max(Number(url.searchParams.get('pad') ?? 0), 0), 50);

	const res = await query<{
		crop_bounds: { x: number; y: number; width: number; height: number };
		page_image_path: string;
		warped_image_path: string | null;
		page_width: number | null;
		page_height: number | null;
		day_image_path: string | null;
	}>(`
		SELECT cd.crop_bounds, cp.page_image_path, cp.warped_image_path,
		       COALESCE(cp.warped_width, cp.image_width) AS page_width,
		       COALESCE(cp.warped_height, cp.image_height) AS page_height,
		       cd.day_image_path
		  FROM calendar_days cd
		  JOIN calendar_pages cp ON cp.id = cd.page_id
		 WHERE cd.entry_date = $1
	`, [entryDate]);

	if (!res.rows[0]) error(404, 'Day not found');
	const { crop_bounds, page_image_path, warped_image_path, page_width, page_height, day_image_path } = res.rows[0];
	if (!crop_bounds) error(404, 'No crop bounds for this day');

	if (day_image_path && padPct === 0) {
		const cropBuffer = await getObject(day_image_path);
		return new Response(cropBuffer as unknown as BodyInit, {
			headers: {
				'Content-Type': 'image/jpeg',
				'Cache-Control': 'private, max-age=3600'
			}
		});
	}

	let bounds = crop_bounds;
	if (padPct > 0 && page_width && page_height) {
		const padX = Math.round(crop_bounds.width * padPct / 100);
		const padY = Math.round(crop_bounds.height * padPct / 100);
		bounds = {
			x: Math.max(0, crop_bounds.x - padX),
			y: Math.max(0, crop_bounds.y - padY),
			width: Math.min(page_width - Math.max(0, crop_bounds.x - padX), crop_bounds.width + padX * 2),
			height: Math.min(page_height - Math.max(0, crop_bounds.y - padY), crop_bounds.height + padY * 2)
		};
	}

	const imageKey = warped_image_path ?? page_image_path;
	const pageBuffer = await getPageBuffer(imageKey, true);
	const cropped = await cropRegion(pageBuffer, bounds);

	return new Response(cropped as unknown as BodyInit, {
		headers: {
			'Content-Type': 'image/jpeg',
			'Cache-Control': 'private, max-age=3600'
		}
	});
};
