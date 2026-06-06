import { spawn } from 'child_process';
import { openSync, existsSync, mkdirSync } from 'fs';
import { query } from '$lib/db';

const STALE_THRESHOLD_MINUTES = 10;

function getLogPath(): string {
	const pmLogDir = '/var/log/pm2';
	if (existsSync(pmLogDir)) return `${pmLogDir}/madonnahist-ocr-worker.log`;
	return 'ocr-worker.log';
}

/**
 * Check if a worker is already running for this page (in_progress job within
 * the stale threshold). Returns true if a spawn should be skipped.
 */
async function isWorkerRunning(pageId: number): Promise<boolean> {
	const res = await query<{ id: number }>(
		`SELECT id FROM job_runs
		  WHERE job_type = 'page_ocr'
		    AND payload->>'page_id' = $1::text
		    AND status = 'in_progress'
		    AND started_at > NOW() - INTERVAL '${STALE_THRESHOLD_MINUTES} minutes'
		  LIMIT 1`,
		[String(pageId)]
	);
	return res.rows.length > 0;
}

/**
 * Mark the pending page_ocr job as failed so the progress UI can report the
 * spawn error instead of showing "queued" forever.
 */
async function markSpawnFailed(pageId: number, errorMsg: string): Promise<void> {
	await query(
		`UPDATE job_runs
		    SET status = 'failed', last_error = $2, completed_at = NOW()
		  WHERE job_type = 'page_ocr'
		    AND payload->>'page_id' = $1::text
		    AND status = 'pending'`,
		[String(pageId), errorMsg.slice(0, 500)]
	);
}

export async function spawnOcrWorker(pageId: number): Promise<void> {
	try {
		if (await isWorkerRunning(pageId)) return;

		const logPath = getLogPath();
		const out = openSync(logPath, 'a');

		const child = spawn('npx', [
			'tsx', '--env-file=.env',
			'backend/workers/ocr-worker.ts',
			`--page-id=${pageId}`
		], {
			detached: true,
			stdio: ['ignore', out, out],
			shell: true
		});

		child.on('error', async (err) => {
			const msg = `worker spawn error: ${err.message}`;
			console.error(`[spawnOcrWorker] ${msg}`);
			await markSpawnFailed(pageId, msg);
		});

		child.unref();
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`[spawnOcrWorker] Failed to spawn: ${msg}`);
		await markSpawnFailed(pageId, `spawn failed: ${msg}`);
	}
}
