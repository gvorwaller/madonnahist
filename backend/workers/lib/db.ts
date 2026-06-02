import pg from 'pg';

const { Pool } = pg;

let pool: pg.Pool | undefined;

function getPool(): pg.Pool {
	if (!pool) {
		pool = new Pool({
			host: process.env.PGHOST ?? '127.0.0.1',
			port: Number(process.env.PGPORT ?? 5435),
			database: process.env.PGDATABASE ?? 'madonnahist',
			user: process.env.WORKER_PGUSER ?? 'madonnahist_worker',
			password: process.env.WORKER_PGPASSWORD,
			max: 3,
			idleTimeoutMillis: 30_000,
			application_name: 'madonnahist-ocr-worker'
		});
	}
	return pool;
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
	text: string,
	params?: unknown[]
): Promise<pg.QueryResult<T>> {
	return getPool().query<T>(text, params as never);
}

export async function withClient<T>(
	fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
	const client = await getPool().connect();
	try {
		return await fn(client);
	} finally {
		client.release();
	}
}

export async function withTransaction<T>(
	fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
	const client = await getPool().connect();
	try {
		await client.query('BEGIN');
		const result = await fn(client);
		await client.query('COMMIT');
		return result;
	} catch (err) {
		try { await client.query('ROLLBACK'); } catch { /* secondary */ }
		throw err;
	} finally {
		client.release();
	}
}

export async function shutdown(): Promise<void> {
	if (pool) {
		await pool.end();
		pool = undefined;
	}
}
