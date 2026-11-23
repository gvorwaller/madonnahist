/**
 * Data for /admin/entities/cleanup (td-c6e871 plan §1, §5, §6): canonical
 * entities with their family days, the matcher's groups, "not the same"
 * pairs, stored Claude checks, and the Claude check itself.
 */
import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { query, withTransaction } from '$lib/db';
import { SPAN_MARGIN_YEARS, findGroups, pairKey, type Group, type MatchEntity } from '$lib/entity-matcher';
import {
	CHECK_PROMPT_VERSION,
	ENTITY_CHECK_MODEL,
	buildCheckPrompt,
	parseCheckAnswer,
	stubCheckAnswer,
	type CheckEvidence,
	type Verdict
} from '$lib/entity-check';
import { completeBounded } from '$lib/server/llm';
import { loadFamily, sampleDays } from '$lib/server/entity-evidence';
import { EntityGraphError, UNUSED_SQL, type EntityType } from '$lib/server/entity-graph';
import { ENTITY_GRAPH_LOCK } from '$lib/entity-locks';

export const ENTITY_TYPES: readonly EntityType[] = ['person', 'place', 'event'];
export function isEntityType(s: unknown): s is EntityType {
	return typeof s === 'string' && (ENTITY_TYPES as readonly string[]).includes(s);
}

type Queryable = Pick<pg.PoolClient, 'query'>;
const pool: Queryable = { query } as unknown as Queryable;

/**
 * Canonical entities of one type (or the given ids), each with its whole
 * family's days and `rev`: a digest of the family's alias names and of those
 * days' corrected text and notes, which is everything else the Claude check
 * reads (CODEX9 td-c6e871 #8). Pass `db` to read inside a transaction on its
 * own connection (CODEX9 #7).
 */
export async function loadMatchEntities(type: EntityType, ids?: number[], db: Queryable = pool): Promise<MatchEntity[]> {
	const res = await db.query<{
		id: string;
		display_name: string;
		days: string[];
		rev: string;
	}>(
		`WITH fam AS (
		   SELECT DISTINCT COALESCE(m.alias_of_entity_id, m.id) AS cid, de.day_id
		     FROM day_entities de JOIN entities m ON m.id = de.entity_id
		    WHERE m.entity_type = $1
		      AND ($2::bigint[] IS NULL OR COALESCE(m.alias_of_entity_id, m.id) = ANY($2::bigint[]))
		 ), d AS (
		   SELECT f.cid,
		          array_agg(cd.entry_date::text ORDER BY cd.entry_date) AS days,
		          md5(string_agg(cd.id::text || ':' || md5(COALESCE(cd.corrected_text, '')) || ':' || md5(COALESCE(cd.day_narrative, '')),
		                         ',' ORDER BY cd.entry_date, cd.id)) AS text_rev
		     FROM fam f JOIN calendar_days cd ON cd.id = f.day_id
		    GROUP BY f.cid
		 ), n AS (
		   SELECT alias_of_entity_id AS cid, string_agg(display_name, '|' ORDER BY id) AS names
		     FROM entities
		    WHERE entity_type = $1 AND alias_of_entity_id IS NOT NULL
		      AND ($2::bigint[] IS NULL OR alias_of_entity_id = ANY($2::bigint[]))
		    GROUP BY alias_of_entity_id
		 )
		 SELECT c.id, c.display_name, COALESCE(d.days, '{}') AS days,
		        md5(COALESCE(n.names, '') || '#' || COALESCE(d.text_rev, '')) AS rev
		   FROM entities c
		   LEFT JOIN d ON d.cid = c.id
		   LEFT JOIN n ON n.cid = c.id
		  WHERE c.entity_type = $1 AND c.alias_of_entity_id IS NULL
		    AND ($2::bigint[] IS NULL OR c.id = ANY($2::bigint[]))`,
		[type, ids ?? null]
	);
	return res.rows.map((r) => ({
		id: Number(r.id),
		name: r.display_name,
		count: r.days.length,
		days: r.days,
		rev: r.rev
	}));
}

export interface NotSamePair {
	a: { id: number; name: string };
	b: { id: number; name: string };
	decidedAt: string;
}

export async function loadNotSame(type: EntityType): Promise<{ keys: Set<string>; pairs: NotSamePair[] }> {
	const res = await query<{
		a: string;
		an: string;
		b: string;
		bn: string;
		decided_at: string;
	}>(
		`SELECT ns.entity_a AS a, ea.display_name AS an, ns.entity_b AS b, eb.display_name AS bn, ns.decided_at::text
		   FROM entity_not_same ns
		   JOIN entities ea ON ea.id = ns.entity_a
		   JOIN entities eb ON eb.id = ns.entity_b
		  WHERE ea.entity_type = $1
		  ORDER BY ns.decided_at DESC`,
		[type]
	);
	const pairs = res.rows.map((r) => ({
		a: { id: Number(r.a), name: r.an },
		b: { id: Number(r.b), name: r.bn },
		decidedAt: r.decided_at
	}));
	return { keys: new Set(pairs.map((p) => pairKey(p.a.id, p.b.id))), pairs };
}

