/**
 * Map and directions deep links for a place (td-085e19), ported from the
 * trips app (trips/src/lib/maplinks.ts). Plain URLs: no map scripts, no
 * browser key. A Google place id makes the Google links exact.
 */

export interface MapPlace {
	name: string;
	lat: number;
	lon: number;
	placeId?: string | null;
}

const coords = (p: MapPlace) => `${p.lat},${p.lon}`;

/** "Map": Google Maps, by place id when known, else by coordinates. */
export function googleMapsLink(p: MapPlace): string {
	const base = 'https://www.google.com/maps/search/?api=1';
	if (p.placeId) {
		return `${base}&query=${encodeURIComponent(p.name || coords(p))}&query_place_id=${encodeURIComponent(p.placeId)}`;
	}
	return `${base}&query=${encodeURIComponent(coords(p))}`;
}

/** Apple Maps; the https form opens the Maps app on iPhone and iPad. */
export function appleMapsLink(p: MapPlace): string {
	const params = new URLSearchParams();
	if (p.name) params.set('q', p.name);
	params.set('ll', coords(p));
	return `https://maps.apple.com/?${params.toString()}`;
}

/** Directions from wherever the reader is now (Google). */
export function googleDirectionsLink(p: MapPlace): string {
	const base = 'https://www.google.com/maps/dir/?api=1';
	if (p.placeId) {
		return `${base}&destination=${encodeURIComponent(p.name || coords(p))}&destination_place_id=${encodeURIComponent(p.placeId)}`;
	}
	return `${base}&destination=${encodeURIComponent(coords(p))}`;
}
