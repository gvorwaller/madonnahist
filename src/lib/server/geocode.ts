/**
 * Google Places text search for place entities (td-085e19). Ported from
 * the trips app (trips/src/lib/server/geocode.ts `placesTextSearch`), with
 * two changes: it keeps the top five results (so an admin can pick another
 * one), and it always sends a region and location bias.
 *
 * Key: private_data.api_credentials ('google_maps', 'GEOCODING_KEY'), else
 * env GOOGLE_GEOCODING_KEY (the same key trips/birds/gaylonphotos use).
 *
 * Stub mode: MADONNAHIST_GEOCODE_STUB=1 returns canned results from
 * STUB_RESULTS below and never touches the network. Like
 * MADONNAHIST_LLM_STUB, it must be set before the server process starts.
 */
import { env } from '$env/dynamic/private';
import { credentialService } from '$lib/credentials';

export interface Candidate {
	name: string;
	address: string;
	lat: number;
	lon: number;
	placeId: string | null;
	types: string[];
}

export type SearchResult =
	| { ok: true; candidates: Candidate[] }
	| { ok: false; error: string };

const MAX_CANDIDATES = 5;
const TIMEOUT_MS = 10_000;

export function isGeocodeStub(): boolean {
	return env.MADONNAHIST_GEOCODE_STUB === '1';
}

async function getKey(): Promise<string | null> {
	const stored = await credentialService.getCredential('google_maps', 'GEOCODING_KEY');
	return stored || env.GOOGLE_GEOCODING_KEY || null;
}

/** True when lookups can run: a key is available, or the test stub is on. */
export async function isGeocodeConfigured(): Promise<boolean> {
	if (isGeocodeStub()) return true;
	return (await getKey()) !== null;
}

/**
 * Text search biased toward `near` (lat/lon, radius in metres) within the US.
 * A bias, not a limit: an obvious place far away (a vacation spot) can still
 * come back first.
 */
export async function searchPlaces(
	text: string,
	near: { lat: number; lon: number; radiusM: number }
): Promise<SearchResult> {
	const q = text.trim().slice(0, 200);
	if (!q) return { ok: true, candidates: [] };
	if (isGeocodeStub()) return { ok: true, candidates: stubSearch(q) };

	const key = await getKey();
	if (!key) return { ok: false, error: 'No Google key configured' };

	const params = new URLSearchParams({
		query: q,
		location: `${near.lat},${near.lon}`,
		radius: String(near.radiusM),
		region: 'us',
		key
	});
	let data: {
		status?: string;
		error_message?: string;
		results?: Array<{
			name?: string;
			formatted_address?: string;
			place_id?: string;
			types?: string[];
			geometry?: { location?: { lat?: number; lng?: number } };
		}>;
	};
	try {
		const res = await fetch(`https://maps.googleapis.com/maps/api/place/textsearch/json?${params}`, {
			signal: AbortSignal.timeout(TIMEOUT_MS)
		});
		if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
		data = await res.json();
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : 'request failed' };
	}
	if (data.status === 'ZERO_RESULTS') return { ok: true, candidates: [] };
	if (data.status !== 'OK') {
		return { ok: false, error: `${data.status ?? 'unknown'}${data.error_message ? `: ${data.error_message}` : ''}` };
	}
	const candidates: Candidate[] = [];
	for (const r of data.results ?? []) {
		const lat = r.geometry?.location?.lat;
		const lon = r.geometry?.location?.lng;
		if (typeof lat !== 'number' || typeof lon !== 'number') continue;
		candidates.push({
			name: r.name ?? r.formatted_address ?? q,
			address: r.formatted_address ?? '',
			lat,
			lon,
			placeId: r.place_id ?? null,
			types: r.types ?? []
		});
		if (candidates.length >= MAX_CANDIDATES) break;
	}
	return { ok: true, candidates };
}

// ── Test stub ────────────────────────────────────────────────────────────
// Keyed by the lowercased query. Jacksonville ≈ 30.33,-81.66; Salt Lake City
// ≈ 40.76,-111.89. scripts/test-places.mjs relies on these exact entries.
const JAX = { lat: 30.3322, lon: -81.6557 };
const SLC = { lat: 40.7608, lon: -111.891 };
const c = (
	name: string,
	at: { lat: number; lon: number },
	dLat: number,
	dLon: number,
	types: string[],
	address: string,
	placeId: string
): Candidate => ({ name, address, lat: at.lat + dLat, lon: at.lon + dLon, placeId, types });

const STUB_RESULTS: Record<string, Candidate[]> = {
	'zqxmap riverside park': [
		c('Zqxmap Riverside Park', JAX, 0.01, 0.01, ['park'], 'Jacksonville, FL, USA', 'stub-riverside')
	],
	'zqxmap canyon': [c('Zqxmap Canyon', SLC, 0.05, 0.08, ['natural_feature'], 'Salt Lake County, UT, USA', 'stub-canyon')],
	'zqxmap burgerbarn': [
		c('Zqxmap Burgerbarn', JAX, 0.02, 0.0, ['restaurant'], '1 Main St, Jacksonville, FL, USA', 'stub-bb-1'),
		c('Zqxmap Burgerbarn', JAX, -0.1, 0.05, ['restaurant'], '9 Beach Blvd, Jacksonville Beach, FL, USA', 'stub-bb-2')
	],
	'zqxmap cove landing': [
		c('Zqxmap Cove Marina', JAX, 0.03, 0.03, ['marina'], 'Jacksonville, FL, USA', 'stub-cove-1')
	],
	'zqxmap cove landing, jacksonville fl': [
		c('Zqxmap Cove Landing', JAX, 0.04, 0.02, ['point_of_interest'], 'Cove Rd, Jacksonville, FL, USA', 'stub-cove-2')
	],
	'zqxmap outlet': [
		c('Zqxmap Outlet', { lat: 47.6, lon: -122.33 }, 0, 0, ['store'], 'Seattle, WA, USA', 'stub-outlet')
	],
	'zqxmap falls': [
		c('Zqxmap Falls', { lat: 44.42, lon: -110.58 }, 0, 0, ['natural_feature'], 'Wyoming, USA', 'stub-falls')
	],
	'zqxmap renamed spot': [
		c('Zqxmap Renamed Spot', JAX, 0.02, -0.02, ['point_of_interest'], 'Jacksonville, FL, USA', 'stub-renamed')
	]
};

function stubSearch(q: string): Candidate[] {
	return STUB_RESULTS[q.toLowerCase()] ?? [];
}
