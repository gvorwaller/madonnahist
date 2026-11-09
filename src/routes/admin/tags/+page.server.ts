import { query, withTransaction } from '$lib/db';
import { isValidTagLabel, isValidTagSlug } from '$lib/server/tags';
import { VISIBLE_DAY_TAGS } from '$lib/server/viewer';
import { error, fail } from '@sveltejs/kit';
import type pg from 'pg';
import type { Actions, PageServerLoad } from './$types';

/**
 * /admin/tags — tag approval by tag NAME (td-3418e6, Family Viewer V3
 * Slice 1T; docs/2026-11-05-family-viewer-v3-redesign-plan.md).
 *
 * One row per distinct day_tags slug (plus any decided slug with no day
 * rows left). Decisions live in tag_vocabulary (migration 0027):
 *   approve → the family sees this name on every day carrying it
 *   hide    → never shown (a person-added tag still shows)
 *   merge   → shown as an approved target name (one hop, no chains)
 *   undo    → back to undecided (row deleted)
 * day_tags.source is never rewritten. The family-side rule lives in
 * src/lib/server/viewer.ts (VISIBLE_DAY_TAGS).
 *
 * Invariants kept by these actions (inside one transaction, under row
 * locks, so concurrent admin tabs can't break them):
 *   - a merge target is approved and is not itself merged
 *   - a name with names merged into it can't be hidden, merged
 *     elsewhere without re-pointing them, or undone
 */

const MAX_BULK = 500;

type Status = 'approved' | 'hidden' | 'merged';

export interface TagRow {
	slug: string;
	label: string;
	rawLabel: string | null;
	status: Status | null;
	mergedInto: string | null;
	acceptedDays: number;
	aiDays: number;
	humanDays: number;
	pendingDays: number;
	familyDays: number;
	decidedBy: string | null;
	decidedAt: string | null;
}

function requireAdmin(locals: App.Locals): number {
	if (!locals.user || locals.user.role !== 'admin') error(403, 'Admin access required');
	return Number(locals.user.id);
}

/** A business-rule failure raised inside a transaction: rolls back, becomes fail(409). */
class RuleError extends Error {}

function slugsFrom(data: FormData): string[] | null {
	const raw = data.getAll('slug').map((v) => String(v).trim());
	// Sorted so concurrent bulk actions take row locks in the same order.
	const slugs = [...new Set(raw)].sort();
	if (slugs.length === 0 || slugs.length > MAX_BULK) return null;
	if (!slugs.every(isValidTagSlug)) return null;
	return slugs;
}

async function audit(
	client: pg.PoolClient,
	userId: number,
	action: string,
	rowId: number,
	before: unknown,
	after: unknown,
	description: string
) {
	await client.query(
		`INSERT INTO audit_log (user_id, action, entity_type, entity_id, before_value, after_value, description)
		 VALUES ($1, $2, 'tag_vocabulary', $3, $4::jsonb, $5::jsonb, $6)`,
		[
			userId,
			action,
			rowId,
			before === null ? null : JSON.stringify(before),
			after === null ? null : JSON.stringify(after),
			description
		]
	);
}

interface VocabRow {
	id: number;
	tag_slug: string;
	label: string;
	status: Status;
	merged_into_slug: string | null;
}

/** Lock and return the vocabulary row for `slug` (or null if undecided). */
async function lockRow(client: pg.PoolClient, slug: string): Promise<VocabRow | null> {
	const res = await client.query<VocabRow>(
		`SELECT id::int AS id, tag_slug, label, status, merged_into_slug
		   FROM tag_vocabulary WHERE tag_slug = $1 FOR UPDATE`,
		[slug]
	);
	return res.rows[0] ?? null;
}

/** Most common label among this slug's day_tags rows (null if the slug has none). */
async function rawLabel(client: pg.PoolClient, slug: string): Promise<string | null> {
	const res = await client.query<{ label: string | null }>(
		`SELECT mode() WITHIN GROUP (ORDER BY tag_label) AS label FROM day_tags WHERE tag_slug = $1`,
		[slug]
	);
	return res.rows[0]?.label ?? null;
}

