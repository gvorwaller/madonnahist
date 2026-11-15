/**
 * The automatic place-matching rule (td-085e19). Pure: no database, no
 * network, so it can be tested and re-run over stored Google results.
 *
 * Revised 2026-11-14 after the first production run showed chains and
 * one-word names shown with wrong maps (K-Mart → "K Beauty Mart", Penney →
 * a retirement community, Dairy Queen → one of many):
 *   - A strong match must carry the place's name as a whole phrase
 *     ("Hanna Park" in "Kathryn Abbey Hanna Park"), not just share words.
 *     Spacing and hyphens don't matter ("K-Mart" = "Kmart", "River Walk" =
 *     "Riverwalk").
 *   - Any second strong match somewhere else means a chain or a common
 *     name: no map. Two towns of the same name go to Needs a look.
 *   - A one-word name is shown automatically only when Google's name is
 *     exactly that word, or it is a nearby town/area or natural feature.
 *   - Far from Utah/Florida, only states, countries, and multi-word town
 *     names are shown automatically; everything else waits for a look.
 *   - Streets ("Windy Hill Lane") never match a place unless the place
 *     name is itself an address.
 *
 * Bump RULE_VERSION whenever decide() changes: rows decided automatically
 * under an older version are re-decided from their stored candidates
 * (no new Google calls). Admin decisions are never touched.
 */

export const RULE_VERSION = 2;

export type Region = 'utah' | 'florida';
export type LocationStatus = 'auto' | 'confirmed' | 'needs_review' | 'no_location';
export type NoMapReason = 'general' | 'several' | 'not_found' | 'admin';

