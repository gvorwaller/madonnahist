/**
 * Shared helpers for entity-powered viewer surfaces (`/app/person/[slug]`,
 * `/app/place/[slug]`, entity chips on `/app/day/[date]`, and the
 * person/place filter on `/app/search`) — Phase D of
 * docs/2026-07-21-next-phases-search-viewer-narrative-plan.md.
 *
 * Same accepted-only invariant as src/lib/server/viewer.ts: every query
 * here applies `correction_status = 'accepted'` directly, independently of
 * any page-level check.
 *
 * Alias resolution is one hop: `COALESCE(alias_of_entity_id, id)`. The
 * admin alias/merge actions (src/routes/admin/entities) enforce that a
 * canonical target can never itself be an alias, which is what keeps a
 * single COALESCE hop correct — see that route's server file for the
 * enforced invariant.
 */
import { query } from '$lib/db';
import { redirect } from '@sveltejs/kit';
import { formatHumanDate, firstSentences } from '$lib/server/viewer';

export type EntityType = 'person' | 'place';

export interface EntityDay {
	entryDate: string;
	dateLabel: string;
	snippet: string;
}

export interface YearCount {
	year: number;
	count: number;
}

export interface RelatedEntity {
	slug: string;
	name: string;
	entityType: EntityType;
	/** Accepted days on which both are mentioned. */
	days: number;
}

export interface EntityProfile {
	displayName: string;
	entityType: EntityType;
	slug: string;
	mentionCount: number;
	firstYear: number | null;
	lastYear: number | null;
	yearCounts: YearCount[];
	days: EntityDay[];
	/** People and places mentioned on the same accepted days (V3 Slice 4). */
	related: { people: RelatedEntity[]; places: RelatedEntity[] };
}

const RELATED_PER_TYPE = 8;

/**
 * Co-mentions (V3 Slice 4, plan CODEX #6): canonical people and places
 * named on the same accepted days as the entity group `groupIds`, counted
 * as distinct days, aliases resolved, the entity itself excluded. Top
 * RELATED_PER_TYPE of each type, most shared days first.
 */
async function getRelatedEntities(
	canonicalId: number,
	groupIds: number[]
): Promise<{ people: RelatedEntity[]; places: RelatedEntity[] }> {
	const res = await query<{ slug: string; display_name: string; entity_type: EntityType; days: number }>(
		`WITH my_days AS (
		   SELECT DISTINCT de.day_id
		     FROM day_entities de
		     JOIN calendar_days cd ON cd.id = de.day_id
		    WHERE de.entity_id = ANY($1::bigint[])
		      AND cd.correction_status = 'accepted'
		 ), counted AS (
		   SELECT canon.slug, canon.display_name, canon.entity_type,
		          COUNT(DISTINCT md.day_id)::int AS days
		     FROM my_days md
		     JOIN day_entities de ON de.day_id = md.day_id
		     JOIN entities e ON e.id = de.entity_id
		     JOIN entities canon ON canon.id = COALESCE(e.alias_of_entity_id, e.id)
		    WHERE canon.id <> $2
		      AND canon.entity_type IN ('person', 'place')
		    GROUP BY canon.id, canon.slug, canon.display_name, canon.entity_type
		 )
		 SELECT slug, display_name, entity_type, days
		   FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY entity_type
		                                     ORDER BY days DESC, display_name) AS rn
		           FROM counted) ranked
		  WHERE rn <= $3
		  ORDER BY entity_type, days DESC, display_name`,
		[groupIds, canonicalId, RELATED_PER_TYPE]
	);
	const people: RelatedEntity[] = [];
	const places: RelatedEntity[] = [];
	for (const r of res.rows) {
		const item = { slug: r.slug, name: r.display_name, entityType: r.entity_type, days: r.days };
		(r.entity_type === 'person' ? people : places).push(item);
	}
	return { people, places };
}

/**
 * Load an entity profile. Returns null only when no entities row matches
 * `(entityType, slug)` at all. An entity that exists but has zero accepted
 * mentions still returns a profile (mentionCount 0, empty days) — callers
 * render that as "no accepted mentions yet," distinct from "not found."
 *
 * If `slug` belongs to a non-canonical alias, redirects (301) to the
 * canonical entity's own slug — an alias URL and its canonical URL must
 * show identical content (mentions are always alias-resolved), so keeping
 * one URL as the source of truth avoids duplicating this query at two
 * paths.
 */
