import { loadEntityProfile } from '$lib/server/entities';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
	const profile = await loadEntityProfile('person', params.slug);
	return { profile };
};
