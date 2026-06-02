# Plan: Perspective Warp + Grid Line Refinement

## Context

The grid alignment UI (already built) has two problems:

1. **No perspective correction.** The camera setup is an easel at ~85° with the camera tilted down to compensate. The resulting image has real perspective distortion — the calendar grid isn't a true rectangle. Axis-aligned rectangular crops from the skewed image cut across cell boundaries. The image must be de-skewed before any cell extraction.

2. **Interior grid lines can't match actual grid lines.** The auto-subdivision produces evenly spaced lines, but on the perspective-distorted image, "even" in pixel space doesn't match "even" on the physical calendar. Even after de-skewing, commercial calendars may have non-uniform row heights (the top row with mini-calendars is shorter). Refine mode exists in code but only works on the axis-aligned model.

## Approach

**Two-phase workflow:** place corners on the original image → apply perspective warp → refine interior lines on the warped (rectangular) image → save.

### Phase 1: Corner Placement (on original image)

User drags 4 corner handles onto the outer boundary of the calendar grid. The original (skewed) image is displayed. Interior lines are preview-only — they show approximate positions but aren't authoritative until after warp.

### Phase 2: Apply Warp → Line Refinement (on warped image)

User clicks "Apply Warp." The server:
1. Downloads the original page image from Spaces
2. Perspective-warps it using the 4 corners → rectangle (using `perspectiveWarp()` from `src/lib/image/perspective.ts`, already written)
3. Uploads the warped image to Spaces
4. Stores `warped_image_path`, warped dimensions, and warp corners on `calendar_pages`
5. Auto-computes evenly-spaced `xLines`/`yLines` on the warped rectangle
6. Redirects back

On reload, the page detects `warped_image_path` exists and switches to showing the warped image. Interior lines are now axis-aligned on a rectangular image. User switches to "Refine Lines" to drag individual lines to match actual grid lines. Then clicks "Apply Grid" to save.

### Data Model Changes

New migration `0010_warped_image.sql`:
```sql
ALTER TABLE calendar_pages ADD COLUMN warped_image_path TEXT;
ALTER TABLE calendar_pages ADD COLUMN warped_width INT;
ALTER TABLE calendar_pages ADD COLUMN warped_height INT;
```

The existing `grid_lines` column stores:
- `corners`: the 4 points on the ORIGINAL image (used to compute the warp)
- `xLines`/`yLines`: line positions on the WARPED image (used for crop bounds)

No schema change to `grid_lines` itself — just a semantic shift in what the coordinates refer to.

### UI States

The UI has two states, determined by `data.isWarped` (whether `warped_image_path` exists):

**State 1: Corners (not yet warped)**
- Shows original image
- Corner handles visible and draggable
- Interior lines shown as thin previews (auto-subdivided from corners)
- Button: "Apply Warp" (replaces "Apply Grid")
- "Refine Lines" mode is disabled

**State 2: Warped (after warp applied)**
- Shows warped image
- "Refine Lines" is the default mode
- Interior lines are draggable (not edge lines — edge = warped image boundary)
- Corner handles hidden (the warp is locked in)
- Button: "Apply Grid" saves line positions + recomputes crop bounds
- Button: "Re-place Corners" resets warp and returns to State 1

### Save Actions

**`applyWarp` (new):**
1. Read corners from form data
2. Download original page image from Spaces
3. Call `perspectiveWarp()` with corners
4. Upload warped image to Spaces as `pages/{year}/{mm}/page-{year}-{mm}-{hash8}-warped.jpg`
5. Transaction: update `warped_image_path`, `warped_width`, `warped_height`, `grid_lines` (with corners + even-spaced xLines/yLines on warped dims), increment `grid_version`
6. Redirect back → page reloads in warped state

**`saveGrid` (modified):**
- Validates `xLines`/`yLines` against WARPED image dimensions (not original)
- Computes `crop_bounds` from the warped image's coordinate space
- Crops at OCR time use the warped image

### Image Serving Changes

**`page-image/+server.ts`:**
- Accept `?original=1` query param
- Default: serve warped image if `warped_image_path` exists, else original
- `?original=1`: always serve original (for corner re-placement)

**`crop/[dayId]/+server.ts`** (OCR review crop endpoint):
- Use `warped_image_path` when available for cropping

**OCR worker (`backend/workers/ocr-worker.ts`):**
- Check `warped_image_path` on the page; if present, download and crop from the warped image instead of the original

### Coordinate System

- `grid_lines.corners` — always in ORIGINAL image pixels (these are the warp source points)
- `grid_lines.xLines` / `yLines` — in WARPED image pixels after warp is applied
- `crop_bounds` on `calendar_days` — in WARPED image pixels
- `image_width`/`image_height` — original image dimensions (unchanged)
- `warped_width`/`warped_height` — warped image dimensions

## Files to Modify

| File | Change |
|------|--------|
| `backend/db/migrations/0010_warped_image.sql` | **Create** — add `warped_image_path`, `warped_width`, `warped_height` to `calendar_pages` |
| `src/lib/image/perspective.ts` | **Already created** — `perspectiveWarp()` function |
| `src/routes/admin/grid-align/[pageId]/+page.server.ts` | **Modify** — add `applyWarp` action, load returns `isWarped`, validate against warped dims in `saveGrid` |
| `src/routes/admin/grid-align/[pageId]/+page.svelte` | **Modify** — two UI states based on `isWarped`, "Apply Warp" button, show warped image |
| `src/routes/admin/grid-align/[pageId]/page-image/+server.ts` | **Modify** — serve warped image by default when available |
| `src/routes/admin/ocr-review/[pageId]/crop/[dayId]/+server.ts` | **Modify** — crop from warped image when available |
| `backend/workers/ocr-worker.ts` | **Modify** — use warped image for cell cropping |

## Verification

1. `./backend/db/migrate_pg.sh` — apply 0010
2. Navigate to `/admin/grid-align/1` — see original image with corner handles (State 1)
3. Drag 4 corners to match calendar grid boundary
4. Click "Apply Warp" — page reloads showing the warped (rectangular) image
5. Verify the warped image is rectangular (lines of the calendar are horizontal/vertical)
6. Switch to "Refine Lines" — drag interior lines to match actual grid lines
7. Click "Apply Grid" — saves, recomputes crop_bounds
8. Navigate to `/admin/ocr-review/1` — verify crop images are correctly aligned cells
9. Run OCR worker — verify it uses the warped image
10. Test "Re-place Corners" to go back to State 1 and re-warp
11. `npm run check` — 0 errors, 0 warnings
