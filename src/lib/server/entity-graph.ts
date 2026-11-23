/**
 * Every change to which entity a day is about goes through here (td-c6e871,
 * docs/2026-11-23-entity-cleanup-plan.md "Ground rules" and §3): merge, set
 * alias, move a day, "not the same", delete an unused entity. Used by
 * /admin/entities and /admin/entities/cleanup.
 *
 * Each function runs inside the caller's transaction (withTransaction) and:
 *   1. takes the entity-graph advisory lock, then the day locks for every day
 *      it touches, ascending (src/lib/entity-locks.ts; the enrichment worker
 *      takes the same day lock before rebuilding a day's AI links), and only
 *      then locks entity rows. That order matters: the worker holds a day
 *      lock while its link inserts take a foreign-key share lock on an
 *      entity row, so locking rows first and then waiting for a day lock is
 *      a deadlock (CODEX9 td-c6e871 #1). Rows are locked FOR NO KEY UPDATE,
 *      which those foreign-key locks don't conflict with;
 *   2. re-reads and validates everything on that transaction's client, so a
 *      second tab or the extractor can't slip in between check and write;
 *   3. writes, plus one audit_log row per human decision.
 * Problems throw EntityGraphError(status, message); the caller turns that
 * into fail(status, { error }). Any throw rolls back the whole transaction,
 * so a multi-merge with one stale name merges nothing.
 *
 * Identity is the canonical family: an entity plus everything aliased to it
 * (readers resolve COALESCE(alias_of_entity_id, id)). Ids are BIGINT, which
 * node-pg returns as strings: everything here is Number()-ed on the way in.
 *
 * Human beats AI: when a day link is copied onto an entity that already has
 * one for that day, the result is 'human' if either was, and an AI
 * confidence is dropped when a row becomes human. The extractor only ever
 * replaces source='ai' rows, so a human decision survives later merges and
 * re-extraction.
 */
import type pg from 'pg';
import { fail, type ActionFailure } from '@sveltejs/kit';
import { withTransaction } from '$lib/db';
import { ENTITY_DAY_LOCK_CLASS, ENTITY_GRAPH_LOCK } from '$lib/entity-locks';
import { pairKey } from '$lib/entity-matcher';

export type EntityType = 'person' | 'place' | 'event';
type Client = pg.PoolClient;

export class EntityGraphError extends Error {
	constructor(
		public status: number,
		message: string
	) {
		super(message);
	}
}

interface EntityRow {
	id: number;
	display_name: string;
	entity_type: EntityType;
	alias_of_entity_id: number | null;
}

/**
 * An unused entity: canonical (an alias is a spelling the extractor resolves
 * through, so deleting it would let that spelling come back as a new,
 * unblocked entity: CODEX td-c6e871 code review #1), and nothing links to it,
 * aliases it, blocks it, decided its map, or marked it "not the same" as
 * another name (deleting would cascade that decision away, and the next
 * extraction of the spelling would bring the dismissed suggestion back:
 * CODEX9 #5). Each is a human decision that only its own undo should remove.
 */
export const UNUSED_SQL = (e: string) => `
	${e}.alias_of_entity_id IS NULL
	AND NOT EXISTS (SELECT 1 FROM day_entities de WHERE de.entity_id = ${e}.id)
	AND NOT EXISTS (SELECT 1 FROM entities al WHERE al.alias_of_entity_id = ${e}.id)
	AND NOT EXISTS (SELECT 1 FROM day_entity_blocks b WHERE b.entity_id = ${e}.id)
	AND NOT EXISTS (SELECT 1 FROM place_locations pl WHERE pl.entity_id = ${e}.id AND pl.decided_at IS NOT NULL)
	AND NOT EXISTS (SELECT 1 FROM entity_not_same ns WHERE ${e}.id IN (ns.entity_a, ns.entity_b))`;

export function toId(v: unknown): number | null {
	const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : NaN;
	return Number.isSafeInteger(n) && n > 0 ? n : null;
}

async function lockGraph(client: Client): Promise<void> {
	await client.query('SELECT pg_advisory_xact_lock($1, $2)', [...ENTITY_GRAPH_LOCK]);
}