export interface Candidate {
	name: string;
	address: string;
	lat: number;
	lon: number;
	placeId: string | null;
	types: string[];
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

export const CENTRES: Record<Region, { lat: number; lon: number }> = {
	utah: { lat: 40.7608, lon: -111.891 }, // Salt Lake City
	florida: { lat: 30.3322, lon: -81.6557 } // Jacksonville
};
export const NEAR_KM = 150;
const WEAK = 0.5;
const SAME_SPOT_KM = 2;

// Towns, states, countries, neighbourhoods.
const AREA_TYPES = new Set([
	'locality',
	'administrative_area_level_1',
	'administrative_area_level_2',
	'country',
	'colloquial_area',
	'neighborhood',
	'sublocality',
	'sublocality_level_1'
]);
// Far-away matches shown without a look: states and countries (a town needs two words).
const WIDE_AREA_TYPES = new Set(['administrative_area_level_1', 'country']);
const STREET_TYPES = new Set(['route', 'street_address', 'intersection']);
// Kinds of business that come in chains.
const BUSINESS_TYPES = new Set([
	'restaurant', 'food', 'cafe', 'bar', 'bakery', 'meal_takeaway', 'meal_delivery', 'store',
	'supermarket', 'grocery_or_supermarket', 'department_store', 'clothing_store', 'shoe_store',
	'convenience_store', 'gas_station', 'lodging', 'pharmacy', 'drugstore', 'home_goods_store',
	'furniture_store', 'hardware_store', 'electronics_store', 'book_store', 'car_dealer', 'bank'
]);

// Words that never identify one spot on their own.
const GENERIC_WORDS = new Set([
	'a', 'the', 'my', 'our', 'beach', 'house', 'home', 'mall', 'park', 'church', 'chapel', 'temple',
	'library', 'school', 'store', 'stores', 'shop', 'work', 'office', 'seminary', 'hospital', 'doctor',
	'dentist', 'lake', 'pool', 'gym', 'market', 'restaurant', 'ward', 'stake', 'center', 'centre',
	'building', 'class', 'camp', 'cabin', 'farm', 'river', 'downtown', 'airport',
	'station', 'apartment', 'apartments', 'motel', 'hotel', 'bank', 'post', 'gas', 'job', 'clinic',
	'theater', 'theatre', 'movies', 'show', 'party', 'meeting', 'yard', 'garden', 'kitchen', 'cafeteria',
	'institute', 'college', 'university', 'grocery', 'groceries', 'cemetery', 'mountains', 'mountain',
	'canyon', 'zoo', 'museum', 'beach house', 'school house',
	// Added 2026-11-14 ("Mini Mall", "game room", "Family restaurant", "Christmas tree lot").
	'mini', 'game', 'room', 'family', 'christmas', 'tree', 'lot', 'fountain', 'nursery', 'bookstore',
	'playground', 'pond', 'trail', 'field', 'court', 'courts', 'rink', 'arcade', 'bowling', 'skating'
]);

const US_STATES: Record<string, string> = {
	alabama: 'al', alaska: 'ak', arizona: 'az', arkansas: 'ar', california: 'ca', colorado: 'co',
	connecticut: 'ct', delaware: 'de', florida: 'fl', georgia: 'ga', hawaii: 'hi', idaho: 'id',
	illinois: 'il', indiana: 'in', iowa: 'ia', kansas: 'ks', kentucky: 'ky', louisiana: 'la',
	maine: 'me', maryland: 'md', massachusetts: 'ma', michigan: 'mi', minnesota: 'mn',
	mississippi: 'ms', missouri: 'mo', montana: 'mt', nebraska: 'ne', nevada: 'nv',
	newhampshire: 'nh', newjersey: 'nj', newmexico: 'nm', newyork: 'ny', northcarolina: 'nc',
	northdakota: 'nd', ohio: 'oh', oklahoma: 'ok', oregon: 'or', pennsylvania: 'pa',
	rhodeisland: 'ri', southcarolina: 'sc', southdakota: 'sd', tennessee: 'tn', texas: 'tx',
	utah: 'ut', vermont: 'vt', virginia: 'va', washington: 'wa', westvirginia: 'wv',
	wisconsin: 'wi', wyoming: 'wy'
};

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

/** 0..1: how much of the place name the candidate's name carries. Shown to the admin and used for ordering. */
export function nameScore(placeName: string, candidateName: string): number {
	const q = new Set(tokens(placeName));
	const c = new Set(tokens(candidateName));
	if (q.size === 0 || c.size === 0) return 0;
	let shared = 0;
	for (const t of q) if (c.has(t)) shared++;
	return Math.round((0.8 * (shared / q.size) + 0.2 * (shared / c.size)) * 1000) / 1000;
}

// Words an official name adds inside a familiar one: "Salt Lake (Utah) Temple",
// "Salt Lake (City) Tabernacle", "Utah Lake (State) Park".
const FILLER_WORDS = new Set(['city', 'utah', 'ut', 'florida', 'fl', 'state', 'county', 'of', 'and']);

/**
 * True when `phrase` appears in `text` as a run of whole words, ignoring
 * spacing ("K-Mart" in "Kmart #4021") and filler words an official name
 * adds ("Salt Lake Temple" in "Salt Lake Utah Temple").
 */
export function containsPhrase(text: string, phrase: string): boolean {
	const want = tokens(phrase).join('');
	if (!want) return false;
	const t = tokens(text);
	for (let i = 0; i < t.length; i++) {
		let joined = '';
		for (let j = i; j < t.length && joined.length < want.length; j++) {
			// Skip a filler word in the middle, unless the phrase itself continues with it.
			if (j > i && FILLER_WORDS.has(t[j]) && !want.startsWith(joined + t[j])) continue;
			joined += t[j];
			if (joined === want) return true;
			if (!want.startsWith(joined)) break;
		}
	}
	return false;
}

/** "Provo, Utah" → head "Provo" + tail "Utah"; the tail must agree with the address. */
function splitPlace(name: string): { head: string; tail: string | null } {
	const i = name.indexOf(',');
	if (i <= 0) return { head: name, tail: null };
	const tail = name.slice(i + 1).trim();
	return { head: name.slice(0, i).trim(), tail: tail || null };
}

function tailAgrees(tail: string, c: Candidate): boolean {
	const where = `${c.name}, ${c.address}`;
	if (containsPhrase(where, tail)) return true;
	const abbr = US_STATES[tokens(tail).join('')];
	return !!abbr && containsPhrase(where, abbr);
}

const compact = (s: string) => tokens(s).join('');

function isStrong(placeName: string, c: StoredCandidate): boolean {
	if (c.types.some((t) => STREET_TYPES.has(t)) && !/^\d/.test(placeName.trim())) return false;
	const { head, tail } = splitPlace(placeName);
	if (!containsPhrase(c.name, head)) return false;
	// The phrase must also be a real word match, not letters run together
	// inside another word ("Fun Day" is not "Sidewalk Funday Inc").
	if (c.score < WEAK && compact(c.name) !== compact(head) && nameScore(head, c.name) < WEAK) return false;
	return tail === null || tailAgrees(tail, c);
}

export function km(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
	const R = 6371;
	const dLat = ((b.lat - a.lat) * Math.PI) / 180;
	const dLon = ((b.lon - a.lon) * Math.PI) / 180;
	const s =
		Math.sin(dLat / 2) ** 2 +
		Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
	return 2 * R * Math.asin(Math.sqrt(s));
}

const isArea = (c: Candidate) => c.types.some((t) => AREA_TYPES.has(t));
const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/**
 * Re-decide a stored automatic row under the current rule, from the
 * candidates saved with it (no Google call). A name that is now a general
 * word gets no map.
 */
export function redecide(placeName: string, region: Region, stored: Candidate[]): Decision {
	if (isGeneralName(placeName)) return { status: 'no_location', reason: 'general', pick: null, candidates: [] };
	return decide(
		placeName,
		region,
		stored.map((c) => ({
			name: c.name,
			address: c.address,
			lat: c.lat,
			lon: c.lon,
			placeId: c.placeId,
			types: c.types ?? []
		}))
	);
}

/** The automatic rule, given search results for a place (in Google's order). */
export function decide(placeName: string, region: Region, found: Candidate[]): Decision {
	const candidates: StoredCandidate[] = found
		.map((c, i) => ({ c: { ...c, score: nameScore(placeName, c.name) }, i }))
		.sort((a, b) => b.c.score - a.c.score || a.i - b.i)
		.map((x) => x.c);
	const strong = candidates.filter((c) => isStrong(placeName, c));
	const review: Decision = { status: 'needs_review', reason: null, pick: null, candidates };

	const top = strong[0];
	if (!top) {
		return candidates.some((c) => c.score >= WEAK)
			? review
			: { status: 'no_location', reason: 'not_found', pick: null, candidates };
	}

	// Home ground is near either home: a Florida place mentioned in the Utah
	// years (or the reverse) is still home, not a trip.
	const nearHome = (c: Candidate) => km(c, CENTRES.utah) <= NEAR_KM || km(c, CENTRES.florida) <= NEAR_KM;
	const near = nearHome(top) || km(top, CENTRES[region]) <= NEAR_KM;

	// A second strong match somewhere else. Near home, only rivals near home
	// count: the search is centred there, so a local chain shows its local
	// branches, while a famous namesake far away doesn't make a local place
	// ambiguous.
	// Businesses: two branches of the same name are a chain however close
	// together they are (five downtown Starbucks).
	const business = (c: Candidate) => c.types.some((t) => BUSINESS_TYPES.has(t));
	const rivals = strong.filter(
		(c) =>
			c !== top &&
			(c.placeId === null || c.placeId !== top.placeId) &&
			(!near || nearHome(c)) &&
			(km(c, top) > SAME_SPOT_KM || (business(top) && business(c)))
	);
	if (rivals.length > 0) {
		if (isArea(top) && rivals.some(isArea)) return review; // two towns of the same name
		if (!isArea(top)) return { status: 'no_location', reason: 'several', pick: null, candidates };
	}

	const { head, tail } = splitPlace(placeName);
	// "Mobile, Alabama" names its state, so it is not a bare one-word name.
	const oneWord = tail === null && wordCount(head) === 1;
	const exact = compact(top.name) === compact(head);

	if (near) {
		if (oneWord && !exact && !isArea(top) && !top.types.includes('natural_feature')) return review;
		return { status: 'auto', reason: null, pick: top, candidates };
	}
	// Far away (a trip): states and countries, or a town whose name is more
	// than one bare word ("Las Vegas", "Mobile, Alabama"). Not "Franklin".
	if (top.types.some((t) => WIDE_AREA_TYPES.has(t)) || (top.types.includes('locality') && !oneWord)) {
		return { status: 'auto', reason: null, pick: top, candidates };
	}
	return review;
}
