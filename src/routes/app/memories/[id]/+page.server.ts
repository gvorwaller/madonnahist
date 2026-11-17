import { error, fail, redirect } from '@sveltejs/kit';
import {
	afterSave,
	deleteMemory,
	getMyMemory,
	latestToday,
	MemoryMoved,
	MemoryNotFound,
	readMemoryForm,
	requireWriter,
	setShared,
	typedValues,
	updateMemory
} from '$server/memories';
import { fieldsOf } from '$lib/viewer/memories';
import type { Actions, PageServerLoad } from './$types';

/**
 * Edit one of your own memories (plan §3). Every query is scoped to
 * created_by = you; anyone else's id is "not found" (CODEX #2).
 */

const GONE = "That memory isn't available. It may have been deleted in another window.";
const MOVED =
	'This memory was changed in another window. Reload the page to see the latest, then make your change again.';

function idOf(params: { id: string }): number {
	return /^\d{1,9}$/.test(params.id) ? Number(params.id) : 0;
}

/** Share / unshare with the loaded version; returns the new one for the page. */
async function toggle(userId: number, id: number, shared: boolean, form: FormData) {
	try {
		const version = await setShared(userId, id, shared, String(form.get('version') ?? ''));
		return {
			done: shared ? 'Shared with the family.' : 'Private again. Only you can see it now.',
			version
		};
	} catch (e) {
		if (e instanceof MemoryNotFound) return fail(404, { error: GONE });
		if (e instanceof MemoryMoved) return fail(409, { error: MOVED });
		throw e;
	}
}

export const load: PageServerLoad = async ({ locals, params }) => {
	const { userId, writer } = await requireWriter(locals);
	const memory = await getMyMemory(userId, idOf(params));
	if (!memory) error(404, GONE);
	return {
		writerName: writer.displayName,
		memory,
		initial: fieldsOf(memory),
		maxYear: Number(latestToday().slice(0, 4))
	};
};

export const actions: Actions = {
	/** Save the text and date. intent=share also shares a draft; keep leaves sharing as it is. */
	save: async ({ request, locals, params }) => {
		const { userId } = await requireWriter(locals);
		const form = await request.formData();
		// A refused save hands back the version it was submitted with, so a
		// page re-rendered without JS keeps pairing the typed text with the
		// version it was based on (CODEX code review #2).
		const version = String(form.get('version') ?? '');
		const refused = (status: number, error: string) =>
			fail(status, { error, values: typedValues(form), version });
		const parsed = readMemoryForm(form);
		if (!parsed.ok) return refused(400, parsed.error);
		const id = idOf(params);
		try {
			await updateMemory(userId, id, parsed.input, version, form.get('intent') === 'share');
		} catch (e) {
			if (e instanceof MemoryNotFound) return refused(404, GONE);
			if (e instanceof MemoryMoved) return refused(409, MOVED);
			throw e;
		}
		redirect(
			303,
			afterSave(id, parsed.input.date, parsed.input.precision, String(form.get('from') ?? ''))
		);
	},

	share: async ({ request, locals, params }) => {
		const { userId } = await requireWriter(locals);
		return toggle(userId, idOf(params), true, await request.formData());
	},

	unshare: async ({ request, locals, params }) => {
		const { userId } = await requireWriter(locals);
		return toggle(userId, idOf(params), false, await request.formData());
	},

	delete: async ({ request, locals, params }) => {
		const { userId } = await requireWriter(locals);
		const form = await request.formData();
		try {
			await deleteMemory(userId, idOf(params), String(form.get('version') ?? ''));
		} catch (e) {
			if (e instanceof MemoryNotFound) return fail(404, { error: GONE });
			if (e instanceof MemoryMoved) return fail(409, { error: MOVED });
			throw e;
		}
		redirect(303, '/app/memories?deleted=1');
	}
};
