/**
 * Admin-only PDF export download (Phase H of
 * docs/2026-07-21-next-phases-search-viewer-narrative-plan.md). Streams the
 * object bytes straight from Spaces (or the local test object store) —
 * never redirects to a public/presigned URL and never exposes the raw
 * object key to the client, only this row's opaque numeric id.
 *
 * src/hooks.server.ts's roleAllowed() already restricts all of /admin to
 * the admin role (viewer -> 403, unauthenticated GET -> redirect to login);
 * the requireAdmin() check here is defense-in-depth, matching every other
 * admin +page.server.ts/+server.ts in this codebase.
 */
import { query } from '$lib/db';
import { getObject } from '$lib/ingest/spaces-upload';
import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

function requireAdmin(locals: App.Locals) {
	if (!locals.user || locals.user.role !== 'admin') {
		error(403, 'Admin access required');
	}
}

// Phase H content modes (Gaylon, 2026-07-23): 'full' keeps the original
// filename (existing exports from before this feature never had a mode
// segment); 'narrative'/'days' get an explicit suffix so a family member
// downloading multiple PDFs for the same year can tell them apart at a
// glance in their downloads folder. Mirrors
// src/routes/app/year/[year]/pdf/+server.ts's identical helper — duplicated
// rather than shared, matching this codebase's existing precedent of small
// per-route helpers (see e.g. each route's own requireAdmin()) over a
// cross-cutting utility module for a five-line function.
function pdfExportFilename(scopeKey: string, contentMode: string): string {
	const suffix = contentMode === 'full' ? '' : `-${contentMode}`;
	return `madonnahist-${scopeKey}${suffix}.pdf`;
}

export const GET: RequestHandler = async ({ params, locals }) => {
	requireAdmin(locals);

	const id = Number(params.id);
	if (!Number.isInteger(id) || id <= 0) error(404, 'Not found');

	const res = await query<{ object_key: string; scope_key: string; content_mode: string }>(
		`SELECT object_key, scope_key, content_mode FROM pdf_exports WHERE id = $1`,
		[id]
	);
	const row = res.rows[0];
	if (!row) error(404, 'Not found');

	let buffer: Buffer;
	try {
		buffer = await getObject(row.object_key);
	} catch {
		error(404, 'Not found');
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
