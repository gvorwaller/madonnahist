import { json } from '@sveltejs/kit';
import { placeDetails, reverseGeocode, type Spot } from '$lib/server/geocode';
import { getActionablePlace, searchForPicker } from '$lib/server/places';
import type { RequestHandler } from './$types';

/**
 * The admin map picker's lookups (td-085e19), all server-side with the
 * server key:
 *   { entity_id, q }   search, biased toward the place's home area
 *   { lat, lon }       the address nearest a dropped pin
 *   { place_id }       a business tapped on the map
 * Nothing is saved here; "Save this location" posts the ?/pin action.
 */

const MAX_QUERY = 200;
const PLACE_ID = /^[A-Za-z0-9_-]{1,300}$/;

const spotJson = (s: Spot) => ({ name: s.name, address: s.address, lat: s.lat, lon: s.lon, placeId: s.placeId });

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user || locals.user.role !== 'admin') return json({ error: 'Admin access required' }, { status: 403 });

	let body: Record<string, unknown>;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid request' }, { status: 400 });
	}

	if (typeof body.q === 'string') {
		const text = body.q.trim().slice(0, MAX_QUERY);
		const entityId = Number(body.entity_id);
		if (!text) return json({ error: 'Type what to search for.' }, { status: 400 });
		if (!Number.isInteger(entityId) || entityId <= 0) return json({ error: 'Missing place' }, { status: 400 });
		const place = await getActionablePlace(entityId);
		if (!place) return json({ error: 'That place has no transcribed days.' }, { status: 404 });
		const r = await searchForPicker(place, text);
		if (!r.ok) return json({ error: `Search failed: ${r.error}` }, { status: 502 });
		return json({ results: r.candidates.map(spotJson) });
	}

	if (typeof body.place_id === 'string') {
		if (!PLACE_ID.test(body.place_id)) return json({ error: 'Invalid place' }, { status: 400 });
		const r = await placeDetails(body.place_id);
		if (!r.ok) return json({ error: `Lookup failed: ${r.error}` }, { status: 502 });
		return json({ spot: r.spot ? spotJson(r.spot) : null });
	}

	const lat = Number(body.lat);
	const lon = Number(body.lon);
	if (body.lat !== undefined && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
		const r = await reverseGeocode(lat, lon);
		if (!r.ok) return json({ error: `Lookup failed: ${r.error}` }, { status: 502 });
		return json({ spot: r.spot ? spotJson(r.spot) : null });
	}

	return json({ error: 'Provide a search, a point, or a place.' }, { status: 400 });
};
