import { query } from '$lib/db';
import type { PageServerLoad } from './$types';

/**
 * Family-visible LIST of saved "Ask the archive" answers (Gaylon,
 * 2026-07-23) — split from the original single-page /app/stories into a
 * list (this page) and a detail page (./[id]/+page.server.ts) so the list
 * stays a fast, scannable index. Deliberately does NOT select
 * narrative_text at all — the list is title + meta only, never narrative
 * text, so there is nothing to accidentally leak into the list markup even
 * before considering what the template renders.
 *
 * Saving on /admin/ask is the curation act — an admin has read the answer
 * and chosen to keep it — so every saved row is family-visible here, with
 * its provenance (question + subset + day count). Deleting on /admin/ask is
 * how one is withdrawn.
 *
 * Route gating: /app requires any authenticated role; no extra check
 * needed. Reads only adhoc_narratives, which contains exclusively
 * admin-reviewed, archive-derived text.
 */
export const load: PageServerLoad = async () => {
	const res = await query<{
		id: number;
		question: string;
		subset_definition: unknown;
		day_count: number;
		created_at: string;
	}>(
		`SELECT id, question, subset_definition, day_count, created_at::text
		   FROM adhoc_narratives
		  ORDER BY created_at DESC`
	);

	const stories = res.rows.map((r) => {
		const sd = (typeof r.subset_definition === 'string'
			? JSON.parse(r.subset_definition)
			: r.subset_definition) as { subsetSummary?: string } | null;
		return {
			id: r.id,
			question: r.question,
			dayCount: r.day_count,
			subsetSummary: sd?.subsetSummary ?? 'the transcribed archive',
			createdAt: r.created_at
		};
	});

	return { stories };
};
