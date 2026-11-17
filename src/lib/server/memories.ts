/**
 * Memories (td-bc2c29 / td-76a40f, first slice; migration 0032). Plan:
 * docs/2026-11-16-writers-and-memories-plan.md (CODEX #1–#9, AGY2 #1–#10).
 *
 * Rules every caller relies on:
 *   - Only a user linked to a writer with adds_memories may write
 *     (getWriterForUser). /app admits every signed-in role, so the menu
 *     flag is not a guard (CODEX #2).
 *   - writer_id and created_by always come from the session, never a form.
 *   - Every read-for-edit and every write is scoped in SQL to
 *     created_by = the signed-in user, under FOR UPDATE. Someone else's id
 *     is "not found", which doesn't confirm it exists.
 *   - A draft (shared_at NULL) is visible only to the person who typed it.
 *   - The text goes to memory_revisions (private, append-only); audit_log
 *     rows carry metadata only, because workers and /admin/audit can read
 *     audit_log (CODEX #1).
 *   - Saving never changes sharing as a side effect; a save carries the
 *     version it loaded and is refused if the memory moved since (CODEX #3).
 */
import { error } from '@sveltejs/kit';
import type pg from 'pg';
import { query, withTransaction } from '$lib/db';
import { isValidEntryDate } from '$server/viewer';
import { backTarget, withFrom } from '$lib/viewer/nav';
import {
	MEMORY_MAX,
	PRECISIONS,
	memoryDateLabel,
	memoryPageHref,
	type MemoryFields,
	type MemoryView,
	type Precision
} from '$lib/viewer/memories';

export interface Writer {
	id: number;
	displayName: string;
}

/** The writer this person writes as, only when they may add memories. */
export async function getWriterForUser(userId: number): Promise<Writer | null> {
	if (!Number.isInteger(userId) || userId <= 0) return null;
	const res = await query<{ id: number; display_name: string }>(
		`SELECT w.id, w.display_name
		   FROM writers w
		   JOIN users u ON u.id = w.user_id
		  WHERE w.user_id = $1 AND w.adds_memories AND u.removed_at IS NULL`,
		[userId]
	);
	const r = res.rows[0];
	return r ? { id: r.id, displayName: r.display_name } : null;
}

/**
 * The signed-in writer, or a 403. Every /app/memories loader and action
 * calls this; the menu link is not a guard (CODEX #2).
 */
export async function requireWriter(
	locals: App.Locals
): Promise<{ userId: number; writer: Writer }> {
	const userId = viewerIdOf(locals);
	const writer = userId > 0 ? await getWriterForUser(userId) : null;
	if (!writer) error(403, 'Only family members who write memories can open this page.');
	return { userId, writer };
}

/** Signed-in person's numeric id; 0 for the PDF renderer or nobody. */
export function viewerIdOf(locals: App.Locals): number {
	const id = Number(locals.user?.id);
	return Number.isInteger(id) && id > 0 ? id : 0;
}

interface Row {
	id: number;
	writer_name: string;
	memory_date: string;
	date_precision: Precision;
	body: string;
	shared: boolean;
	created_by: number;
	version: string;
}

const SELECT_VIEW = `
	SELECT m.id, w.display_name AS writer_name, m.memory_date::text AS memory_date,
	       m.date_precision, m.body, (m.shared_at IS NOT NULL) AS shared,
	       m.created_by, m.updated_at::text AS version
	  FROM memories m
	  JOIN writers w ON w.id = m.writer_id`;

function toView(r: Row, viewerId: number): MemoryView {
	return {
		id: r.id,
		writerName: r.writer_name,
		date: r.memory_date,
		precision: r.date_precision,
		body: r.body,
		shared: r.shared,
		mine: viewerId > 0 && r.created_by === viewerId,
		version: r.version
	};
}

/**
 * Memories a page may show: shared ones, plus the viewer's own drafts.
 * Shared first (oldest first), then drafts.
 */
