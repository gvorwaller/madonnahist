import sharp from 'sharp';
import { query } from '$lib/db';
import { getPageBuffer } from '$lib/image/page-cache';
import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

const MIN_YEAR = 1900;
const MAX_YEAR = 2100;

function parseMonthKey(monthKey: string | undefined): { year: number; month: number } | null {
	if (!monthKey || !/^\d{4}-\d{2}$/.test(monthKey)) return null;
	const [yearStr, monthStr] = monthKey.split('-');
	const year = Number(yearStr);
	const month = Number(monthStr);
	if (year < MIN_YEAR || year > MAX_YEAR) return null;
	if (month < 1 || month > 12) return null;
	return { year, month };
}

/**
 * Full calendar-page image for the month view (td-852d99).
 *
 * POLICY (deliberate, Gaylon 2026-07-23): the full scanned page photo is
 * family-visible to ANY authenticated /app viewer even though it shows the
 * handwriting of days that haven't been transcribed/accepted yet — unlike
 * the per-day crop endpoint (src/routes/app/day/[date]/image/+server.ts),
 * which gates on `correction_status = 'accepted'` because that endpoint
 * exposes a specific day's content tied to a specific transcription status.
 * A whole scanned page is just "here is the physical page for this month" —
 * no transcribed text is served alongside it, and the day-detail pages and
 * their image endpoint remain accepted-only exactly as before. Requires an
 * authenticated user (enforced by src/hooks.server.ts's blanket /app gate;
 * checked again here defensively, matching the day-image endpoint's
 * precedent) and is NOT reachable via a render-token synthetic session —
 * src/lib/server/render-token.ts's matchesRenderScopePath() only allows the
 * book-page path and the /app/day/[date]/image path, deliberately not
 * extended to month pages for this task (no PDF export for months yet).
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) error(404, 'Not found');

	const parsed = parseMonthKey(params.monthKey);
	if (!parsed) error(404, 'Not found');

	const res = await query<{ page_image_path: string; warped_image_path: string | null }>(
		`SELECT page_image_path, warped_image_path FROM calendar_pages WHERE year = $1 AND month = $2`,
		[parsed.year, parsed.month]
	);

	const row = res.rows[0];
	if (!row) error(404, 'Not found');

	const imageKey = row.warped_image_path ?? row.page_image_path;

	let raw: Buffer;
	try {
		raw = await getPageBuffer(imageKey, true);
	} catch {
		// Object missing/unreachable in the store — a 404 to the client either
		// way; this is an operational gap, not an authorization signal.
		error(404, 'Not found');
	}

	const meta = await sharp(raw).metadata();
	const maxWidth = 2400;

	let output: Buffer;
	if (meta.width && meta.width > maxWidth) {
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