async function incomingMerges(client: pg.PoolClient, slug: string): Promise<number> {
	const res = await client.query<{ n: number }>(
		`SELECT COUNT(*)::int AS n FROM tag_vocabulary WHERE merged_into_slug = $1`,
		[slug]
	);
	return res.rows[0]?.n ?? 0;
}

/** Insert or update the decision for `slug`; returns the row id. */
async function upsert(
	client: pg.PoolClient,
	slug: string,
	label: string,
	status: Status,
	mergedInto: string | null,
	userId: number
): Promise<number> {
	const res = await client.query<{ id: number }>(
		`INSERT INTO tag_vocabulary (tag_slug, label, status, merged_into_slug, decided_by, decided_at)
		 VALUES ($1, $2, $3, $4, $5, NOW())
		 ON CONFLICT (tag_slug) DO UPDATE
		   SET label = EXCLUDED.label, status = EXCLUDED.status,
		       merged_into_slug = EXCLUDED.merged_into_slug,
		       decided_by = EXCLUDED.decided_by, decided_at = NOW()
		 RETURNING id::int AS id`,
		[slug, label, status, mergedInto, userId]
	);
	return res.rows[0].id;
}

async function runRules(fn: () => Promise<string>) {
	try {
		const message = await fn();
		return { ok: true, message };
	} catch (e) {
		if (e instanceof RuleError) return fail(409, { error: e.message });
		throw e;
	}
}

export const load: PageServerLoad = async ({ locals }) => {
	requireAdmin(locals);

	const [rowsRes, familyRes] = await Promise.all([
		query<{
			slug: string;
			raw_label: string | null;
			vocab_label: string | null;
			status: Status | null;
			merged_into_slug: string | null;
			accepted_days: number;
			ai_days: number;
			human_days: number;
			pending_days: number;
			decided_by: string | null;
			decided_at: string | null;
		}>(
			`WITH counts AS (
			   SELECT dt.tag_slug,
			          mode() WITHIN GROUP (ORDER BY dt.tag_label) AS raw_label,
			          COUNT(*) FILTER (WHERE cd.correction_status = 'accepted')::int AS accepted_days,
			          COUNT(*) FILTER (WHERE cd.correction_status = 'accepted' AND dt.source = 'ai')::int AS ai_days,
			          COUNT(*) FILTER (WHERE cd.correction_status = 'accepted' AND dt.source = 'human')::int AS human_days,
			          COUNT(*) FILTER (WHERE cd.correction_status <> 'accepted')::int AS pending_days
			     FROM day_tags dt
			     JOIN calendar_days cd ON cd.id = dt.day_id
			    GROUP BY dt.tag_slug
			 )
			 SELECT COALESCE(c.tag_slug, tv.tag_slug) AS slug,
			        c.raw_label, tv.label AS vocab_label, tv.status, tv.merged_into_slug,
			        COALESCE(c.accepted_days, 0) AS accepted_days,
			        COALESCE(c.ai_days, 0) AS ai_days,
			        COALESCE(c.human_days, 0) AS human_days,
			        COALESCE(c.pending_days, 0) AS pending_days,
			        u.display_name AS decided_by,
			        tv.decided_at::text AS decided_at
			   FROM counts c
			   FULL OUTER JOIN tag_vocabulary tv ON tv.tag_slug = c.tag_slug
			   LEFT JOIN users u ON u.id = tv.decided_by`
		),
		query<{ tag_slug: string; n: number }>(
			`SELECT vt.tag_slug, COUNT(*)::int AS n
			   FROM ${VISIBLE_DAY_TAGS} vt
			   JOIN calendar_days cd ON cd.id = vt.day_id
			  WHERE cd.correction_status = 'accepted'
			  GROUP BY vt.tag_slug`
		)
	]);

	const familyDays = new Map(familyRes.rows.map((r) => [r.tag_slug, r.n]));

	const tags: TagRow[] = rowsRes.rows.map((r) => ({
		slug: r.slug,
		label: r.vocab_label ?? r.raw_label ?? r.slug,
		rawLabel: r.raw_label,
		status: r.status,
		mergedInto: r.merged_into_slug,
		acceptedDays: r.accepted_days,
		aiDays: r.ai_days,
		humanDays: r.human_days,
		pendingDays: r.pending_days,
		familyDays: familyDays.get(r.slug) ?? 0,
		decidedBy: r.decided_by,
		decidedAt: r.decided_at
	}));
	tags.sort((a, b) => b.acceptedDays - a.acceptedDays || a.label.localeCompare(b.label));

	return { tags };
};

