/**
 * The days an entity is mentioned on, with a snippet showing where (td-c6e871
 * plan §4). Used by the mentions endpoint (/admin/entities, cleanup page) and
 * by the Claude pre-check, so both read the same evidence.
 *
 * A canonical entity's days are its whole family's (itself plus its aliases,
 * as readers resolve them). An alias's days are its own direct links only:
 * that's what you're judging when you look at an alias row.
 *
 * The extractor reads both the corrected text and the day's note
 * (calendar_days.day_narrative), so snippets look in both. A name found in
 * neither (an OCR'd spelling since corrected, or a renamed entity) is
 * labelled rather than faked.
 */
import { query } from '$lib/db';

export interface Snippet {
	where: 'text' | 'note' | 'none';
	before: string;
	match: string;
	after: string;
}

export interface EvidenceDay {
	dayId: number;
	entryDate: string;
	/** A human decision links this day (moved here, or tagged by hand). */
	human: boolean;
	/** Names in the family that link this day, when not just the entity itself. */
	via: string[];
	snippet: Snippet;
}

export interface Family {
	id: number;
	displayName: string;
	entityType: string;
	/** Canonical id: the family this entity belongs to (itself when canonical). */
	canonicalId: number;
	/** Ids whose links count as this entity's days. */
	memberIds: number[];
	names: string[];
}

export async function loadFamily(id: number): Promise<Family | null> {
	const self = await query<{ id: string; display_name: string; entity_type: string; alias_of_entity_id: string | null }>(
		`SELECT id, display_name, entity_type, alias_of_entity_id FROM entities WHERE id = $1`,
		[id]
	);
	const r = self.rows[0];
	if (!r) return null;
	if (r.alias_of_entity_id !== null) {
		return {
			id,
			displayName: r.display_name,
			entityType: r.entity_type,
			canonicalId: Number(r.alias_of_entity_id),
			memberIds: [id],
			names: [r.display_name]
		};
	}
	const members = await query<{ id: string; display_name: string }>(
		`SELECT id, display_name FROM entities WHERE id = $1 OR alias_of_entity_id = $1 ORDER BY (id = $1) DESC, id`,
		[id]
	);
	return {
		id,
		displayName: r.display_name,
		entityType: r.entity_type,
		canonicalId: id,
		memberIds: members.rows.map((m) => Number(m.id)),
		names: members.rows.map((m) => m.display_name)
	};
}

const RADIUS = 90;

/** Where any of `names` first appears: the corrected text, else the day's note. */
export function snippetFor(text: string | null, note: string | null, names: string[], radius = RADIUS): Snippet {
	const sorted = [...new Set(names.filter(Boolean))].sort((a, b) => b.length - a.length);
	for (const [where, raw] of [
		['text', text],
		['note', note]
	] as const) {
		const t = (raw ?? '').replace(/\s+/g, ' ').trim();
		if (!t) continue;
		const lower = t.toLowerCase();
		for (const n of sorted) {
			const idx = lower.indexOf(n.toLowerCase());
			if (idx < 0) continue;
			const start = Math.max(0, idx - radius);
			const end = Math.min(t.length, idx + n.length + radius);
			return {
				where,
				before: (start > 0 ? '…' : '') + t.slice(start, idx),
				match: t.slice(idx, idx + n.length),
				after: t.slice(idx + n.length, end) + (end < t.length ? '…' : '')
			};
		}
	}
	const t = (text ?? note ?? '').replace(/\s+/g, ' ').trim();
	const head = t.slice(0, radius * 2) + (t.length > radius * 2 ? '…' : '');
	return { where: 'none', before: head, match: '', after: '' };
}

interface DayRow {
	day_id: string;
	entry_date: string;
	corrected_text: string | null;
	day_narrative: string | null;
	human: boolean;
	via: string[];
}

const DAY_SELECT = `
	SELECT cd.id AS day_id, cd.entry_date::text AS entry_date, cd.corrected_text, cd.day_narrative,
	       bool_or(de.source = 'human') AS human,
	       array_agg(DISTINCT e.display_name ORDER BY e.display_name) AS via
	  FROM day_entities de
	  JOIN calendar_days cd ON cd.id = de.day_id
	  JOIN entities e ON e.id = de.entity_id
	 WHERE de.entity_id = ANY($1::bigint[])`;

function toEvidence(f: Family, r: DayRow): EvidenceDay {
	return {
		dayId: Number(r.day_id),
		entryDate: r.entry_date,
		human: r.human,
		via: r.via.length === 1 && r.via[0] === f.displayName ? [] : r.via,
		snippet: snippetFor(r.corrected_text, r.day_narrative, f.names)
	};
}

/** One page of days, oldest first, after the cursor `${date},${dayId}`. */
export async function familyDays(
	f: Family,
	opts: { after?: { date: string; dayId: number } | null; limit: number }
): Promise<{ days: EvidenceDay[]; next: string | null }> {
	const params: unknown[] = [f.memberIds, opts.limit + 1];
	let cursor = '';
	if (opts.after) {
		params.push(opts.after.date, opts.after.dayId);
		cursor = `AND (cd.entry_date, cd.id) > ($3::date, $4::int)`;
	}
	const res = await query<DayRow>(
		`${DAY_SELECT} ${cursor}
		 GROUP BY cd.id ORDER BY cd.entry_date, cd.id LIMIT $2`,
		params
	);
	const rows = res.rows.slice(0, opts.limit);
	const last = rows[rows.length - 1];
	const next = res.rows.length > opts.limit && last ? `${last.entry_date},${last.day_id}` : null;
	return { days: rows.map((r) => toEvidence(f, r)), next };
}

/** Parse a `${date},${dayId}` cursor; null when absent or malformed. */
export function parseCursor(raw: string | null): { date: string; dayId: number } | null {
	const m = /^(\d{4}-\d{2}-\d{2}),(\d+)$/.exec(raw ?? '');
	return m ? { date: m[1], dayId: Number(m[2]) } : null;
}

/**
 * A few days spread across the family's span, for the Claude check: the
 * first, the last, one from the middle, plus (when given the main name's
 * span) one that falls outside it, since that's where a second person
 * hides. At most `max`.
 */
export async function sampleDays(f: Family, max: number, span?: { first: string; last: string } | null): Promise<EvidenceDay[]> {
	const all = await query<{ day_id: string; entry_date: string }>(
		`SELECT DISTINCT cd.id AS day_id, cd.entry_date::text AS entry_date
		   FROM day_entities de JOIN calendar_days cd ON cd.id = de.day_id
		  WHERE de.entity_id = ANY($1::bigint[])
		  ORDER BY entry_date, day_id`,
		[f.memberIds]
	);
	const rows = all.rows;
	if (rows.length === 0) return [];
	const pick: number[] = [];
	const add = (i: number) => {
		if (i >= 0 && i < rows.length && !pick.includes(i) && pick.length < max) pick.push(i);
	};
	if (span) add(rows.findIndex((r) => r.entry_date < span.first || r.entry_date > span.last));
	add(0);
	add(rows.length - 1);
	add(Math.floor(rows.length / 2));
	for (let i = 1; pick.length < max && i < rows.length; i++) add(Math.floor((i * rows.length) / max));
	const ids = pick.map((i) => Number(rows[i].day_id));
	const res = await query<DayRow>(`${DAY_SELECT} AND cd.id = ANY($2::int[]) GROUP BY cd.id ORDER BY cd.entry_date, cd.id`, [
		f.memberIds,
		ids
	]);
	return res.rows.map((r) => toEvidence(f, r));
}
