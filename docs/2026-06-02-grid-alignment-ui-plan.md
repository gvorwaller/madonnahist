# Plan: Grid Alignment UI

## Context

The OCR pipeline produces garbage when cell crops are wrong. The current `cellBounds()` divides the full image evenly with a hardcoded 12% header, but real calendar photos have decorative headers (25-40%), decorative borders, and the calendar grid doesn't fill the full photo. The naive grid was off by hundreds of pixels, causing crops to capture the wrong cells entirely.

Algorithmic grid detection failed — the grid lines on these calendars are faint beige on beige, invisible to edge detection. The user needs a visual tool to place grid lines on the actual image, similar to photo app adjustment tools. Once crops are correct, Claude Vision with family-context prompts produces usable OCR (validated on day 5).

## Approach

Post-ingest grid editor at `/admin/grid-align/[pageId]`. The primary interaction is **four-corner placement** (CODEX P1): the user drags the four outer corners of the grid to define a quadrilateral, and the interior lines subdivide automatically based on row/col count. This is faster than dragging 13+ individual lines and handles slight rotation/perspective from camera photos.

After corners are set, the user can optionally refine individual interior lines for hand-drawn calendars with uneven cells.

### Primary UX: Four Corners + Auto-Subdivide

1. User drags 4 corner handles to match the outer boundary of the calendar grid
2. Interior lines are computed automatically: evenly spaced between corners, following the quadrilateral edges (handles slight rotation/skew)
3. Optional: switch to "refine" mode to drag individual interior lines for non-uniform cells
4. Live crop preview strip shows sample cells (corners + center) so user can verify before saving

### Data Model

Add to `calendar_pages`:
```sql
ALTER TABLE calendar_pages ADD COLUMN grid_lines JSONB;
ALTER TABLE calendar_pages ADD COLUMN grid_version INT NOT NULL DEFAULT 0;
ALTER TABLE calendar_pages ADD COLUMN image_width INT;
ALTER TABLE calendar_pages ADD COLUMN image_height INT;
```

Add to `calendar_days` (CODEX P1 — row/col must be explicit for crop recomputation):
```sql
ALTER TABLE calendar_days ADD COLUMN grid_row INT;
ALTER TABLE calendar_days ADD COLUMN grid_col INT;
```

`grid_lines` stores the grid definition in original image pixels:
```json
{
  "corners": {
    "topLeft": [350, 870],
    "topRight": [5449, 870],
    "bottomLeft": [350, 3820],
    "bottomRight": [5449, 3820]
  },
  "xLines": [350, 1078, 1807, 2535, 3264, 3992, 4721, 5449],
  "yLines": [870, 1460, 2050, 2640, 3230, 3820]
}
```
- `corners`: the 4 user-placed corner points (source of truth for the quadrilateral)
- `xLines`/`yLines`: computed subdivisions (may be manually refined)
- Cell (row, col) = x from `xLines[col]` to `xLines[col+1]`, y from `yLines[row]` to `yLines[row+1]`

`grid_version` increments on every save. OCR jobs carry the version in their payload; the worker refuses stale-version jobs (CODEX P1 — prevents old-crop OCR from overwriting current results).

### UI Layout

```
┌──────────────────────────────────────────────────┐
│ ← Back to OCR Review   January 2022 — Grid Align │
│                                                   │
│ [Corners] [Refine Lines]  Rows: 5  Cols: 7        │
│ [Copy from Previous Page]  [Reset]                │
│                                                   │
│ ┌───────────────────────────────────────────────┐ │
│ │                                               │ │
│ │   Page image (2400px wide from Spaces)        │ │
│ │   + SVG overlay:                              │ │
│ │     - 4 draggable corner handles (large)      │ │
│ │     - Auto-subdivided grid lines              │ │
│ │     - Day number labels in each cell          │ │
│ │                                               │ │
│ └───────────────────────────────────────────────┘ │
│                                                   │
│ ┌─ Live Crop Preview ───────────────────────────┐ │
│ │ [Day 1] [Day 5] [Day 15] [Day 23] [Day 29]   │ │
│ │  (cropped cell thumbnails update in real time) │ │
│ └───────────────────────────────────────────────┘ │
│                                                   │
│ [x] Re-run OCR after save                         │
│ [Apply Grid]                                      │
└──────────────────────────────────────────────────┘
```

