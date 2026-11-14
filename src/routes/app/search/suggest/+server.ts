import { json } from '@sveltejs/kit';
import { SUGGEST_MAX_TERM, suggestFilters } from '$lib/server/search';
import type { RequestHandler } from './$types';

/**
 * Typeahead for /app/search (V3 Slice 4): people, places and tags whose
 * name contains `q`. Behind the /app sign-in gate like every viewer route
 * (src/hooks.server.ts); accepted-only (src/lib/server/search.ts). Replaces
 * loading every filter list on each search page view (plan: GROK #8).
 */
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) return json({ people: [], places: [], tags: [] }, { status: 401 });
	const q = (url.searchParams.get('q') ?? '').slice(0, SUGGEST_MAX_TERM);
	const result = await suggestFilters(q);
	return json(result, { headers: { 'Cache-Control': 'private, max-age=60' } });
};