export async function loadEntityProfile(entityType: EntityType, slug: string): Promise<EntityProfile | null> {
	const selfRes = await query<{ id: number; alias_of_entity_id: number | null }>(
		`SELECT id, alias_of_entity_id FROM entities WHERE entity_type = $1 AND slug = $2`,
		[entityType, slug]
	);
	const self = selfRes.rows[0];
	if (!self) return null;

	let canonicalId = self.id;
	if (self.alias_of_entity_id !== null) {
		const canonicalRes = await query<{ slug: string }>(
			`SELECT slug FROM entities WHERE id = $1 AND entity_type = $2`,
			[self.alias_of_entity_id, entityType]
		);
		const canonicalSlug = canonicalRes.rows[0]?.slug;
		if (canonicalSlug && canonicalSlug !== slug) {
			redirect(301, `/app/${entityType}/${canonicalSlug}`);
		}
		canonicalId = self.alias_of_entity_id;
	}

	const displayRes = await query<{ display_name: string; slug: string }>(
		`SELECT display_name, slug FROM entities WHERE id = $1`,
		[canonicalId]
	);
	const display = displayRes.rows[0];
	if (!display) return null;

	const groupRes = await query<{ id: number }>(
		`SELECT id FROM entities WHERE id = $1 OR alias_of_entity_id = $1`,
		[canonicalId]
	);
	const groupIds = groupRes.rows.map((r) => r.id);

	// DISTINCT requires every ORDER BY expression to appear (verbatim) in the
	// select list — ordering by the unqualified `entry_date` alias rather
	// than the cast `cd.entry_date::text` expression satisfies that.
	const [daysRes, related] = await Promise.all([
		query<{ entry_date: string; corrected_text: string | null }>(
			`SELECT DISTINCT cd.entry_date::text AS entry_date, cd.corrected_text
			   FROM day_entities de
			   JOIN calendar_days cd ON cd.id = de.day_id
			  WHERE de.entity_id = ANY($1::bigint[])
			    AND cd.correction_status = 'accepted'
			  ORDER BY entry_date`,
			[groupIds]
		),
		getRelatedEntities(canonicalId, groupIds)
	]);

	const days: EntityDay[] = daysRes.rows.map((r) => ({
		entryDate: r.entry_date,
		dateLabel: formatHumanDate(r.entry_date),
		// Short, one-sentence snippets: a busy person can have 1,000+ days, and
		// every one is listed (grouped by year) on the profile page.
		snippet: firstSentences(r.corrected_text ?? '', 1, 160)
	}));

	const yearCountsMap = new Map<number, number>();
	for (const d of days) {
		const year = Number(d.entryDate.slice(0, 4));
		yearCountsMap.set(year, (yearCountsMap.get(year) ?? 0) + 1);
	}
	const yearCounts: YearCount[] = [...yearCountsMap.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([year, count]) => ({ year, count }));

	return {
		displayName: display.display_name,
		entityType,
		slug: display.slug,
		mentionCount: days.length,
		firstYear: yearCounts[0]?.year ?? null,
		lastYear: yearCounts.length > 0 ? yearCounts[yearCounts.length - 1].year : null,
		yearCounts,
		days,
		related
	};
}

export interface DayEntityChip {
	slug: string;
	displayName: string;
	entityType: EntityType;
}

/**
 * Person/place entities mentioned on an accepted day, alias-resolved to
 * their canonical slug/name — feeds the entity chips on
 * `/app/day/[date]`. Event-type entities are omitted: Phase D ships only
 * person and place profile pages, so there is nowhere for an event chip to
 * link yet.
 */
export async function getDayEntityChips(entryDate: string): Promise<DayEntityChip[]> {
	const res = await query<{ slug: string; display_name: string; entity_type: EntityType }>(
		`SELECT DISTINCT
		        COALESCE(alias.slug, e.slug) AS slug,
		        COALESCE(alias.display_name, e.display_name) AS display_name,
		        COALESCE(alias.entity_type, e.entity_type) AS entity_type
		   FROM day_entities de
		   JOIN calendar_days cd ON cd.id = de.day_id
		   JOIN entities e ON e.id = de.entity_id
		   LEFT JOIN entities alias ON alias.id = e.alias_of_entity_id
		  WHERE cd.entry_date = $1
		    AND cd.correction_status = 'accepted'
		    AND COALESCE(alias.entity_type, e.entity_type) IN ('person', 'place')
		  ORDER BY display_name`,
		[entryDate]
	);
	return res.rows.map((r) => ({ slug: r.slug, displayName: r.display_name, entityType: r.entity_type }));
}

