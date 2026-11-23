import { error, json } from '@sveltejs/kit';
import { familyDays, loadFamily, parseCursor } from '$lib/server/entity-evidence';
import { toId } from '$lib/server/entity-graph';
import type { RequestHandler } from './$types';

const DEFAULT_LIMIT = 15;
const MAX_LIMIT = 100;

/**
 * The days an entity is mentioned on, oldest first, a page at a time
 * (?after=<cursor>&limit=n). Admin curation aid for /admin/entities and
 * /admin/entities/cleanup: read the actual entries before merging, and move
 * a day that's about someone else (td-c6e871).
 *
 * A canonical entity's days are its whole family's; an alias's are its own.
 * `familyId` is the canonical id a "move this day" acts on. Snippets come
 * back as {before, match, after} segments so the client renders text nodes
 * with a <mark>, never {@html} (house rule from the Phase B search work).
 */
export const GET: RequestHandler = async ({ params, locals, url }) => {
	// Route gating already restricts /admin to the admin role; belt-and-braces.
	if (!locals.user || locals.user.role !== 'admin') error(403, 'Admin access required');

	const entityId = toId(params.id);
	if (entityId === null) error(400, 'Invalid entity id');
	const family = await loadFamily(entityId);
	if (!family) error(404, 'Entity not found');

	const rawLimit = Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT);
	const limit = Number.isInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), MAX_LIMIT) : DEFAULT_LIMIT;
	const { days, next } = await familyDays(family, { after: parseCursor(url.searchParams.get('after')), limit });

	return json({
		displayName: family.displayName,
		familyId: family.canonicalId,
		entityType: family.entityType,
		mentions: days.map((d) => ({
			dayId: d.dayId,
			entryDate: d.entryDate,
			human: d.human,
			via: d.via,
			snippet: d.snippet
		})),
		next,
		truncated: next !== null
	});
};
