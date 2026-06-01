/**
 * Ingest orchestrator — the combined approve+ingest action.
 *
 * Flow (docs/2026-05-29-capture-intake-pipeline.md § UI Behavior / Crash recovery):
 *   1. compute deterministic Spaces key, mark capture_intake.ingest_phase
 *   2. EXIF-normalize the page image, upload it (HEAD-then-skip idempotent)
 *   3. ONE DB transaction: calendar_pages + calendar_days (per cell/date) +
 *      OCR job_runs + flip capture_intake → ingested
 *
 * Only the page image is uploaded here; per-day cell crops are derived later
 * by the OCR worker from the page image + crop_bounds, so no network I/O
 * happens inside the transaction.
 *
 * Idempotency: the key is computed before upload; uploadIfAbsent skips an
 * existing object. The DB step is atomic, so a crash before COMMIT leaves no
 * page/day rows and the intake row stays pre-ingested for a clean retry.
 */
import sharp from 'sharp';
import { query, withTransaction } from '$lib/db';
import { pageObjectKey, uploadIfAbsent } from './spaces-upload';
import { GRID_TEMPLATES, buildDayGrid, cellBounds, type GridLayout } from './day-grid';

export interface IngestInput {
	intakeId: number;
	year: number;
	month: number;
	templateKey: string;
	contentHash: string;
	captureSession: string;
	/** Original file bytes; the caller is responsible for path validation + read. */
	imageBuffer: Buffer;
}

export type IngestOutcome =
	| { ok: true; pageId: number; dayCount: number; spacesKey: string; uploaded: boolean }
	| { ok: false; error: string };

const OCR_VENDOR = 'google-vision';

async function setPhase(
	intakeId: number,
	phase: 'uploading' | 'db_insert' | 'enqueue_ocr',
	extra?: { spacesKey?: string; bumpAttempts?: boolean }
): Promise<void> {
	await query(
		`UPDATE capture_intake
		    SET ingest_phase = $2,
		        ingest_error = NULL,
		        ingest_attempts = ingest_attempts + $3,
		        spaces_object_key = COALESCE($4, spaces_object_key)
		  WHERE id = $1`,
		[intakeId, phase, extra?.bumpAttempts ? 1 : 0, extra?.spacesKey ?? null]
	);
}

export async function ingestPage(input: IngestInput): Promise<IngestOutcome> {
	const layout: GridLayout | undefined = GRID_TEMPLATES[input.templateKey];
	if (!layout) {
		return { ok: false, error: `Unknown grid template "${input.templateKey}"` };
	}

	const grid = buildDayGrid(input.year, input.month, layout);
	if (!grid.fits) {
		return {
			ok: false,
			error: `${input.year}-${String(input.month).padStart(2, '0')} does not fit the "${input.templateKey}" layout — choose a layout with more rows`
		};
	}

	const hash8 = input.contentHash.slice(0, 8);
	const spacesKey = pageObjectKey(input.year, input.month, hash8);

	try {
		// Phase 1: upload the page image (idempotent).
		await setPhase(input.intakeId, 'uploading', { spacesKey, bumpAttempts: true });

		const normalized = await sharp(input.imageBuffer).rotate().jpeg({ quality: 92 }).toBuffer();
		const meta = await sharp(normalized).metadata();
		const pageWidth = meta.width ?? 0;
		const pageHeight = meta.height ?? 0;
		if (pageWidth === 0 || pageHeight === 0) {
			throw new Error('Could not read normalized page dimensions');
		}

		const upload = await uploadIfAbsent(spacesKey, normalized);

		// Phase 2: atomic DB write.
		await setPhase(input.intakeId, 'db_insert');

		const result = await withTransaction(async (client) => {
			// Guard against re-ingesting a month that already has a page.
			const existing = await client.query<{ id: number }>(
				`SELECT id FROM calendar_pages WHERE year = $1 AND month = $2 LIMIT 1`,
				[input.year, input.month]
			);
			if (existing.rows.length > 0) {
				throw new Error(
					`${input.year}-${String(input.month).padStart(2, '0')} is already ingested (page #${existing.rows[0].id})`
				);
			}

			const pageRes = await client.query<{ id: number }>(
				`INSERT INTO calendar_pages (year, month, page_image_path, capture_session)
				 VALUES ($1, $2, $3, $4)
				 RETURNING id`,
				[input.year, input.month, spacesKey, input.captureSession]
			);
			const pageId = pageRes.rows[0].id;

			// Record the layout as a crop template (provenance for crop_bounds).
			const tplRes = await client.query<{ id: number }>(
				`INSERT INTO crop_templates (template_key, grid_definition)
				 VALUES ($1, $2::jsonb)
				 ON CONFLICT (template_key) DO UPDATE SET grid_definition = EXCLUDED.grid_definition
				 RETURNING id`,
				[input.templateKey, JSON.stringify(layout)]
			);
			const cropTemplateId = tplRes.rows[0].id;

			let dayCount = 0;
			for (const cell of grid.cells) {
				const bounds = cellBounds(layout, pageWidth, pageHeight, cell.row, cell.col);
				for (const entryDate of cell.dates) {
					const dayRes = await client.query<{ id: number }>(
						`INSERT INTO calendar_days (page_id, entry_date, crop_template_id, crop_bounds)
						 VALUES ($1, $2, $3, $4::jsonb)
						 RETURNING id`,
						[pageId, entryDate, cropTemplateId, JSON.stringify(bounds)]
					);
					const dayId = dayRes.rows[0].id;

					await client.query(
						`INSERT INTO job_runs (job_type, payload)
						 VALUES ('ocr', $1::jsonb)`,
						[JSON.stringify({ day_id: dayId, page_id: pageId, vendor: OCR_VENDOR })]
					);
					dayCount++;
				}
			}

			await client.query(
				`UPDATE capture_intake
				    SET status = 'ingested',
				        page_id = $2,
				        ingested_at = NOW(),
				        ingest_phase = NULL,
				        ingest_error = NULL
				  WHERE id = $1`,
				[input.intakeId, pageId]
			);

			return { pageId, dayCount };
		});

		return { ok: true, pageId: result.pageId, dayCount: result.dayCount, spacesKey, uploaded: upload.uploaded };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		// Record the failure; leave ingest_phase as-is for diagnosis. The row
		// stays pre-ingested so the operator can retry.
		await query(`UPDATE capture_intake SET ingest_error = $2 WHERE id = $1`, [
			input.intakeId,
			message
		]);
		return { ok: false, error: message };
	}
}