async function visible(
	precision: Precision,
	date: string,
	viewerId: number
): Promise<MemoryView[]> {
	const res = await query<Row>(
		`${SELECT_VIEW}
		  WHERE m.date_precision = $1 AND m.memory_date = $2::date
		    AND (m.shared_at IS NOT NULL OR m.created_by = $3)
		  ORDER BY (m.shared_at IS NULL), m.shared_at, m.created_at, m.id`,
		[precision, date, viewerId]
	);
	return res.rows.map((r) => toView(r, viewerId));
}

export function getDayMemories(date: string, viewerId: number): Promise<MemoryView[]> {
	return visible('day', date, viewerId);
}

/** key: "YYYY-MM" for a month, "YYYY" for a year. */
export function getPeriodMemories(
	precision: 'month' | 'year',
	key: string,
	viewerId: number
): Promise<MemoryView[]> {
	const date = precision === 'month' ? `${key}-01` : `${key}-01-01`;
	return visible(precision, date, viewerId);
}

/** Everything this person typed: drafts first, then by memory date. */
export async function listMyMemories(userId: number): Promise<MemoryView[]> {
	const res = await query<Row>(
		`${SELECT_VIEW}
		  WHERE m.created_by = $1
		  ORDER BY (m.shared_at IS NOT NULL), m.memory_date DESC, m.updated_at DESC, m.id DESC`,
		[userId]
	);
	return res.rows.map((r) => toView(r, userId));
}

/** One of this person's own memories, or null (also for someone else's). */
export async function getMyMemory(userId: number, id: number): Promise<MemoryView | null> {
	if (!Number.isInteger(id) || id <= 0) return null;
	const res = await query<Row>(`${SELECT_VIEW} WHERE m.id = $1 AND m.created_by = $2`, [
		id,
		userId
	]);
	return res.rows[0] ? toView(res.rows[0], userId) : null;
}

// ─────────────────────────────────────────────────────────────────
// Input
// ─────────────────────────────────────────────────────────────────

export interface MemoryInput {
	date: string;
	precision: Precision;
	body: string;
}

/** Latest date anywhere on Earth right now (UTC+14), so no evening entry is "future" (AGY2 #10). */
export function latestToday(now = Date.now()): string {
	return new Date(now + 14 * 3_600_000).toISOString().slice(0, 10);
}

const FIRST_DATE = '1900-01-01';

/**
 * Reads When (precision + year/month/day) and the text from a form. The
 * full date is validated before a month or year memory is moved to the 1st,
 * so Feb 30 is refused rather than rolled over (CODEX #9).
 */
export function readMemoryForm(
	form: FormData
): { ok: true; input: MemoryInput } | { ok: false; error: string } {
	const precision = String(form.get('precision') ?? '') as Precision;
	if (!PRECISIONS.includes(precision)) {
		return { ok: false, error: 'Choose whether this memory is about a day, a month or a year.' };
	}
	const y = String(form.get('year') ?? '');
	const rawM = String(form.get('month') ?? '');
	const rawD = String(form.get('day') ?? '');
	if (!y) return { ok: false, error: 'Please choose the year.' };
	if (precision !== 'year' && !rawM) return { ok: false, error: 'Please choose the month.' };
	if (precision === 'day' && !rawD) return { ok: false, error: 'Please choose the day.' };
	const m = precision === 'year' ? '01' : rawM.padStart(2, '0');
	const d = precision === 'day' ? rawD.padStart(2, '0') : '01';
	const date = `${y}-${m}-${d}`;
	if (!/^\d{4}$/.test(y) || !isValidEntryDate(date)) {
		return { ok: false, error: "That date doesn't exist. Please check the year, month and day." };
	}
	if (date < FIRST_DATE) return { ok: false, error: 'Please choose a date from 1900 onward.' };
	if (date > latestToday()) return { ok: false, error: "That date hasn't happened yet." };

	const body = String(form.get('body') ?? '')
		.replace(/\r\n?/g, '\n')
		.trim();
	if (!body) return { ok: false, error: 'Please write the memory before saving.' };
	if (body.length > MEMORY_MAX) {
		return {
			ok: false,
			error: `That's ${body.length.toLocaleString('en-US')} characters; the most is ${MEMORY_MAX.toLocaleString('en-US')}. Please shorten it or split it into two memories.`
		};
	}
	return { ok: true, input: { date, precision, body } };
}

