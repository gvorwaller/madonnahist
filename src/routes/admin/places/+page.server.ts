import { query } from '$lib/db';
import { isGeocodeConfigured } from '$lib/server/geocode';
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
	searchAgain,
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
	const [rows, pending, configured] = await Promise.all([listForAdmin(), countPending(), isGeocodeConfigured()]);
	return { rows, pending, configured, run: runState() };
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
			// A place never looked up has no row yet: create one so "no map" sticks.
			if (!(await getRow(place.id))) {
				await query(
					`INSERT INTO place_locations (entity_id, status, reason, region, looked_up_name, decided_by, decided_at)
					 VALUES ($1, 'no_location', 'admin', $2, $3, $4, NOW())`,
					[place.id, place.region, place.name, userId]
				);
				return { ok: true, action: 'place_location_no_map', message: 'No map' };
			}
			return { ok: await markNoMap(place.id, userId), action: 'place_location_no_map', message: 'No map' };
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