/**
 * Day locks in one round trip (a merge into Gaylon touches 1,000+ days).
 * Ascending, though no ordering deadlock is possible: app writers already
 * hold the graph lock, and the worker only ever holds one day lock. Taken
 * before any entity row lock (see the header).
 */
async function lockDays(client: Client, dayIds: Iterable<number>): Promise<void> {
	const sorted = [...new Set([...dayIds].map(Number))].sort((a, b) => a - b);
	if (sorted.length === 0) return;
	await client.query(
		`SELECT count(pg_advisory_xact_lock($1, d)) FROM (SELECT d FROM unnest($2::int[]) AS d ORDER BY d) s`,
		[ENTITY_DAY_LOCK_CLASS, sorted]
	);
}

/**
 * FOR NO KEY UPDATE, not FOR UPDATE: it still serializes against any other
 * update or delete of these rows, but not against the foreign-key share lock
 * the extractor takes when it links a day to one of them (CODEX9 #1).
 */
async function loadEntities(client: Client, ids: number[]): Promise<Map<number, EntityRow>> {
	const res = await client.query<EntityRow>(
		`SELECT id, display_name, entity_type, alias_of_entity_id FROM entities WHERE id = ANY($1::bigint[]) FOR NO KEY UPDATE`,
		[ids]
	);
	return new Map(
		res.rows.map((r) => [
			Number(r.id),
			{ ...r, id: Number(r.id), alias_of_entity_id: r.alias_of_entity_id === null ? null : Number(r.alias_of_entity_id) }
		])
	);
}

function need(rows: Map<number, EntityRow>, id: number, what: string): EntityRow {
	const r = rows.get(id);
	if (!r) throw new EntityGraphError(404, `${what} no longer exists. Reload the page.`);
	return r;
}

function needCanonical(r: EntityRow): void {
	if (r.alias_of_entity_id !== null) {
		throw new EntityGraphError(409, `"${r.display_name}" is already an alias of another name. Reload the page.`);
	}
}

async function audit(
	client: Client,
	userId: number,
	action: string,
	entityId: number,
	before: unknown,
	after: unknown,
	description: string
): Promise<void> {
	await client.query(
		`INSERT INTO audit_log (user_id, action, entity_type, entity_id, before_value, after_value, description)
		 VALUES ($1, $2, 'entities', $3, $4::jsonb, $5::jsonb, $6)`,
		[userId, action, entityId, before === null ? null : JSON.stringify(before), after === null ? null : JSON.stringify(after), description]
	);
}

/** Refuse if any two of `ids` were marked "not the same" (similarity isn't transitive). */
async function refuseDismissedPairs(client: Client, ids: number[], names: Map<number, EntityRow>): Promise<void> {
	const res = await client.query<{ entity_a: string; entity_b: string }>(
		`SELECT entity_a, entity_b FROM entity_not_same WHERE entity_a = ANY($1::bigint[]) AND entity_b = ANY($1::bigint[])`,
		[ids]
	);
	const hit = res.rows[0];
	if (hit) {
		const a = names.get(Number(hit.entity_a))?.display_name ?? hit.entity_a;
		const b = names.get(Number(hit.entity_b))?.display_name ?? hit.entity_b;
		throw new EntityGraphError(409, `"${a}" and "${b}" were marked not the same. Undo that first if they are.`);
	}
}

interface PlaceRow {
	entity_id: string;
	status: string;
	reason: string | null;
	google_place_id: string | null;
	lat: number | null;
	lon: number | null;
	query: string | null;
	decided_at: string | null;
}
/**
 * An admin decided it: confirmed, chose, pinned, "no map", "Wrong", or
 * searched with their own words. src/lib/server/places.ts sets decided_at on
 * every one of those and clears it on every automatic lookup, so decided_at
 * (kept even if the deciding account is removed) is the provenance, not the
 * status (CODEX td-c6e871 code review #3).
 */
const isHumanMap = (r: PlaceRow) => r.decided_at !== null;
const sameMap = (a: PlaceRow, b: PlaceRow) =>
	a.status === b.status &&
	(a.reason ?? '') === (b.reason ?? '') &&
	(a.query ?? '') === (b.query ?? '') &&
	((a.google_place_id !== null && a.google_place_id === b.google_place_id) || (a.lat === b.lat && a.lon === b.lon));

/**
 * The map decision follows the family (td-085e19 maps read the canonical
 * id). A lone row moves to the survivor intact; a human decision beats a
 * machine one; two different human decisions are refused.
 */
