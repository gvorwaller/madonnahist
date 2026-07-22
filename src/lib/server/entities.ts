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

export interface EntityProfile {
	displayName: string;
	entityType: EntityType;
	slug: string;
	mentionCount: number;
	firstYear: number | null;
	lastYear: number | null;
	yearCounts: YearCount[];
	days: EntityDay[];
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
	const daysRes = await query<{ entry_date: string; corrected_text: string | null }>(
		`SELECT DISTINCT cd.entry_date::text AS entry_date, cd.corrected_text
		   FROM day_entities de
		   JOIN calendar_days cd ON cd.id = de.day_id
		  WHERE de.entity_id = ANY($1::bigint[])
		    AND cd.correction_status = 'accepted'
		  ORDER BY entry_date`,
		[groupIds]
	);

	const days: EntityDay[] = daysRes.rows.map((r) => ({
		entryDate: r.entry_date,
		dateLabel: formatHumanDate(r.entry_date),
		snippet: firstSentences(r.corrected_text ?? '')
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
		days
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
