import { query } from '$lib/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	const res = await query<{
		id: number;
		year: number;
		month: number;
		has_grid: boolean;
		has_warp: boolean;
	}>(`
		SELECT cp.id, cp.year, cp.month,
		       cp.grid_lines IS NOT NULL AS has_grid,
		       cp.warped_image_path IS NOT NULL AS has_warp
		  FROM calendar_pages cp
		 ORDER BY cp.year, cp.month
	`);

	return { pages: res.rows };
};
