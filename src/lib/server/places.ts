/**
 * Place locations (td-085e19): which places get Map / Directions links.
 *
 * Gaylon's rules (2026-11-14):
 *   - Lookups favour Utah for Aug 1976 – May 1979 and May 1984 – May 1986,
 *     Florida otherwise. A place's region is where most of its accepted
 *     mentions fall. Vacation places should be obvious from their name.
 *   - Confident matches show automatically; only the exceptions wait on
 *     /admin/places. He won't approve every place.
 *
 * Accepted-only: a place is looked up only when it has an accepted mention,
 * so a name known only from untranscribed days is never sent to Google.
 * Generic words and possessive names ("Grandma's", "Wendy's") are never
 * sent either. Admin decisions (decided_by set) are never overwritten.
 */
import { query } from '$lib/db';
import { env } from '$env/dynamic/private';
import { isGeocodeConfigured, isGeocodeStub, searchPlaces, type Candidate } from '$lib/server/geocode';

export type Region = 'utah' | 'florida';
export type LocationStatus = 'auto' | 'confirmed' | 'needs_review' | 'no_location';
export type NoMapReason = 'general' | 'several' | 'not_found' | 'admin';

const CENTRES: Record<Region, { lat: number; lon: number }> = {
	utah: { lat: 40.7608, lon: -111.891 }, // Salt Lake City
	florida: { lat: 30.3322, lon: -81.6557 } // Jacksonville
};
const BIAS_RADIUS_M = 60_000;
const NEAR_KM = 150;
const STRONG = 0.8;
const WEAK = 0.5;
const SAME_SPOT_KM = 2;
const GAP_MS = 250;

/** Accepted-day predicate for the Utah years, as SQL over `cd.entry_date`. */
const UTAH_DAYS = `(cd.entry_date BETWEEN DATE '1976-08-01' AND DATE '1979-05-31'
	OR cd.entry_date BETWEEN DATE '1984-05-01' AND DATE '1986-05-31')`;

// Kinds of place that are obvious wherever they are (cities, states, parks,
// landmarks), so a far-away strong match is still trusted: vacations.
const OBVIOUS_TYPES = new Set([
	'locality',
	'administrative_area_level_1',
	'administrative_area_level_2',
	'country',
	'colloquial_area',
	'natural_feature',
	'park',
	'national_park',
	'amusement_park',
	'tourist_attraction',
	'university',
	'zoo',
	'museum',
	'stadium'
]);
const AREA_TYPES = new Set(['locality', 'administrative_area_level_1', 'administrative_area_level_2', 'country', 'colloquial_area']);

// Words that never identify one spot on their own.
const GENERIC_WORDS = new Set([
	'a', 'the', 'my', 'our', 'beach', 'house', 'home', 'mall', 'park', 'church', 'chapel', 'temple',
	'library', 'school', 'store', 'stores', 'shop', 'work', 'office', 'seminary', 'hospital', 'doctor',
	'dentist', 'lake', 'pool', 'gym', 'market', 'restaurant', 'ward', 'stake', 'center', 'centre',
	'building', 'class', 'camp', 'cabin', 'farm', 'river', 'downtown', 'airport',
	'station', 'apartment', 'apartments', 'motel', 'hotel', 'bank', 'post', 'gas', 'job', 'clinic',
	'theater', 'theatre', 'movies', 'show', 'party', 'meeting', 'yard', 'garden', 'kitchen', 'cafeteria',
	'institute', 'college', 'university', 'grocery', 'groceries', 'cemetery', 'mountains', 'mountain',
	'canyon', 'zoo', 'museum', 'beach house', 'school house'
]);

