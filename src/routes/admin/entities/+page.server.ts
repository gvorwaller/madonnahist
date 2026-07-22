import { query, withTransaction } from '$lib/db';
import { error, fail } from '@sveltejs/kit';
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

	const entitiesRes = await query<EntityRow>(
		`SELECT e.id, e.slug, e.display_name, e.entity_type, e.alias_of_entity_id,
		        alias.display_name AS alias_of_display_name, alias.slug AS alias_of_slug,
		        COUNT(de.day_id)::int AS mention_count
		   FROM entities e
		   LEFT JOIN day_entities de ON de.entity_id = e.id
		   LEFT JOIN entities alias ON alias.id = e.alias_of_entity_id
		  GROUP BY e.id, alias.display_name, alias.slug
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

/**
 * Re-parent any entity currently aliasing `entityId` to `targetId` instead.
 * Keeps COALESCE(alias_of_entity_id, id) resolution correct at one hop no
 * matter which action (setAlias or mergeInto) is about to make `entityId`
 * itself into an alias — without this, an entity that was already a
 * canonical target for other aliases would produce a 2-hop chain
 * (Z -> entityId -> targetId) the moment entityId became an alias.
 */
async function reparentExistingAliases(
	client: { query: (text: string, params?: unknown[]) => Promise<unknown> },
	entityId: number,
	targetId: number
): Promise<void> {
	await client.query(`UPDATE entities SET alias_of_entity_id = $2 WHERE alias_of_entity_id = $1`, [entityId, targetId]);
}

async function validateAliasTarget(entityId: number, targetId: number): Promise<string | null> {
	if (entityId === targetId) return 'An entity cannot be an alias of itself';

	const entityRes = await query<{ entity_type: EntityType }>(`SELECT entity_type FROM entities WHERE id = $1`, [entityId]);
	if (!entityRes.rows[0]) return 'Entity not found';

	const targetRes = await query<{ entity_type: EntityType; alias_of_entity_id: number | null }>(
		`SELECT entity_type, alias_of_entity_id FROM entities WHERE id = $1`,
		[targetId]
	);
	if (!targetRes.rows[0]) return 'Target entity not found';

	if (targetRes.rows[0].entity_type !== entityRes.rows[0].entity_type) {
		return 'Alias target must be the same entity type';
	}
	if (targetRes.rows[0].alias_of_entity_id !== null) {
		return 'Alias target must itself be canonical (not already an alias) — no chains';
	}
	return null;
}

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
		const id = Number(data.get('id'));
		const targetId = Number(data.get('targetId'));

		if (!Number.isFinite(id)) return fail(400, { error: 'Invalid entity ID' });
		if (!Number.isFinite(targetId)) return fail(400, { error: 'Invalid alias target' });

		const validationError = await validateAliasTarget(id, targetId);
		if (validationError) return fail(409, { error: validationError });

		const before = await query<{ display_name: string; entity_type: string; alias_of_entity_id: number | null }>(
			`SELECT display_name, entity_type, alias_of_entity_id FROM entities WHERE id = $1`,
			[id]
		);
		const target = await query<{ display_name: string }>(`SELECT display_name FROM entities WHERE id = $1`, [targetId]);
		if (!before.rows[0] || !target.rows[0]) return fail(404, { error: 'Entity not found' });

		await withTransaction(async (client) => {
			await reparentExistingAliases(client, id, targetId);
			await client.query(`UPDATE entities SET alias_of_entity_id = $2 WHERE id = $1`, [id, targetId]);
			await client.query(
				`INSERT INTO audit_log (user_id, action, entity_type, entity_id, before_value, after_value, description)
				 VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)`,
				[Number(locals.user!.id), 'entity_set_alias', 'entities', id,
				 JSON.stringify({ alias_of_entity_id: before.rows[0].alias_of_entity_id }),
				 JSON.stringify({ alias_of_entity_id: targetId }),
				 `Set "${before.rows[0].display_name}" (${before.rows[0].entity_type}) as an alias of "${target.rows[0].display_name}"`]
			);
		});
	},

	mergeInto: async ({ request, locals }) => {
		requireAdmin(locals);
		const data = await request.formData();
		const sourceId = Number(data.get('sourceId'));
		const targetId = Number(data.get('targetId'));

		if (!Number.isFinite(sourceId)) return fail(400, { error: 'Invalid source entity' });
		if (!Number.isFinite(targetId)) return fail(400, { error: 'Invalid merge target' });

		const validationError = await validateAliasTarget(sourceId, targetId);
		if (validationError) return fail(409, { error: validationError });

		const source = await query<{ display_name: string; entity_type: string }>(
			`SELECT display_name, entity_type FROM entities WHERE id = $1`,
			[sourceId]
		);
		const target = await query<{ display_name: string }>(`SELECT display_name FROM entities WHERE id = $1`, [targetId]);
		if (!source.rows[0] || !target.rows[0]) return fail(404, { error: 'Entity not found' });

		const mentionCountBefore = await query<{ count: number }>(
			`SELECT COUNT(DISTINCT day_id)::int AS count FROM day_entities WHERE entity_id IN ($1, $2)`,
			[sourceId, targetId]
		);

		await withTransaction(async (client) => {
			// Rewrite day_entities from source to target: insert target-pointed
			// copies first (skipping any day that already has a target row via
			// ON CONFLICT DO NOTHING — a day already linked to both keeps a
			// single row), then delete every remaining source row. Every
			// distinct day that mentioned either source or target still
			// mentions target afterward.
			await client.query(
				`INSERT INTO day_entities (day_id, entity_id, source, confidence_score)
				 SELECT day_id, $2, source, confidence_score FROM day_entities WHERE entity_id = $1
				 ON CONFLICT (day_id, entity_id) DO NOTHING`,
				[sourceId, targetId]
			);
			await client.query(`DELETE FROM day_entities WHERE entity_id = $1`, [sourceId]);

			// Keep source as an alias pointing at the canonical target, per
			// plan Phase D item 6, rather than deleting it — re-parenting any
			// of ITS OWN existing aliases first keeps one-hop resolution intact.
			await reparentExistingAliases(client, sourceId, targetId);
			await client.query(`UPDATE entities SET alias_of_entity_id = $2 WHERE id = $1`, [sourceId, targetId]);

			await client.query(
				`INSERT INTO audit_log (user_id, action, entity_type, entity_id, before_value, after_value, description)
				 VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)`,
				[Number(locals.user!.id), 'entity_merge', 'entities', sourceId,
				 JSON.stringify({ display_name: source.rows[0].display_name, distinct_days_before: mentionCountBefore.rows[0]?.count ?? null }),
				 JSON.stringify({ merged_into: target.rows[0].display_name, merged_into_id: targetId }),
				 `Merged "${source.rows[0].display_name}" (${source.rows[0].entity_type}) into "${target.rows[0].display_name}"`]
			);
		});
	},

	delete: async ({ request, locals }) => {
		requireAdmin(locals);
		const data = await request.formData();
		const id = Number(data.get('id'));
		if (!Number.isFinite(id)) return fail(400, { error: 'Invalid entity ID' });

		const before = await query<{ display_name: string; entity_type: string; slug: string }>(
			`SELECT display_name, entity_type, slug FROM entities WHERE id = $1`,
			[id]
		);
		if (!before.rows[0]) return fail(404, { error: 'Entity not found' });

		let blocked = false;
		await withTransaction(async (client) => {
			// Guard lives in the DELETE's own WHERE clause (atomic with the
			// delete itself, no separate check-then-act race) — zero rows
			// deleted means either condition failed; the audit insert is
			// simply skipped and the transaction commits as a no-op.
			const deleted = await client.query<{ id: number }>(
				`DELETE FROM entities WHERE id = $1
				   AND NOT EXISTS (SELECT 1 FROM day_entities WHERE entity_id = $1)
				   AND NOT EXISTS (SELECT 1 FROM entities WHERE alias_of_entity_id = $1)
				 RETURNING id`,
				[id]
			);
			if (!deleted.rows[0]) {
				blocked = true;
				return;
			}
			await client.query(
				`INSERT INTO audit_log (user_id, action, entity_type, entity_id, before_value, after_value, description)
				 VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)`,
				[Number(locals.user!.id), 'entity_delete', 'entities', id,
				 JSON.stringify(before.rows[0]), null,
				 `Deleted ${before.rows[0].entity_type} "${before.rows[0].display_name}" (zero mentions, no aliases pointing to it)`]
			);
		});

		if (blocked) {
			return fail(409, { error: 'Cannot delete: entity has mentions or is an alias target for another entity' });
		}
	}
};
