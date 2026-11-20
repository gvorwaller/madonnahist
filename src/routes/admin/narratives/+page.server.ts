/**
 * Admin desk for year narratives (Phase E of
 * docs/2026-07-21-next-phases-search-viewer-narrative-plan.md, reworked by
 * td-f1f49b — docs/2026-11-20-narrative-models-guidance-plan.md).
 *
 * Generate enqueues one narrative_summary job per chosen model for the
 * enrichment worker (backend/workers/enrichment-worker.ts); this page never
 * calls an LLM. Each job appends a candidate to narrative_drafts. The worker
 * cannot write narrative_summaries at all (migration 0033), so the text the
 * family sees changes only here: "Use this" copies a candidate across,
 * Edit changes it by hand (saved as a draft too, so it can be switched back
 * to), Publish/Unpublish flip visibility. Every action that writes a year's
 * narrative first takes that year's advisory lock (lockYear), so two tabs
 * can't interleave — including on a year that has no row yet to lock.
 *
 * Guidance: the house style (app_state) and the year's notes
 * (narrative_guidance) are copied into each job when it is queued, along
 * with the current text for a revision, so a queued job is unaffected by
 * later edits.
 *
 * The year's full candidate list is loaded only for the year opened in the
 * page (?open=YYYY), to keep the 30-second refresh small.
 */
import { query, withTransaction } from '$lib/db';
import { error, fail } from '@sveltejs/kit';
import { getYearCoverage } from '$lib/server/viewer';
import {
	DEFAULT_NARRATIVE_MODEL,
	HAND_EDIT_MODEL_NAME,
	MAX_GUIDANCE_LENGTH,
	MAX_NARRATIVE_LENGTH,
	NARRATIVE_MODELS,
	cleanGuidance,
	findNarrativeModel,
	isNarrativeMode
} from '$lib/narrative-models';
import { getStyleGuidance, getYearNotes, saveStyleGuidance, saveYearNotes } from '$server/narrative-guidance';
import type pg from 'pg';
import type { Actions, PageServerLoad } from './$types';

function requireAdmin(locals: App.Locals) {
	if (!locals.user || locals.user.role !== 'admin') {
		error(403, 'Admin access required');
	}
}

function isValidYearKey(s: unknown): s is string {
	return typeof s === 'string' && /^\d{4}$/.test(s);
}

/**
 * Serialize every write to one year's narrative (generate, use, edit,
 * publish, unpublish) for the rest of the transaction. A row lock isn't
 * enough: before the first "Use this" there is no row to lock.
 */
async function lockYear(client: pg.PoolClient, yearKey: string): Promise<void> {
	await client.query(`SELECT pg_advisory_xact_lock(hashtext('narrative_summary:year:' || $1))`, [yearKey]);
}

/** A job's model, treating jobs queued before td-f1f49b (no model) as the default. */
const JOB_MODEL_SQL = `COALESCE(payload->>'model', '${DEFAULT_NARRATIVE_MODEL}')`;

interface NarrativeRow {
	id: number;
	scope_key: string;
	summary_text: string;
	generated_by: string;
	generated_at: string;
	is_published: boolean;
	source_draft_id: string | null;
}

export interface DraftRow {
	id: string;
	model_name: string;
	provider: string;
	mode: 'fresh' | 'revise' | 'imported' | 'edit';
	draft_text: string;
	style_guidance: string | null;
	year_guidance: string | null;
	day_count: number;
	input_tokens: number | null;
	output_tokens: number | null;
	requested_by_name: string | null;
	created_at: string;
}