### Interaction Details

**Corner mode** (default):
- 4 large draggable circle handles at the grid corners
- Drag any corner → interior lines recompute as even subdivisions of the quadrilateral
- Handles slight camera rotation: if corners form a non-rectangular quad, subdivisions follow the perspective

**Refine mode** (optional, for hand-drawn calendars):
- Individual interior lines become draggable
- Moving one line affects only that line (non-uniform cells)

**Grid translation**: Drag the interior to move the entire grid without changing cell sizes.

**Copy from previous page** (CODEX P2): Copy `grid_lines` from the previous page (same calendar brand typically has same grid). User adjusts corners if framing shifted.

**Live crop preview** (CODEX P2): A strip below the image shows 5 representative cell crops (day 1, a middle day, last day, corners) that update in real time as the user drags. The user can verify alignment before committing.

**Keyboard nudge**: Arrow keys move the selected handle/line by 1px. Shift+arrow = 10px.

**Initial position**: When no `grid_lines` exist, try to copy from the most recently calibrated page of the same year. If none, use default estimates (6% horizontal padding, 25% header, 95% bottom).

### Coordinate System

The image displays at ~1200px wide in the browser but is 5776px in original pixels. All stored positions are in original pixels. The UI converts using `scale = containerWidth / originalWidth` (via `getBoundingClientRect()` on the image container). SVG elements are positioned in display pixels; saved values are divided by scale.

`originalWidth` and `originalHeight` are stored on `calendar_pages` (populated at ingest time; backfilled for existing pages on first grid-align load). Migration allows nullable initially; ingest writes them in the same transaction as the page row.

### Save Action

The `saveGrid` form action:
1. Validates grid lines JSON (correct count, monotonically increasing, within image bounds)
2. Transaction:
   - Increment `calendar_pages.grid_version`
   - Update `calendar_pages.grid_lines`
   - For each `calendar_day` on this page: recompute `crop_bounds` from grid lines + stored `grid_row`/`grid_col`, UPDATE the row
   - If "re-run OCR" checked: cancel pending/in-progress OCR jobs for this page, enqueue fresh ones with `grid_version` in payload
   - Write `audit_log` entry recording old/new grid JSON, version, who changed it, whether OCR was requeued (CODEX P2 — provenance)
3. If accepted human corrections exist on any day of this page, show a confirmation warning before proceeding (CODEX P2)
4. Redirect back with success message

### Stale OCR Prevention (CODEX P1)

- `grid_version` on `calendar_pages` increments on every grid save
- OCR job payload includes `grid_version` at time of enqueue
- Worker checks `grid_version` before writing `ocr_runs` — refuses if payload version < current page version
- `job_runs.status` constraint: add `'canceled'` to the CHECK to handle superseded jobs cleanly (CODEX P1)

### Wrapped/Split Days (CODEX P2)

