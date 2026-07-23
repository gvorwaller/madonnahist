/**
 * Admin PDF/print export (Phase H of
 * docs/2026-07-21-next-phases-search-viewer-narrative-plan.md).
 *
 * Generate enqueues a pdf_export job_runs row for the enrichment worker
 * (backend/workers/enrichment-worker.ts's processPdfExport) to render via
 * headless Chromium and upload to Spaces; this page never renders or
 * touches Spaces directly except to delete an object on Delete (deleteObject,
 * the same app-side Spaces helper src/lib/ingest/spaces-upload.ts already
 * exposes for ingest). Download is a separate admin-only streaming endpoint
 * (./download/[id]/+server.ts) — this page only links to it by pdf_exports
 * row id, never by object key.
 */
import { query, withTransaction } from '$lib/db';
import { error, fail } from '@sveltejs/kit';
import { getYearCoverage } from '$lib/server/viewer';
import { deleteObject } from '$lib/ingest/spaces-upload';
import type { Actions, PageServerLoad } from './$types';

function requireAdmin(locals: App.Locals) {
	if (!locals.user || locals.user.role !== 'admin') {
		error(403, 'Admin access required');
	}
}

function isValidYearKey(s: string | null | undefined): s is string {
	return typeof s === 'string' && /^\d{4}$/.test(s);
}

interface ExportRow {
	id: number;
	scope_key: string;
	byte_size: string | number;
	day_count: number;
	created_at: string;
}

export const load: PageServerLoad = async ({ locals }) => {
	requireAdmin(locals);

	const [yearCoverage, exportsRes, inFlightRes] = await Promise.all([
		getYearCoverage(),
		query<ExportRow>(
			`SELECT id, scope_key, byte_size, day_count, created_at::text AS created_at
			   FROM pdf_exports WHERE scope = 'year' ORDER BY created_at DESC`
		),
		// Both 'pending' AND 'in_progress' count as "already in flight" here —
		// unlike narrative_summary's dedupe (only 'pending' counts there, see
		// src/routes/admin/narratives/+page.server.ts), because the worker
		// claims pdf_export jobs one at a time on purpose (Chromium is
		// memory-heavy on the shared droplet, per the plan's Phase H v1
		// design) — a second enqueue while one is actively rendering (which
		// can take a while for a large year) is exactly what this dedupe must
		// prevent, not just the case where nothing has started yet.
		query<{ scope_key: string }>(
			`SELECT payload->>'scope_key' AS scope_key FROM job_runs
			  WHERE job_type = 'pdf_export' AND status IN ('pending', 'in_progress') AND payload->>'scope' = 'year'`
		)
	]);

	const inFlightYears = new Set(inFlightRes.rows.map((r) => r.scope_key));

	const years = yearCoverage
		.filter((y) => y.accepted > 0)
		.map((y) => ({
			year: y.year,
			accepted: y.accepted,
			total: y.total,
			percent: y.percent,
			pending: inFlightYears.has(String(y.year))
		}))
		.sort((a, b) => b.year - a.year);

	const exportsList = exportsRes.rows.map((r) => ({
		id: r.id,
		year: r.scope_key,
		// BIGINT comes back from node-pg as a string — Number() here only for
		// display (human-readable size), never fed back into a query.
		byteSize: Number(r.byte_size),
		dayCount: r.day_count,
		createdAt: r.created_at
	}));

	return { years, exports: exportsList };
};

async function auditExport(
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
		[userId, action, 'pdf_exports', entityId, JSON.stringify(before), JSON.stringify(after), description]
	);
}

export const actions: Actions = {
	generate: async ({ request, locals }) => {
		requireAdmin(locals);
		const data = await request.formData();
		const yearKey = data.get('year') as string | null;
		if (!isValidYearKey(yearKey)) return fail(400, { error: 'Invalid year' });

		const pending = await query(
			`SELECT 1 FROM job_runs WHERE job_type = 'pdf_export' AND status IN ('pending', 'in_progress')
			   AND payload->>'scope' = 'year' AND payload->>'scope_key' = $1`,
			[yearKey]
		);
		if (pending.rows.length > 0) {
			return fail(409, { error: 'A PDF export for this year is already generating.' });
		}

		const userId = Number(locals.user!.id);
		await withTransaction(async (client) => {
			await client.query(`INSERT INTO job_runs (job_type, payload) VALUES ('pdf_export', $1::jsonb)`, [
				JSON.stringify({ scope: 'year', scope_key: yearKey, requested_by: userId })
			]);
			await auditExport(
				client,
				userId,
				'pdf_export_generate_enqueued',
				Number(yearKey),
				null,
				{ scope: 'year', scope_key: yearKey },
				`Enqueued pdf_export job for year ${yearKey}`
			);
		});
	},

	delete: async ({ request, locals }) => {
		requireAdmin(locals);
		const data = await request.formData();
		const idRaw = data.get('id') as string | null;
		const id = Number(idRaw);
		if (!idRaw || !Number.isInteger(id) || id <= 0) return fail(400, { error: 'Invalid export id' });

		const before = await query<{ id: number; scope_key: string; object_key: string }>(
			`SELECT id, scope_key, object_key FROM pdf_exports WHERE id = $1`,
			[id]
		);
		if (!before.rows[0]) return fail(404, { error: 'Export not found' });
		const row = before.rows[0];

		await deleteObject(row.object_key);

		const userId = Number(locals.user!.id);
		await withTransaction(async (client) => {
			await client.query(`DELETE FROM pdf_exports WHERE id = $1`, [id]);
			await auditExport(
				client,
				userId,
				'pdf_export_delete',
				id,
				{ scope_key: row.scope_key, object_key: row.object_key },
				null,
				`Deleted PDF export for year ${row.scope_key}`
			);
		});
	}
};
