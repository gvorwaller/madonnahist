import { query } from '$lib/db';
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

interface MentionRow {
	entry_date: string;
	corrected_text: string | null;
	source: string;
	confidence_score: number | null;
}

const SNIPPET_RADIUS = 90;
const MAX_MENTIONS = 15;

/**
 * Example entries for one entity — admin curation aid on /admin/entities.
 * Lets the admin judge a merge ("are these two Alans the same person?") or
 * spot a junk extraction ("Arvie" = an uncorrected OCR typo) by reading the
 * actual day text the extractor saw. Snippets are returned as
 * {before, match, after} segments so the client renders text nodes with a
 * <mark> — never {@html} (house rule from the Phase B search work).
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	// Route gating already restricts /admin to the admin role; belt-and-braces.
	if (!locals.user || locals.user.role !== 'admin') error(403, 'Admin access required');

	const entityId = Number(params.id);
	if (!Number.isFinite(entityId)) error(400, 'Invalid entity id');

	const entityRes = await query<{ display_name: string }>(
		`SELECT display_name FROM entities WHERE id = $1`,
		[entityId]
	);
	if (!entityRes.rows[0]) error(404, 'Entity not found');
	const displayName = entityRes.rows[0].display_name;

	const mentionsRes = await query<MentionRow>(
		`SELECT cd.entry_date::text AS entry_date, cd.corrected_text,
		        de.source, de.confidence_score
		   FROM day_entities de
		   JOIN calendar_days cd ON cd.id = de.day_id
		  WHERE de.entity_id = $1
		  ORDER BY cd.entry_date
		  LIMIT ${MAX_MENTIONS + 1}`,
		[entityId]
	);

	const truncated = mentionsRes.rows.length > MAX_MENTIONS;
	const rows = mentionsRes.rows.slice(0, MAX_MENTIONS);

	const mentions = rows.map((row) => {
		const text = (row.corrected_text ?? '').replace(/\s+/g, ' ').trim();
		const idx = text.toLowerCase().indexOf(displayName.toLowerCase());
		let before: string;
		let match: string;
		let after: string;
		if (idx >= 0) {
			const start = Math.max(0, idx - SNIPPET_RADIUS);
			const end = Math.min(text.length, idx + displayName.length + SNIPPET_RADIUS);
			before = (start > 0 ? '…' : '') + text.slice(start, idx);
			match = text.slice(idx, idx + displayName.length);
			after = text.slice(idx + displayName.length, end) + (end < text.length ? '…' : '');
		} else {
			// Extractor matched on something the display name no longer equals
			// (e.g. renamed entity) — show the head of the entry unhighlighted.
			before = text.slice(0, SNIPPET_RADIUS * 2) + (text.length > SNIPPET_RADIUS * 2 ? '…' : '');
			match = '';
			after = '';
		}
		return {
			entryDate: row.entry_date,
			source: row.source,
			confidence: row.confidence_score,
			snippet: { before, match, after }
		};
	});

	return json({ displayName, mentions, truncated });
};