export const load: PageServerLoad = async ({ locals, url }) => {
	requireAdmin(locals);
	const openParam = url.searchParams.get('open');
	const openYear = isValidYearKey(openParam) ? openParam : null;

	const [yearCoverage, narrativesRes, pendingRes, countsRes, styleGuidance] = await Promise.all([
		getYearCoverage(),
		query<NarrativeRow>(
			`SELECT id, scope_key, summary_text, generated_by, generated_at::text AS generated_at,
			        is_published, source_draft_id::text AS source_draft_id
			   FROM narrative_summaries WHERE scope = 'year'`
		),
		query<{ scope_key: string; model: string }>(
			`SELECT DISTINCT payload->>'scope_key' AS scope_key, ${JOB_MODEL_SQL} AS model
			   FROM job_runs
			  WHERE job_type = 'narrative_summary' AND status IN ('pending', 'in_progress') AND payload->>'scope' = 'year'`
		),
		query<{ scope_key: string; n: number; latest: string }>(
			`SELECT scope_key, COUNT(*)::int AS n, MAX(created_at)::text AS latest
			   FROM narrative_drafts WHERE scope = 'year' GROUP BY scope_key`
		),
		getStyleGuidance()
	]);

	const narrativeByYear = new Map(narrativesRes.rows.map((r) => [r.scope_key, r]));
	const pendingByYear = new Map<string, string[]>();
	for (const r of pendingRes.rows) {
		const list = pendingByYear.get(r.scope_key) ?? [];
		list.push(r.model);
		pendingByYear.set(r.scope_key, list);
	}
	const countsByYear = new Map(countsRes.rows.map((r) => [r.scope_key, r]));

	// A year is listed if it has accepted days to write from, or already has
	// text or drafts — so a published story stays reachable (to unpublish or
	// edit) even if its last accepted day is reopened.
	const coverageByYear = new Map(yearCoverage.map((y) => [String(y.year), y]));
	const yearKeys = new Set([
		...yearCoverage.filter((y) => y.accepted > 0).map((y) => String(y.year)),
		...narrativeByYear.keys(),
		...countsByYear.keys()
	]);

	const years = [...yearKeys]
		.filter(isValidYearKey)
		.map((yearKey) => {
			const y = coverageByYear.get(yearKey) ?? { year: Number(yearKey), accepted: 0, total: 0, percent: 0 };
			const narrative = narrativeByYear.get(yearKey) ?? null;
			const counts = countsByYear.get(yearKey);
			const pendingModels = pendingByYear.get(yearKey) ?? [];
			return {
				year: y.year,
				accepted: y.accepted,
				total: y.total,
				percent: y.percent,
				canGenerate: y.accepted > 0,
				status: (narrative ? (narrative.is_published ? 'published' : 'draft') : 'none') as
					| 'none'
					| 'draft'
					| 'published',
				narrative,
				draftCount: counts?.n ?? 0,
				// A candidate newer than the current text (or any candidate when
				// there is no text yet) is waiting for review.
				newDrafts:
					!!counts && (!narrative || new Date(counts.latest) > new Date(narrative.generated_at)),
				pendingModels,
				pendingJob: pendingModels.length > 0
			};
		})
		.sort((a, b) => b.year - a.year);

	let open: {
		year: string;
		notes: string;
		drafts: DraftRow[];
		lastFailures: { model: string; error: string; at: string }[];
	} | null = null;
	if (openYear && years.some((y) => String(y.year) === openYear)) {
		const [notes, draftsRes, jobsRes] = await Promise.all([
			getYearNotes(openYear),
			query<DraftRow>(
				`SELECT d.id::text AS id, d.model_name, d.provider, d.mode, d.draft_text, d.style_guidance,
				        d.year_guidance, d.day_count, d.input_tokens, d.output_tokens,
				        COALESCE(u.display_name, u.username) AS requested_by_name, d.created_at::text AS created_at
				   FROM narrative_drafts d LEFT JOIN users u ON u.id = d.requested_by
				  WHERE d.scope = 'year' AND d.scope_key = $1
				  ORDER BY d.created_at DESC, d.id DESC`,
				[openYear]
			),
			// Latest job per model: if it failed (e.g. a missing API key),
			// say so next to the Generate button.
			query<{ model: string; status: string; last_error: string | null; at: string }>(
				`SELECT DISTINCT ON (${JOB_MODEL_SQL}) ${JOB_MODEL_SQL} AS model, status, last_error,
				        COALESCE(completed_at, enqueued_at)::text AS at
				   FROM job_runs
				  WHERE job_type = 'narrative_summary' AND payload->>'scope' = 'year' AND payload->>'scope_key' = $1
				  ORDER BY ${JOB_MODEL_SQL}, id DESC`,
				[openYear]
			)
		]);
		open = {
			year: openYear,
			notes,
			drafts: draftsRes.rows,
			lastFailures: jobsRes.rows
				.filter((j) => j.status === 'failed')
				.map((j) => ({ model: j.model, error: j.last_error ?? 'unknown error', at: j.at }))
		};
	}

	return {
		years,
		open,
		styleGuidance,
		maxGuidanceLength: MAX_GUIDANCE_LENGTH,
		models: NARRATIVE_MODELS.map((m) => ({ id: m.id, label: m.label })),
		defaultModel: DEFAULT_NARRATIVE_MODEL
	};
};

