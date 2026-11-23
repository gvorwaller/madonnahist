import { query } from '$lib/db';
import { getBrowserMapConfig, isGeocodeConfigured } from '$lib/server/geocode';
import {
	chooseCandidate,
	confirmAuto,
	countPending,
	getActionablePlace,
	getRow,
	listForAdmin,
	lookUpAgain,
	markNoMap,
	markWrong,
	runState,
	regionCentre,
	searchAgain,
	setPin,
	startLookups
} from '$lib/server/places';
import { error, fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

/**
 * /admin/places — place map locations (td-085e19).
 *
 * Lookups run automatically (hourly, plus "Look up new places"); confident
 * matches show on place pages without anyone approving them. This page is
 * for the exceptions: weaker matches wait in "Needs a look", and anything
 * shown automatically can be marked wrong. Every decision writes audit_log.
 */

const MAX_QUERY = 200;
const MAX_LABEL = 300;
const PLACE_ID = /^[A-Za-z0-9_-]{1,300}$/;

function requireAdmin(locals: App.Locals): number {
	if (!locals.user || locals.user.role !== 'admin') error(403, 'Admin access required');
	return Number(locals.user.id);
}

/** entity_id 0 marks a run rather than one place (same as /admin/about). */
async function audit(userId: number, action: string, entityId: number, before: unknown, after: unknown, description: string) {
	await query(
		`INSERT INTO audit_log (user_id, action, entity_type, entity_id, before_value, after_value, description)
		 VALUES ($1, $2, 'place_locations', $3, $4::jsonb, $5::jsonb, $6)`,
		[
			userId,
			action,
			entityId,
			before === null || before === undefined ? null : JSON.stringify(before),
			after === null || after === undefined ? null : JSON.stringify(after),
			description
		]
	);
}

function entityIdFrom(data: FormData): number | null {
	const n = Number(data.get('entity_id'));
	return Number.isInteger(n) && n > 0 ? n : null;
}

export const load: PageServerLoad = async ({ locals, depends }) => {
	requireAdmin(locals);
	depends('admin:places');
	const [rows, pending, configured, maps] = await Promise.all([
		listForAdmin(),
		countPending(),
		isGeocodeConfigured(),
		getBrowserMapConfig()
	]);
	return {
		rows,
		pending,
		configured,
		maps,
		centres: { utah: regionCentre('utah'), florida: regionCentre('florida') },
		run: runState()
	};
};

/** Shared shape for the per-place actions: admin, a real actionable place, an audit row. */
async function onPlace(
	request: Request,
	locals: App.Locals,
	act: (
		place: NonNullable<Awaited<ReturnType<typeof getActionablePlace>>>,
		data: FormData,
		userId: number
	) => Promise<{ ok: boolean; message: string; action: string; error?: string }>
) {
	const userId = requireAdmin(locals);
	const data = await request.formData();
	const entityId = entityIdFrom(data);
	if (entityId === null) return fail(400, { error: 'Missing place' });
	const place = await getActionablePlace(entityId);
	if (!place) return fail(404, { error: 'That place has no transcribed days.' });
	const before = await getRow(entityId);
	const result = await act(place, data, userId);
	if (!result.ok) return fail(409, { error: result.error ?? 'That change could not be made.' });
	const after = await getRow(entityId);
	await audit(userId, result.action, entityId, before, after, `${result.message}: ${place.name}`);
	return { message: `${result.message}: ${place.name}` };
}

export const actions: Actions = {
	run: async ({ locals }) => {
		const userId = requireAdmin(locals);
		if (!(await isGeocodeConfigured())) return fail(409, { error: 'No Google key is configured.' });
		const started = await startLookups(null);
		if (!started) return fail(409, { error: 'A lookup is already running.' });
		const run = runState();
		await audit(userId, 'place_lookup_run', 0, null, { total: run.total }, `Started looking up ${run.total} places`);
		return { message: run.total === 0 ? 'Nothing new to look up.' : `Looking up ${run.total} places…` };
	},

	choose: ({ request, locals }) =>
		onPlace(request, locals, async (place, data, userId) => {
			const index = Number(data.get('index'));
			const ok = Number.isInteger(index) && index >= 0 && (await chooseCandidate(place.id, index, userId));
			return { ok, action: 'place_location_choose', message: 'Map set', error: 'That match is no longer listed.' };
		}),

	confirm: ({ request, locals }) =>
		onPlace(request, locals, async (place, _data, userId) => ({
			ok: await confirmAuto(place.id, userId),
			action: 'place_location_confirm',
			message: 'Confirmed',
			error: 'Only an automatic match can be confirmed.'
		})),

	nomap: ({ request, locals }) =>
		onPlace(request, locals, async (place, _data, userId) => {
			// Creates the row for a place never looked up, under the same lock as merges.
			return { ok: await markNoMap(place, userId), action: 'place_location_no_map', message: 'No map' };
		}),

	wrong: ({ request, locals }) =>
		onPlace(request, locals, async (place, _data, userId) => ({
			ok: await markWrong(place.id, userId),
			action: 'place_location_wrong',
			message: 'Moved to Needs a look',
			error: 'Nothing to mark wrong.'
		})),

	search: ({ request, locals }) =>
		onPlace(request, locals, async (place, data, userId) => {
			const text = String(data.get('q') ?? '').trim().slice(0, MAX_QUERY);
			if (!text) return { ok: false, action: '', message: '', error: 'Type what to search for.' };
			const r = await searchAgain(place, text, userId);
			if (!r.ok) return { ok: false, action: '', message: '', error: `Search failed: ${r.error}` };
			return {
				ok: true,
				action: 'place_location_search',
				message:
					r.count === 0
						? `Nothing found for “${text}”`
						: `${r.count} ${r.count === 1 ? 'match' : 'matches'} for “${text}”`
			};
		}),

	// The map picker: a point chosen by search, a tapped business, or a dropped pin.
	pin: ({ request, locals }) =>
		onPlace(request, locals, async (place, data, userId) => {
			const lat = Number(data.get('lat'));
			const lon = Number(data.get('lon'));
			const fail = (error: string) => ({ ok: false, action: '', message: '', error });
			if (!data.get('lat') || !data.get('lon') || !Number.isFinite(lat) || !Number.isFinite(lon)) {
				return fail('Choose a spot on the map first.');
			}
			if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return fail('That point is not on the map.');
			const placeId = String(data.get('place_id') ?? '').trim();
			if (placeId && !PLACE_ID.test(placeId)) return fail('That place could not be saved.');
			const name = String(data.get('name') ?? '').trim().slice(0, MAX_LABEL) || place.name;
			const address = String(data.get('address') ?? '').trim().slice(0, MAX_LABEL);
			if (!(await setPin(place, { lat, lon, placeId: placeId || null, name, address }, userId))) {
				return fail('That place was merged into another. Reload the page.');
			}
			return { ok: true, action: 'place_location_pin', message: 'Location saved' };
		}),

	again: ({ request, locals }) =>
		onPlace(request, locals, async (place) => {
			const err = await lookUpAgain(place);
			return {
				ok: err === null,
				action: 'place_location_undo',
				message: 'Looked up again',
				error: `Lookup failed: ${err}`
			};
		})
};
