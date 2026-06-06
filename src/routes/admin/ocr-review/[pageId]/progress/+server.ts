import { json, error } from '@sveltejs/kit';
import { query } from '$lib/db';
import type { RequestHandler } from './$types';

const STALE_MINUTES = 10;

export const GET: RequestHandler = async ({ params }) => {
	const pageId = Number(params.pageId);
	if (!Number.isFinite(pageId)) error(400, 'Invalid page ID');

	const pageRes = await query<{ grid_version: number }>(
		`SELECT grid_version FROM calendar_pages WHERE id = $1`, [pageId]
	);
	if (!pageRes.rows[0]) error(404, 'Page not found');
	const { grid_version } = pageRes.rows[0];

	// Stage 1: find the latest page_ocr job matching current grid_version
	const stage1Res = await query<{
		id: number;
		status: string;
		last_error: string | null;
		started_at: string | null;
		completed_at: string | null;
	}>(`
		SELECT id, status, last_error, started_at::text, completed_at::text
		  FROM job_runs
		 WHERE job_type = 'page_ocr'
		   AND payload->>'page_id' = $1::text
		   AND (payload->>'grid_version')::int = $2
		 ORDER BY enqueued_at DESC
		 LIMIT 1
	`, [String(pageId), grid_version]);

	const stage1Job = stage1Res.rows[0] ?? null;

	let stage1Status: string;
	let stage1Detail: Record<string, unknown> = {};

	if (!stage1Job) {
		stage1Status = 'none';
	} else if (stage1Job.status === 'pending') {
		stage1Status = 'queued';
	} else if (stage1Job.status === 'in_progress') {
		const startedAt = stage1Job.started_at ? new Date(stage1Job.started_at) : null;
		const stale = startedAt && (Date.now() - startedAt.getTime()) > STALE_MINUTES * 60_000;
		stage1Status = stale ? 'stalled' : 'scanning';
	} else if (stage1Job.status === 'done') {
		stage1Status = 'done';
		// Get word count and duration from the ocr_runs created by this job
		const ocrStats = await query<{ word_count: number; duration_ms: number }>(
			`SELECT
			   SUM((vendor_meta->>'wordCount')::int) AS word_count,
			   MAX((vendor_meta->>'pageLatencyMs')::int) AS duration_ms
			 FROM ocr_runs WHERE created_by_job_run_id = $1`,
			[stage1Job.id]
		);
		const stats = ocrStats.rows[0];
		stage1Detail = {
			wordCount: stats?.word_count ?? 0,
			durationMs: stats?.duration_ms ?? 0
		};
	} else if (stage1Job.status === 'failed') {
		stage1Status = 'failed';
		stage1Detail = { error: stage1Job.last_error };
	} else {
		stage1Status = 'none';
	}

	// Stage 2: count llm_cleanup jobs for this page, scoped to current grid_version
	// These are enqueued by the page_ocr job, so filter by jobs enqueued after the stage1 job
	let stage2Status = 'none';
	let stage2Detail: Record<string, unknown> = {};

	if (stage1Job && (stage1Job.status === 'done' || stage1Job.status === 'in_progress')) {
		const stage2Res = await query<{
			total: number;
			done: number;
			failed: number;
			in_progress: number;
			pending: number;
		}>(`
			SELECT
			  COUNT(*)::int AS total,
			  COUNT(*) FILTER (WHERE status = 'done')::int AS done,
			  COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
			  COUNT(*) FILTER (WHERE status = 'in_progress')::int AS in_progress,
			  COUNT(*) FILTER (WHERE status = 'pending')::int AS pending
			FROM job_runs
			WHERE job_type = 'llm_cleanup'
			  AND payload->>'page_id' = $1::text
			  AND (payload->>'grid_version')::int = $2
		`, [String(pageId), grid_version]);

		const counts = stage2Res.rows[0];

		if (counts && counts.total > 0) {
			if (counts.done === counts.total) {
				stage2Status = 'complete';
			} else if (counts.failed > 0 && counts.done + counts.failed === counts.total) {
				stage2Status = 'failed';
			} else if (counts.in_progress > 0 || counts.done > 0) {
				stage2Status = 'cleaning';
			} else {
				stage2Status = 'queued';
			}

			// Get the latest completed day preview
			const latestRes = await query<{ entry_date: string; draft_text: string }>(
				`SELECT cd.entry_date::text AS entry_date, ldr.draft_text
				   FROM llm_draft_runs ldr
				   JOIN calendar_days cd ON cd.id = ldr.day_id
				   JOIN job_runs jr ON jr.id = ldr.created_by_job_run_id
				  WHERE cd.page_id = $1
				    AND jr.job_type = 'llm_cleanup'
				    AND (jr.payload->>'grid_version')::int = $2
				  ORDER BY ldr.id DESC LIMIT 1`,
				[pageId, grid_version]
			);
			const latest = latestRes.rows[0];

			stage2Detail = {
				total: counts.total,
				done: counts.done,
				failed: counts.failed,
				latestDay: latest ? {
					date: latest.entry_date,
					preview: latest.draft_text.length > 80
						? latest.draft_text.slice(0, 77) + '...'
						: latest.draft_text
				} : null
			};
		}
	}

	const active = stage1Status !== 'none' && stage1Status !== 'done'
		|| stage2Status !== 'none' && stage2Status !== 'complete';

	return json({
		gridVersion: grid_version,
		active,
		stage1: { status: stage1Status, ...stage1Detail },
		stage2: { status: stage2Status, ...stage2Detail }
	});
};
