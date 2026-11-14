import { getTimelineYears } from '$lib/server/viewer';
import type { PageServerLoad } from './$types';

/**
 * Timeline (V3 Slice 2): decades of year rows, each with a 12-month
 * density strip and a one-line excerpt. Replaces /app/browse, which now
 * redirects here. Accepted-only; see getTimelineYears().
 */
export const load: PageServerLoad = async () => {
	return { years: await getTimelineYears() };
};