async function carryPlace(client: Client, keep: EntityRow, src: EntityRow): Promise<void> {
	if (keep.entity_type !== 'place') return;
	const res = await client.query<PlaceRow>(
		`SELECT entity_id, status, reason, google_place_id, lat, lon, query, decided_at::text FROM place_locations WHERE entity_id = ANY($1::bigint[]) FOR UPDATE`,
		[[keep.id, src.id]]
	);
	const k = res.rows.find((r) => Number(r.entity_id) === keep.id);
	const s = res.rows.find((r) => Number(r.entity_id) === src.id);
	if (!s) return;
	if (!k) {
		await client.query(`UPDATE place_locations SET entity_id = $2 WHERE entity_id = $1`, [src.id, keep.id]);
		return;
	}
	if (isHumanMap(s) && isHumanMap(k) && !sameMap(s, k)) {
		throw new EntityGraphError(
			409,
			`"${src.display_name}" and "${keep.display_name}" both have a map decision. Choose one on /admin/places first.`
		);
	}
	if (isHumanMap(s) && !isHumanMap(k)) {
		await client.query(`DELETE FROM place_locations WHERE entity_id = $1`, [keep.id]);
		await client.query(`UPDATE place_locations SET entity_id = $2 WHERE entity_id = $1`, [src.id, keep.id]);
		return;
	}
	await client.query(`DELETE FROM place_locations WHERE entity_id = $1`, [src.id]);
}

/**
 * Everything that follows `src`'s identity into `keep`'s family except its
 * day links: its aliases, its day blocks, its "not the same" pairs, its map
 * decision. Stored Claude checks about `src` are dropped (stale).
 */
async function absorb(client: Client, keep: EntityRow, src: EntityRow): Promise<void> {
	await client.query(`UPDATE entities SET alias_of_entity_id = $2 WHERE alias_of_entity_id = $1`, [src.id, keep.id]);
	await client.query(`UPDATE entities SET alias_of_entity_id = $2 WHERE id = $1`, [src.id, keep.id]);

	await client.query(
		`INSERT INTO day_entity_blocks (day_id, entity_id, blocked_by, blocked_at)
		 SELECT day_id, $2, blocked_by, blocked_at FROM day_entity_blocks WHERE entity_id = $1
		 ON CONFLICT (day_id, entity_id) DO NOTHING`,
		[src.id, keep.id]
	);
	await client.query(`DELETE FROM day_entity_blocks WHERE entity_id = $1`, [src.id]);
	await settleBlocks(client, keep.id);

	await client.query(
		`INSERT INTO entity_not_same (entity_a, entity_b, decided_by, decided_at)
		 SELECT LEAST($2::bigint, other), GREATEST($2::bigint, other), decided_by, decided_at
		   FROM (SELECT CASE WHEN entity_a = $1 THEN entity_b ELSE entity_a END AS other, decided_by, decided_at
		           FROM entity_not_same WHERE $1 IN (entity_a, entity_b)) s
		  WHERE other <> $2
		 ON CONFLICT (entity_a, entity_b) DO NOTHING`,
		[src.id, keep.id]
	);
	await client.query(`DELETE FROM entity_not_same WHERE $1 IN (entity_a, entity_b)`, [src.id]);

	await client.query(`DELETE FROM entity_cleanup_checks WHERE $1 IN (main_id, candidate_id)`, [src.id]);
	await carryPlace(client, keep, src);
}

/**
 * After two families join, a day can be both linked to the family and
 * blocked from it (a day moved from A to B, then A merged into B). Rule
 * (CODEX td-c6e871 code review #5): an explicit human link wins and the
 * block goes; otherwise the block stands and any AI link into the family on
 * that day goes now, rather than at the next re-extraction.
 */
async function settleBlocks(client: Client, keepId: number): Promise<void> {
	const family = `SELECT id FROM entities WHERE id = $1 OR alias_of_entity_id = $1`;
	await client.query(
		`DELETE FROM day_entity_blocks b
		  WHERE b.entity_id = $1
		    AND EXISTS (SELECT 1 FROM day_entities de WHERE de.day_id = b.day_id AND de.source = 'human' AND de.entity_id IN (${family}))`,
		[keepId]
	);
	await client.query(
		`DELETE FROM day_entities de
		  WHERE de.source = 'ai' AND de.entity_id IN (${family})
		    AND de.day_id IN (SELECT day_id FROM day_entity_blocks WHERE entity_id = $1)`,
		[keepId]
	);
}

