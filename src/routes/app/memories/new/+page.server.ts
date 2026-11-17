import { fail, redirect } from '@sveltejs/kit';
import {
	afterSave,
	createMemory,
	latestToday,
	readMemoryForm,
	requireWriter,
	typedValues
} from '$server/memories';
import { isValidEntryDate } from '$server/viewer';
import type { MemoryFields } from '$lib/viewer/memories';
import type { Actions, PageServerLoad } from './$types';

/** Prefill from ?date=YYYY-MM-DD, ?month=YYYY-MM or ?year=YYYY. */
function prefill(url: URL): MemoryFields {
	const blank: MemoryFields = { precision: 'day', year: '', month: '', day: '', body: '' };
	const date = url.searchParams.get('date');
	const month = url.searchParams.get('month');
	const year = url.searchParams.get('year');
	if (date && isValidEntryDate(date)) {
		return {
			...blank,
			year: date.slice(0, 4),
			month: String(Number(date.slice(5, 7))),
			day: String(Number(date.slice(8, 10)))
		};
	}
	if (month && /^\d{4}-\d{2}$/.test(month) && isValidEntryDate(`${month}-01`)) {
		return {
			...blank,
			precision: 'month',
			year: month.slice(0, 4),
			month: String(Number(month.slice(5, 7)))
		};
	}
	if (year && /^\d{4}$/.test(year)) return { ...blank, precision: 'year', year };
	return blank;
}

export const load: PageServerLoad = async ({ locals, url }) => {
	const { writer } = await requireWriter(locals);
	const initial = prefill(url);
	const maxYear = Number(latestToday().slice(0, 4));
	// Out-of-range prefill years are dropped rather than shown as a bad choice.
	if (initial.year && (Number(initial.year) < 1900 || Number(initial.year) > maxYear)) {
		initial.year = '';
	}
	return { writerName: writer.displayName, initial, maxYear };
};

export const actions: Actions = {
	save: async ({ request, locals }) => {
		const { userId, writer } = await requireWriter(locals);
		const form = await request.formData();
		const parsed = readMemoryForm(form);
		if (!parsed.ok) return fail(400, { error: parsed.error, values: typedValues(form) });
		const share = form.get('intent') === 'share';
		const id = await createMemory(userId, writer, parsed.input, share);
		redirect(
			303,
			afterSave(id, parsed.input.date, parsed.input.precision, String(form.get('from') ?? ''))
		);
	}
};
