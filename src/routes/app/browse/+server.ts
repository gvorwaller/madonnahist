import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/** Old Browse page (before V3 Slice 2): bookmarks and shared links land on the Timeline. */
export const GET: RequestHandler = () => {
	redirect(308, '/app/timeline');
};
