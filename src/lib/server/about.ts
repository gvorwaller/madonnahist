/**
 * "About this archive" text for the family viewer menu (V3 Slice 1b).
 * Admin-editable plain text kept in app_state (key viewer_about,
 * value {"text": "..."}); blank lines separate paragraphs. Until an admin
 * saves something, DEFAULT_ABOUT is shown.
 */
import type pg from 'pg';
import { query } from '$lib/db';

const KEY = 'viewer_about';
export const MAX_ABOUT_LENGTH = 6000;

export const DEFAULT_ABOUT = `For about sixty years, Madonna kept a calendar and wrote a few lines in it nearly every day: who visited, where the family went, what happened at church, school and work.

This archive brings those calendars together. Each page is photographed, the handwriting is read by a computer, and Madonna checks and corrects every day before it appears here. Days that haven't been checked yet stay hidden.

The year stories and Family Stories are written by AI from Madonna's corrected entries, and each one is reviewed before the family sees it. New days are added every week.`;

export async function getAboutText(): Promise<{ text: string; isDefault: boolean }> {
	const res = await query<{ value: { text?: unknown } }>(
		`SELECT value FROM app_state WHERE key = $1`,
		[KEY]
	);
	const text = res.rows[0]?.value?.text;
	return typeof text === 'string' && text.trim()
		? { text, isDefault: false }
		: { text: DEFAULT_ABOUT, isDefault: true };
}

/** Normalize line endings and outer whitespace; caller enforces the length cap. */
export function cleanAboutText(raw: string): string {
	return raw.replace(/\r\n?/g, '\n').trim();
}

/** Paragraphs for display: split on blank lines, keep single line breaks. */
export function aboutParagraphs(text: string): string[] {
	return text
		.split(/\n\s*\n/)
		.map((p) => p.trim())
		.filter(Boolean);
}

/** Save (or clear back to the default, with empty text) inside a transaction. */
export async function saveAboutText(client: pg.PoolClient, text: string): Promise<void> {
	if (!text) {
		await client.query(`DELETE FROM app_state WHERE key = $1`, [KEY]);
		return;
	}
	await client.query(
		`INSERT INTO app_state (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
		 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
		[KEY, JSON.stringify({ text })]
	);
}