/**
 * Ties a stored answer to what it was about: prompt version, model, both
 * names, both families' day lists (which also fix which days were sampled),
 * and both `rev`s (alias names, and the text and notes of those days). A
 * merge, move, rename, re-extraction, new alias or corrected passage changes
 * it, and the old answer is then ignored: never shown, never pre-ticked.
 * `rev` covers every family day, not just the sampled ones, so it errs
 * towards asking again.
 */
export function checkFingerprint(main: MatchEntity, cand: MatchEntity): string {
	return createHash('sha256')
		.update(
			JSON.stringify([
				CHECK_PROMPT_VERSION,
				ENTITY_CHECK_MODEL,
				main.id,
				main.name,
				main.days,
				main.rev ?? '',
				cand.id,
				cand.name,
				cand.days,
				cand.rev ?? ''
			])
		)
		.digest('hex')
		.slice(0, 32);
}

export interface StoredCheck {
	status: 'pending' | 'done';
	fingerprint: string;
	verdict: Verdict | null;
	reason: string | null;
}

export async function loadChecks(type: EntityType): Promise<Map<string, StoredCheck>> {
	const res = await query<{ main_id: string; candidate_id: string } & StoredCheck>(
		`SELECT k.main_id, k.candidate_id, k.status, k.fingerprint, k.verdict, k.reason
		   FROM entity_cleanup_checks k JOIN entities e ON e.id = k.main_id
		  WHERE e.entity_type = $1`,
		[type]
	);
	return new Map(res.rows.map((r) => [`${Number(r.main_id)}:${Number(r.candidate_id)}`, r]));
}

export async function loadUnused(type: EntityType): Promise<{ id: number; name: string }[]> {
	const res = await query<{ id: string; display_name: string }>(
		`SELECT e.id, e.display_name FROM entities e
		  WHERE e.entity_type = $1 AND e.alias_of_entity_id IS NULL AND ${UNUSED_SQL('e')}
		  ORDER BY e.display_name, e.id`,
		[type]
	);
	return res.rows.map((r) => ({ id: Number(r.id), name: r.display_name }));
}

export async function loadGroups(type: EntityType): Promise<{
	groups: Group[];
	notSame: Awaited<ReturnType<typeof loadNotSame>>;
}> {
	const [entities, notSame] = await Promise.all([loadMatchEntities(type), loadNotSame(type)]);
	return {
		groups: findGroups(entities, {
			notSame: notSame.keys,
			firstWord: type !== 'event'
		}),
		notSame
	};
}

function years(days: string[]): string {
	if (days.length === 0) return 'no mentions';
	const a = days[0].slice(0, 4);
	const b = days[days.length - 1].slice(0, 4);
	return a === b ? a : `${a}–${b}`;
}

async function evidence(m: MatchEntity, span: { first: string; last: string } | null): Promise<CheckEvidence> {
	const family = await loadFamily(m.id);
	if (!family) throw new EntityGraphError(409, `"${m.name}" no longer exists. Reload the page.`);
	const days = await sampleDays(family, 4, span);
	return {
		id: m.id,
		name: m.name,
		aliases: family.names.filter((n) => n !== m.name),
		count: m.count,
		years: years(m.days),
		entries: days.map((d) => ({
			date: d.entryDate,
			where: d.snippet.where,
			text: `${d.snippet.before}${d.snippet.match}${d.snippet.after}`.slice(0, 300)
		}))
	};
}

/** Current fingerprints of (mainId, each candidate); a name that isn't a canonical one of the main's kind is absent. */
export async function currentFingerprints(mainId: number, candIds: number[], db: Queryable = pool): Promise<Map<number, string>> {
	const t = await db.query<{ entity_type: string }>(`SELECT entity_type FROM entities WHERE id = $1`, [mainId]);
	const type = t.rows[0]?.entity_type;
	const out = new Map<number, string>();
	if (!isEntityType(type)) return out;
	const ents = await loadMatchEntities(type, [mainId, ...candIds], db);
	const main = ents.find((e) => e.id === mainId);
	if (!main) return out;
	for (const id of candIds) {
		const cand = ents.find((e) => e.id === id);
		if (cand) out.set(id, checkFingerprint(main, cand));
	}
	return out;
}

