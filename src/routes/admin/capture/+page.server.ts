/**
 * /admin/capture — capture-station intake UI.
 *
 * Runs locally on the Mac connected to the camera (the droplet can't see
 * ~/Lumix Tether). On load it discovers new image files into capture_intake;
 * actions classify (full-page OCR + quality) and ingest (upload + DB rows).
 * All actions operate on capture_intake.id — never on client-submitted paths.
 * See docs/2026-05-29-capture-intake-pipeline.md.
 */
import { readdir, stat, readFile, realpath } from 'node:fs/promises';
import { join, extname, sep } from 'node:path';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fail } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { query } from '$lib/db';
import { classifyImage } from '$lib/ingest/classify';
import { assessQuality } from '$lib/ingest/quality';
import { ingestPage } from '$lib/ingest/ingest';
import { GRID_TEMPLATES } from '$lib/ingest/day-grid';
import type { Actions, PageServerLoad } from './$types';

const TETHER_DIR = join(process.env.TETHER_DIR ?? join(process.env.HOME ?? '', 'Lumix Tether'));
const JPG_EXTS = new Set(['.jpg', '.jpeg']);
const RAW_EXTS = new Set(['.rw2']);

interface DiscoveredFile {
	session: string;
	filename: string;
	sourcePath: string;
	sizeBytes: number;
	mtime: Date;
	rawFilename: string | null;
}

/** Resolve a stored source_path and confirm it lives under TETHER_DIR (rejects symlink escapes). */
async function validatedPath(sourcePath: string): Promise<string | null> {
	try {
		const real = await realpath(sourcePath);
		const realTether = await realpath(TETHER_DIR);
		if (real === realTether || real.startsWith(realTether + sep)) return real;
		return null;
	} catch {
		return null;
	}
}

/** Scan the tether folder for JPGs (with paired RAWs). */
async function scanTether(): Promise<DiscoveredFile[]> {
	if (!existsSync(TETHER_DIR)) return [];

	const out: DiscoveredFile[] = [];
	const entries = await readdir(TETHER_DIR, { withFileTypes: true });
	const sessions = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort().reverse();

	for (const session of sessions) {
		const dir = join(TETHER_DIR, session);
		const files = await readdir(dir, { withFileTypes: true });
		const names = files.filter((f) => f.isFile()).map((f) => f.name);
		const rawByStem = new Map<string, string>();
		for (const n of names) {
			if (RAW_EXTS.has(extname(n).toLowerCase())) {
				rawByStem.set(n.slice(0, n.length - extname(n).length).toLowerCase(), n);
			}
		}

		for (const name of names) {
			if (!JPG_EXTS.has(extname(name).toLowerCase())) continue;
			const sourcePath = join(dir, name);
			const st = await stat(sourcePath);
			const stem = name.slice(0, name.length - extname(name).length).toLowerCase();
			out.push({
				session,
				filename: name,
				sourcePath,
				sizeBytes: st.size,
				mtime: st.mtime,
				rawFilename: rawByStem.get(stem) ?? null
			});
		}
	}
	return out;
}

/** Register newly-seen tether files into capture_intake (hash only what's new). */
async function discover(): Promise<void> {
	const files = await scanTether();
	if (files.length === 0) return;

	const known = await query<{ tether_session: string; camera_filename: string }>(
		`SELECT tether_session, camera_filename FROM capture_intake`
	);
	const knownSet = new Set(known.rows.map((r) => `${r.tether_session}/${r.camera_filename}`));

	for (const f of files) {
		if (knownSet.has(`${f.session}/${f.filename}`)) continue;
		const buf = await readFile(f.sourcePath);
		const hash = createHash('sha256').update(buf).digest('hex');
		await query(
			`INSERT INTO capture_intake
			   (tether_session, camera_filename, raw_filename, source_path,
			    content_hash, file_size_bytes, file_mtime)
			 VALUES ($1, $2, $3, $4, $5, $6, $7)
			 ON CONFLICT (tether_session, camera_filename) DO NOTHING`,
			[f.session, f.filename, f.rawFilename, f.sourcePath, hash, f.sizeBytes, f.mtime.toISOString()]
		);
	}
}

interface IntakeRow {
	id: number;
	tether_session: string;
	camera_filename: string;
	raw_filename: string | null;
	proposed_year: number | null;
	proposed_month: number | null;
	classification_confidence: string | null;
	quality_verdict: string;
	quality_notes: string | null;
	status: string;
	approved_year: number | null;
	approved_month: number | null;
	grid_template_key: string | null;
	page_id: number | null;
	ingest_error: string | null;
}

export const load: PageServerLoad = async () => {
	await discover();

	const rows = await query<IntakeRow>(
		`SELECT id, tether_session, camera_filename, raw_filename,
		        proposed_year, proposed_month, classification_confidence,
		        quality_verdict, quality_notes, status,
		        approved_year, approved_month, grid_template_key, page_id, ingest_error
		   FROM capture_intake
		  ORDER BY tether_session DESC, camera_filename ASC`
	);

	const active = rows.rows.filter((r) => ['unclassified', 'classified', 'reshoot'].includes(r.status));
	const completed = rows.rows.filter((r) => r.status === 'ingested');
	const rejected = rows.rows.filter((r) => r.status === 'rejected');

	return {
		active,
		completed,
		rejected,
		tetherExists: existsSync(TETHER_DIR),
		gridTemplates: Object.keys(GRID_TEMPLATES)
	};
};