function normalize(s: string): string {
	return s
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/&/g, ' and ')
		.replace(/[’']/g, "'");
}

function tokens(s: string): string[] {
	return normalize(s)
		.replace(/'s\b/g, '')
		.split(/[^a-z0-9]+/)
		.filter((t) => t && t !== 'the');
}

/** Generic words or a possessive ("Grandma's", "Vorwaller's"): never looked up. */
export function isGeneralName(name: string): boolean {
	const n = normalize(name).trim();
	if (/\w's\b/.test(n)) return true;
	const t = n.split(/[^a-z0-9]+/).filter(Boolean);
	if (t.length === 0) return true;
	if (GENERIC_WORDS.has(t.join(' '))) return true;
	return t.every((w) => GENERIC_WORDS.has(w));
}

/** 0..1: how much of the place name the candidate's name carries (trips backfill nameScore, simplified). */
export function nameScore(placeName: string, candidateName: string): number {
	const q = new Set(tokens(placeName));
	const c = new Set(tokens(candidateName));
	if (q.size === 0 || c.size === 0) return 0;
	let shared = 0;
	for (const t of q) if (c.has(t)) shared++;
	return Math.round((0.8 * (shared / q.size) + 0.2 * (shared / c.size)) * 1000) / 1000;
}

function km(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
	const R = 6371;
	const dLat = ((b.lat - a.lat) * Math.PI) / 180;
	const dLon = ((b.lon - a.lon) * Math.PI) / 180;
	const s =
		Math.sin(dLat / 2) ** 2 +
		Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
	return 2 * R * Math.asin(Math.sqrt(s));
}

export interface StoredCandidate extends Candidate {
	score: number;
}

export interface Decision {
	status: LocationStatus;
	reason: NoMapReason | null;
	pick: StoredCandidate | null;
	candidates: StoredCandidate[];
}

/** The automatic rule, given search results for a place. Pure, so it is easy to test. */
export function decide(placeName: string, region: Region, found: Candidate[]): Decision {
	const candidates = found
		.map((c) => ({ ...c, score: nameScore(placeName, c.name) }))
		.sort((a, b) => b.score - a.score);
	const top = candidates[0];
	if (!top || top.score < WEAK) return { status: 'no_location', reason: 'not_found', pick: null, candidates };
	if (top.score >= STRONG) {
		const isArea = top.types.some((t) => AREA_TYPES.has(t));
		// A rival equally strong match somewhere else: a chain or a common name.
		const rival =
			!isArea &&
			candidates.some((c) => c !== top && c.score >= STRONG && c.score >= top.score - 0.05 && km(c, top) > SAME_SPOT_KM);
		if (rival) return { status: 'no_location', reason: 'several', pick: null, candidates };
		const near = km(top, CENTRES[region]) <= NEAR_KM;
		if (near || top.types.some((t) => OBVIOUS_TYPES.has(t))) {
			return { status: 'auto', reason: null, pick: top, candidates };
		}
	}
	return { status: 'needs_review', reason: null, pick: null, candidates };
}

// ── Reading ─────────────────────────────────────────────────────────────

export interface PlaceLocation {
	lat: number;
	lon: number;
	placeId: string | null;
	name: string;
	address: string;
}

/** The location shown on a place page: only auto or confirmed matches. */
export async function getShownLocation(canonicalId: number): Promise<PlaceLocation | null> {
	const res = await query<{ lat: number; lon: number; google_place_id: string | null; matched_name: string | null; address: string | null }>(
		`SELECT lat, lon, google_place_id, matched_name, address
		   FROM place_locations
		  WHERE entity_id = $1 AND status IN ('auto', 'confirmed') AND lat IS NOT NULL`,
		[canonicalId]
	);
	const r = res.rows[0];
	if (!r) return null;
	return { lat: r.lat, lon: r.lon, placeId: r.google_place_id, name: r.matched_name ?? '', address: r.address ?? '' };
}

interface PendingPlace {
	id: number;
	name: string;
	region: Region;
}

/**
 * Canonical places with an accepted mention that need a lookup: never
 * looked up, or renamed since an automatic (not admin-decided) lookup.
 */
async function pendingPlaces(limit: number | null): Promise<PendingPlace[]> {
	const res = await query<{ id: number; display_name: string; days: number; utah_days: number }>(
		`SELECT canon.id, canon.display_name,
		        COUNT(DISTINCT cd.id)::int AS days,
		        COUNT(DISTINCT cd.id) FILTER (WHERE ${UTAH_DAYS})::int AS utah_days
		   FROM entities canon
		   JOIN entities e ON COALESCE(e.alias_of_entity_id, e.id) = canon.id
		   JOIN day_entities de ON de.entity_id = e.id
		   JOIN calendar_days cd ON cd.id = de.day_id
		   LEFT JOIN place_locations pl ON pl.entity_id = canon.id
		  WHERE canon.entity_type = 'place'
		    AND canon.alias_of_entity_id IS NULL
		    AND cd.correction_status = 'accepted'
		    AND (pl.entity_id IS NULL
		         OR (pl.decided_by IS NULL AND pl.looked_up_name <> canon.display_name))
		  GROUP BY canon.id, canon.display_name
		  ORDER BY COUNT(DISTINCT cd.id) DESC, canon.display_name
		  LIMIT $1`,
		[limit]
	);
	return res.rows.map((r) => ({
		id: r.id,
		name: r.display_name,
		region: r.utah_days * 2 > r.days ? 'utah' : 'florida'
	}));
}

export async function countPending(): Promise<number> {
	return (await pendingPlaces(null)).length;
}

async function save(place: PendingPlace, d: Decision, queryText: string | null) {
	await query(
		`INSERT INTO place_locations
		   (entity_id, status, reason, lat, lon, google_place_id, matched_name, address, region,
		    query, looked_up_name, score, candidates, looked_up_at, decided_by, decided_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, NOW(), NULL, NULL)
		 ON CONFLICT (entity_id) DO UPDATE SET
		   status = EXCLUDED.status, reason = EXCLUDED.reason, lat = EXCLUDED.lat, lon = EXCLUDED.lon,
		   google_place_id = EXCLUDED.google_place_id, matched_name = EXCLUDED.matched_name,
		   address = EXCLUDED.address, region = EXCLUDED.region, query = EXCLUDED.query,
		   looked_up_name = EXCLUDED.looked_up_name, score = EXCLUDED.score,
		   candidates = EXCLUDED.candidates, looked_up_at = NOW(), decided_by = NULL, decided_at = NULL`,
		[
			place.id,
			d.status,
			d.reason,
			d.pick?.lat ?? null,
			d.pick?.lon ?? null,
			d.pick?.placeId ?? null,
			d.pick?.name ?? null,
			d.pick?.address ?? null,
			place.region,
			queryText,
			place.name,
			d.pick?.score ?? d.candidates[0]?.score ?? null,
			JSON.stringify(d.candidates)
		]
	);
}

/** Look up one place and store the automatic decision. Returns an error message, or null. */
async function lookUp(place: PendingPlace): Promise<string | null> {
	if (isGeneralName(place.name)) {
		await save(place, { status: 'no_location', reason: 'general', pick: null, candidates: [] }, null);
		return null;
	}
	const centre = CENTRES[place.region];
	const result = await searchPlaces(place.name, { ...centre, radiusM: BIAS_RADIUS_M });
	if (!result.ok) return result.error;
	await save(place, decide(place.name, place.region, result.candidates), place.name);
	return null;
}

// ── Runner ──────────────────────────────────────────────────────────────

export interface RunState {
	running: boolean;
	total: number;
	done: number;
	failed: number;
	lastError: string | null;
	startedAt: string | null;
	finishedAt: string | null;
}

const state: RunState = {
	running: false,
	total: 0,
	done: 0,
	failed: 0,
	lastError: null,
	startedAt: null,
	finishedAt: null
};

export function runState(): RunState {
	return { ...state };
}

/**
 * Look up pending places one at a time in the background. Only one run at a
 * time per server process; returns false when one is already running or no
 * key is configured.
 */
export async function startLookups(limit: number | null = null): Promise<boolean> {
	if (state.running || !(await isGeocodeConfigured())) return false;
	const places = await pendingPlaces(limit);
	Object.assign(state, {
		running: true,
		total: places.length,
		done: 0,
		failed: 0,
		lastError: null,
		startedAt: new Date().toISOString(),
		finishedAt: null
	});
	void (async () => {
		try {
			for (const p of places) {
				try {
					const err = await lookUp(p);
					if (err) {
						state.failed++;
						state.lastError = `${p.name}: ${err}`;
						console.error(`[PLACES] lookup failed for ${p.name}: ${err}`);
					}
				} catch (e) {
					state.failed++;
					state.lastError = `${p.name}: ${e instanceof Error ? e.message : String(e)}`;
					console.error('[PLACES] lookup error', e);
				}
				state.done++;
				if (!isGeocodeStub()) await new Promise((r) => setTimeout(r, GAP_MS));
			}
		} finally {
			state.running = false;
			state.finishedAt = new Date().toISOString();
		}
	})();
	return true;
}

let timer: ReturnType<typeof setInterval> | undefined;

/**
 * Hourly lookup of new places (at most 25 a run), started once from
 * hooks.server.ts. Off in the test environment unless
 * MADONNAHIST_PLACE_TIMER=1, so it never races a test script.
 */
export function startPlaceLookupTimer(): void {
	if (timer) return;
	if (env.MADONNAHIST_ENV === 'test' && env.MADONNAHIST_PLACE_TIMER !== '1') return;
	const tick = () => {
		startLookups(25).catch((e) => console.error('[PLACES] hourly lookup failed', e));
	};
	setTimeout(tick, 5 * 60_000).unref();
	timer = setInterval(tick, 60 * 60_000);
	timer.unref();
}

// ── Admin decisions ─────────────────────────────────────────────────────

export interface AdminRow {
	entityId: number;
	slug: string;
	name: string;
	days: number;
	firstYear: number;
	lastYear: number;
	status: LocationStatus | null;
	reason: NoMapReason | null;
	region: Region | null;
	lat: number | null;
	lon: number | null;
	placeId: string | null;
	matchedName: string | null;
	address: string | null;
	query: string | null;
	score: number | null;
	candidates: StoredCandidate[];
	renamed: boolean;
	decidedBy: string | null;
	decidedAt: string | null;
}

/** Every canonical place with an accepted mention, with its location row if any. */
export async function listForAdmin(): Promise<AdminRow[]> {
	const res = await query<{
		entity_id: number;
		slug: string;
		display_name: string;
		days: number;
		first_year: number;
		last_year: number;
		status: LocationStatus | null;
		reason: NoMapReason | null;
		region: Region | null;
		lat: number | null;
		lon: number | null;
		google_place_id: string | null;
		matched_name: string | null;
		address: string | null;
		query: string | null;
		score: number | null;
		candidates: StoredCandidate[] | null;
		looked_up_name: string | null;
		decided_by_name: string | null;
		decided_at: string | null;
	}>(
		`SELECT canon.id AS entity_id, canon.slug, canon.display_name,
		        COUNT(DISTINCT cd.id)::int AS days,
		        MIN(EXTRACT(YEAR FROM cd.entry_date))::int AS first_year,
		        MAX(EXTRACT(YEAR FROM cd.entry_date))::int AS last_year,
		        pl.status, pl.reason, pl.region, pl.lat, pl.lon, pl.google_place_id, pl.matched_name,
		        pl.address, pl.query, pl.score, pl.candidates, pl.looked_up_name,
		        u.display_name AS decided_by_name, pl.decided_at::text AS decided_at
		   FROM entities canon
		   JOIN entities e ON COALESCE(e.alias_of_entity_id, e.id) = canon.id
		   JOIN day_entities de ON de.entity_id = e.id
		   JOIN calendar_days cd ON cd.id = de.day_id
		   LEFT JOIN place_locations pl ON pl.entity_id = canon.id
		   LEFT JOIN users u ON u.id = pl.decided_by
		  WHERE canon.entity_type = 'place'
		    AND canon.alias_of_entity_id IS NULL
		    AND cd.correction_status = 'accepted'
		  GROUP BY canon.id, canon.slug, canon.display_name, pl.entity_id, u.display_name
		  ORDER BY COUNT(DISTINCT cd.id) DESC, canon.display_name`
	);
	return res.rows.map((r) => ({
		entityId: r.entity_id,
		slug: r.slug,
		name: r.display_name,
		days: r.days,
		firstYear: r.first_year,
		lastYear: r.last_year,
		status: r.status,
		reason: r.reason,
		region: r.region,
		lat: r.lat,
		lon: r.lon,
		placeId: r.google_place_id,
		matchedName: r.matched_name,
		address: r.address,
		query: r.query,
		score: r.score,
		candidates: r.candidates ?? [],
		renamed: r.looked_up_name !== null && r.looked_up_name !== r.display_name,
		decidedBy: r.decided_by_name,
		decidedAt: r.decided_at
	}));
}

export async function getRow(entityId: number) {
	const res = await query<{
		status: LocationStatus;
		reason: NoMapReason | null;
		lat: number | null;
		lon: number | null;
		google_place_id: string | null;
		matched_name: string | null;
		address: string | null;
		region: Region | null;
		query: string | null;
		candidates: StoredCandidate[];
		decided_by: number | null;
	}>(
		`SELECT status, reason, lat, lon, google_place_id, matched_name, address, region, query, candidates, decided_by
		   FROM place_locations WHERE entity_id = $1`,
		[entityId]
	);
	return res.rows[0] ?? null;
}

/** A canonical place with an accepted mention (the only ones admins act on), with its region. */
export async function getActionablePlace(entityId: number): Promise<PendingPlace | null> {
	const res = await query<{ id: number; display_name: string; days: number; utah_days: number }>(
		`SELECT canon.id, canon.display_name,
		        COUNT(DISTINCT cd.id)::int AS days,
		        COUNT(DISTINCT cd.id) FILTER (WHERE ${UTAH_DAYS})::int AS utah_days
		   FROM entities canon
		   JOIN entities e ON COALESCE(e.alias_of_entity_id, e.id) = canon.id
		   JOIN day_entities de ON de.entity_id = e.id
		   JOIN calendar_days cd ON cd.id = de.day_id
		  WHERE canon.id = $1 AND canon.entity_type = 'place' AND canon.alias_of_entity_id IS NULL
		    AND cd.correction_status = 'accepted'
		  GROUP BY canon.id, canon.display_name`,
		[entityId]
	);
	const r = res.rows[0];
	if (!r) return null;
	return { id: r.id, name: r.display_name, region: r.utah_days * 2 > r.days ? 'utah' : 'florida' };
}

/** Use one of the stored candidates: confirmed, shown. */
export async function chooseCandidate(entityId: number, index: number, userId: number): Promise<boolean> {
	const row = await getRow(entityId);
	const c = row?.candidates[index];
	if (!row || !c) return false;
	await query(
		`UPDATE place_locations
		    SET status = 'confirmed', reason = NULL, lat = $2, lon = $3, google_place_id = $4,
		        matched_name = $5, address = $6, score = $7, decided_by = $8, decided_at = NOW()
		  WHERE entity_id = $1`,
		[entityId, c.lat, c.lon, c.placeId, c.name, c.address, c.score, userId]
	);
	return true;
}

/** Approve the automatic match as is. */
export async function confirmAuto(entityId: number, userId: number): Promise<boolean> {
	const res = await query(
		`UPDATE place_locations SET status = 'confirmed', decided_by = $2, decided_at = NOW()
		  WHERE entity_id = $1 AND status = 'auto'`,
		[entityId, userId]
	);
	return (res.rowCount ?? 0) > 0;
}

export async function markNoMap(entityId: number, userId: number): Promise<boolean> {
	const res = await query(
		`UPDATE place_locations
		    SET status = 'no_location', reason = 'admin', lat = NULL, lon = NULL, google_place_id = NULL,
		        matched_name = NULL, address = NULL, decided_by = $2, decided_at = NOW()
		  WHERE entity_id = $1`,
		[entityId, userId]
	);
	return (res.rowCount ?? 0) > 0;
}

/** "Wrong": hide it and put it in Needs a look, keeping the candidates. */
export async function markWrong(entityId: number, userId: number): Promise<boolean> {
	const res = await query(
		`UPDATE place_locations
		    SET status = 'needs_review', reason = NULL, lat = NULL, lon = NULL, google_place_id = NULL,
		        matched_name = NULL, address = NULL, decided_by = $2, decided_at = NOW()
		  WHERE entity_id = $1`,
		[entityId, userId]
	);
	return (res.rowCount ?? 0) > 0;
}

/** Search with the admin's own words; stores fresh candidates for them to pick from. */
export async function searchAgain(
	place: PendingPlace,
	text: string,
	userId: number
): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
	const centre = CENTRES[place.region];
	const result = await searchPlaces(text, { ...centre, radiusM: BIAS_RADIUS_M });
	if (!result.ok) return result;
	const candidates = result.candidates
		.map((c) => ({ ...c, score: nameScore(place.name, c.name) }))
		.sort((a, b) => b.score - a.score);
	await query(
		`INSERT INTO place_locations (entity_id, status, region, query, looked_up_name, candidates, decided_by, decided_at)
		 VALUES ($1, 'needs_review', $2, $3, $4, $5::jsonb, $6, NOW())
		 ON CONFLICT (entity_id) DO UPDATE SET
		   status = 'needs_review', reason = NULL, lat = NULL, lon = NULL, google_place_id = NULL,
		   matched_name = NULL, address = NULL, score = NULL, region = EXCLUDED.region,
		   query = EXCLUDED.query, looked_up_name = EXCLUDED.looked_up_name,
		   candidates = EXCLUDED.candidates, looked_up_at = NOW(),
		   decided_by = EXCLUDED.decided_by, decided_at = NOW()`,
		[place.id, place.region, text, place.name, JSON.stringify(candidates), userId]
	);
	return { ok: true, count: candidates.length };
}

/** Undo: forget everything about this place and look it up again now. */
export async function lookUpAgain(place: PendingPlace): Promise<string | null> {
	await query(`DELETE FROM place_locations WHERE entity_id = $1`, [place.id]);
	return lookUp(place);
}