/**
 * Refuse a merge made from evidence the page no longer shows (CODEX9 final
 * review #1): for each name being merged, the fingerprint the page had for
 * it against `mainId` must still be the current one. Passed to
 * mergeEntities as its `verify`, which runs it once the merge holds the
 * graph lock and its day locks, so neither another admin action nor an
 * extraction of one of those days can change the evidence after this check.
 */
export async function assertShownEvidence(
	client: pg.PoolClient,
	mainId: number,
	candIds: number[],
	shown: Map<number, string>
): Promise<void> {
	const t = await client.query<{ entity_type: string }>(`SELECT entity_type FROM entities WHERE id = $1`, [mainId]);
	const type = t.rows[0]?.entity_type;
	if (!isEntityType(type)) throw new EntityGraphError(409, 'This group has changed. Reload the page.');
	const ents = await loadMatchEntities(type, [mainId, ...candIds], client);
	const main = ents.find((e) => e.id === mainId);
	if (!main) throw new EntityGraphError(409, 'This group has changed. Reload the page.');
	for (const id of candIds) {
		const cand = ents.find((e) => e.id === id);
		const fp = shown.get(id);
		if (!cand || !fp || checkFingerprint(main, cand) !== fp) {
			const name = cand?.name ?? 'one of these names';
			throw new EntityGraphError(
				409,
				`The entries for "${name}" changed since this page loaded. Reload the page and look again before merging.`
			);
		}
	}
}

export type CheckResult =
	| {
			candidateId: number;
			state: 'done' | 'cached';
			verdict: Verdict;
			reason: string;
	  }
	| { candidateId: number; state: 'busy' | 'changed' };

const CLAIM_STALE = "interval '2 minutes'";
const DEADLINE_MS = 40_000;

/**
 * Ask Claude about some of one group's candidates (td-c6e871 plan §5).
 * Only candidates currently in this main name's group; answers already
 * stored for the same evidence come from the cache; candidates someone else
 * is checking right now come back 'busy'. Claims are taken before the paid
 * call (each request's claims carry its own token, so a request whose claim
 * expired and was re-taken can't store over or release its successor's) and
 * released if it fails; an answer is stored only if the pair is still two
 * canonical names, not marked "not the same", and the evidence
 * hasn't changed meanwhile.
 */