async function loadIntake(id: number) {
	const r = await query<{
		id: number;
		source_path: string;
		content_hash: string;
		tether_session: string;
		status: string;
	}>(
		`SELECT id, source_path, content_hash, tether_session, status FROM capture_intake WHERE id = $1`,
		[id]
	);
	return r.rows[0] ?? null;
}

export const actions: Actions = {
	/** OCR + quality-assess every unclassified image. */
	classify: async () => {
		const apiKey = env.GOOGLE_VISION_API_KEY;
		if (!apiKey) return fail(500, { error: 'GOOGLE_VISION_API_KEY is not configured' });

		const pending = await query<{ id: number; source_path: string }>(
			`SELECT id, source_path FROM capture_intake WHERE status = 'unclassified'`
		);

		let classified = 0;
		const errors: Array<{ id: number; error: string }> = [];

		for (const row of pending.rows) {
			const path = await validatedPath(row.source_path);
			if (!path) {
				errors.push({ id: row.id, error: 'Source file missing or outside tether dir' });
				continue;
			}
			try {
				const buf = await readFile(path);
				const cls = await classifyImage(buf, { apiKey });
				const qual = await assessQuality(buf);
				await query(
					`UPDATE capture_intake
					    SET proposed_year = $2, proposed_month = $3,
					        ocr_full_text = $4, classification_confidence = $5,
					        sharpness_score = $6, sharpness_corner_min = $7,
					        exposure_mean = $8, exposure_clipped_pct = $9, contrast_score = $10,
					        quality_verdict = $11, quality_notes = $12,
					        status = 'classified', classified_at = NOW()
					  WHERE id = $1`,
					[
						row.id, cls.year, cls.month, cls.fullText, cls.confidence,
						qual.sharpnessScore, qual.sharpnessCornerMin,
						qual.exposureMean, qual.exposureClippedPct, qual.contrastScore,
						qual.verdict, [cls.notes, qual.notes].filter(Boolean).join('; ') || null
					]
				);
				classified++;
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				errors.push({ id: row.id, error: message });
			}
		}

		return { classified, errors };
	},

	/** Combined approve + upload + DB ingest for a batch of capture_intake ids. */
	ingest: async ({ request }) => {
		const data = await request.formData();
		const raw = data.get('items');
		if (typeof raw !== 'string') return fail(400, { error: 'Missing items' });

		let items: Array<{ id: number; year: number; month: number; templateKey: string }>;
		try {
			items = JSON.parse(raw);
		} catch {
			return fail(400, { error: 'Malformed items payload' });
		}
		if (!Array.isArray(items) || items.length === 0) {
			return fail(400, { error: 'No images selected' });
		}

		let ingested = 0;
		const errors: Array<{ id: number; error: string }> = [];

		for (const item of items) {
			try {
				const year = Number(item.year);
				const month = Number(item.month);
				if (!Number.isInteger(year) || year < 1960 || year > 2030 || !Number.isInteger(month) || month < 1 || month > 12) {
					errors.push({ id: item.id, error: 'Invalid year or month' });
					continue;
				}
				if (!GRID_TEMPLATES[item.templateKey]) {
					errors.push({ id: item.id, error: `Unknown layout "${item.templateKey}"` });
					continue;
				}

				const intake = await loadIntake(item.id);
				if (!intake) {
					errors.push({ id: item.id, error: 'Intake row not found' });
					continue;
				}
				if (intake.status !== 'classified') {
					errors.push({ id: item.id, error: `Cannot ingest from status "${intake.status}"` });
					continue;
				}
				const path = await validatedPath(intake.source_path);
				if (!path) {
					errors.push({ id: item.id, error: 'Source file missing or outside tether dir' });
					continue;
				}

				await query(
					`UPDATE capture_intake SET approved_year = $2, approved_month = $3, grid_template_key = $4, approved_at = NOW() WHERE id = $1`,
					[item.id, year, month, item.templateKey]
				);

				const buf = await readFile(path);
				const outcome = await ingestPage({
					intakeId: item.id,
					year,
					month,
					templateKey: item.templateKey,
					contentHash: intake.content_hash,
					captureSession: intake.tether_session,
					imageBuffer: buf
				});

				if (outcome.ok) ingested++;
				else errors.push({ id: item.id, error: outcome.error });
			} catch (err) {
				errors.push({ id: item.id, error: err instanceof Error ? err.message : String(err) });
			}
		}

		return { ingested, errors };
	},

	/** Flag for reshoot or reject (operate on id, not path). */
	setStatus: async ({ request }) => {
		const data = await request.formData();
		const id = Number(data.get('id'));
		const status = String(data.get('status'));
		if (!Number.isInteger(id)) return fail(400, { error: 'Invalid id' });
		if (!['reshoot', 'rejected', 'unclassified'].includes(status)) {
			return fail(400, { error: 'Invalid status' });
		}
		await query(`UPDATE capture_intake SET status = $2 WHERE id = $1 AND status <> 'ingested'`, [id, status]);
		return { success: true };
	}
};
