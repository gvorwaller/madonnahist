// Unit test for the automatic place-matching rule (td-085e19),
// src/lib/server/place-rules.ts. No database, no server, no Google.
//
// The cases are shaped like the first production run (2026-11-14), where
// the v1 rule showed chains and one-word names with wrong maps. Names and
// addresses mirror what Google returned; coordinates are close enough for
// the distance rules.
//
// Usage: npm run test:place-rules

import { containsPhrase, decide, isGeneralName, redecide, type Candidate, type Region } from '../src/lib/server/place-rules';

const SLC = { lat: 40.7608, lon: -111.891 };
const JAX = { lat: 30.3322, lon: -81.6557 };

function at(base: { lat: number; lon: number }, dLat: number, dLon: number) {
	return { lat: base.lat + dLat, lon: base.lon + dLon };
}
function cand(name: string, where: { lat: number; lon: number }, types: string[], address = '', placeId: string | null = null): Candidate {
	return { name, address, ...where, placeId: placeId ?? `id-${name}-${where.lat.toFixed(3)}`, types };
}

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail = '') {
	if (ok) pass++;
	else fail++;
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `  (${detail})`}`);
}
function expect(label: string, name: string, region: Region, found: Candidate[], status: string, reason: string | null = null) {
	const d = decide(name, region, found);
	check(label, d.status === status && d.reason === reason, `${d.status}/${d.reason}`);
}

const STORE = ['establishment', 'point_of_interest', 'store'];
const FOOD = ['establishment', 'food', 'point_of_interest', 'restaurant'];
const CAFE = ['cafe', 'establishment', 'food', 'point_of_interest', 'store'];

// ── Phrases ──
check('phrase: "Hanna Park" in "Kathryn Abbey Hanna Park"', containsPhrase('Kathryn Abbey Hanna Park', 'Hanna Park'));
check('phrase: "K-Mart" equals "Kmart"', containsPhrase('Kmart', 'K-Mart'));
check('phrase: "K-Mart" is not in "K Beauty Mart"', !containsPhrase('K Beauty Mart', 'K-Mart'));
check('phrase: "Salt Lake Temple" in "Salt Lake Utah Temple" (filler word)', containsPhrase('Salt Lake Utah Temple', 'Salt Lake Temple'));
check('phrase: "Utah Lake Park" in "Utah Lake State Park"', containsPhrase('Utah Lake State Park', 'Utah Lake Park'));
check('phrase: "Salt Lake City" keeps its own "City"', containsPhrase('Salt Lake City', 'Salt Lake City'));
check('phrase: "Provo Water Works" not in "Western Water Works Supply - Provo Branch"', !containsPhrase('Western Water Works Supply Company - Provo Branch', 'Provo Water Works'));

// ── General words ──
check('general: "Mini Mall"', isGeneralName('Mini Mall'));
check('general: "game room"', isGeneralName('game room'));
check('general: "Family restaurant"', isGeneralName('Family restaurant'));
check('general: "Christmas tree lot"', isGeneralName('Christmas tree lot'));
check('general: "Grandma\'s"', isGeneralName("Grandma's"));
check('not general: "Hanna Park"', !isGeneralName('Hanna Park'));

// ── Shown automatically (stay right) ──
expect('Hanna Park → auto', 'Hanna Park', 'florida', [cand('Kathryn Abbey Hanna Park', at(JAX, 0.06, 0.25), ['park', 'point_of_interest'])], 'auto');
expect('Salt Lake Temple → auto (official name adds "Utah")', 'Salt Lake Temple', 'utah', [cand('Salt Lake Utah Temple', at(SLC, 0.01, 0), ['church', 'place_of_worship'])], 'auto');
expect('Mill Creek Canyon → auto (Millcreek spellings are one place)', 'Mill Creek Canyon', 'utah', [
	cand('Mill Creek Canyon', at(SLC, -0.07, 0.14), ['natural_feature', 'establishment']),
	cand('Millcreek Canyon', at(SLC, -0.07, 0.12), ['point_of_interest', 'establishment'])
], 'auto');
expect('Provo, Utah → auto (state agrees)', 'Provo, Utah', 'utah', [cand('Provo', at(SLC, -0.53, 0.23), ['locality', 'political'], 'Provo, UT')], 'auto');
expect('Mobile, Alabama → auto (far, but names its state)', 'Mobile, Alabama', 'utah', [cand('Mobile', { lat: 30.69, lon: -88.04 }, ['locality', 'political'], 'Mobile, AL')], 'auto');
expect('Jacksonville in the Utah years → auto (home, either one)', 'Jacksonville', 'utah', [cand('Jacksonville', JAX, ['locality', 'political'], 'Jacksonville, FL')], 'auto');
expect('Las Vegas → auto (far two-word town)', 'Las Vegas', 'utah', [cand('Las Vegas', { lat: 36.17, lon: -115.14 }, ['locality', 'political'], 'Las Vegas, NV')], 'auto');
expect('Portugal → auto (country)', 'Portugal', 'utah', [cand('Portugal', { lat: 39.4, lon: -8.2 }, ['country', 'political'])], 'auto');
expect('an address spelled the same may match a street address', '920 N 500 W', 'utah', [cand('920 N 500 W', at(SLC, -0.53, 0.23), ['street_address'], '920 N 500 W, Provo, UT')], 'auto');
expect('"500 West" vs "500 W" → needs a look (address spellings vary)', '920 N 500 West', 'utah', [cand('920 N 500 W', at(SLC, -0.53, 0.23), ['street_address'], '920 N 500 W, Provo, UT')], 'needs_review');

// ── Chains: no map ──
expect('Dairy Queen (two branches) → several', 'Dairy Queen', 'utah', [
	cand('Dairy Queen', at(SLC, -0.08, 0.06), FOOD),
	cand('Dairy Queen Grill & Chill', at(SLC, -0.2, -0.05), FOOD)
], 'no_location', 'several');
expect('Starbucks (five downtown, all within 2 km) → several', 'Starbucks', 'utah', [
	cand('Starbucks', at(SLC, -0.006, 0.006), CAFE),
	cand('Starbucks Coffee Company', at(SLC, -0.008, -0.004), CAFE),
	cand('Starbucks Coffee Company', at(SLC, -0.003, 0.0), CAFE)
], 'no_location', 'several');
expect('K-Mart (Kmart stores; "K Beauty Mart" is not one) → several', 'K-Mart', 'florida', [
	cand('K Beauty Mart', { lat: 29.65, lon: -82.32 }, STORE),
	cand('Kmart', at(JAX, 0.05, 0.1), ['department_store', 'store']),
	cand('Kmart', at(JAX, -0.15, 0.02), ['department_store', 'store'])
], 'no_location', 'several');
expect('a local place with a famous namesake far away → auto', 'Lake View Motel', 'florida', [
	cand('Lake View Motel', { lat: 29.43, lon: -81.51 }, ['lodging']),
	cand('Lake View Motel', { lat: 44.0, lon: -73.0 }, ['lodging'])
], 'auto');

// ── Needs a look ──
expect('Penney → needs a look (one word inside a longer name)', 'Penney', 'florida', [cand('Penney Retirement Community', at(JAX, -0.33, 0.0), ['point_of_interest'])], 'needs_review');
expect('Diamond (one business) → needs a look', 'Diamond', 'florida', [cand('Diamond Billiards', at(JAX, -0.06, 0.03), ['point_of_interest'])], 'needs_review');
expect('Franklin, far → needs a look (one-word town)', 'Franklin', 'florida', [cand('Franklin', { lat: 35.92, lon: -86.87 }, ['locality', 'political'], 'Franklin, TN')], 'needs_review');
expect('Deer Creek Lake in Ohio → needs a look (far, not a town)', 'Deer Creek Lake', 'utah', [cand('Deer Creek Lake', { lat: 39.62, lon: -83.22 }, ['natural_feature'])], 'needs_review');
expect('Lakeland, two towns → needs a look', 'Lakeland', 'florida', [
	cand('Lakeland', { lat: 31.04, lon: -83.07 }, ['locality', 'political'], 'Lakeland, GA'),
	cand('Lakeland', { lat: 28.04, lon: -81.95 }, ['locality', 'political'], 'Lakeland, FL')
], 'needs_review');
expect('Seventh Ward (a New Orleans neighborhood) → needs a look', 'Seventh Ward', 'florida', [cand('Seventh Ward', { lat: 29.97, lon: -90.07 }, ['neighborhood', 'political'], 'Seventh Ward, New Orleans, LA')], 'needs_review');
expect('Windy Hill is not a street (Windy Hill Lane) → needs a look', 'Windy Hill', 'florida', [cand('Windy Hill Lane', at(JAX, 0.1, -0.3), ['route'])], 'needs_review');
expect('West Valley Fair Mall → not a cinema inside it', 'West Valley Fair Mall', 'utah', [cand('Megaplex West Valley City at Valley Fair Mall', at(SLC, -0.06, -0.09), ['movie_theater'])], 'needs_review');
expect('Fun Day ≠ "Sidewalk Funday Inc"', 'Fun Day', 'florida', [cand('Sidewalk Funday Inc', at(JAX, 0, 0.01), ['point_of_interest'])], 'no_location', 'not_found');

// ── Re-deciding a stored row ──
const r = redecide('Mini Mall', 'utah', [cand('Hill AFB Mini Mall', { lat: 41.12, lon: -111.97 }, ['shopping_mall'])]);
check('redecide: a now-general name gets no map', r.status === 'no_location' && r.reason === 'general');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