export async function runCheck(
	mainId: number,
	requestedIds: number[],
	userId: number,
	/**
	 * The fingerprints the page showed, by candidate id. A candidate whose
	 * evidence has changed since comes back 'changed' without a call, so an
	 * old tab never gets (and pre-ticks on) an answer about entries it
	 * didn't show (CODEX9 re-review #3).
	 */
	shown?: Map<number, string>
): Promise<CheckResult[]> {
	// Numeric order: two tabs claiming overlapping candidates take the row
	// locks in the same order, so they can't deadlock (CODEX9 re-review #2).
	const candidateIds = [...new Set(requestedIds)].sort((a, b) => a - b);
	const typeRes = await query<{ entity_type: string }>(`SELECT entity_type FROM entities WHERE id = $1`, [mainId]);
	const type = typeRes.rows[0]?.entity_type;
	if (!isEntityType(type)) throw new EntityGraphError(404, 'That name no longer exists. Reload the page.');
	const { groups } = await loadGroups(type);
	const group = groups.find((g) => g.main.id === mainId);
	if (!group) throw new EntityGraphError(409, 'This group has changed. Reload the page.');
	const inGroup = new Map(group.candidates.map((c) => [c.entity.id, c.entity]));
	for (const id of candidateIds) {
		if (!inGroup.has(id)) throw new EntityGraphError(409, 'This group has changed. Reload the page.');
	}

	const fps = new Map(candidateIds.map((id) => [id, checkFingerprint(group.main, inGroup.get(id)!)]));
	const results: CheckResult[] = [];
	const claimed: number[] = [];
	const asking: number[] = [];
	for (const id of candidateIds) {
		const seen = shown?.get(id);
		if (seen !== undefined && seen !== fps.get(id)) results.push({ candidateId: id, state: 'changed' });
		else asking.push(id);
	}
	const token = randomUUID();
	// All claims in one short transaction (no paid call inside): if any
	// insert fails (a candidate deleted since the group was read), none are
	// left behind looking "being checked" (CODEX9 #13).
	await withTransaction(async (client) => {
		for (const id of asking) {
			const fp = fps.get(id)!;
			const claim = await client.query(
				`INSERT INTO entity_cleanup_checks (main_id, candidate_id, status, fingerprint, claim_token, claimed_at, checked_by)
			 VALUES ($1, $2, 'pending', $3, $5, NOW(), $4)
			 ON CONFLICT (main_id, candidate_id) DO UPDATE SET
			   status = 'pending', fingerprint = EXCLUDED.fingerprint, claim_token = EXCLUDED.claim_token,
			   claimed_at = NOW(), checked_by = EXCLUDED.checked_by,
			   verdict = NULL, reason = NULL, model = NULL, checked_at = NULL
			 WHERE (entity_cleanup_checks.status = 'done' AND entity_cleanup_checks.fingerprint <> EXCLUDED.fingerprint)
			    OR (entity_cleanup_checks.status = 'pending' AND entity_cleanup_checks.claimed_at < NOW() - ${CLAIM_STALE})
			 RETURNING candidate_id`,
				[mainId, id, fp, userId, token]
			);
			if (claim.rowCount) {
				claimed.push(id);
				continue;
			}
			const row = await client.query<StoredCheck>(
				`SELECT status, fingerprint, verdict, reason FROM entity_cleanup_checks WHERE main_id = $1 AND candidate_id = $2`,
				[mainId, id]
			);
			const r = row.rows[0];
			if (r?.status === 'done' && r.fingerprint === fp && r.verdict && r.reason) {
				results.push({
					candidateId: id,
					state: 'cached',
					verdict: r.verdict,
					reason: r.reason
				});
			} else {
				results.push({ candidateId: id, state: 'busy' });
			}
		}
	});
	if (claimed.length === 0) return results;

	const release = () =>
		query(
			`DELETE FROM entity_cleanup_checks
			  WHERE main_id = $1 AND candidate_id = ANY($2::bigint[]) AND status = 'pending' AND claim_token = $3`,
			[mainId, claimed, token]
		);

	try {
		// Same margin as the matcher's span warning: whole years, one either side.
		const first = group.main.days[0];
		const span = first
			? {
					first: `${Number(first.slice(0, 4)) - SPAN_MARGIN_YEARS}-01-01`,
					last: `${Number(group.main.days[group.main.days.length - 1].slice(0, 4)) + SPAN_MARGIN_YEARS}-12-31`
				}
			: null;
		const mainEv = await evidence(group.main, null);
		const candEv: CheckEvidence[] = [];
		for (const id of claimed) candEv.push(await evidence(inGroup.get(id)!, span));
		const prompt = buildCheckPrompt(type, mainEv, candEv);
		const reply = await completeBounded({
			model: ENTITY_CHECK_MODEL,
			system: prompt.system,
			user: prompt.user,
			maxTokens: 3000,
			effort: 'low',
			deadlineMs: DEADLINE_MS,
			stub: () => stubCheckAnswer(mainEv, candEv)
		});
		const answers = parseCheckAnswer(reply.text, claimed);

		await withTransaction(async (client) => {
			await client.query('SELECT pg_advisory_xact_lock($1, $2)', [...ENTITY_GRAPH_LOCK]);
			// Store only what still describes the current evidence.
			const fresh = await loadMatchEntities(type, [mainId, ...claimed], client);
			const freshMain = fresh.find((e) => e.id === mainId);
			const dismissed = await client.query<{ a: string; b: string }>(
				`SELECT entity_a AS a, entity_b AS b FROM entity_not_same
				  WHERE (entity_a = $1 AND entity_b = ANY($2::bigint[])) OR (entity_b = $1 AND entity_a = ANY($2::bigint[]))`,
				[mainId, claimed]
			);
			const notSame = new Set(dismissed.rows.flatMap((r) => [Number(r.a), Number(r.b)]));
			for (const id of claimed) {
				const now = fresh.find((e) => e.id === id);
				const a = answers.get(id)!;
				const fp = fps.get(id)!;
				// loadMatchEntities only returns canonical entities of this type.
				const same = freshMain && now && !notSame.has(id) && checkFingerprint(freshMain, now) === fp;
				const upd = same
					? await client.query(
							`UPDATE entity_cleanup_checks
							    SET status = 'done', verdict = $4, reason = $5, model = $6, checked_at = NOW(), claim_token = NULL
							  WHERE main_id = $1 AND candidate_id = $2 AND status = 'pending' AND fingerprint = $3 AND claim_token = $7`,
							[mainId, id, fp, a.verdict, a.reason, reply.model, token]
						)
					: { rowCount: 0 };
				if (upd.rowCount) {
					results.push({
						candidateId: id,
						state: 'done',
						verdict: a.verdict,
						reason: a.reason
					});
				} else {
					await client.query(
						`DELETE FROM entity_cleanup_checks WHERE main_id = $1 AND candidate_id = $2 AND status = 'pending' AND claim_token = $3`,
						[mainId, id, token]
					);
					results.push({ candidateId: id, state: 'changed' });
				}
			}
		});
		return results;
	} catch (e) {
		await release().catch(() => {});
		throw e;
	}
}
