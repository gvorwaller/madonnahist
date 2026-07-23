import { query } from '$lib/db';
import type { PageServerLoad } from './$types';

/**
 * Story DETAIL page (Gaylon, 2026-07-23) — the other half of the
 * /app/stories split (see ../+page.server.ts for the list half). Loads one
 * saved "Ask the archive" answer by id: full question, narrative text,
 * provenance, and (if one has been rendered) the latest scope='story' PDF
 * export for the "Download PDF" link.
 *
 * A malformed or nonexistent id gets the SAME friendly "not found" 200
 * response as a real load — no error() thrown, no format leak — matching
 * the precedent set by src/routes/app/day/[date]/+page.server.ts
 * (found:false) and src/routes/app/book/[scope]/[key]/+page.server.ts
 * (available:false).
 *
 * ?render=pdf is the same server-read-only rendering-mode convention as the
 * book page (src/routes/app/book/[scope]/[key]/+page.server.ts): it never
 * changes what loads, only what +page.svelte renders (back-link/chrome
 * hidden, print-clean). There is no content-mode query here — a story PDF
 * is always the full narrative (content modes are N/A for stories, per the
 * spec), so unlike the book route there is nothing to branch on besides
 * renderMode itself.
 */
function isValidIdParam(s: string | undefined): s is string {
	return !!s && /^\d+$/.test(s);
}

export const load: PageServerLoad = async ({ params, url }) => {
	const renderMode = url.searchParams.get('render') === 'pdf';

	if (!isValidIdParam(params.id)) {
		return { available: false as const, renderMode };
	}
	const id = Number(params.id);

	const [storyRes, pdfRes] = await Promise.all([
		query<{
			id: number;
			question: string;
			subset_definition: unknown;
			narrative_text: string;
			day_count: number;
			created_at: string;
		}>(
			`SELECT id, question, subset_definition, narrative_text, day_count, created_at::text AS created_at
			   FROM adhoc_narratives WHERE id = $1`,
			[id]
		),
		query<{ byte_size: string }>(
			`SELECT byte_size FROM pdf_exports
			  WHERE scope = 'story' AND scope_key = $1
			  ORDER BY created_at DESC LIMIT 1`,
			[String(id)]
		)
	]);

	const row = storyRes.rows[0];
	if (!row) {
		return { available: false as const, renderMode };
	}

	const sd = (typeof row.subset_definition === 'string'
		? JSON.parse(row.subset_definition)
		: row.subset_definition) as { subsetSummary?: string } | null;

	const pdfRow = pdfRes.rows[0];

	return {
		available: true as const,
		renderMode,
		id: row.id,
		question: row.question,
		narrativeText: row.narrative_text,
		dayCount: row.day_count,
		subsetSummary: sd?.subsetSummary ?? 'the transcribed archive',
		createdAt: row.created_at,
		// BIGINT comes back from node-pg as a string — Number() here only for
		// display (a human-readable KB size on the "Download PDF" link), same
		// precedent as src/routes/admin/exports/+page.server.ts's byteSize.
		pdfSizeKb: pdfRow ? Math.max(1, Math.round(Number(pdfRow.byte_size) / 1024)) : null
	};
};
