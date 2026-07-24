import os from 'node:os';
import { readFile } from 'node:fs/promises';
import { query } from '$lib/db';
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

async function getSwapInfo(): Promise<{ swapTotal: number; swapFree: number; memAvailable: number } | null> {
	try {
		const text = await readFile('/proc/meminfo', 'utf8');
		const parse = (key: string) => {
			const m = text.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'));
			return m ? parseInt(m[1], 10) : 0;
		};
		return {
			swapTotal: parse('SwapTotal'),
			swapFree: parse('SwapFree'),
			memAvailable: parse('MemAvailable')
		};
	} catch {
		return null;
	}
}

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user || locals.user.role !== 'admin') error(403, 'Admin only');

	const mem = process.memoryUsage();
	const swap = await getSwapInfo();

	const jobRes = await query<{
		pending: number;
		in_progress: number;
		done: number;
		failed: number;
		canceled: number;
		last_completed: string | null;
	}>(`SELECT
		COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
		COUNT(*) FILTER (WHERE status = 'in_progress')::int AS in_progress,
		COUNT(*) FILTER (WHERE status = 'done')::int AS done,
		COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
		COUNT(*) FILTER (WHERE status = 'canceled')::int AS canceled,
		MAX(completed_at)::text AS last_completed
	FROM job_runs`);

	const heartbeatRes = await query<{ value: string; updated_at: string }>(
		`SELECT value::text, updated_at::text FROM app_state WHERE key = 'worker_heartbeat'`
	);

	const enrichmentHeartbeatRes = await query<{ value: string; updated_at: string }>(
		`SELECT value::text, updated_at::text FROM app_state WHERE key = 'enrichment_worker_heartbeat'`
	);

	// Nightly DB backup health (td-ff8a42) — written by
	// scripts/droplet/db-backup-to-spaces.sh after each run.
	const dbBackupRes = await query<{ value: string; updated_at: string }>(
		`SELECT value::text, updated_at::text FROM app_state WHERE key = 'db_backup_last_status'`
	);

	const pageStatsRes = await query<{
		total_pages: number;
		total_days: number;
		days_with_ocr: number;
		days_with_corrections: number;
		days_with_crops: number;
	}>(`SELECT
		(SELECT COUNT(*)::int FROM calendar_pages) AS total_pages,
		(SELECT COUNT(*)::int FROM calendar_days) AS total_days,
		(SELECT COUNT(*)::int FROM calendar_days WHERE latest_ocr_run_id IS NOT NULL) AS days_with_ocr,
		(SELECT COUNT(*)::int FROM calendar_days WHERE correction_status = 'accepted') AS days_with_corrections,
		(SELECT COUNT(*)::int FROM calendar_days WHERE day_image_path IS NOT NULL) AS days_with_crops
	`);

	return {
		dbBackup: dbBackupRes.rows[0]
			? { ...JSON.parse(dbBackupRes.rows[0].value), updatedAt: dbBackupRes.rows[0].updated_at }
			: null,
		process: {
			rss: Math.round(mem.rss / 1024 / 1024),
			heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
			heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
			external: Math.round(mem.external / 1024 / 1024),
			uptime: Math.round(process.uptime())
		},
		system: {
			totalMem: Math.round(os.totalmem() / 1024 / 1024),
			freeMem: Math.round(os.freemem() / 1024 / 1024),
			loadAvg: os.loadavg().map(v => Math.round(v * 100) / 100),
			swapTotal: swap ? Math.round(swap.swapTotal / 1024) : null,
			swapFree: swap ? Math.round(swap.swapFree / 1024) : null,
			memAvailable: swap ? Math.round(swap.memAvailable / 1024) : null,
			cpus: os.cpus().length
		},
		jobs: jobRes.rows[0] ?? { pending: 0, in_progress: 0, done: 0, failed: 0, canceled: 0, last_completed: null },
		worker: (() => {
			if (!heartbeatRes.rows[0]) return null;
			try {
				const parsed = JSON.parse(heartbeatRes.rows[0].value);
				const updatedAt = new Date(heartbeatRes.rows[0].updated_at).getTime();
				const ageSec = Math.round((Date.now() - updatedAt) / 1000);
				return { ...parsed, updated_at: heartbeatRes.rows[0].updated_at, age_seconds: ageSec };
			} catch { return null; }
		})(),
		enrichmentWorker: (() => {
			if (!enrichmentHeartbeatRes.rows[0]) return null;
			try {
				const parsed = JSON.parse(enrichmentHeartbeatRes.rows[0].value);
				const updatedAt = new Date(enrichmentHeartbeatRes.rows[0].updated_at).getTime();
				const ageSec = Math.round((Date.now() - updatedAt) / 1000);
				return { ...parsed, updated_at: enrichmentHeartbeatRes.rows[0].updated_at, age_seconds: ageSec };
			} catch { return null; }
		})(),
		ingestion: pageStatsRes.rows[0] ?? { total_pages: 0, total_days: 0, days_with_ocr: 0, days_with_corrections: 0, days_with_crops: 0 }
	};
};
