import sharp from 'sharp';
import { query, withTransaction } from '$lib/db';
import { getObject, uploadIfAbsent, deleteObject } from '$lib/ingest/spaces-upload';
import {
	cellBoundsFromGridLines,
	defaultGridLines,
	subdivideCornersToLines,
	validateGridLines,
	type GridLines,
	type GridCorners
} from '$lib/ingest/day-grid';
import { perspectiveWarp, validateCorners, transformLinesToWarped, type Point } from '$lib/image/perspective';
import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
	const pageId = Number(params.pageId);
	if (!Number.isFinite(pageId)) error(400, 'Invalid page ID');

	const pageRes = await query<{
		id: number;
		year: number;
		month: number;
		page_image_path: string;
		grid_lines: GridLines | null;
		grid_version: number;
		image_width: number | null;
		image_height: number | null;
		warped_image_path: string | null;
		warped_width: number | null;
		warped_height: number | null;
	}>(`SELECT id, year, month, page_image_path, grid_lines, grid_version,
	           image_width, image_height,
	           warped_image_path, warped_width, warped_height
	      FROM calendar_pages WHERE id = $1`, [pageId]);

	if (!pageRes.rows[0]) error(404, 'Page not found');
	const page = pageRes.rows[0];

	// Backfill image dimensions if missing
	if (page.image_width === null || page.image_height === null) {
		const raw = await getObject(page.page_image_path);
		const normalized = await sharp(raw).rotate().toBuffer();
		const meta = await sharp(normalized).metadata();
		page.image_width = meta.width!;
		page.image_height = meta.height!;
		await query(
			`UPDATE calendar_pages SET image_width = $2, image_height = $3 WHERE id = $1`,
			[pageId, page.image_width, page.image_height]
		);
	}

	const dayRes = await query<{
		id: number;
		entry_date: string;
		grid_row: number | null;
		grid_col: number | null;
		correction_status: string;
	}>(`SELECT id, entry_date::text AS entry_date, grid_row, grid_col, correction_status
	      FROM calendar_days WHERE page_id = $1 ORDER BY entry_date`, [pageId]);

	const rows = dayRes.rows.length > 0
		? Math.max(...dayRes.rows.filter(d => d.grid_row !== null).map(d => d.grid_row!)) + 1
		: 5;
	const cols = 7;

	const isWarped = page.warped_image_path !== null;

	let gridLines = page.grid_lines;
	if (!gridLines) {
		gridLines = defaultGridLines(page.image_width, page.image_height, rows, cols);
	}

	const hasAcceptedCorrections = dayRes.rows.some(d => d.correction_status === 'accepted');

	const prevPageRes = await query<{ id: number; year: number; month: number; grid_lines: GridLines | null }>(
		`SELECT id, year, month, grid_lines FROM calendar_pages
		  WHERE id < $1 AND grid_lines IS NOT NULL
		  ORDER BY id DESC LIMIT 1`, [pageId]
	);
	const previousGrid = prevPageRes.rows[0] ?? null;

	return {
		page: {
			id: page.id,
			year: page.year,
			month: page.month,
			gridVersion: page.grid_version,
			imageWidth: page.image_width,
			imageHeight: page.image_height,
			warpedWidth: page.warped_width,
			warpedHeight: page.warped_height
		},
		isWarped,
		gridLines,
		days: dayRes.rows,
		rows,
		cols,
		hasAcceptedCorrections,
		previousGrid: previousGrid ? {
			pageId: previousGrid.id,
			year: previousGrid.year,
			month: previousGrid.month,
			gridLines: previousGrid.grid_lines!
		} : null
	};
};

function cornersToPoints(c: GridCorners): [Point, Point, Point, Point] {
	return [
		{ x: c.topLeft[0], y: c.topLeft[1] },
		{ x: c.topRight[0], y: c.topRight[1] },
		{ x: c.bottomRight[0], y: c.bottomRight[1] },
		{ x: c.bottomLeft[0], y: c.bottomLeft[1] }
	];
}