/** Form values as typed, so a refused save keeps them (also without JS). */
export function typedValues(form: FormData): MemoryFields {
	const p = String(form.get('precision') ?? 'day');
	return {
		precision: p === 'month' || p === 'year' ? p : 'day',
		year: String(form.get('year') ?? ''),
		month: String(form.get('month') ?? ''),
		day: String(form.get('day') ?? ''),
		body: String(form.get('body') ?? '')
	};
}

/** Where to land after saving: the page the memory shows on. */
export function afterSave(
	id: number,
	date: string,
	precision: MemoryFields['precision'],
	from: string | null
): string {
	const page = memoryPageHref(date, precision);
	const back = backTarget(from, '');
	// Keep "◂ My memories" when that's where the writer started.
	const href = back.startsWith('/app/memories') ? withFrom(page, '/app/memories') : page;
	return `${href}#m-${id}`;
}

// ─────────────────────────────────────────────────────────────────
// Writes
// ─────────────────────────────────────────────────────────────────

/** The memory isn't this person's, or no longer exists. */
export class MemoryNotFound extends Error {}
/** The memory changed after this form was loaded. */
export class MemoryMoved extends Error {}

interface Locked {
	id: number;
	writer_id: number;
	memory_date: string;
	date_precision: Precision;
	body: string;
	shared: boolean;
	version: string;
}

async function lockMine(client: pg.PoolClient, userId: number, id: number): Promise<Locked> {
	if (!Number.isInteger(id) || id <= 0) throw new MemoryNotFound();
	const res = await client.query<Locked>(
		`SELECT id, writer_id, memory_date::text AS memory_date, date_precision, body,
		        (shared_at IS NOT NULL) AS shared, updated_at::text AS version
		   FROM memories
		  WHERE id = $1 AND created_by = $2
		  FOR UPDATE`,
		[id, userId]
	);
	if (!res.rows[0]) throw new MemoryNotFound();
	return res.rows[0];
}

type Action = 'create' | 'edit' | 'share' | 'unshare' | 'delete';

/** Private text copy + metadata-only audit row, in the caller's transaction. */
async function record(
	client: pg.PoolClient,
	userId: number,
	action: Action,
	m: { id: number; writer_id: number; memory_date: string; date_precision: Precision; body: string; shared: boolean },
	before: Record<string, unknown> | null
): Promise<void> {
	await client.query(
		`INSERT INTO memory_revisions
		   (memory_id, action, writer_id, memory_date, date_precision, body, shared, revised_by)
		 VALUES ($1, $2, $3, $4::date, $5, $6, $7, $8)`,
		[m.id, action, m.writer_id, m.memory_date, m.date_precision, m.body, m.shared, userId]
	);
	const when = memoryDateLabel(m.memory_date, m.date_precision);
	const description = {
		create: `Added a memory of ${when}${m.shared ? ' and shared it' : ' (draft)'}`,
		edit: `Edited a memory of ${when}`,
		share: `Shared a memory of ${when} with the family`,
		unshare: `Made a memory of ${when} private again`,
		delete: `Deleted a memory of ${when}`
	}[action];
	// Never the text: workers and /admin/audit can read audit_log.
	const meta = (x: { memory_date: string; date_precision: string; shared: boolean; body: string }) => ({
		date: x.memory_date,
		precision: x.date_precision,
		shared: x.shared,
		length: x.body.length
	});
	await client.query(
		`INSERT INTO audit_log (user_id, action, entity_type, entity_id, before_value, after_value, description)
		 VALUES ($1, $2, 'memories', $3, $4::jsonb, $5::jsonb, $6)`,
		[
			userId,
			`memory_${action}`,
			m.id,
			before ? JSON.stringify(before) : null,
			action === 'delete' ? null : JSON.stringify(meta(m)),
			description
		]
	);
}

