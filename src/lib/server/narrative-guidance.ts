/**
 * Saved guidance for year narratives (td-f1f49b).
 *
 * House style: one admin-written text for every year, in app_state (key
 * narrative_style_guidance, value {"text": "..."}), same storage as the
 * viewer About text (src/lib/server/about.ts).
 * Year notes: one row per year in narrative_guidance (migration 0033).
 *
 * Both are copied into each narrative_summary job when it is queued, so a
 * job always runs with the guidance it was queued with.
 */
import type pg from 'pg';
import { query } from '$lib/db';

const STYLE_KEY = 'narrative_style_guidance';

/** Read through `client` when inside a transaction, else the shared pool. */
function run<T extends pg.QueryResultRow>(client: pg.PoolClient | undefined, text: string, params: unknown[]) {
	return client ? client.query<T>(text, params) : query<T>(text, params);
}

export async function getStyleGuidance(client?: pg.PoolClient): Promise<string> {
	const res = await run<{ value: { text?: unknown } }>(client, `SELECT value FROM app_state WHERE key = $1`, [STYLE_KEY]);
	const text = res.rows[0]?.value?.text;
	return typeof text === 'string' ? text : '';
}

/** Save (or clear, with empty text) inside the caller's transaction. */
export async function saveStyleGuidance(client: pg.PoolClient, text: string): Promise<void> {
	if (!text) {
		await client.query(`DELETE FROM app_state WHERE key = $1`, [STYLE_KEY]);
		return;
	}
	await client.query(
		`INSERT INTO app_state (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
		 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
		[STYLE_KEY, JSON.stringify({ text })]
	);
}

export async function getYearNotes(yearKey: string, client?: pg.PoolClient): Promise<string> {
	const res = await run<{ guidance_text: string }>(
		client,
		`SELECT guidance_text FROM narrative_guidance WHERE scope = 'year' AND scope_key = $1`,
		[yearKey]
	);
	return res.rows[0]?.guidance_text ?? '';
}

/** Save (or clear, with empty text) a year's notes inside the caller's transaction. */
export async function saveYearNotes(client: pg.PoolClient, yearKey: string, text: string, userId: number): Promise<void> {
	if (!text) {
		await client.query(`DELETE FROM narrative_guidance WHERE scope = 'year' AND scope_key = $1`, [yearKey]);
		return;
	}
	await client.query(
		`INSERT INTO narrative_guidance (scope, scope_key, guidance_text, updated_by, updated_at)
		 VALUES ('year', $1, $2, $3, NOW())
		 ON CONFLICT (scope, scope_key)
		 DO UPDATE SET guidance_text = EXCLUDED.guidance_text, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
		[yearKey, text, userId]
	);
}