/** Days whose links or blocks a change to these entities' families touches. */
async function daysOf(client: Client, ids: number[]): Promise<number[]> {
	const res = await client.query<{ day_id: number }>(
		`SELECT day_id FROM day_entities WHERE entity_id IN (SELECT id FROM entities WHERE id = ANY($1::bigint[]) OR alias_of_entity_id = ANY($1::bigint[]))
		 UNION
		 SELECT day_id FROM day_entity_blocks WHERE entity_id = ANY($1::bigint[])`,
		[ids]
	);
	return res.rows.map((r) => Number(r.day_id));
}

/**
 * Merge `sourceIds` into `keepId`: their day links move to keepId (human
 * beats AI), and each becomes an alias of keepId, kept, not deleted.
 * All canonical, same type, distinct; no pair among them marked not-same.
 */
export async function mergeEntities(
	client: Client,
	keepId: number,
	sourceIds: number[],
	userId: number,
	/**
	 * A precondition checked once this merge holds the graph lock and every
	 * involved day's lock, so it sees whatever an extraction that held one of
	 * those days committed while the merge waited (the cleanup page's "these
	 * are the entries I looked at" check, CODEX9 final review #1). Throw
	 * EntityGraphError to refuse.
	 */
	verify?: (client: Client) => Promise<void>
): Promise<{ merged: string[]; into: string }> {
	const sources = [...new Set(sourceIds.map(Number))];
	if (sources.length === 0) throw new EntityGraphError(400, 'Choose at least one name to merge.');
	if (sources.includes(keepId)) throw new EntityGraphError(400, 'A name cannot be merged into itself.');

	await lockGraph(client);
	const all = [keepId, ...sources];
	// Family membership can't change under the graph lock, so these are all
	// the days with a link or block for these families. A day the extractor
	// links meanwhile isn't locked, and needn't be: that new link is to a name
	// in one of these families, which resolves through the alias made below.
	await lockDays(client, await daysOf(client, all));
	const rows = await loadEntities(client, all);
	const keep = need(rows, keepId, 'The name to keep');
	needCanonical(keep);
	for (const id of sources) {
		const r = need(rows, id, 'A name to merge');
		needCanonical(r);
		if (r.entity_type !== keep.entity_type) throw new EntityGraphError(409, 'Only names of the same kind can be merged.');
	}
	await refuseDismissedPairs(client, all, rows);
	if (verify) await verify(client);

	const merged: string[] = [];
	for (const id of sources) {
		const src = rows.get(id)!;
		const before = await client.query<{ n: number }>(
			`SELECT COUNT(DISTINCT day_id)::int AS n FROM day_entities WHERE entity_id IN ($1, $2)`,
			[src.id, keep.id]
		);
		// One statement: exactly the rows this DELETE removes are the rows
		// copied. As two statements (copy, then delete), a link the extractor
		// committed in between, on a day outside the locked set, was deleted
		// without being copied (CODEX9 td-c6e871 re-review #1). A link committed
		// after this statement stays on the source, now an alias, and resolves
		// to the survivor.
		await client.query(
			`WITH moved AS (
			   DELETE FROM day_entities WHERE entity_id = $1 RETURNING day_id, source, confidence_score
			 )
			 INSERT INTO day_entities (day_id, entity_id, source, confidence_score)
			 SELECT day_id, $2, source, confidence_score FROM moved
			 ON CONFLICT (day_id, entity_id) DO UPDATE SET
			   source = CASE WHEN day_entities.source = 'human' OR EXCLUDED.source = 'human' THEN 'human' ELSE 'ai' END,
			   confidence_score = CASE WHEN day_entities.source = 'ai' AND EXCLUDED.source = 'human' THEN NULL
			                           ELSE day_entities.confidence_score END`,
			[src.id, keep.id]
		);
		await absorb(client, keep, src);
		await audit(
			client,
			userId,
			'entity_merge',
			src.id,
			{ display_name: src.display_name, distinct_days_before: before.rows[0]?.n ?? null },
			{ merged_into: keep.display_name, merged_into_id: keep.id },
			`Merged "${src.display_name}" (${src.entity_type}) into "${keep.display_name}"`
		);
		merged.push(src.display_name);
	}
	return { merged, into: keep.display_name };
}

