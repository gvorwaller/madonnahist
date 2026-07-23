/**
 * Viewer-facing PDF download for a year's book (Gaylon, 2026-07-23) — the
 * family can already read a published narrative and the full book on-screen
 * at /app/year/[year] / /app/book/year/[year]; this lets them download and
 * print the same content as a PDF without needing admin access.
 *
 * Any authenticated role reaches this: src/hooks.server.ts's roleAllowed()
 * already lets every role through the /app prefix, and this route lives
 * under /app/year/[year], so no extra role check is needed here — unlike
 * src/routes/admin/exports/download/[id]/+server.ts, which is admin-only by
 * virtue of living under /admin.
 *
 * Streams the MOST RECENT pdf_exports row for this year and the requested
 * content mode (?mode=narrative|days, default 'full') straight from Spaces
 * (or the local test object store) — same pattern as the admin download
 * endpoint: never redirects to a public/presigned URL, never exposes the
 * raw object key to the client. A year with no matching export (wrong mode,
 * or none generated at all) gets a friendly 404, not a crash.
 */
import { query } from '$lib/db';
import { getObject } from '$lib/ingest/spaces-upload';
import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

const MIN_YEAR = 1900;
const MAX_YEAR = 2100;

function isValidYearParam(s: string | undefined): s is string {
	if (!s || !/^\d{4}$/.test(s)) return false;
	const y = Number(s);
	return y >= MIN_YEAR && y <= MAX_YEAR;
}

type ContentMode = 'full' | 'narrative' | 'days';

function isValidContentMode(s: string | null): s is ContentMode {
	return s === 'narrative' || s === 'days';
}

// Mirrors src/routes/admin/exports/download/[id]/+server.ts's identical
// helper — duplicated rather than shared, matching this codebase's existing
// precedent of small per-route helpers over a cross-cutting utility module
// for a five-line function.
function pdfExportFilename(scopeKey: string, contentMode: string): string {
	const suffix = contentMode === 'full' ? '' : `-${contentMode}`;
	return `madonnahist-${scopeKey}${suffix}.pdf`;
}

export const GET: RequestHandler = async ({ params, url }) => {
	if (!isValidYearParam(params.year)) error(404, 'No PDF export is available for this year.');

	const modeParam = url.searchParams.get('mode');
	const contentMode: ContentMode = isValidContentMode(modeParam) ? modeParam : 'full';

	const res = await query<{ object_key: string; scope_key: string; content_mode: string }>(
		`SELECT object_key, scope_key, content_mode FROM pdf_exports
		  WHERE scope = 'year' AND scope_key = $1 AND content_mode = $2
		  ORDER BY created_at DESC LIMIT 1`,
		[params.year, contentMode]
	);
	const row = res.rows[0];
	if (!row) error(404, 'No PDF export is available for this year yet.');

	let buffer: Buffer;
	try {
		buffer = await getObject(row.object_key);
	} catch {
		error(404, 'No PDF export is available for this year yet.');
	}

	const filename = pdfExportFilename(row.scope_key, row.content_mode);
	return new Response(buffer as unknown as BodyInit, {
		headers: {
			'Content-Type': 'application/pdf',
			'Content-Disposition': `attachment; filename="${filename}"`,
			'Cache-Control': 'private, no-store'
		}
	});
};
