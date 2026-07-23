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

export const GET: RequestHandler = async ({ params, locals }) => {
	requireAdmin(locals);

	const id = Number(params.id);
	if (!Number.isInteger(id) || id <= 0) error(404, 'Not found');

	const res = await query<{ object_key: string; scope_key: string }>(
		`SELECT object_key, scope_key FROM pdf_exports WHERE id = $1`,
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

	const filename = `madonnahist-${row.scope_key}.pdf`;
	return new Response(buffer as unknown as BodyInit, {
		headers: {
			'Content-Type': 'application/pdf',
			'Content-Disposition': `attachment; filename="${filename}"`,
			'Cache-Control': 'private, no-store'
		}
	});
};
