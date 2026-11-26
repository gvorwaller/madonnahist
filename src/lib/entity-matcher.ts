/**
 * Likely-duplicate finder for /admin/entities/cleanup (td-c6e871,
 * docs/2026-11-23-entity-cleanup-plan.md §1). Pure: no DB, no imports
 * beyond the shared name fold, so it is unit-tested directly
 * (scripts/test-entity-matcher.ts).
 *
 * Works on canonical entities of ONE type. Each entity's count, first/last
 * and days are its whole canonical family's (itself plus its aliases).
 *
 * It only suggests. Even the "likely" tier has false matches on real data
 * (Janie ~ Jamie), so nothing here ever merges anything, and being in the
 * same group proves nothing about two candidates (similarity isn't
 * transitive): every merge is checked pairwise against "not the same".
 */
import { fold, squash } from './name-fold';

export type Tier = 'likely' | 'possible';
export type MatchReason = 'same-letters' | 'typo-of-common' | 'one-letter' | 'two-letters' | 'first-word';

export interface MatchEntity {
	id: number;
	name: string;
	/** Distinct days the family is mentioned on. */
	count: number;
	/** ISO dates (YYYY-MM-DD) of those days, ascending. */
	days: string[];
	/**
	 * Opaque digest of everything else a Claude check reads about this family
	 * (its alias names and those days' text and notes), so a stored answer
	 * can tell when its evidence changed. Not used for matching.
	 */
	rev?: string;
}

export interface Candidate {
	entity: MatchEntity;
	tier: Tier;
	reason: MatchReason;
	/**
	 * How many of the candidate's days fall outside the main name's years,
	 * with a year's margin either side: "Becky" in 1977 against a Rebekah
	 * first mentioned in 1985 counts; a typo a week after the last mention
	 * doesn't.
	 */
	outside: number;
}

export interface Group {
	main: MatchEntity;
	tier: Tier;
	candidates: Candidate[];
}

/** "low:high", the storage order of entity_not_same. Ids are numbers, compared as numbers. */
export function pairKey(a: number, b: number): string {
	return a < b ? `${a}:${b}` : `${b}:${a}`;
}

interface Prepared {
	e: MatchEntity;
	sq: string;
	digits: string;
	words: string[];
}

function prepare(e: MatchEntity): Prepared | null {
	const f = fold(e.name);
	const sq = squash(f);
	if (sq === '') return null;
	return {
		e,
		sq,
		digits: sq.replace(/\P{Nd}/gu, ''),
		words: f.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
	};
}

/** Levenshtein distance, giving up (returning max + 1) once it can't be ≤ max. */
export function editDistance(a: string, b: string, max = 2): number {
	if (Math.abs(a.length - b.length) > max) return max + 1;
	let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		const cur = [i];
		let best = i;
		for (let j = 1; j <= b.length; j++) {
			cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
			if (cur[j] < best) best = cur[j];
		}
		if (best > max) return max + 1;
		prev = cur;
	}
	return prev[b.length];
}

/** The more-mentioned one is the main name; a tie goes to the lower id. */
function order(a: Prepared, b: Prepared): [Prepared, Prepared] {
	if (a.e.count !== b.e.count) return a.e.count > b.e.count ? [a, b] : [b, a];
	return a.e.id < b.e.id ? [a, b] : [b, a];
}

function classify(main: Prepared, cand: Prepared, allowFirstWord: boolean): { tier: Tier; reason: MatchReason } | null {
	if (main.sq === cand.sq) return { tier: 'likely', reason: 'same-letters' };
	const longest = Math.max(main.sq.length, cand.sq.length);
	const d = editDistance(main.sq, cand.sq, 2);
	if (d === 1) {
		// A rare spelling one letter off a much more common name: a typo.
		// A zero-mention entity never counts as rare (it has no evidence).
		const rare = cand.e.count;
		if (longest >= 5 && rare >= 1 && rare <= 2 && main.e.count >= 10 * rare) {
			return { tier: 'likely', reason: 'typo-of-common' };
		}
		if (longest >= 4) return { tier: 'possible', reason: 'one-letter' };
	}
	if (d === 2 && longest >= 7) return { tier: 'possible', reason: 'two-letters' };
	if (allowFirstWord) {
		const [short, long] = main.words.length <= cand.words.length ? [main, cand] : [cand, main];
		if (short.words.length === 1 && long.words.length > 1 && long.words[0] === short.words[0] && short.sq.length >= 3) {
			return { tier: 'possible', reason: 'first-word' };
		}
	}
	return null;
}