function metaOf(m: Locked) {
	return { date: m.memory_date, precision: m.date_precision, shared: m.shared, length: m.body.length };
}

export async function createMemory(
	userId: number,
	writer: Writer,
	input: MemoryInput,
	share: boolean
): Promise<number> {
	return withTransaction(async (client) => {
		const res = await client.query<{ id: number }>(
			`INSERT INTO memories (writer_id, created_by, memory_date, date_precision, body, shared_at)
			 VALUES ($1, $2, $3::date, $4, $5, CASE WHEN $6 THEN NOW() END)
			 RETURNING id`,
			[writer.id, userId, input.date, input.precision, input.body, share]
		);
		const id = res.rows[0].id;
		await record(
			client,
			userId,
			'create',
			{
				id,
				writer_id: writer.id,
				memory_date: input.date,
				date_precision: input.precision,
				body: input.body,
				shared: share
			},
			null
		);
		return id;
	});
}

/**
 * Save edits. `share` true also shares a draft ("Save and share"); false
 * keeps the current sharing ("Save draft" / "Save changes"). Refused with
 * MemoryMoved when `version` isn't what's stored now.
 */
export async function updateMemory(
	userId: number,
	id: number,
	input: MemoryInput,
	version: string,
	share: boolean
): Promise<void> {
	await withTransaction(async (client) => {
		const cur = await lockMine(client, userId, id);
		if (cur.version !== version) throw new MemoryMoved();
		const sharing = share && !cur.shared;
		const changed =
			cur.body !== input.body ||
			cur.memory_date !== input.date ||
			cur.date_precision !== input.precision;
		if (!changed && !sharing) return;
		await client.query(
			`UPDATE memories
			    SET memory_date = $3::date, date_precision = $4, body = $5,
			        shared_at = CASE WHEN $6 THEN NOW() ELSE shared_at END,
			        updated_at = clock_timestamp()
			  WHERE id = $1 AND created_by = $2`,
			[id, userId, input.date, input.precision, input.body, sharing]
		);
		await record(
			client,
			userId,
			sharing ? 'share' : 'edit',
			{
				id,
				writer_id: cur.writer_id,
				memory_date: input.date,
				date_precision: input.precision,
				body: input.body,
				shared: cur.shared || sharing
			},
			metaOf(cur)
		);
	});
}

/**
 * Share or unshare without touching the text. Like a save, it carries the
 * version the page loaded, so a stale tab can't act on (or quietly adopt)
 * text it never saw (CODEX code review #1). Returns the new version.
 */
export async function setShared(
	userId: number,
	id: number,
	shared: boolean,
	version: string
): Promise<string> {
	return withTransaction(async (client) => {
		const cur = await lockMine(client, userId, id);
		if (cur.version !== version) throw new MemoryMoved();
		if (cur.shared === shared) return cur.version;
		const res = await client.query<{ version: string }>(
			`UPDATE memories
			    SET shared_at = CASE WHEN $3 THEN NOW() END, updated_at = clock_timestamp()
			  WHERE id = $1 AND created_by = $2
			  RETURNING updated_at::text AS version`,
			[id, userId, shared]
		);
		await record(client, userId, shared ? 'share' : 'unshare', { ...cur, shared }, metaOf(cur));
		return res.rows[0].version;
	});
}

/**
 * Delete; the text stays in memory_revisions so it can be recovered by
 * hand. Refused if the memory changed since the page loaded it.
 */
export async function deleteMemory(
	userId: number,
	id: number,
	version: string
): Promise<{ date: string; precision: Precision }> {
	return withTransaction(async (client) => {
		const cur = await lockMine(client, userId, id);
		if (cur.version !== version) throw new MemoryMoved();
		await client.query(`DELETE FROM memories WHERE id = $1 AND created_by = $2`, [id, userId]);
		await record(client, userId, 'delete', cur, metaOf(cur));
		return { date: cur.memory_date, precision: cur.date_precision };
	});
}
