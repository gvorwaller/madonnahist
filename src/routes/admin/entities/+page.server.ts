import { query, withTransaction } from '$lib/db';
import { error, fail } from '@sveltejs/kit';
import { deleteUnused, graphWrite, mergeEntities, moveDay, setAlias, toId } from '$lib/server/entity-graph';
import type { Actions, PageServerLoad } from './$types';

const ENTITY_TYPES = ['person', 'place', 'event'] as const;
type EntityType = (typeof ENTITY_TYPES)[number];

const MAX_DISPLAY_NAME_LENGTH = 100;

function requireAdmin(locals: App.Locals) {
	if (!locals.user || locals.user.role !== 'admin') {
		error(403, 'Admin access required');
	}
}

interface EntityRow {
	id: number;
	slug: string;
	display_name: string;
	entity_type: EntityType;
	alias_of_entity_id: number | null;
	alias_of_display_name: string | null;
	alias_of_slug: string | null;
	mention_count: number;
}

export const load: PageServerLoad = async ({ locals }) => {
	requireAdmin(locals);

	// mention_count matches what the row's Entries list shows (the mentions
	// endpoint, src/lib/server/entity-evidence.ts): a main name's whole
	// family's distinct days, an alias's own direct links (CODEX9 td-c6e871
	// #12). A main name whose mentions all sit on its aliases isn't "0".
	const entitiesRes = await query<EntityRow>(
		`WITH direct AS (
		   SELECT entity_id, COUNT(*)::int AS n FROM day_entities GROUP BY entity_id
		 ), fam AS (
		   SELECT COALESCE(m.alias_of_entity_id, m.id) AS cid, COUNT(DISTINCT de.day_id)::int AS n
		     FROM day_entities de JOIN entities m ON m.id = de.entity_id
		    GROUP BY 1
		 )
		 SELECT e.id, e.slug, e.display_name, e.entity_type, e.alias_of_entity_id,
		        alias.display_name AS alias_of_display_name, alias.slug AS alias_of_slug,
		        CASE WHEN e.alias_of_entity_id IS NULL THEN COALESCE(fam.n, 0) ELSE COALESCE(direct.n, 0) END AS mention_count
		   FROM entities e
		   LEFT JOIN entities alias ON alias.id = e.alias_of_entity_id
		   LEFT JOIN direct ON direct.entity_id = e.id
		   LEFT JOIN fam ON fam.cid = e.id
		  ORDER BY e.entity_type, e.display_name`
	);

	// Canonical entities per type — the only valid alias/merge targets
	// (must themselves have alias_of_entity_id IS NULL, per the one-hop
	// COALESCE(alias_of_entity_id, id) invariant enforced by the actions
	// below).
	const canonicalRes = await query<{ id: number; slug: string; display_name: string; entity_type: EntityType }>(
		`SELECT id, slug, display_name, entity_type FROM entities WHERE alias_of_entity_id IS NULL ORDER BY entity_type, display_name`
	);

	return {
		entities: entitiesRes.rows,
		canonicalByType: {
			person: canonicalRes.rows.filter((r) => r.entity_type === 'person'),
			place: canonicalRes.rows.filter((r) => r.entity_type === 'place'),
			event: canonicalRes.rows.filter((r) => r.entity_type === 'event')
		}
	};
};

export const actions: Actions = {
	rename: async ({ request, locals }) => {
		requireAdmin(locals);
		const data = await request.formData();
		const id = Number(data.get('id'));
		const displayName = ((data.get('displayName') as string) ?? '').trim();

		if (!Number.isFinite(id)) return fail(400, { error: 'Invalid entity ID' });
		if (!displayName) return fail(400, { error: 'Display name is required' });
		if (displayName.length > MAX_DISPLAY_NAME_LENGTH) {
			return fail(400, { error: `Display name must be ${MAX_DISPLAY_NAME_LENGTH} characters or fewer` });
		}

		const before = await query<{ display_name: string; entity_type: string }>(
			`SELECT display_name, entity_type FROM entities WHERE id = $1`,
			[id]
		);
		if (!before.rows[0]) return fail(404, { error: 'Entity not found' });

		await withTransaction(async (client) => {
			await client.query(`UPDATE entities SET display_name = $2 WHERE id = $1`, [id, displayName]);
			await client.query(
				`INSERT INTO audit_log (user_id, action, entity_type, entity_id, before_value, after_value, description)
				 VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)`,
				[Number(locals.user!.id), 'entity_rename', 'entities', id,
				 JSON.stringify({ display_name: before.rows[0].display_name }),
				 JSON.stringify({ display_name: displayName }),
				 `Renamed ${before.rows[0].entity_type} "${before.rows[0].display_name}" → "${displayName}"`]
			);
		});
	},

	setAlias: async ({ request, locals }) => {
		requireAdmin(locals);
		const data = await request.formData();
		const id = toId(data.get('id'));
		const targetId = toId(data.get('targetId'));
		if (id === null) return fail(400, { error: 'Invalid entity ID' });
		if (targetId === null) return fail(400, { error: 'Invalid alias target' });
		return graphWrite((client) => setAlias(client, id, targetId, Number(locals.user!.id)));
	},

	mergeInto: async ({ request, locals }) => {
		requireAdmin(locals);
		const data = await request.formData();
		const sourceId = toId(data.get('sourceId'));
		const targetId = toId(data.get('targetId'));
		if (sourceId === null) return fail(400, { error: 'Invalid source entity' });
		if (targetId === null) return fail(400, { error: 'Invalid merge target' });
		return graphWrite((client) => mergeEntities(client, targetId, [sourceId], Number(locals.user!.id)));
	},

	moveDay: async ({ request, locals }) => {
		requireAdmin(locals);
		const data = await request.formData();
		const dayId = toId(data.get('dayId'));
		const fromId = toId(data.get('fromId'));
		const toEntity = toId(data.get('toId'));
		if (dayId === null || fromId === null || toEntity === null) return fail(400, { error: 'Invalid move' });
		return graphWrite((client) => moveDay(client, dayId, fromId, toEntity, Number(locals.user!.id)));
	},

	delete: async ({ request, locals }) => {
		requireAdmin(locals);
		const data = await request.formData();
		const id = toId(data.get('id'));
		if (id === null) return fail(400, { error: 'Invalid entity ID' });
		return graphWrite((client) => deleteUnused(client, id, Number(locals.user!.id)));
	}
};