const TIER_RANK: Record<Tier, number> = { likely: 0, possible: 1 };
export const SPAN_MARGIN_YEARS = 1;

/**
 * Groups of likely duplicates, best first. `notSame` holds pairKey()s the
 * admin marked "not the same"; those pairs are never suggested.
 * First-word matches ("Easter" / "Easter party") are only used for people
 * and places: for events they were nearly all noise on real data.
 */
export function findGroups(
	entities: MatchEntity[],
	opts: { notSame: Set<string>; firstWord: boolean }
): Group[] {
	// A name with no days (e.g. a correction removed its last mention) has no
	// evidence and nothing to merge: it is never suggested, either way round.
	// The cleanup page lists it under Unused instead (td-a7920d).
	const prepared = entities
		.filter((e) => e.count > 0)
		.map(prepare)
		.filter((p): p is Prepared => p !== null);
	// Best pair for each candidate id.
	const best = new Map<number, { main: Prepared; tier: Tier; reason: MatchReason }>();
	for (let i = 0; i < prepared.length; i++) {
		for (let j = i + 1; j < prepared.length; j++) {
			const a = prepared[i];
			const b = prepared[j];
			if (a.digits !== b.digits) continue; // "40th" vs "37th birthday"
			if (opts.notSame.has(pairKey(a.e.id, b.e.id))) continue;
			const [main, cand] = order(a, b);
			const m = classify(main, cand, opts.firstWord);
			if (!m) continue;
			const prev = best.get(cand.e.id);
			if (
				!prev ||
				TIER_RANK[m.tier] < TIER_RANK[prev.tier] ||
				(m.tier === prev.tier &&
					(main.e.count > prev.main.e.count || (main.e.count === prev.main.e.count && main.e.id < prev.main.e.id)))
			) {
				best.set(cand.e.id, { main, ...m });
			}
		}
	}

	const groups = new Map<number, Group>();
	const byId = new Map(prepared.map((p) => [p.e.id, p.e]));
	for (const [candId, m] of best) {
		const cand = byId.get(candId)!;
		const main = m.main.e;
		const firstYear = main.days.length ? Number(main.days[0].slice(0, 4)) - SPAN_MARGIN_YEARS : 0;
		const lastYear = main.days.length ? Number(main.days[main.days.length - 1].slice(0, 4)) + SPAN_MARGIN_YEARS : 0;
		const outside = main.days.length
			? cand.days.filter((d) => {
					const y = Number(d.slice(0, 4));
					return y < firstYear || y > lastYear;
				}).length
			: 0;
		let g = groups.get(main.id);
		if (!g) groups.set(main.id, (g = { main, tier: m.tier, candidates: [] }));
		g.candidates.push({ entity: cand, tier: m.tier, reason: m.reason, outside });
		if (TIER_RANK[m.tier] < TIER_RANK[g.tier]) g.tier = m.tier;
	}

	const list = [...groups.values()];
	for (const g of list) {
		g.candidates.sort(
			(x, y) =>
				TIER_RANK[x.tier] - TIER_RANK[y.tier] || y.entity.count - x.entity.count || x.entity.id - y.entity.id
		);
	}
	list.sort((x, y) => TIER_RANK[x.tier] - TIER_RANK[y.tier] || y.main.count - x.main.count || x.main.id - y.main.id);
	return list;
}