async function auditNarrative(
	client: pg.PoolClient,
	userId: number,
	action: string,
	entityType: string,
	entityId: number,
	before: unknown,
	after: unknown,
	description: string
): Promise<void> {
	await client.query(
		`INSERT INTO audit_log (user_id, action, entity_type, entity_id, before_value, after_value, description)
		 VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)`,
		[userId, action, entityType, entityId, JSON.stringify(before), JSON.stringify(after), description]
	);
}

/** Thrown inside a transaction to roll it back and return fail(status, …). */
class ActionFailure extends Error {
	constructor(
		public status: number,
		message: string
	) {
		super(message);
	}
}

async function runAction(fn: () => Promise<unknown>) {
	try {
		await fn();
	} catch (err) {
		if (err instanceof ActionFailure) return fail(err.status, { error: err.message });
		throw err;
	}
}

function readNotes(data: FormData): string {
	const notes = cleanGuidance(((data.get('notes') as string | null) ?? '').toString());
	if (notes.length > MAX_GUIDANCE_LENGTH) {
		throw new ActionFailure(400, `Please keep the notes under ${MAX_GUIDANCE_LENGTH} characters.`);
	}
	return notes;
}

/**
 * The draft the form was showing when it was opened (expectedDraftId), so a
 * dialog or edit started before another tab changed the year's text can't
 * act on text the admin never saw. undefined = not sent (no check); null =
 * the form saw text that came from no draft.
 */
function readExpectedDraft(data: FormData): string | null | undefined {
	const raw = data.get('expectedDraftId');
	if (raw === null) return undefined;
	const s = raw.toString();
	if (s === '') return null;
	if (!/^\d+$/.test(s)) throw new ActionFailure(400, 'Invalid draft');
	return s;
}

/** Save a year's notes and audit the change, if it changed. */
async function storeNotes(client: pg.PoolClient, userId: number, yearKey: string, notes: string) {
	const before = await getYearNotes(yearKey, client);
	if (before === notes) return;
	await saveYearNotes(client, yearKey, notes, userId);
	await auditNarrative(
		client,
		userId,
		'narrative_notes_update',
		'narrative_guidance',
		Number(yearKey),
		{ guidance_text: before || null },
		{ guidance_text: notes || null },
		notes ? `Updated the ${yearKey} narrative notes` : `Cleared the ${yearKey} narrative notes`
	);
}