/**
 * Make `id` an alias of `targetId` (its day links stay where they are; readers
 * resolve them to the target). Same carry-over as a merge for aliases,
 * blocks, not-same pairs and the map decision.
 */
export async function setAlias(client: Client, id: number, targetId: number, userId: number): Promise<void> {
	if (id === targetId) throw new EntityGraphError(400, 'An entity cannot be an alias of itself');
	await lockGraph(client);
	await lockDays(client, await daysOf(client, [id, targetId]));
	const rows = await loadEntities(client, [id, targetId]);
	const src = need(rows, id, 'That name');
	const target = need(rows, targetId, 'The alias target');
	// A stale form (another tab already made it an alias) must not silently
	// repoint it: its merged links would stay with the old target while new
	// mentions resolved to the new one (CODEX9 #2).
	needCanonical(src);
	if (target.alias_of_entity_id !== null) {
		throw new EntityGraphError(409, 'Alias target must itself be canonical (not already an alias), no chains');
	}
	if (target.entity_type !== src.entity_type) throw new EntityGraphError(409, 'Alias target must be the same entity type');
	await refuseDismissedPairs(client, [id, targetId], rows);
	const beforeAlias = src.alias_of_entity_id;
	await absorb(client, target, src);
	await audit(
		client,
		userId,
		'entity_set_alias',
		id,
		{ alias_of_entity_id: beforeAlias },
		{ alias_of_entity_id: targetId },
		`Set "${src.display_name}" (${src.entity_type}) as an alias of "${target.display_name}"`
	);
}

/**
 * This day isn't about `fromId`'s family; it's about `toId`. Removes every
 * link on the day into fromId's family, links toId as a human decision,
 * blocks fromId on that day (so re-extraction can't put it back), and clears
 * any block of toId there (moving back works). 409 if the day no longer
 * mentions fromId (another tab moved it already).
 */
