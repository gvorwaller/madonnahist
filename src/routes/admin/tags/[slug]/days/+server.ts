import { query } from '$lib/db';
import { isValidTagSlug } from '$lib/server/tags';
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

const MAX_DAYS = 8;
const SNIPPET_CHARS = 200;

/**
 * Example days for one tag name — curation aid on /admin/tags, same idea as
 * /admin/entities/[id]/mentions: read a few real entries before deciding
 * whether a tag name is worth showing, hiding, or merging. Accepted days
 * only (that's what the family would see), newest first, plain-text
 * snippets (rendered as text nodes, never {@html}).
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user || locals.user.role !== 'admin') error(403, 'Admin access required');
	const slug = params.slug;
	if (!isValidTagSlug(slug)) error(400, 'Invalid tag');

	const res = await query<{
		entry_date: string;
		corrected_text: string | null;
		source: string;
	}>(
		`SELECT cd.entry_date::text AS entry_date, cd.corrected_text, dt.source
		   FROM day_tags dt
		   JOIN calendar_days cd ON cd.id = dt.day_id
		  WHERE dt.tag_slug = $1 AND cd.correction_status = 'accepted'
		  ORDER BY cd.entry_date DESC
		  LIMIT ${MAX_DAYS + 1}`,
		[slug]
	);
	const truncated = res.rows.length > MAX_DAYS;
	const days = res.rows.slice(0, MAX_DAYS).map((r) => {
		const text = (r.corrected_text ?? '').replace(/\s+/g, ' ').trim();
		return {
			entryDate: r.entry_date,
			source: r.source,
			snippet: text.length > SNIPPET_CHARS ? text.slice(0, SNIPPET_CHARS) + '…' : text
		};
	});
	return json({ days, truncated });
};
