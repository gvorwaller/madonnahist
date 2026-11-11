import { getEntityDirectory } from '$lib/server/entities';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	return { entries: await getEntityDirectory('place') };
};
