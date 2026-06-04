import sharp from 'sharp';
import { query } from '$lib/db';
import { getPageBuffer } from '$lib/image/page-cache';
import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params }) => {
	const entryDate = params.date;
	if (!/^\d{4}-\d{2}-\d{2}$/.test(entryDate)) error(400, 'Invalid date');

	const res = await query<{
		page_id: number;
		page_image_path: string;
		warped_image_path: string | null;
	}>(`
		SELECT cd.page_id, cp.page_image_path, cp.warped_image_path
		  FROM calendar_days cd
		  JOIN calendar_pages cp ON cp.id = cd.page_id
		 WHERE cd.entry_date = $1
	`, [entryDate]);

	if (!res.rows[0]) error(404, 'Day not found');

	const imageKey = res.rows[0].warped_image_path ?? res.rows[0].page_image_path;
	const raw = await getPageBuffer(imageKey, true);
	const meta = await sharp(raw).metadata();
	const maxWidth = 2400;

	let output: Buffer;
	if (meta.width! > maxWidth) {
		output = await sharp(raw).resize({ width: maxWidth }).jpeg({ quality: 90 }).toBuffer();
	} else {
		output = await sharp(raw).jpeg({ quality: 90 }).toBuffer();
	}

	return new Response(output as unknown as BodyInit, {
		headers: {
			'Content-Type': 'image/jpeg',
			'Cache-Control': 'private, max-age=3600'
		}
	});
};
