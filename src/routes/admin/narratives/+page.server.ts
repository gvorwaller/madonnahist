/**
 * Admin review UI for year narrative summaries (Phase E of
 * docs/2026-07-21-next-phases-search-viewer-narrative-plan.md, item 3).
 *
 * Generate/regenerate enqueues a narrative_summary job_runs row for the
 * enrichment worker (backend/workers/enrichment-worker.ts) to pick up; this
 * page never calls the LLM directly. Publish/unpublish and inline edits are
 * app-role writes straight to narrative_summaries — the worker is
 * column-grant-restricted from ever touching is_published (migration
 * 0021_narrative_worker_grants.sql), so this admin surface is the only path
 * that can flip it.
 */
import { query, withTransaction } from '$lib/db';
import { error, fail } from '@sveltejs/kit';
import { getYearCoverage } from '$lib/server/viewer';
import type { Actions, PageServerLoad } from './$types';

function requireAdmin(locals: App.Locals) {
	if (!locals.user || locals.user.role !== 'admin') {
		error(403, 'Admin access required');
	}
}

function isValidYearKey(s: string | null | undefined): s is string {
	return typeof s === 'string' && /^\d{4}$/.test(s);
}

interface NarrativeRow {
	id: number;
	scope_key: string;
	summary_text: string;
	generated_by: string;
	generated_at: string;
	is_published: boolean;
}

export const load: PageServerLoad = async ({ locals }) => {
	requireAdmin(locals);

	const [yearCoverage, narrativesRes, pendingJobsRes] = await Promise.all([
		getYearCoverage(),
		query<NarrativeRow>(
			`SELECT id, scope_key, summary_text, generated_by, generated_at::text AS generated_at, is_published
			   FROM narrative_summaries WHERE scope = 'year'`
		),
		// Only 'pending' counts as a dedupe hit, matching 0020_entity_enrichment.sql's
		// trigger pattern: an in_progress job is expected to be reclaimed by the
		// worker's own stale-retry window, not treated as already-in-flight here.
		query<{ scope_key: string }>(
			`SELECT payload->>'scope_key' AS scope_key FROM job_runs
			  WHERE job_type = 'narrative_summary' AND status = 'pending' AND payload->>'scope' = 'year'`
		)
	]);

	const narrativeByYear = new Map(narrativesRes.rows.map((r) => [r.scope_key, r]));
	const pendingYears = new Set(pendingJobsRes.rows.map((r) => r.scope_key));

	const years = yearCoverage
		.filter((y) => y.accepted > 0)
		.map((y) => {
			const yearKey = String(y.year);
			const narrative = narrativeByYear.get(yearKey) ?? null;
			return {
				year: y.year,
				accepted: y.accepted,
				total: y.total,
				percent: y.percent,
				status: (narrative ? (narrative.is_published ? 'published' : 'draft') : 'none') as
					| 'none'
					| 'draft'
					| 'published',
				narrative,
				pendingJob: pendingYears.has(yearKey)
			};
		})
		.sort((a, b) => b.year - a.year);

	return { years };
};

async function auditNarrative(
	client: { query: (text: string, params?: unknown[]) => Promise<unknown> },
	userId: number,
	action: string,
	entityId: number,
	before: unknown,
	after: unknown,
	description: string
): Promise<void> {
	await client.query(
		`INSERT INTO audit_log (user_id, action, entity_type, entity_id, before_value, after_value, description)
		 VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)`,
		[userId, action, 'narrative_summaries', entityId, JSON.stringify(before), JSON.stringify(after), description]
	);
}

