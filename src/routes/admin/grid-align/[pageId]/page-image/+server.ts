import sharp from 'sharp';
import { query } from '$lib/db';
import { getObject } from '$lib/ingest/spaces-upload';
import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

const pageCache = new Map<string, { promise: Promise<Buffer>; expires: number }>();
const CACHE_TTL = 5 * 60 * 1000;

function getCachedPage(key: string): Promise<Buffer> {
	const now = Date.now();
	const entry = pageCache.get(key);
	if (entry && entry.expires > now) return entry.promise;

	for (const [k, v] of pageCache) {
		if (v.expires <= now) pageCache.delete(k);
	}

	const promise = getObject(key);
	pageCache.set(key, { promise, expires: now + CACHE_TTL });
	promise.catch(() => { pageCache.delete(key); });
	return promise;
}

export const GET: RequestHandler = async ({ params, url }) => {
	const pageId = Number(params.pageId);
	if (!Number.isFinite(pageId)) error(400, 'Invalid page ID');

	const forceOriginal = url.searchParams.get('original') === '1';
	const maxWidth = Number(url.searchParams.get('w') || 2400);

	const res = await query<{
		page_image_path: string;
		warped_image_path: string | null;
	}>(`SELECT page_image_path, warped_image_path FROM calendar_pages WHERE id = $1`, [pageId]);
	if (!res.rows[0]) error(404, 'Page not found');

	const imageKey = (!forceOriginal && res.rows[0].warped_image_path)
		? res.rows[0].warped_image_path
		: res.rows[0].page_image_path;

	const raw = await getCachedPage(imageKey);
	const normalized = await sharp(raw).rotate().toBuffer();
	const meta = await sharp(normalized).metadata();
	const w = meta.width!;

	let output: Buffer;
	if (w > maxWidth) {
		output = await sharp(normalized).resize({ width: maxWidth }).jpeg({ quality: 90 }).toBuffer();
	} else {
		output = await sharp(normalized).jpeg({ quality: 90 }).toBuffer();
	}

	return new Response(output as unknown as BodyInit, {
		headers: {
			'Content-Type': 'image/jpeg',
			'Cache-Control': 'private, no-cache'
		}
	});
};
