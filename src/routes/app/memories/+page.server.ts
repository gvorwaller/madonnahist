import { listMyMemories, requireWriter } from '$server/memories';
import type { PageServerLoad } from './$types';

/** "My memories": everything this writer typed, drafts first (plan §3). */
export const load: PageServerLoad = async ({ locals, url }) => {
	const { userId, writer } = await requireWriter(locals);
	return {
		writerName: writer.displayName,
		memories: await listMyMemories(userId),
		deleted: url.searchParams.get('deleted') === '1'
	};
};
