/**
 * Viewer-facing PDF download for a saved "Ask the archive" story (Gaylon,
 * 2026-07-23) — mirrors src/routes/app/year/[year]/pdf/+server.ts's pattern
 * for the same reasons: any authenticated role reaches this (this route
 * lives under /app/stories/[id], already allowed for every role by
 * src/hooks.server.ts's roleAllowed()). Streams the MOST RECENT scope='story'
 * pdf_exports row for this id straight from Spaces (or the local test object
 * store) — never redirects to a public/presigned URL, never exposes the raw
 * object key to the client. A malformed/nonexistent id, or one with no
 * rendered export yet, gets a friendly 404, not a crash.
 */
import { query } from '$lib/db';
import { getObject } from '$lib/ingest/spaces-upload';
import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

function isValidIdParam(s: string | undefined): s is string {
	return !!s && /^\d+$/.test(s);
}

export const GET: RequestHandler = async ({ params }) => {
	if (!isValidIdParam(params.id)) error(404, 'No PDF export is available for this story.');

	const res = await query<{ object_key: string }>(
		`SELECT object_key FROM pdf_exports
		  WHERE scope = 'story' AND scope_key = $1
		  ORDER BY created_at DESC LIMIT 1`,
		[params.id]
	);
	const row = res.rows[0];
	if (!row) error(404, 'No PDF export is available for this story yet.');

	let buffer: Buffer;
	try {
		buffer = await getObject(row.object_key);
	} catch {
		error(404, 'No PDF export is available for this story yet.');
	}

	return new Response(buffer as unknown as BodyInit, {
		headers: {
			'Content-Type': 'application/pdf',
			'Content-Disposition': `attachment; filename="madonnahist-story-${params.id}.pdf"`,
			'Cache-Control': 'private, no-store'
		}
	});
};
