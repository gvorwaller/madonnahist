/**
 * Legacy spawn interface — now a no-op.
 *
 * The persistent PM2 worker (madonnahist-worker, --daemon mode) polls
 * job_runs automatically. Jobs are enqueued by cancelAndRequeueOcr()
 * in the grid-align action; the daemon picks them up within 5 seconds.
 */
export async function spawnOcrWorker(_pageId: number): Promise<void> {
	// No-op: daemon worker polls job_runs automatically.
}