export async function moveDay(client: Client, dayId: number, fromId: number, toId: number, userId: number): Promise<void> {
	if (fromId === toId) throw new EntityGraphError(400, 'Choose a different name to move this day to.');
	await lockGraph(client);
	await lockDays(client, [dayId]);
	const rows = await loadEntities(client, [fromId, toId]);
	const from = need(rows, fromId, 'The name');
	const to = need(rows, toId, 'The name to move to');
	needCanonical(from);
	needCanonical(to);
	if (from.entity_type !== to.entity_type) throw new EntityGraphError(409, 'A day can only move to a name of the same kind.');

	const day = await client.query<{ entry_date: string }>(`SELECT entry_date::text FROM calendar_days WHERE id = $1`, [dayId]);
	if (!day.rows[0]) throw new EntityGraphError(404, 'That day no longer exists.');
	const removed = await client.query<{ entity_id: string; source: string }>(
		`DELETE FROM day_entities
		  WHERE day_id = $1 AND entity_id IN (SELECT id FROM entities WHERE id = $2 OR alias_of_entity_id = $2)
		  RETURNING entity_id, source`,
		[dayId, fromId]
	);
	if (removed.rows.length === 0) {
		throw new EntityGraphError(409, `${day.rows[0].entry_date} no longer mentions "${from.display_name}". Reload the page.`);
	}
	await client.query(
		`INSERT INTO day_entities (day_id, entity_id, source, confidence_score) VALUES ($1, $2, 'human', NULL)
		 ON CONFLICT (day_id, entity_id) DO UPDATE SET source = 'human', confidence_score = NULL`,
		[dayId, toId]
	);
	await client.query(
		`INSERT INTO day_entity_blocks (day_id, entity_id, blocked_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
		[dayId, fromId, userId]
	);
	await client.query(`DELETE FROM day_entity_blocks WHERE day_id = $1 AND entity_id = $2`, [dayId, toId]);
	await client.query(`DELETE FROM entity_cleanup_checks WHERE main_id = ANY($1::bigint[]) OR candidate_id = ANY($1::bigint[])`, [
		[fromId, toId]
	]);
	await audit(
		client,
		userId,
		'entity_move_day',
		fromId,
		{ day: day.rows[0].entry_date, entity_id: fromId, display_name: from.display_name, links: removed.rows.map((r) => ({ entity_id: Number(r.entity_id), source: r.source })) },
		{ day: day.rows[0].entry_date, entity_id: toId, display_name: to.display_name },
		`Moved ${day.rows[0].entry_date} from "${from.display_name}" to "${to.display_name}" (${from.entity_type})`
	);
}

/** Mark two names as different people/places/events; never suggested together again. */
export async function markNotSame(client: Client, a: number, b: number, userId: number): Promise<void> {
	if (a === b) throw new EntityGraphError(400, 'Choose two different names.');
	await lockGraph(client);
	const rows = await loadEntities(client, [a, b]);
	const x = need(rows, a, 'That name');
	const y = need(rows, b, 'That name');
	needCanonical(x);
	needCanonical(y);
	if (x.entity_type !== y.entity_type) throw new EntityGraphError(409, 'Only names of the same kind can be compared.');
	const [lo, hi] = a < b ? [a, b] : [b, a];
	await client.query(
		`INSERT INTO entity_not_same (entity_a, entity_b, decided_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
		[lo, hi, userId]
	);
	await client.query(
		`DELETE FROM entity_cleanup_checks WHERE (main_id = $1 AND candidate_id = $2) OR (main_id = $2 AND candidate_id = $1)`,
		[lo, hi]
	);
	await audit(client, userId, 'entity_not_same', lo, null, { pair: pairKey(lo, hi) },
		`Marked "${x.display_name}" and "${y.display_name}" (${x.entity_type}) as not the same`);
}

export async function undoNotSame(client: Client, a: number, b: number, userId: number): Promise<void> {
	await lockGraph(client);
	const [lo, hi] = a < b ? [a, b] : [b, a];
	const del = await client.query(`DELETE FROM entity_not_same WHERE entity_a = $1 AND entity_b = $2`, [lo, hi]);
	if (del.rowCount === 0) throw new EntityGraphError(409, 'That pair is no longer marked. Reload the page.');
	const rows = await loadEntities(client, [lo, hi]);
	const name = (id: number) => rows.get(id)?.display_name ?? `#${id}`;
	await audit(client, userId, 'entity_not_same_undo', lo, { pair: pairKey(lo, hi) }, null,
		`Undid "not the same" for "${name(lo)}" and "${name(hi)}"`);
}

/**
 * Delete an unused entity (UNUSED_SQL, checked in the DELETE itself).
 * The row is locked FOR UPDATE in its own statement first: that waits out an
 * extractor transaction that is linking a day to it right now (its
 * foreign-key share lock), so the DELETE's fresh snapshot sees that link and
 * refuses, instead of cascading it away (CODEX9 #3).
 */
export async function deleteUnused(client: Client, id: number, userId: number): Promise<void> {
	await lockGraph(client);
	const before = await client.query<{ display_name: string; entity_type: string; slug: string }>(
		`SELECT display_name, entity_type, slug FROM entities WHERE id = $1 FOR UPDATE`,
		[id]
	);
	if (!before.rows[0]) throw new EntityGraphError(404, 'Entity not found');
	const deleted = await client.query(`DELETE FROM entities e WHERE e.id = $1 AND ${UNUSED_SQL('e')} RETURNING e.id`, [id]);
	if (deleted.rowCount === 0) {
		throw new EntityGraphError(
			409,
			'Cannot delete: it is an alias (a spelling to keep), or has mentions, aliases, moved-day records, a map decision or a "not the same" mark'
		);
	}
	const b = before.rows[0];
	await audit(client, userId, 'entity_delete', id, b, null,
		`Deleted ${b.entity_type} "${b.display_name}" (unused: no mentions, aliases, moved days, map decision or "not the same" mark)`);
}

/**
 * Run one graph change in its own transaction and turn an EntityGraphError
 * into the form failure the pages show (`form.error` / result.data.error).
 */
export async function graphWrite<T>(fn: (client: Client) => Promise<T>): Promise<T | ActionFailure<{ error: string }>> {
	try {
		return await withTransaction(fn);
	} catch (e) {
		if (e instanceof EntityGraphError) return fail(e.status, { error: e.message });
		throw e;
	}
}