async function cancelAndRequeueOcr(
	client: import('pg').PoolClient,
	pageId: number,
	gridVersion: number
) {
	await client.query(
		`UPDATE job_runs
		    SET status = 'canceled', completed_at = NOW()
		  WHERE job_type IN ('ocr', 'page_ocr', 'llm_cleanup')
		    AND status IN ('pending', 'in_progress')
		    AND payload->>'page_id' = $1::text`,
		[String(pageId)]
	);

	await client.query(
		`INSERT INTO job_runs (job_type, payload)
		 VALUES ('page_ocr', $1::jsonb)`,
		[JSON.stringify({
			page_id: pageId,
			grid_version: gridVersion
		})]
	);
}

export const actions = {
	applyWarp: async ({ params, request }) => {
		const pageId = Number(params.pageId);
		if (!Number.isFinite(pageId)) return fail(400, { error: 'Invalid page ID' });

		const formData = await request.formData();
		const cornersJson = formData.get('corners') as string;

		let corners: GridCorners;
		try {
			corners = JSON.parse(cornersJson);
		} catch {
			return fail(400, { error: 'Invalid corners JSON' });
		}

		const pageRes = await query<{
			page_image_path: string;
			image_width: number;
			image_height: number;
			grid_version: number;
			warped_image_path: string | null;
			year: number;
			month: number;
		}>(`SELECT page_image_path, image_width, image_height, grid_version,
		           warped_image_path, year, month
		      FROM calendar_pages WHERE id = $1`, [pageId]);
		if (!pageRes.rows[0]) return fail(404, { error: 'Page not found' });
		const page = pageRes.rows[0];

		const pts = cornersToPoints(corners);
		const validationError = validateCorners(pts, page.image_width, page.image_height);
		if (validationError) return fail(400, { error: validationError });

		// Download and EXIF-normalize the original page image
		const raw = await getObject(page.page_image_path);
		const normalized = await sharp(raw).rotate().toBuffer();

		// Perspective warp
		const warped = await perspectiveWarp(normalized, pts);

		const newVersion = page.grid_version + 1;
		const mm = String(page.month).padStart(2, '0');
		const hash8 = page.page_image_path.match(/page-\d{4}-\d{2}-([a-f0-9]{8})/)?.[1] ?? 'unknown';
		const warpedKey = `pages/${page.year}/${mm}/page-${page.year}-${mm}-${hash8}-warped-v${newVersion}.jpg`;

		// Upload warped image
		await uploadIfAbsent(warpedKey, warped.buffer);

		// Get the pre-warp line positions (from current grid_lines or recompute from corners)
		const existingGrid = (await query<{ grid_lines: GridLines | null }>(
			`SELECT grid_lines FROM calendar_pages WHERE id = $1`, [pageId]
		)).rows[0]?.grid_lines;

		let preWarpXLines: number[];
		let preWarpYLines: number[];
		if (existingGrid && existingGrid.xLines.length > 0) {
			preWarpXLines = existingGrid.xLines;
			preWarpYLines = existingGrid.yLines;
		} else {
			const dayMeta = await query<{ grid_row: number; grid_col: number }>(
				`SELECT DISTINCT grid_row, grid_col FROM calendar_days
				  WHERE page_id = $1 AND grid_row IS NOT NULL`, [pageId]
			);
			const gridRows = Math.max(...dayMeta.rows.map(d => d.grid_row)) + 1;
			const gridCols = Math.max(...dayMeta.rows.map(d => d.grid_col)) + 1;
			const { xLines: xl, yLines: yl } = subdivideCornersToLines(corners, gridRows, gridCols);
			preWarpXLines = xl;
			preWarpYLines = yl;
		}

		// Transform pre-warp lines through the forward homography
		const transformed = transformLinesToWarped(pts, warped.width, warped.height, preWarpXLines, preWarpYLines);

		const gridLines: GridLines = {
			coordinateSpace: 'warped',
			corners,
			xLines: transformed.xLines,
			yLines: transformed.yLines
		};

		const oldWarpedPath = page.warped_image_path;

		await withTransaction(async (client) => {
			await client.query(
				`UPDATE calendar_pages
				    SET warped_image_path = $2, warped_width = $3, warped_height = $4,
				        grid_lines = $5::jsonb, grid_version = $6
				  WHERE id = $1`,
				[pageId, warpedKey, warped.width, warped.height,
				 JSON.stringify(gridLines), newVersion]
			);

			// Recompute crop_bounds for all days using warped-image lines
			const dayRes = await client.query<{
				id: number; grid_row: number | null; grid_col: number | null;
			}>(`SELECT id, grid_row, grid_col FROM calendar_days WHERE page_id = $1`, [pageId]);

			for (const day of dayRes.rows) {
				if (day.grid_row === null || day.grid_col === null) continue;
				const bounds = cellBoundsFromGridLines(gridLines, day.grid_row, day.grid_col);
				await client.query(
					`UPDATE calendar_days SET crop_bounds = $2::jsonb WHERE id = $1`,
					[day.id, JSON.stringify(bounds)]
				);
			}

			await cancelAndRequeueOcr(client, pageId, newVersion);

			await client.query(
				`INSERT INTO audit_log (user_id, action, entity_type, entity_id, before_value, after_value, description)
				 VALUES ($1, 'warp_apply', 'calendar_page', $2, NULL, $3::jsonb, $4)`,
				[null, pageId, JSON.stringify({ corners, warpedKey, warpedWidth: warped.width, warpedHeight: warped.height }),
				 `Perspective warp applied, grid v${newVersion}, OCR re-queued`]
			);
		});

		// Best-effort delete old warped image
		if (oldWarpedPath && oldWarpedPath !== warpedKey) {
			await deleteObject(oldWarpedPath);
		}

		redirect(303, `/admin/grid-align/${pageId}?saved=1`);
	},

	saveGrid: async ({ params, request }) => {
		const pageId = Number(params.pageId);
		if (!Number.isFinite(pageId)) return fail(400, { error: 'Invalid page ID' });

		const formData = await request.formData();
		const gridLinesJson = formData.get('gridLines') as string;
		const rerunOcr = formData.get('rerunOcr') === 'true';
		const rowCount = Number(formData.get('rows'));
		const colCount = Number(formData.get('cols'));

		let gridLines: GridLines;
		try {
			gridLines = JSON.parse(gridLinesJson);
		} catch {
			return fail(400, { error: 'Invalid grid JSON' });
		}

		const pageRes = await query<{
			image_width: number;
			image_height: number;
			warped_width: number | null;
			warped_height: number | null;
			grid_lines: GridLines | null;
			grid_version: number;
		}>(`SELECT image_width, image_height, warped_width, warped_height,
		           grid_lines, grid_version
		      FROM calendar_pages WHERE id = $1`, [pageId]);
		if (!pageRes.rows[0]) return fail(404, { error: 'Page not found' });
		const page = pageRes.rows[0];

		// Validate against warped dims if warped, else original
		const valWidth = page.warped_width ?? page.image_width;
		const valHeight = page.warped_height ?? page.image_height;

		const validationError = validateGridLines(
			gridLines, valWidth, valHeight, rowCount, colCount
		);
		if (validationError) return fail(400, { error: validationError });

		const oldGridLines = page.grid_lines;
		const newVersion = page.grid_version + 1;

		await withTransaction(async (client) => {
			await client.query(
				`UPDATE calendar_pages
				    SET grid_lines = $2::jsonb, grid_version = $3
				  WHERE id = $1`,
				[pageId, JSON.stringify(gridLines), newVersion]
			);

			const dayRes = await client.query<{
				id: number; grid_row: number | null; grid_col: number | null;
			}>(`SELECT id, grid_row, grid_col FROM calendar_days WHERE page_id = $1`, [pageId]);

			for (const day of dayRes.rows) {
				if (day.grid_row === null || day.grid_col === null) continue;
				const bounds = cellBoundsFromGridLines(gridLines, day.grid_row, day.grid_col);
				await client.query(
					`UPDATE calendar_days SET crop_bounds = $2::jsonb WHERE id = $1`,
					[day.id, JSON.stringify(bounds)]
				);
			}

			if (rerunOcr) {
				await cancelAndRequeueOcr(client, pageId, newVersion);
			}

			await client.query(
				`INSERT INTO audit_log (user_id, action, entity_type, entity_id, before_value, after_value, description)
				 VALUES ($1, 'grid_update', 'calendar_page', $2, $3::jsonb, $4::jsonb, $5)`,
				[null, pageId,
				 oldGridLines ? JSON.stringify(oldGridLines) : null,
				 JSON.stringify(gridLines),
				 `Grid updated to v${newVersion}${rerunOcr ? ', OCR re-queued' : ''}`]
			);
		});

		redirect(303, `/admin/grid-align/${pageId}?saved=1`);
	},

	resetWarp: async ({ params }) => {
		const pageId = Number(params.pageId);
		if (!Number.isFinite(pageId)) return fail(400, { error: 'Invalid page ID' });

		const pageRes = await query<{
			grid_lines: GridLines | null;
			grid_version: number;
			warped_image_path: string | null;
			image_width: number;
			image_height: number;
		}>(`SELECT grid_lines, grid_version, warped_image_path, image_width, image_height
		      FROM calendar_pages WHERE id = $1`, [pageId]);
		if (!pageRes.rows[0]) return fail(404, { error: 'Page not found' });
		const page = pageRes.rows[0];

		if (!page.warped_image_path) {
			redirect(303, `/admin/grid-align/${pageId}`);
		}

		const newVersion = page.grid_version + 1;

		// Rebuild grid lines in original coordinates from the stored corners
		const existingCorners = page.grid_lines?.corners;

		await withTransaction(async (client) => {
			// Determine row/col count from days
			const dayMeta = await client.query<{ max_row: number; max_col: number }>(
				`SELECT MAX(grid_row) AS max_row, MAX(grid_col) AS max_col
				   FROM calendar_days WHERE page_id = $1`, [pageId]
			);
			const gridRows = (dayMeta.rows[0]?.max_row ?? 4) + 1;
			const gridCols = (dayMeta.rows[0]?.max_col ?? 6) + 1;

			let newGridLines: GridLines;
			if (existingCorners) {
				const { xLines, yLines } = subdivideCornersToLines(existingCorners, gridRows, gridCols);
				newGridLines = { coordinateSpace: 'original', corners: existingCorners, xLines, yLines };
			} else {
				newGridLines = defaultGridLines(page.image_width, page.image_height, gridRows, gridCols);
			}

			await client.query(
				`UPDATE calendar_pages
				    SET warped_image_path = NULL, warped_width = NULL, warped_height = NULL,
				        grid_lines = $2::jsonb, grid_version = $3
				  WHERE id = $1`,
				[pageId, JSON.stringify(newGridLines), newVersion]
			);

			await client.query(
				`UPDATE job_runs
				    SET status = 'canceled', completed_at = NOW()
				  WHERE job_type = 'ocr'
				    AND status IN ('pending', 'in_progress')
				    AND payload->>'page_id' = $1::text`,
				[String(pageId)]
			);

			await client.query(
				`INSERT INTO audit_log (user_id, action, entity_type, entity_id, before_value, after_value, description)
				 VALUES ($1, 'warp_reset', 'calendar_page', $2, NULL, NULL, $3)`,
				[null, pageId, `Warp reset, grid v${newVersion}, OCR canceled`]
			);
		});

		// Best-effort delete warped image
		if (page.warped_image_path) {
			await deleteObject(page.warped_image_path);
		}

		redirect(303, `/admin/grid-align/${pageId}`);
	}
} satisfies Actions;
