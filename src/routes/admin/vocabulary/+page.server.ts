import { query, withTransaction } from '$lib/db';
import { error, fail } from '@sveltejs/kit';
import type { PageServerLoad, Actions } from './$types';

function requireAdmin(locals: App.Locals) {
	if (!locals.user || locals.user.role !== 'admin') {
		error(403, 'Admin access required');
	}
}

interface VocabRow {
	id: number;
	term: string;
	category: string;
	context_note: string | null;
	is_active: boolean;
	created_at: string;
}

interface NotationRow {
	id: number;
	input_shorthand: string;
	canonical_form: string;
	meaning: string;
	category: string | null;
}

interface LexiconRow {
	id: number;
	ocr_token: string;
	corrected_token: string;
	frequency: number;
	first_seen: string;
	last_seen: string;
	is_active: boolean;
	suppressed_at: string | null;
}

export const load: PageServerLoad = async ({ locals }) => {
	requireAdmin(locals);
	const vocabRes = await query<VocabRow>(
		`SELECT id, term, category, context_note, is_active, created_at::text
		   FROM ocr_vocabulary ORDER BY category, term`
	);
	const lexiconRes = await query<LexiconRow>(
		`SELECT id, ocr_token, corrected_token, frequency, first_seen::text, last_seen::text, is_active, suppressed_at::text
		   FROM correction_lexicon ORDER BY is_active DESC, frequency DESC`
	);
	const notationRes = await query<NotationRow>(
		`SELECT id, input_shorthand, canonical_form, meaning, category
		   FROM notation_key ORDER BY id`
	);
	return {
		vocabulary: vocabRes.rows,
		lexicon: lexiconRes.rows,
		notation: notationRes.rows
	};
};