export const actions: Actions = {
	saveStyle: async ({ request, locals }) => {
		requireAdmin(locals);
		const data = await request.formData();
		const text = cleanGuidance(((data.get('style') as string | null) ?? '').toString());
		if (text.length > MAX_GUIDANCE_LENGTH) {
			return fail(400, { error: `Please keep the house style under ${MAX_GUIDANCE_LENGTH} characters.` });
		}
		const userId = Number(locals.user!.id);
		await withTransaction(async (client) => {
			const before = await getStyleGuidance(client);
			if (before === text) return;
			await saveStyleGuidance(client, text);
			await auditNarrative(
				client,
				userId,
				'narrative_style_update',
				'app_state',
				0,
				{ text: before || null },
				{ text: text || null },
				text ? 'Updated the narrative house style' : 'Cleared the narrative house style'
			);
		});
		return { styleSaved: true };
	},

	saveNotes: async ({ request, locals }) => {
		requireAdmin(locals);
		const data = await request.formData();
		const yearKey = data.get('year');
		if (!isValidYearKey(yearKey)) return fail(400, { error: 'Invalid year' });
		const userId = Number(locals.user!.id);
		return runAction(async () => {
			const notes = readNotes(data);
			await withTransaction(async (client) => {
				await lockYear(client, yearKey);
				await storeNotes(client, userId, yearKey, notes);
			});
		});
	},

	generate: async ({ request, locals }) => {
		requireAdmin(locals);
		const data = await request.formData();
		const yearKey = data.get('year');
		if (!isValidYearKey(yearKey)) return fail(400, { error: 'Invalid year' });
		const modelIds = [...new Set(data.getAll('model').map(String))];
		if (modelIds.length === 0) return fail(400, { error: 'Pick at least one model.' });
		const unknown = modelIds.filter((m) => !findNarrativeModel(m));
		if (unknown.length > 0) return fail(400, { error: `Unknown model: ${unknown.join(', ')}` });
		const mode = data.get('mode') ?? 'fresh';
		if (!isNarrativeMode(mode)) return fail(400, { error: 'Invalid mode' });
		const userId = Number(locals.user!.id);

		return runAction(async () => {
			const typedNotes = readNotes(data);
			// Notes the admin didn't touch in this tab (still equal to what the
			// page loaded) mean "use what's saved", which another tab may have
			// changed since; only notes typed here are saved over it.
			const notesBase = data.get('notesBase');
			const untouched = typeof notesBase === 'string' && cleanGuidance(notesBase) === typedNotes;
			await withTransaction(async (client) => {
				// Two quick clicks can't both pass the duplicate check below.
				await lockYear(client, yearKey);

				const acceptedRes = await client.query<{ n: number }>(
					`SELECT COUNT(*)::int AS n FROM calendar_days
					  WHERE correction_status = 'accepted' AND EXTRACT(YEAR FROM entry_date)::int = $1`,
					[Number(yearKey)]
				);
				if (acceptedRes.rows[0].n === 0) {
					throw new ActionFailure(400, `${yearKey} has no accepted days to write from.`);
				}

				const pendingRes = await client.query<{ model: string }>(
					`SELECT DISTINCT ${JOB_MODEL_SQL} AS model FROM job_runs
					  WHERE job_type = 'narrative_summary' AND status IN ('pending', 'in_progress')
					    AND payload->>'scope' = 'year' AND payload->>'scope_key' = $1`,
					[yearKey]
				);
				const busy = modelIds.filter((m) => pendingRes.rows.some((r) => r.model === m));
				if (busy.length > 0) {
					const names = busy.map((m) => findNarrativeModel(m)?.label ?? m).join(', ');
					throw new ActionFailure(409, `Already generating with ${names} for ${yearKey}.`);
				}

				let baseText: string | null = null;
				if (mode === 'revise') {
					const cur = await client.query<{ summary_text: string }>(
						`SELECT summary_text FROM narrative_summaries WHERE scope = 'year' AND scope_key = $1`,
						[yearKey]
					);
					baseText = cur.rows[0]?.summary_text?.trim() || null;
					if (!baseText) {
						throw new ActionFailure(400, `There is no current ${yearKey} text to revise yet. Use "Fresh from entries" first.`);
					}
					if (baseText.length > MAX_NARRATIVE_LENGTH) {
						throw new ActionFailure(
							400,
							`The current ${yearKey} text is too long to revise (over ${MAX_NARRATIVE_LENGTH.toLocaleString()} characters). Shorten it by hand, or use "Fresh from entries".`
						);
					}
				}

				let notes: string;
				if (untouched) {
					notes = (await getYearNotes(yearKey, client)).trim();
				} else {
					notes = typedNotes;
					await storeNotes(client, userId, yearKey, notes);
				}
				const style = (await getStyleGuidance(client)).trim();

				for (const model of modelIds) {
					const payload = {
						scope: 'year',
						scope_key: yearKey,
						model,
						mode,
						...(baseText ? { base_text: baseText } : {}),
						style_guidance: style,
						year_guidance: notes,
						requested_by: userId
					};
					await client.query(`INSERT INTO job_runs (job_type, payload) VALUES ('narrative_summary', $1::jsonb)`, [
						JSON.stringify(payload)
					]);
				}
				await auditNarrative(
					client,
					userId,
					'narrative_generate_enqueued',
					'narrative_summaries',
					Number(yearKey),
					null,
					{ scope: 'year', scope_key: yearKey, models: modelIds, mode },
					`Queued ${mode === 'revise' ? 'a revision' : 'a new draft'} of the ${yearKey} narrative with ${modelIds.join(', ')}`
				);
			});
		});
	},

	useDraft: async ({ request, locals }) => {
		requireAdmin(locals);
		const data = await request.formData();
		const yearKey = data.get('year');
		const draftId = data.get('draftId');
		if (!isValidYearKey(yearKey)) return fail(400, { error: 'Invalid year' });
		if (typeof draftId !== 'string' || !/^\d+$/.test(draftId)) return fail(400, { error: 'Invalid draft' });
		const confirmed = data.get('confirmPublished') === '1';
		const userId = Number(locals.user!.id);

		return runAction(async () => {
			await withTransaction(async (client) => {
				await lockYear(client, yearKey);
				const cur = await client.query<{ id: number; is_published: boolean; summary_text: string; source_draft_id: string | null }>(
					`SELECT id, is_published, summary_text, source_draft_id::text AS source_draft_id
					   FROM narrative_summaries WHERE scope = 'year' AND scope_key = $1 FOR UPDATE`,
					[yearKey]
				);
				// Scope the lookup to this year so a mismatched form can never
				// copy another year's draft in.
				const draftRes = await client.query<{ id: string; model_name: string; draft_text: string }>(
					`SELECT id::text AS id, model_name, draft_text FROM narrative_drafts
					  WHERE id = $1 AND scope = 'year' AND scope_key = $2`,
					[draftId, yearKey]
				);
				const draft = draftRes.rows[0];
				if (!draft) throw new ActionFailure(404, `That draft doesn't belong to ${yearKey}.`);

				const before = cur.rows[0];
				// Checked here, not just in the browser: the year may have been
				// published in another tab since this page loaded.
				if (before?.is_published && !confirmed) {
					throw new ActionFailure(
						409,
						`The ${yearKey} narrative is published. Confirm to replace the text the family sees.`
					);
				}

				const res = await client.query<{ id: number }>(
					`INSERT INTO narrative_summaries (scope, scope_key, summary_text, generated_by, generated_at, is_published, source_draft_id)
					 SELECT 'year', $1, d.draft_text, d.model_name, d.created_at, FALSE, d.id
					   FROM narrative_drafts d WHERE d.id = $2
					 ON CONFLICT (scope, scope_key) DO UPDATE
					   SET summary_text = EXCLUDED.summary_text,
					       generated_by = EXCLUDED.generated_by,
					       generated_at = EXCLUDED.generated_at,
					       source_draft_id = EXCLUDED.source_draft_id
					 RETURNING id`,
					[yearKey, draftId]
				);
				await auditNarrative(
					client,
					userId,
					'narrative_use_draft',
					'narrative_summaries',
					res.rows[0].id,
					before ? { summary_text: before.summary_text, source_draft_id: before.source_draft_id } : null,
					{ summary_text: draft.draft_text, source_draft_id: draft.id, is_published: before?.is_published ?? false },
					`Used draft #${draft.id} (${draft.model_name}) for the ${yearKey} narrative` +
						(before?.is_published ? ' — replaced the published text' : '')
				);
			});
		});
	},

	saveEdit: async ({ request, locals }) => {
		requireAdmin(locals);
		const data = await request.formData();
		const yearKey = data.get('year');
		const summaryText = cleanGuidance(((data.get('summaryText') as string | null) ?? '').toString());
		if (!isValidYearKey(yearKey)) return fail(400, { error: 'Invalid year' });
		if (!summaryText) return fail(400, { error: 'Summary text is required' });
		if (summaryText.length > MAX_NARRATIVE_LENGTH) {
			return fail(400, { error: `Please keep the text under ${MAX_NARRATIVE_LENGTH.toLocaleString()} characters.` });
		}
		const userId = Number(locals.user!.id);

		return runAction(() =>
			withTransaction(async (client) => {
				const expected = readExpectedDraft(data);
				await lockYear(client, yearKey);
				const before = (
					await client.query<{ id: number; summary_text: string; source_draft_id: string | null }>(
						`SELECT id, summary_text, source_draft_id::text AS source_draft_id
						   FROM narrative_summaries WHERE scope = 'year' AND scope_key = $1 FOR UPDATE`,
						[yearKey]
					)
				).rows[0];
				if (!before) throw new ActionFailure(404, 'No narrative exists for this year yet');
				if (expected !== undefined && expected !== before.source_draft_id) {
					throw new ActionFailure(
						409,
						`The ${yearKey} text changed (in another tab?) after you started editing. Your edit is still in the box: copy what you need, then Cancel and edit the new text.`
					);
				}
				if (before.summary_text === summaryText) return;

				// The edit is kept as a draft of its own, so replacing it later
				// with another draft never loses it.
				const draft = (
					await client.query<{ id: string }>(
						`INSERT INTO narrative_drafts (scope, scope_key, model_name, provider, mode, draft_text, requested_by)
						 VALUES ('year', $1, $2, 'human', 'edit', $3, $4)
						 RETURNING id::text AS id`,
						[yearKey, HAND_EDIT_MODEL_NAME, summaryText, userId]
					)
				).rows[0];
				await client.query(
					`UPDATE narrative_summaries s
					    SET summary_text = d.draft_text, generated_by = d.model_name,
					        generated_at = d.created_at, source_draft_id = d.id
					   FROM narrative_drafts d
					  WHERE s.id = $1 AND d.id = $2`,
					[before.id, draft.id]
				);
				await auditNarrative(
					client,
					userId,
					'narrative_edit',
					'narrative_summaries',
					before.id,
					{ summary_text: before.summary_text, source_draft_id: before.source_draft_id },
					{ summary_text: summaryText, source_draft_id: draft.id },
					`Edited year ${yearKey} narrative (saved as draft #${draft.id})`
				);
			})
		);
	},

	publish: async ({ request, locals }) => setPublished(request, locals, true),
	unpublish: async ({ request, locals }) => setPublished(request, locals, false)
};

