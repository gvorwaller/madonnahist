import { error, fail } from '@sveltejs/kit';
import { query } from '$lib/db';
import {
	assertShownEvidence,
	checkFingerprint,
	isEntityType,
	loadChecks,
	loadGroups,
	loadUnused
} from '$lib/server/entity-cleanup';
import { deleteUnused, graphWrite, markNotSame, mergeEntities, toId, undoNotSame } from '$lib/server/entity-graph';
import type { Actions, PageServerLoad } from './$types';

/**
 * Find duplicates (td-c6e871, docs/2026-11-23-entity-cleanup-plan.md):
 * likely-duplicate groups from src/lib/entity-matcher.ts, with stored
 * Claude checks, unused names, and "not the same" pairs. Every change goes
 * through src/lib/server/entity-graph.ts.
 */

function requireAdmin(locals: App.Locals) {
	if (!locals.user || locals.user.role !== 'admin') error(403, 'Admin access required');
}

function years(days: string[]): string {
	if (days.length === 0) return '';
	const a = days[0].slice(0, 4);
	const b = days[days.length - 1].slice(0, 4);
	return a === b ? a : `${a}–${b}`;
}

export const load: PageServerLoad = async ({ locals, url }) => {
	requireAdmin(locals);
	const t = url.searchParams.get('type') ?? 'person';
	const type = isEntityType(t) ? t : 'person';

	const [{ groups, notSame }, checks, unused, canonical] = await Promise.all([
		loadGroups(type),
		loadChecks(type),
		loadUnused(type),
		query<{ id: string; display_name: string }>(
			`SELECT id, display_name FROM entities WHERE entity_type = $1 AND alias_of_entity_id IS NULL ORDER BY display_name, id`,
			[type]
		)
	]);

	return {
		type,
		groups: groups.map((g) => ({
			tier: g.tier,
			main: { id: g.main.id, name: g.main.name, count: g.main.count, years: years(g.main.days) },
			candidates: g.candidates.map((c) => {
				const stored = checks.get(`${g.main.id}:${c.entity.id}`);
				const fp = checkFingerprint(g.main, c.entity);
				const current = stored?.status === 'done' && stored.fingerprint === fp;
				return {
					id: c.entity.id,
					// The page keys this visit's ticks and Claude answers by pair and
					// fingerprint, so a change to either evidence drops them.
					fp,
					name: c.entity.name,
					count: c.entity.count,
					years: years(c.entity.days),
					tier: c.tier,
					reason: c.reason,
					outside: c.outside,
					check: current && stored.verdict && stored.reason ? { verdict: stored.verdict, reason: stored.reason } : null
				};
			})
		})),
		unused,
		notSame: notSame.pairs,
		canonical: canonical.rows.map((r) => ({ id: Number(r.id), display_name: r.display_name }))
	};
};

const user = (locals: App.Locals) => Number(locals.user!.id);

export const actions: Actions = {
	mergeGroup: async ({ request, locals }) => {
		requireAdmin(locals);
		const data = await request.formData();
		const keepId = toId(data.get('keepId'));
		const ids = data.getAll('id').map(toId);
		if (keepId === null || ids.length === 0 || ids.some((x) => x === null)) return fail(400, { error: 'Invalid merge' });
		// Required: the group's main name (one of the names merged) and, for
		// every other name, the evidence fingerprint the page showed. The merge
		// checks them once it holds its locks, so it can't go ahead on entries
		// that changed after the page loaded (another tab, the extractor).
		// /admin/entities has its own merge action for merging by hand.
		const mainId = toId(data.get('mainId'));
		const all = [keepId, ...(ids as number[])];
		if (mainId === null || !all.includes(mainId)) return fail(400, { error: 'Invalid merge' });
		const shown = new Map<number, string>();
		for (const [k, v] of data.entries()) {
			const m = /^fp:(\d+)$/.exec(k);
			if (m && typeof v === 'string') shown.set(Number(m[1]), v);
		}
		const others = all.filter((x) => x !== mainId);
		if (others.some((x) => !shown.has(x))) return fail(400, { error: 'Invalid merge' });
		const r = await graphWrite((c) =>
			mergeEntities(c, keepId, ids as number[], user(locals), (cl) => assertShownEvidence(cl, mainId, others, shown))
		);
		if (r && 'merged' in r) return { done: `Merged ${r.merged.map((n) => `"${n}"`).join(', ')} into "${r.into}".` };
		return r;
	},

	notSame: async ({ request, locals }) => {
		requireAdmin(locals);
		const data = await request.formData();
		const a = toId(data.get('a'));
		const b = toId(data.get('b'));
		if (a === null || b === null) return fail(400, { error: 'Invalid pair' });
		const r = await graphWrite((c) => markNotSame(c, a, b, user(locals)));
		return r ?? { done: 'Marked not the same.' };
	},

	undoNotSame: async ({ request, locals }) => {
		requireAdmin(locals);
		const data = await request.formData();
		const a = toId(data.get('a'));
		const b = toId(data.get('b'));
		if (a === null || b === null) return fail(400, { error: 'Invalid pair' });
		const r = await graphWrite((c) => undoNotSame(c, a, b, user(locals)));
		return r ?? { done: 'They can be suggested together again.' };
	},

	deleteUnused: async ({ request, locals }) => {
		requireAdmin(locals);
		const data = await request.formData();
		const id = toId(data.get('id'));
		if (id === null) return fail(400, { error: 'Invalid entity' });
		const r = await graphWrite((c) => deleteUnused(c, id, user(locals)));
		return r ?? { done: 'Deleted.' };
	}
};
