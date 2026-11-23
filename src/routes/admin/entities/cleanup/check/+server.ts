import { error, json } from '@sveltejs/kit';
import { MAX_CHECK_CANDIDATES } from '$lib/entity-check';
import { currentFingerprints, runCheck } from '$lib/server/entity-cleanup';
import { EntityGraphError, toId } from '$lib/server/entity-graph';
import type { RequestHandler } from './$types';

/**
 * POST {mainId, candidateIds, fingerprints?}: ask Claude whether these
 * candidates are the same as the main name (td-c6e871 plan §5).
 * `fingerprints` ({[candidateId]: fp}, as the page showed them) makes a
 * candidate whose evidence changed since come back 'changed' instead. Answers are stored and
 * returned; the page pre-ticks boxes the admin hasn't touched. Nothing is
 * merged here.
 */
/**
 * GET ?mainId=&candidateIds=1,2: the current evidence fingerprints of those
 * pairs, for scripts and tests that merge through the cleanup action
 * without the page. Admin only.
 */
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user || locals.user.role !== 'admin') error(403, 'Admin access required');
	const mainId = toId(url.searchParams.get('mainId'));
	const ids = (url.searchParams.get('candidateIds') ?? '').split(',').filter(Boolean).map(toId);
	if (mainId === null || ids.length === 0 || ids.length > 50 || ids.some((x) => x === null)) error(400, 'Invalid request');
	const fps = await currentFingerprints(mainId, ids as number[]);
	return json({ fingerprints: Object.fromEntries(fps) });
};

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user || locals.user.role !== 'admin') error(403, 'Admin access required');
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		error(400, 'Invalid request');
	}
	if (!body || typeof body !== 'object' || Array.isArray(body)) error(400, 'Invalid request');
	const b = body as { mainId?: unknown; candidateIds?: unknown; fingerprints?: unknown };
	const mainId = toId(b.mainId);
	const raw = Array.isArray(b.candidateIds) ? b.candidateIds : [];
	const ids = [...new Set(raw.map(toId))];
	if (mainId === null || ids.length === 0 || ids.some((x) => x === null) || ids.length > MAX_CHECK_CANDIDATES) {
		error(400, 'Invalid request');
	}
	let shown: Map<number, string> | undefined;
	if (b.fingerprints !== undefined) {
		if (!b.fingerprints || typeof b.fingerprints !== 'object' || Array.isArray(b.fingerprints)) error(400, 'Invalid request');
		shown = new Map();
		for (const [k, v] of Object.entries(b.fingerprints as Record<string, unknown>)) {
			const id = toId(k);
			if (id === null || typeof v !== 'string' || !/^[0-9a-f]{32}$/.test(v)) error(400, 'Invalid request');
			shown.set(id, v);
		}
		// A map, when sent, covers every candidate asked about: a missing one
		// would otherwise be paid for on evidence the page may not show.
		if ((ids as number[]).some((id) => !shown!.has(id))) error(400, 'Invalid request');
	}
	try {
		const results = await runCheck(mainId, ids as number[], Number(locals.user.id), shown);
		return json({ results });
	} catch (e) {
		if (e instanceof EntityGraphError) return json({ error: e.message }, { status: e.status });
		console.error('[entity-check]', e instanceof Error ? e.message : e);
		return json({ error: "Couldn't check this group. Try again later." }, { status: 502 });
	}
};