export interface EntityOption {
	slug: string;
	label: string;
}

/**
 * Canonical person/place entities that have at least one accepted-day
 * mention (recorded either directly or against one of their aliases) —
 * feeds the /app/search person/place filter dropdowns, same
 * "accepted-only, alias-resolved" shape as getAcceptedTagOptions() in
 * viewer.ts.
 */
export async function getAcceptedEntityOptions(entityType: EntityType): Promise<EntityOption[]> {
	const res = await query<{ slug: string; display_name: string }>(
		`SELECT DISTINCT canon.slug, canon.display_name
		   FROM day_entities de
		   JOIN calendar_days cd ON cd.id = de.day_id
		   JOIN entities e ON e.id = de.entity_id
		   JOIN entities canon ON canon.id = COALESCE(e.alias_of_entity_id, e.id)
		  WHERE cd.correction_status = 'accepted'
		    AND canon.entity_type = $1
		  ORDER BY canon.display_name`,
		[entityType]
	);
	return res.rows
		.map((r) => ({ slug: r.slug, label: r.display_name }))
		.sort((a, b) => a.label.localeCompare(b.label));
}

export interface EntityPickerOption {
	id: number;
	display_name: string;
	entityType: EntityType;
}

/**
 * Canonical person/place entities with at least one accepted-day mention,
 * as {id, display_name} pairs feeding src/lib/components/EntityPicker.svelte
 * on /admin/ask (Phase G of
 * docs/2026-07-21-next-phases-search-viewer-narrative-plan.md). Same
 * accepted-only, alias-resolved shape as getAcceptedEntityOptions() above,
 * but keyed by the canonical numeric id (not a (entity_type, slug) pair) —
 * Ask's subset query filters directly on that id via the alias-resolution
 * EXISTS clause in src/routes/admin/ask/+page.server.ts, so there is no
 * need to round-trip through a slug lookup the way /app/search's two
 * separate person/place query params do. Event-type entities are omitted:
 * Phase G's outcome is scoped to "date range and/or entity/tag/FTS filter"
 * where "entity" means person/place, matching /app/search's precedent.
 */
export async function getAcceptedEntityPickerOptions(): Promise<EntityPickerOption[]> {
	const res = await query<{ id: number; display_name: string; entity_type: EntityType }>(
		`SELECT DISTINCT canon.id, canon.display_name, canon.entity_type
		   FROM day_entities de
		   JOIN calendar_days cd ON cd.id = de.day_id
		   JOIN entities e ON e.id = de.entity_id
		   JOIN entities canon ON canon.id = COALESCE(e.alias_of_entity_id, e.id)
		  WHERE cd.correction_status = 'accepted'
		    AND canon.entity_type IN ('person', 'place')
		  ORDER BY canon.display_name`
	);
	return res.rows
		.map((r) => ({ id: r.id, display_name: r.display_name, entityType: r.entity_type }))
		.sort((a, b) => a.display_name.localeCompare(b.display_name));
}

export interface DirectoryEntry {
	slug: string;
	name: string;
	days: number;
	firstYear: number;
	lastYear: number;
}

/**
 * The People / Places index (V3 Slice 1): every canonical person or place
 * with at least one accepted-day mention (directly or through an alias),
 * with its day count and first/last year. Accepted-only and alias-resolved,
 * same shape as getAcceptedEntityOptions() above.
 */
export async function getEntityDirectory(entityType: EntityType): Promise<DirectoryEntry[]> {
	const res = await query<{
		slug: string;
		display_name: string;
		days: number;
		first_year: number;
		last_year: number;
	}>(
		`SELECT canon.slug, canon.display_name,
		        COUNT(DISTINCT cd.id)::int AS days,
		        MIN(EXTRACT(YEAR FROM cd.entry_date))::int AS first_year,
		        MAX(EXTRACT(YEAR FROM cd.entry_date))::int AS last_year
		   FROM day_entities de
		   JOIN calendar_days cd ON cd.id = de.day_id
		   JOIN entities e ON e.id = de.entity_id
		   JOIN entities canon ON canon.id = COALESCE(e.alias_of_entity_id, e.id)
		  WHERE cd.correction_status = 'accepted'
		    AND canon.entity_type = $1
		  GROUP BY canon.id, canon.slug, canon.display_name`,
		[entityType]
	);
	return res.rows
		.map((r) => ({
			slug: r.slug,
			name: r.display_name,
			days: r.days,
			firstYear: r.first_year,
			lastYear: r.last_year
		}))
		.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
}
