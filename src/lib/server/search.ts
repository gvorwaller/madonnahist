/**
 * Search helpers for the family viewer (V3 Slice 4): typeahead suggestions,
 * labels for the active filter chips, and the people/place chips on each
 * result card.
 *
 * Same accepted-only invariant as src/lib/server/viewer.ts: every query
 * here applies `correction_status = 'accepted'` itself. An entity or tag
 * known only from pending days is never suggested, never labelled and never
 * shown as a chip. Entity aliases resolve one hop, as in entities.ts.
 */
import { query } from '$lib/db';
import { VISIBLE_DAY_TAGS } from '$lib/server/viewer';
import type { EntityType } from '$lib/server/entities';

export const SUGGEST_MAX_TERM = 60;
const PER_GROUP = 6;

export interface Suggestion {
	slug: string;
	label: string;
	days: number;
}

export interface Suggestions {
	people: Suggestion[];
	places: Suggestion[];
	tags: Suggestion[];
}

function likeEscape(s: string): string {
	return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * People, places and family-visible tags whose name contains `term`
 * (case-insensitive). A match on an alias suggests its canonical entity.
 * Names starting with the term, or with a word starting with it, rank
 * first; then the most days.
 */
export async function suggestFilters(term: string): Promise<Suggestions> {
	const t = term.trim().slice(0, SUGGEST_MAX_TERM);
	if (t.length < 2) return { people: [], places: [], tags: [] };
	const e = likeEscape(t);
	const contains = `%${e}%`;
	const prefix = `${e}%`;
	const wordStart = `% ${e}%`;

	const [entRes, tagRes] = await Promise.all([
		query<{ slug: string; display_name: string; entity_type: EntityType; days: number }>(
			`WITH hits AS (
			   SELECT DISTINCT COALESCE(e.alias_of_entity_id, e.id) AS canon_id
			     FROM entities e
			    WHERE e.entity_type IN ('person', 'place')
			      AND e.display_name ILIKE $1 ESCAPE '\\'
			 ), counted AS (
			   SELECT canon.slug, canon.display_name, canon.entity_type,
			          COUNT(DISTINCT cd.id)::int AS days,
			          (canon.display_name ILIKE $2 ESCAPE '\\' OR canon.display_name ILIKE $3 ESCAPE '\\') AS starts
			     FROM hits h
			     JOIN entities canon ON canon.id = h.canon_id
			     JOIN entities e ON COALESCE(e.alias_of_entity_id, e.id) = canon.id
			     JOIN day_entities de ON de.entity_id = e.id
			     JOIN calendar_days cd ON cd.id = de.day_id
			    WHERE cd.correction_status = 'accepted'
			      AND canon.entity_type IN ('person', 'place')
			    GROUP BY canon.id, canon.slug, canon.display_name, canon.entity_type
			 )
			 SELECT slug, display_name, entity_type, days
			   FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY entity_type
			                                     ORDER BY starts DESC, days DESC, display_name) AS rn
			           FROM counted) ranked
			  WHERE rn <= $4
			  ORDER BY entity_type, rn`,
			[contains, prefix, wordStart, PER_GROUP]
		),
		query<{ tag_slug: string; tag_label: string; days: number }>(
			`SELECT vt.tag_slug, MIN(vt.tag_label) AS tag_label, COUNT(DISTINCT vt.day_id)::int AS days
			   FROM ${VISIBLE_DAY_TAGS} vt
			   JOIN calendar_days cd ON cd.id = vt.day_id
			  WHERE cd.correction_status = 'accepted'
			    AND vt.tag_label ILIKE $1 ESCAPE '\\'
			  GROUP BY vt.tag_slug
			  ORDER BY bool_or(vt.tag_label ILIKE $2 ESCAPE '\\' OR vt.tag_label ILIKE $3 ESCAPE '\\') DESC,
			           days DESC, MIN(vt.tag_label)
			  LIMIT $4`,
			[contains, prefix, wordStart, PER_GROUP]
		)
	]);

	const people: Suggestion[] = [];
	const places: Suggestion[] = [];
	for (const r of entRes.rows) {
		(r.entity_type === 'person' ? people : places).push({
			slug: r.slug,
			label: r.display_name,
			days: r.days
		});
	}
	const tags = tagRes.rows.map((r) => ({ slug: r.tag_slug, label: r.tag_label, days: r.days }));
	return { people, places, tags };
}

/**
 * Display name for an active person/place filter chip: the canonical name,
 * but only when that entity has an accepted mention. Otherwise null, and
 * the chip shows the slug the reader typed.
 */
export async function getEntityFilterLabel(entityType: EntityType, slug: string): Promise<string | null> {
	const res = await query<{ display_name: string }>(
		`SELECT canon.display_name
		   FROM entities x
		   JOIN entities canon ON canon.id = COALESCE(x.alias_of_entity_id, x.id)
		  WHERE x.entity_type = $1 AND x.slug = $2
		    AND EXISTS (
		      SELECT 1
		        FROM entities e
		        JOIN day_entities de ON de.entity_id = e.id
		        JOIN calendar_days cd ON cd.id = de.day_id
		       WHERE COALESCE(e.alias_of_entity_id, e.id) = canon.id
		         AND cd.correction_status = 'accepted'
		    )
		  LIMIT 1`,
		[entityType, slug]
	);
	return res.rows[0]?.display_name ?? null;
}

/** Label for an active tag filter chip, only when the tag is visible on an accepted day. */
export async function getTagFilterLabel(canonicalSlug: string): Promise<string | null> {
	const res = await query<{ tag_label: string }>(
		`SELECT vt.tag_label
		   FROM ${VISIBLE_DAY_TAGS} vt
		   JOIN calendar_days cd ON cd.id = vt.day_id
		  WHERE vt.tag_slug = $1 AND cd.correction_status = 'accepted'
		  LIMIT 1`,
		[canonicalSlug]
	);
	return res.rows[0]?.tag_label ?? null;
}

export interface ResultChip {
	slug: string;
	name: string;
	entityType: EntityType;
}

/** People and places on each of the given accepted days, keyed by entry date. */
export async function getResultChips(entryDates: string[]): Promise<Map<string, ResultChip[]>> {
	const out = new Map<string, ResultChip[]>();
	if (entryDates.length === 0) return out;
	const res = await query<{ entry_date: string; slug: string; display_name: string; entity_type: EntityType }>(
		`SELECT DISTINCT cd.entry_date::text AS entry_date, canon.slug, canon.display_name, canon.entity_type
		   FROM calendar_days cd
		   JOIN day_entities de ON de.day_id = cd.id
		   JOIN entities e ON e.id = de.entity_id
		   JOIN entities canon ON canon.id = COALESCE(e.alias_of_entity_id, e.id)
		  WHERE cd.entry_date = ANY($1::date[])
		    AND cd.correction_status = 'accepted'
		    AND canon.entity_type IN ('person', 'place')
		  ORDER BY entry_date, canon.entity_type, canon.display_name`,
		[entryDates]
	);
	for (const r of res.rows) {
		const chip = { slug: r.slug, name: r.display_name, entityType: r.entity_type };
		const list = out.get(r.entry_date);
		if (list) list.push(chip);
		else out.set(r.entry_date, [chip]);
	}
	return out;
}