async function setPublished(request: Request, locals: App.Locals, published: boolean) {
	requireAdmin(locals);
	const data = await request.formData();
	const yearKey = data.get('year');
	if (!isValidYearKey(yearKey)) return fail(400, { error: 'Invalid year' });
	const userId = Number(locals.user!.id);

	return runAction(() =>
		withTransaction(async (client) => {
			const expected = readExpectedDraft(data);
			await lockYear(client, yearKey);
			const before = (
				await client.query<{ id: number; is_published: boolean; source_draft_id: string | null }>(
					`SELECT id, is_published, source_draft_id::text AS source_draft_id
					   FROM narrative_summaries WHERE scope = 'year' AND scope_key = $1 FOR UPDATE`,
					[yearKey]
				)
			).rows[0];
			if (!before) throw new ActionFailure(404, 'No narrative exists for this year yet');
			// Publish exactly the text the dialog was opened on.
			if (published && expected !== undefined && expected !== before.source_draft_id) {
				throw new ActionFailure(
					409,
					`The ${yearKey} text changed (in another tab?) since you opened Publish. Read it again, then publish.`
				);
			}

			await client.query(`UPDATE narrative_summaries SET is_published = $2 WHERE id = $1`, [before.id, published]);
			await auditNarrative(
				client,
				userId,
				published ? 'narrative_publish' : 'narrative_unpublish',
				'narrative_summaries',
				before.id,
				{ is_published: before.is_published },
				{ is_published: published },
				`${published ? 'Published' : 'Unpublished'} year ${yearKey} narrative`
			);
		})
	);
}
