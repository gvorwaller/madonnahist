import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { dbHealthCheck } from '$lib/db';
import { spacesHealthCheck } from '$lib/credentials';

const VERSION = process.env.GIT_SHA ?? 'dev';

export const GET: RequestHandler = async () => {
	const [dbOk, spacesState] = await Promise.all([dbHealthCheck(), spacesHealthCheck()]);
	const db = dbOk ? 'ok' : 'error';

	const deployGate = db === 'ok' && spacesState !== 'error';
	const status = deployGate ? 200 : 503;

	return json({ db, spaces: spacesState, version: VERSION }, { status });
};
