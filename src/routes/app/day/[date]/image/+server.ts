import { query } from '$lib/db';
import { getObject } from '$lib/ingest/spaces-upload';
import { isValidEntryDate } from '$lib/server/viewer';
import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/**
 * Viewer day image. Copies the object-store-fetch pattern from
 * src/routes/correct/day/[date]/cell-image/+server.ts, but — per Phase B of
 * docs/2026-07-21-next-phases-search-viewer-narrative-plan.md — the SQL here
 * additionally gates on `correction_status = 'accepted'` for viewer-role
 * requests. The source correction endpoint has no such predicate (correctors
 * need to see in-progress days); this one must, since `/app` is the family
 * viewer and a page-level check alone would not stop a direct GET. A viewer
 * requesting a non-accepted day gets a 404 indistinguishable from a
 * nonexistent day — never a 403 (which would confirm the day exists).
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) error(404, 'Not found');

	const entryDate = params.date;
	if (!isValidEntryDate(entryDate)) error(404, 'Not found');

	const isViewer = locals.user.role === 'viewer';

	const res = await query<{ day_image_path: string | null; correction_status: string }>(
		isViewer
			? `SELECT day_image_path, correction_status
			     FROM calendar_days
			    WHERE entry_date = $1 AND correction_status = 'accepted'`
			: `SELECT day_image_path, correction_status
			     FROM calendar_days
			    WHERE entry_date = $1`,
		[entryDate]
	);

	const row = res.rows[0];
	if (!row || !row.day_image_path) error(404, 'Not found');

	let buffer: Buffer;
	try {
		buffer = await getObject(row.day_image_path);
	} catch {
		// Object missing/unreachable in the store — still a 404 to the client;
		// this is an operational gap (e.g. local test fixture with no real
		// object), not an authorization signal either way.
		error(404, 'Not found');
	}

	return new Response(buffer as unknown as BodyInit, {
		headers: {
			'Content-Type': 'image/jpeg',
			'Cache-Control': 'private, max-age=3600'
		}
	});
};