For wrapped 5-row calendars (e.g., Jan 2022 where days 30/31 share cells with 23/24):
- The UI shows multi-date labels in shared cells ("23 / 30")
- Both dates get the same crop_bounds (same physical cell)
- OCR prompt for shared cells explicitly says "This cell contains entries for [date1] and [date2]"

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `backend/db/migrations/0009_grid_lines.sql` | **Create** | Add `grid_lines`, `grid_version`, `image_width`, `image_height` to `calendar_pages`; add `grid_row`, `grid_col` to `calendar_days`; add `'canceled'` to `job_runs.status` CHECK |
| `src/lib/ingest/day-grid.ts` | **Modify** | Add `GridLines` interface, `cellBoundsFromGridLines()`, `defaultGridLines()`, `subdivideCornersToLines()` |
| `src/lib/ingest/ingest.ts` | **Modify** | Store `image_width`/`image_height` on `calendar_pages`, store `grid_row`/`grid_col` on `calendar_days` during ingest |
| `src/routes/admin/grid-align/[pageId]/+page.server.ts` | **Create** | Load page data + `saveGrid` action with version increment, audit logging, OCR re-queue |
| `src/routes/admin/grid-align/[pageId]/+page.svelte` | **Create** | Grid alignment editor (SVG overlay, corner handles, live crop preview, pointer events) |
| `src/routes/admin/grid-align/[pageId]/page-image/+server.ts` | **Create** | Serve resized page image from Spaces |
| `src/routes/admin/ocr-review/[pageId]/+page.svelte` | **Modify** | Add "Adjust Grid" link to header |
| `backend/workers/ocr-worker.ts` | **Modify** | Check `grid_version` in payload vs current before writing results |

## Key Decisions

- **Four corners primary, line refinement secondary**: Faster UX, handles camera perspective, CODEX's strongest recommendation.
- **SVG over canvas**: Each handle/line is an SVG element with pointer events. No redraw loops.
- **Post-ingest, not pre-ingest**: Page and days already exist. Editor updates existing `crop_bounds`.
- **Per-page storage with copy-from-previous**: Each photo gets its own grid, but initialization reuses prior work.
- **Grid version for stale OCR prevention**: Version in payload, worker refuses mismatched versions.
- **Live crop preview before commit**: User verifies alignment on sample cells before re-running OCR.
- **Audit trail**: Grid changes logged with old/new JSON, version, timestamp, user.
- **Explicit row/col on calendar_days**: Eliminates brittle re-derivation from year/month/layout at save time.

## Verification

1. Apply migration: `./backend/db/migrate_pg.sh`
2. Navigate to `/admin/grid-align/1`
3. See January 2022 page with grid overlay at default positions
4. Drag 4 corner handles to match actual grid boundaries — interior lines follow
5. Check live crop preview strip — cells show correct content
6. Click Apply → crop_bounds updated, grid_version incremented
7. Navigate to `/admin/ocr-review/1` → crop images now align with actual cells
8. Re-run OCR worker → text quality consistent across all cells
9. `npm run check` — 0 errors, 0 warnings
10. Test: save grid without re-run → old OCR stays but is marked stale
11. Test: copy grid from previous page → positions carry over

## CODEX Review Log

| # | Severity | Finding | Resolution |
|---|----------|---------|------------|
| 1 | P1 | Axis-aligned x/y lines can't handle camera rotation/perspective | Four-corner quadrilateral as primary UX; interior lines subdivide from corners |
| 2 | P1 | Grid changes leave stale OCR marked as current | `grid_version` on page, version in OCR job payload, worker refuses stale |
| 3 | P1 | `'superseded'` not in job_runs status CHECK | Add `'canceled'` to the CHECK constraint |
| 4 | P1 | No row/col stored on calendar_days for crop recomputation | Add `grid_row`/`grid_col` columns, populated at ingest |
| 5 | P2 | Wrapped/split days under-specified | Show multi-date labels, same crop_bounds, OCR prompt mentions both dates |
| 6 | P2 | image_width/height need migration/backfill guarantees | Nullable initially, ingest writes in same transaction, backfill on first load |
| 7 | P2 | Coordinate transform needs proper scale/offset handling | Use `getBoundingClientRect()`, explicit scale chain |
| 8 | P2 | Grid edits need audit trail | Write `audit_log` entry on save with old/new JSON, version |
| 9 | P2 | Need crop preview before committing | Live crop preview strip with 5 representative cells |
| 10 | P2 | Per-page-only storage too labor-intensive | Copy-from-previous-page and save-as-template features |
| 11 | P3 | Default grid constants should be data-driven | Initialize from most recent calibrated page of same year |
| 12 | P3 | Verification should include DB/stale-job assertions | Added to verification section |