export const actions: Actions = {
	approve: async ({ request, locals }) => {
		const userId = requireAdmin(locals);
		const data = await request.formData();
		const slugs = slugsFrom(data);
		if (!slugs)
			return fail(400, {
				error: `Choose between 1 and ${MAX_BULK} valid tags`
			});

		return runRules(() =>
			withTransaction(async (client) => {
				for (const slug of slugs) {
					const before = await lockRow(client, slug);
					const label = before?.label ?? (await rawLabel(client, slug));
					if (!label) throw new RuleError(`Unknown tag "${slug}"`);
					if (before?.status === 'approved') continue;
					const id = await upsert(client, slug, label, 'approved', null, userId);
					await audit(
						client,
						userId,
						'tag_approve',
						id,
						before
							? {
									status: before.status,
									merged_into_slug: before.merged_into_slug
								}
							: { status: 'undecided' },
						{ status: 'approved', label },
						`Showed tag "${label}" to the family`
					);
				}
				return slugs.length === 1
					? 'Tag is now shown to the family.'
					: `${slugs.length} tags are now shown to the family.`;
			})
		);
	},

	hide: async ({ request, locals }) => {
		const userId = requireAdmin(locals);
		const data = await request.formData();
		const slugs = slugsFrom(data);
		if (!slugs)
			return fail(400, {
				error: `Choose between 1 and ${MAX_BULK} valid tags`
			});

		return runRules(() =>
			withTransaction(async (client) => {
				for (const slug of slugs) {
					const before = await lockRow(client, slug);
					const label = before?.label ?? (await rawLabel(client, slug));
					if (!label) throw new RuleError(`Unknown tag "${slug}"`);
					if (before?.status === 'hidden') continue;
					const incoming = await incomingMerges(client, slug);
					if (incoming > 0) {
						throw new RuleError(
							`"${label}" has ${incoming} other tag name${incoming === 1 ? '' : 's'} merged into it. Undo or re-merge those first.`
						);
					}
					const id = await upsert(client, slug, label, 'hidden', null, userId);
					await audit(
						client,
						userId,
						'tag_hide',
						id,
						before
							? {
									status: before.status,
									merged_into_slug: before.merged_into_slug
								}
							: { status: 'undecided' },
						{ status: 'hidden' },
						`Hid tag "${label}" from the family`
					);
				}
				return slugs.length === 1 ? 'Tag hidden.' : `${slugs.length} tags hidden.`;
			})
		);
	},

	merge: async ({ request, locals }) => {
		const userId = requireAdmin(locals);
		const data = await request.formData();
		const slugs = slugsFrom(data);
		const target = String(data.get('target') ?? '').trim();
		if (!slugs)
			return fail(400, {
				error: `Choose between 1 and ${MAX_BULK} valid tags`
			});
		if (!isValidTagSlug(target)) return fail(400, { error: 'Choose a tag to merge into' });
		if (slugs.includes(target)) return fail(400, { error: 'A tag cannot be merged into itself' });

		return runRules(() =>
			withTransaction(async (client) => {
				// Lock the target first: it must be approved and stay approved
				// until this transaction commits (hide/undo/merge of the target
				// take the same row lock).
				const tgt = await lockRow(client, target);
				if (!tgt || tgt.status !== 'approved') {
					throw new RuleError('You can only merge into a tag that is shown to the family');
				}
				for (const slug of slugs) {
					const before = await lockRow(client, slug);
					const label = before?.label ?? (await rawLabel(client, slug));
					if (!label) throw new RuleError(`Unknown tag "${slug}"`);
					// Keep resolution one hop: anything merged into this name
					// now points straight at the new target (same rule as
					// /admin/entities' reparentExistingAliases).
					const repointed = await client.query<{
						id: number;
						tag_slug: string;
					}>(
						`UPDATE tag_vocabulary SET merged_into_slug = $2, decided_by = $3, decided_at = NOW()
						  WHERE merged_into_slug = $1
						  RETURNING id::int AS id, tag_slug`,
						[slug, target, userId]
					);
					for (const r of repointed.rows) {
						await audit(
							client,
							userId,
							'tag_merge',
							r.id,
							{ merged_into_slug: slug },
							{ merged_into_slug: target },
							`Re-pointed merged tag "${r.tag_slug}" to "${tgt.label}" (its target "${label}" was merged)`
						);
					}
					const id = await upsert(client, slug, label, 'merged', target, userId);
					await audit(
						client,
						userId,
						'tag_merge',
						id,
						before
							? {
									status: before.status,
									merged_into_slug: before.merged_into_slug
								}
							: { status: 'undecided' },
						{ status: 'merged', merged_into_slug: target },
						`Merged tag "${label}" into "${tgt.label}"`
					);
				}
				return slugs.length === 1
					? `Merged into "${tgt.label}".`
					: `${slugs.length} tags merged into "${tgt.label}".`;
			})
		);
	},

	rename: async ({ request, locals }) => {
		const userId = requireAdmin(locals);
		const data = await request.formData();
		const slugs = slugsFrom(data);
		const label = String(data.get('label') ?? '').trim();
		if (!slugs || slugs.length !== 1) return fail(400, { error: 'Rename one tag at a time' });
		if (!isValidTagLabel(label)) return fail(400, { error: 'Label must be 1–40 characters' });

		return runRules(() =>
			withTransaction(async (client) => {
				const before = await lockRow(client, slugs[0]);
				if (!before) throw new RuleError('Decide on this tag before renaming it');
				await client.query(
					`UPDATE tag_vocabulary SET label = $2, decided_by = $3, decided_at = NOW() WHERE id = $1`,
					[before.id, label, userId]
				);
				await audit(
					client,
					userId,
					'tag_rename',
					before.id,
					{ label: before.label },
					{ label },
					`Renamed tag "${before.label}" to "${label}"`
				);
				return 'Label saved.';
			})
		);
	},

	undo: async ({ request, locals }) => {
		const userId = requireAdmin(locals);
		const data = await request.formData();
		const slugs = slugsFrom(data);
		if (!slugs)
			return fail(400, {
				error: `Choose between 1 and ${MAX_BULK} valid tags`
			});

		return runRules(() =>
			withTransaction(async (client) => {
				let undone = 0;
				for (const slug of slugs) {
					const before = await lockRow(client, slug);
					if (!before) continue;
					const incoming = await incomingMerges(client, slug);
					if (incoming > 0) {
						throw new RuleError(
							`"${before.label}" has ${incoming} other tag name${incoming === 1 ? '' : 's'} merged into it. Undo those first.`
						);
					}
					await client.query(`DELETE FROM tag_vocabulary WHERE id = $1`, [before.id]);
					await audit(
						client,
						userId,
						'tag_undo',
						before.id,
						{
							status: before.status,
							label: before.label,
							merged_into_slug: before.merged_into_slug
						},
						{ status: 'undecided' },
						`Reset tag "${before.label}" to undecided`
					);
					undone++;
				}
				return undone === 1 ? 'Back to undecided.' : `${undone} tags back to undecided.`;
			})
		);
	}
};