export const actions: Actions = {
	addVocab: async ({ request, locals }) => {
		requireAdmin(locals);
		const data = await request.formData();
		const term = (data.get('term') as string)?.trim();
		const category = data.get('category') as string;
		const contextNote = (data.get('contextNote') as string)?.trim() || null;

		if (!term) return fail(400, { error: 'Term is required' });
		if (!['person', 'activity', 'place', 'term'].includes(category)) {
			return fail(400, { error: 'Invalid category' });
		}

		await withTransaction(async (client) => {
			const res = await client.query<{ id: number }>(
				`INSERT INTO ocr_vocabulary (term, category, context_note) VALUES ($1, $2, $3) RETURNING id`,
				[term, category, contextNote]
			);
			await client.query(
				`INSERT INTO audit_log (user_id, action, entity_type, entity_id, before_value, after_value, description)
				 VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)`,
				[Number(locals.user!.id), 'vocab_add', 'ocr_vocabulary', res.rows[0].id,
				 null, JSON.stringify({ term, category, context_note: contextNote }),
				 `Added vocabulary: "${term}" (${category})`]
			);
		});
	},

	updateVocab: async ({ request, locals }) => {
		requireAdmin(locals);
		const data = await request.formData();
		const id = Number(data.get('id'));
		const term = (data.get('term') as string)?.trim();
		const contextNote = (data.get('contextNote') as string)?.trim() || null;

		if (!Number.isFinite(id)) return fail(400, { error: 'Invalid ID' });
		if (!term) return fail(400, { error: 'Term is required' });

		const before = await query<VocabRow>(
			`SELECT id, term, category, context_note, is_active FROM ocr_vocabulary WHERE id = $1`, [id]
		);
		if (!before.rows[0]) return fail(404, { error: 'Not found' });

		await withTransaction(async (client) => {
			await client.query(
				`UPDATE ocr_vocabulary SET term = $2, context_note = $3 WHERE id = $1`,
				[id, term, contextNote]
			);
			await client.query(
				`INSERT INTO audit_log (user_id, action, entity_type, entity_id, before_value, after_value, description)
				 VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)`,
				[Number(locals.user!.id), 'vocab_update', 'ocr_vocabulary', id,
				 JSON.stringify({ term: before.rows[0].term, context_note: before.rows[0].context_note }),
				 JSON.stringify({ term, context_note: contextNote }),
				 `Updated vocabulary: "${before.rows[0].term}" → "${term}"`]
			);
		});
	},

	toggleVocab: async ({ request, locals }) => {
		requireAdmin(locals);
		const data = await request.formData();
		const id = Number(data.get('id'));
		if (!Number.isFinite(id)) return fail(400, { error: 'Invalid ID' });

		const before = await query<{ is_active: boolean; term: string }>(
			`SELECT is_active, term FROM ocr_vocabulary WHERE id = $1`, [id]
		);
		if (!before.rows[0]) return fail(404, { error: 'Not found' });

		const newActive = !before.rows[0].is_active;
		await withTransaction(async (client) => {
			await client.query(`UPDATE ocr_vocabulary SET is_active = $2 WHERE id = $1`, [id, newActive]);
			await client.query(
				`INSERT INTO audit_log (user_id, action, entity_type, entity_id, before_value, after_value, description)
				 VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)`,
				[Number(locals.user!.id), 'vocab_toggle', 'ocr_vocabulary', id,
				 JSON.stringify({ is_active: before.rows[0].is_active }),
				 JSON.stringify({ is_active: newActive }),
				 `${newActive ? 'Activated' : 'Deactivated'} vocabulary: "${before.rows[0].term}"`]
			);
		});
	},

	deleteVocab: async ({ request, locals }) => {
		requireAdmin(locals);
		const data = await request.formData();
		const id = Number(data.get('id'));
		if (!Number.isFinite(id)) return fail(400, { error: 'Invalid ID' });

		const before = await query<VocabRow>(
			`SELECT id, term, category, context_note FROM ocr_vocabulary WHERE id = $1`, [id]
		);
		if (!before.rows[0]) return fail(404, { error: 'Not found' });

		await withTransaction(async (client) => {
			await client.query(`DELETE FROM ocr_vocabulary WHERE id = $1`, [id]);
			await client.query(
				`INSERT INTO audit_log (user_id, action, entity_type, entity_id, before_value, after_value, description)
				 VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)`,
				[Number(locals.user!.id), 'vocab_delete', 'ocr_vocabulary', id,
				 JSON.stringify({ term: before.rows[0].term, category: before.rows[0].category, context_note: before.rows[0].context_note }),
				 null,
				 `Deleted vocabulary: "${before.rows[0].term}" (${before.rows[0].category})`]
			);
		});
	},

	suppressLexicon: async ({ request, locals }) => {
		requireAdmin(locals);
		const data = await request.formData();
		const id = Number(data.get('id'));
		if (!Number.isFinite(id)) return fail(400, { error: 'Invalid ID' });

		const before = await query<LexiconRow>(
			`SELECT id, ocr_token, corrected_token, is_active FROM correction_lexicon WHERE id = $1`, [id]
		);
		if (!before.rows[0]) return fail(404, { error: 'Not found' });

		await withTransaction(async (client) => {
			await client.query(
				`UPDATE correction_lexicon SET is_active = false, suppressed_at = NOW() WHERE id = $1`, [id]
			);
			await client.query(
				`INSERT INTO audit_log (user_id, action, entity_type, entity_id, before_value, after_value, description)
				 VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)`,
				[Number(locals.user!.id), 'lexicon_suppress', 'correction_lexicon', id,
				 JSON.stringify({ ocr_token: before.rows[0].ocr_token, corrected_token: before.rows[0].corrected_token, is_active: true }),
				 JSON.stringify({ is_active: false }),
				 `Suppressed lexicon pair: "${before.rows[0].ocr_token}" → "${before.rows[0].corrected_token}"`]
			);
		});
	},

	restoreLexicon: async ({ request, locals }) => {
		requireAdmin(locals);
		const data = await request.formData();
		const id = Number(data.get('id'));
		if (!Number.isFinite(id)) return fail(400, { error: 'Invalid ID' });

		const before = await query<LexiconRow>(
			`SELECT id, ocr_token, corrected_token, is_active FROM correction_lexicon WHERE id = $1`, [id]
		);
		if (!before.rows[0]) return fail(404, { error: 'Not found' });

		await withTransaction(async (client) => {
			await client.query(
				`UPDATE correction_lexicon SET is_active = true, suppressed_at = NULL WHERE id = $1`, [id]
			);
			await client.query(
				`INSERT INTO audit_log (user_id, action, entity_type, entity_id, before_value, after_value, description)
				 VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)`,
				[Number(locals.user!.id), 'lexicon_restore', 'correction_lexicon', id,
				 JSON.stringify({ is_active: false }),
				 JSON.stringify({ ocr_token: before.rows[0].ocr_token, corrected_token: before.rows[0].corrected_token, is_active: true }),
				 `Restored lexicon pair: "${before.rows[0].ocr_token}" → "${before.rows[0].corrected_token}"`]
			);
		});
	},

	addNotation: async ({ request, locals }) => {
		requireAdmin(locals);
		const data = await request.formData();
		const shorthand = (data.get('shorthand') as string)?.trim();
		const canonical = (data.get('canonical') as string)?.trim();
		const meaning = (data.get('meaning') as string)?.trim();
		const category = (data.get('category') as string)?.trim() || null;

		if (!shorthand || !meaning) return fail(400, { error: 'Shorthand and meaning are required' });

		await withTransaction(async (client) => {
			const res = await client.query<{ id: number }>(
				`INSERT INTO notation_key (input_shorthand, canonical_form, meaning, category, created_by)
				 VALUES ($1, $2, $3, $4, $5) RETURNING id`,
				[shorthand, canonical || shorthand, meaning, category, Number(locals.user!.id)]
			);
			await client.query(
				`INSERT INTO audit_log (user_id, action, entity_type, entity_id, before_value, after_value, description)
				 VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)`,
				[Number(locals.user!.id), 'notation_add', 'notation_key', res.rows[0].id,
				 null, JSON.stringify({ input_shorthand: shorthand, canonical_form: canonical || shorthand, meaning, category }),
				 `Added notation: "${shorthand}" → "${meaning}"`]
			);
		});
	},

	updateNotation: async ({ request, locals }) => {
		requireAdmin(locals);
		const data = await request.formData();
		const id = Number(data.get('id'));
		const shorthand = (data.get('shorthand') as string)?.trim();
		const canonical = (data.get('canonical') as string)?.trim();
		const meaning = (data.get('meaning') as string)?.trim();
		const category = (data.get('category') as string)?.trim() || null;

		if (!Number.isFinite(id)) return fail(400, { error: 'Invalid ID' });
		if (!shorthand || !meaning) return fail(400, { error: 'Shorthand and meaning are required' });

		const before = await query<NotationRow>(
			`SELECT id, input_shorthand, canonical_form, meaning, category FROM notation_key WHERE id = $1`, [id]
		);
		if (!before.rows[0]) return fail(404, { error: 'Not found' });

		await withTransaction(async (client) => {
			await client.query(
				`UPDATE notation_key SET input_shorthand = $2, canonical_form = $3, meaning = $4, category = $5 WHERE id = $1`,
				[id, shorthand, canonical || shorthand, meaning, category]
			);
			await client.query(
				`INSERT INTO audit_log (user_id, action, entity_type, entity_id, before_value, after_value, description)
				 VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)`,
				[Number(locals.user!.id), 'notation_update', 'notation_key', id,
				 JSON.stringify(before.rows[0]),
				 JSON.stringify({ input_shorthand: shorthand, canonical_form: canonical || shorthand, meaning, category }),
				 `Updated notation: "${before.rows[0].input_shorthand}" → "${shorthand}"`]
			);
		});
	},

	deleteNotation: async ({ request, locals }) => {
		requireAdmin(locals);
		const data = await request.formData();
		const id = Number(data.get('id'));
		if (!Number.isFinite(id)) return fail(400, { error: 'Invalid ID' });

		const before = await query<NotationRow>(
			`SELECT id, input_shorthand, canonical_form, meaning, category FROM notation_key WHERE id = $1`, [id]
		);
		if (!before.rows[0]) return fail(404, { error: 'Not found' });

		await withTransaction(async (client) => {
			await client.query(`DELETE FROM notation_key WHERE id = $1`, [id]);
			await client.query(
				`INSERT INTO audit_log (user_id, action, entity_type, entity_id, before_value, after_value, description)
				 VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)`,
				[Number(locals.user!.id), 'notation_delete', 'notation_key', id,
				 JSON.stringify(before.rows[0]), null,
				 `Deleted notation: "${before.rows[0].input_shorthand}" → "${before.rows[0].meaning}"`]
			);
		});
	},

	promoteToVocab: async ({ request, locals }) => {
		requireAdmin(locals);
		const data = await request.formData();
		const lexiconId = Number(data.get('lexiconId'));
		const category = data.get('category') as string;
		if (!Number.isFinite(lexiconId)) return fail(400, { error: 'Invalid ID' });
		if (!['person', 'activity', 'place', 'term'].includes(category)) {
			return fail(400, { error: 'Invalid category' });
		}

		const lex = await query<LexiconRow>(
			`SELECT id, ocr_token, corrected_token FROM correction_lexicon WHERE id = $1`, [lexiconId]
		);
		if (!lex.rows[0]) return fail(404, { error: 'Not found' });

		const existing = await query<{ id: number }>(
			`SELECT id FROM ocr_vocabulary WHERE term = $1 AND category = $2`, [lex.rows[0].corrected_token, category]
		);
		if (existing.rows[0]) {
			return fail(409, { error: `"${lex.rows[0].corrected_token}" already exists in ${category} vocabulary` });
		}

		await withTransaction(async (client) => {
			const res = await client.query<{ id: number }>(
				`INSERT INTO ocr_vocabulary (term, category, context_note)
				 VALUES ($1, $2, $3) RETURNING id`,
				[lex.rows[0].corrected_token, category, `Promoted from lexicon (OCR: "${lex.rows[0].ocr_token}")`]
			);
			await client.query(
				`INSERT INTO audit_log (user_id, action, entity_type, entity_id, before_value, after_value, description)
				 VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)`,
				[Number(locals.user!.id), 'lexicon_promote', 'ocr_vocabulary', res.rows[0].id,
				 JSON.stringify({ lexicon_id: lexiconId, ocr_token: lex.rows[0].ocr_token, corrected_token: lex.rows[0].corrected_token }),
				 JSON.stringify({ term: lex.rows[0].corrected_token, category }),
				 `Promoted lexicon "${lex.rows[0].corrected_token}" to ${category} vocabulary`]
			);
		});
	}
};
