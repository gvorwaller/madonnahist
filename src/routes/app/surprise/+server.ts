import { getRandomAcceptedDate } from '$lib/server/viewer';
import type { RequestHandler } from './$types';

/**
 * "Surprise me" on Today (V3 Slice 2): a random accepted day. A plain
 * redirect, never cached, so each tap picks again. Back on the day page
 * returns to Today.
 */
export const GET: RequestHandler = async () => {
	const date = await getRandomAcceptedDate();
	const location = date ? `/app/day/${date}?from=${encodeURIComponent('/app')}` : '/app';
	return new Response(null, {
		status: 303,
		headers: { Location: location, 'Cache-Control': 'no-store' }
	});
};