export const actions: Actions = {
	generate: async ({ request, locals }) => {
		requireAdmin(locals);
		const data = await request.formData();
		const yearKey = data.get('year') as string | null;
		if (!isValidYearKey(yearKey)) return fail(400, { error: 'Invalid year' });

		const existing = await query<{ is_published: boolean }>(
			`SELECT is_published FROM narrative_summaries WHERE scope = 'year' AND scope_key = $1`,
			[yearKey]
		);
		if (existing.rows[0]?.is_published) {
			return fail(409, { error: 'This year is published — use "Unpublish & Regenerate" instead.' });
		}

		const pending = await query(
			`SELECT 1 FROM job_runs WHERE job_type = 'narrative_summary' AND status = 'pending'
			   AND payload->>'scope' = 'year' AND payload->>'scope_key' = $1`,
			[yearKey]
		);
		if (pending.rows.length > 0) {
			return fail(409, { error: 'A generation job for this year is already queued.' });
		}

		await withTransaction(async (client) => {
			await client.query(`INSERT INTO job_runs (job_type, payload) VALUES ('narrative_summary', $1::jsonb)`, [
				JSON.stringify({ scope: 'year', scope_key: yearKey })
			]);
			await auditNarrative(
				client,
				Number(locals.user!.id),
				'narrative_generate_enqueued',
				Number(yearKey),
				null,
				{ scope: 'year', scope_key: yearKey },
				`Enqueued narrative_summary job for year ${yearKey}`
			);
		});
	},

	saveEdit: async ({ request, locals }) => {
		requireAdmin(locals);
		const data = await request.formData();
		const yearKey = data.get('year') as string | null;
		const summaryText = ((data.get('summaryText') as string) ?? '').trim();
		if (!isValidYearKey(yearKey)) return fail(400, { error: 'Invalid year' });
		if (!summaryText) return fail(400, { error: 'Summary text is required' });

		const before = await query<{ id: number; summary_text: string }>(
			`SELECT id, summary_text FROM narrative_summaries WHERE scope = 'year' AND scope_key = $1`,
			[yearKey]
		);
		if (!before.rows[0]) return fail(404, { error: 'No narrative draft exists for this year yet' });

		await withTransaction(async (client) => {
			await client.query(`UPDATE narrative_summaries SET summary_text = $2 WHERE id = $1`, [
				before.rows[0].id,
				summaryText
			]);
			await auditNarrative(
				client,
				Number(locals.user!.id),
				'narrative_edit',
				before.rows[0].id,
				{ summary_text: before.rows[0].summary_text },
				{ summary_text: summaryText },
				`Edited year ${yearKey} narrative draft`
			);
		});
	},

	publish: async ({ request, locals }) => {
		requireAdmin(locals);
		const data = await request.formData();
		const yearKey = data.get('year') as string | null;
		if (!isValidYearKey(yearKey)) return fail(400, { error: 'Invalid year' });

		const before = await query<{ id: number; is_published: boolean }>(
			`SELECT id, is_published FROM narrative_summaries WHERE scope = 'year' AND scope_key = $1`,
			[yearKey]
		);
		if (!before.rows[0]) return fail(404, { error: 'No narrative draft exists for this year yet' });

		await withTransaction(async (client) => {
			await client.query(`UPDATE narrative_summaries SET is_published = true WHERE id = $1`, [before.rows[0].id]);
			await auditNarrative(
				client,
				Number(locals.user!.id),
				'narrative_publish',
				before.rows[0].id,
				{ is_published: before.rows[0].is_published },
				{ is_published: true },
				`Published year ${yearKey} narrative`
			);
		});
	},

	unpublish: async ({ request, locals }) => {
		requireAdmin(locals);
		const data = await request.formData();
		const yearKey = data.get('year') as string | null;
		if (!isValidYearKey(yearKey)) return fail(400, { error: 'Invalid year' });

		const before = await query<{ id: number; is_published: boolean }>(
			`SELECT id, is_published FROM narrative_summaries WHERE scope = 'year' AND scope_key = $1`,
			[yearKey]
		);
		if (!before.rows[0]) return fail(404, { error: 'No narrative draft exists for this year yet' });

		await withTransaction(async (client) => {
			await client.query(`UPDATE narrative_summaries SET is_published = false WHERE id = $1`, [before.rows[0].id]);
			await auditNarrative(
				client,
				Number(locals.user!.id),
				'narrative_unpublish',
				before.rows[0].id,
				{ is_published: before.rows[0].is_published },
				{ is_published: false },
				`Unpublished year ${yearKey} narrative`
			);
		});
	},

	unpublishAndRegenerate: async ({ request, locals }) => {
		requireAdmin(locals);
		const data = await request.formData();
		const yearKey = data.get('year') as string | null;
		if (!isValidYearKey(yearKey)) return fail(400, { error: 'Invalid year' });

		const before = await query<{ id: number; is_published: boolean }>(
			`SELECT id, is_published FROM narrative_summaries WHERE scope = 'year' AND scope_key = $1`,
			[yearKey]
		);
		if (!before.rows[0]) return fail(404, { error: 'No narrative draft exists for this year yet' });

		const pending = await query(
			`SELECT 1 FROM job_runs WHERE job_type = 'narrative_summary' AND status = 'pending'
			   AND payload->>'scope' = 'year' AND payload->>'scope_key' = $1`,
			[yearKey]
		);
		if (pending.rows.length > 0) {
			return fail(409, { error: 'A generation job for this year is already queued.' });
		}

		await withTransaction(async (client) => {
			await client.query(`UPDATE narrative_summaries SET is_published = false WHERE id = $1`, [before.rows[0].id]);
			await client.query(`INSERT INTO job_runs (job_type, payload) VALUES ('narrative_summary', $1::jsonb)`, [
				JSON.stringify({ scope: 'year', scope_key: yearKey })
			]);
			await auditNarrative(
				client,
				Number(locals.user!.id),
				'narrative_unpublish_and_regenerate',
				before.rows[0].id,
				{ is_published: before.rows[0].is_published },
				{ is_published: false, regenerate_enqueued: true },
				`Unpublished year ${yearKey} narrative and enqueued regeneration`
			);
		});
	}
};
