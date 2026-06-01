# Plan: Auto-Classification & Ingestion Pipeline for Calendar Page Images

> Revised 2026-05-30 incorporating critical review feedback from CODEX.

## Context

Camera (G9 II via Lumix Tether) dumps JPG+RAW files with generic names (`P1034702.jpg`) into `~/Lumix Tether/{session-date}/`. The existing `/admin/capture` UI lets the operator manually pick year/month for each image — one at a time, via dropdowns. At 720 pages, this manual approach will kill the project's momentum.

The system must read each calendar page, auto-detect the month/year from the printed header, assess image quality (and flag re-shoots), and handle classification with minimal operator input. Headers vary: top or bottom of page, different formats even within the same calendar. Some calendars have 4 rows with wrapped last days (two days sharing a cell). All are Sunday-start.

**No CLI scripts.** Everything happens in the `/admin/capture` web UI.

## Deployment Model: Capture Station

**CODEX finding (P1):** The production app runs on the DO droplet, but `~/Lumix Tether` is on the local Mac. A server-side route can only read the filesystem where the server process runs.

**Resolution:** The `/admin/capture` workflow runs on the **capture station** — the Mac connected to the camera via USB. During capture sessions, the operator runs `npm run dev` locally and accesses `/admin/capture` at `localhost:5176`. The capture station connects to the same Postgres instance on the droplet (via SSH tunnel or direct connection with firewall rule). This is an admin-only workflow — it does not need to be accessible from the internet.

The capture station mode is the same SvelteKit app, same codebase, same DB — just running locally during shoot sessions. The `TETHER_DIR` config reads from `process.env.TETHER_DIR` (default: `~/Lumix Tether`). No file upload mechanism needed; the server reads the local filesystem directly.

## Approach: Upgrade `/admin/capture` with Auto-Classification + Quality Analysis

### The Upgraded Workflow

```
1. Shoot pages via Lumix Tether → JPGs + RAWs land in ~/Lumix Tether/{session}/

2. Open /admin/capture (localhost:5176) → see unclassified images

3. Click "Classify All"
   → System OCRs each unclassified image (full-page Vision pass)
   → Assesses image quality (sharpness, exposure, contrast)
   → Proposes month/year + quality verdict for each:
     [HIGH]  [GOOD]    P1034702.jpg → January 2022
     [HIGH]  [RESHOOT] P1034704.jpg → March 1991  ⚠ blurry
     [LOW]   [GOOD]    P1034711.jpg → ???

4. Review & fix
   → High-confidence proposals pre-fill year/month dropdowns
   → Quality warnings flag which images need re-shooting
   → Operator corrects any wrong classifications, re-shoots flagged images

5. Click "Approve & Ingest"  (single combined action — no hidden limbo state)
   → Approved images: renamed, uploaded to Spaces, DB rows created, OCR enqueued
   → Ingested images move to "Completed" section (collapsed, grayed out)
   → Re-shoot flagged images stay visible until replaced
```

### New Table: `capture_intake`

Tracks the classification state of every image from the tether folder. This is the key to making classified images disappear from the active view and supporting re-shoots.

```sql
CREATE TABLE capture_intake (
  id              SERIAL PRIMARY KEY,
  tether_session  TEXT NOT NULL,           -- e.g., "20260525" (subfolder name)
  camera_filename TEXT NOT NULL,           -- e.g., "P1034702.jpg"
  raw_filename    TEXT,                    -- paired RAW: "P1034702.RW2" or null
  source_path     TEXT NOT NULL,           -- full resolved path at discovery time

  -- Identity & dedup
  content_hash    TEXT NOT NULL,           -- SHA-256 of the JPG file contents
  file_size_bytes BIGINT NOT NULL,
  file_mtime      TIMESTAMPTZ NOT NULL,   -- filesystem mtime at discovery

  -- Classification
  proposed_year   INT,
  proposed_month  INT,
  ocr_full_text   TEXT,                   -- raw OCR text from full-page Vision pass
  classification_confidence TEXT           -- 'high', 'medium', 'low'
    CHECK (classification_confidence IN ('high', 'medium', 'low')),

  -- Quality assessment
  sharpness_score       FLOAT,            -- Laplacian variance (higher = sharper)
  sharpness_corner_min  FLOAT,            -- worst corner sharpness score
  exposure_mean         FLOAT,            -- mean brightness 0-255
  exposure_clipped_pct  FLOAT,            -- % pixels clipped (<5 or >250)
  contrast_score        FLOAT,            -- luminance std dev
  quality_verdict TEXT NOT NULL DEFAULT 'pending'
    CHECK (quality_verdict IN ('pending', 'good', 'reshoot_advised', 'reshoot_required')),
  quality_notes   TEXT,                   -- human-readable quality issues

  -- Lifecycle
  status          TEXT NOT NULL DEFAULT 'unclassified'
    CHECK (status IN ('unclassified', 'classified', 'approved', 'ingested', 'rejected', 'reshoot')),
  approved_year   INT,                    -- operator-confirmed year (may differ from proposed)
  approved_month  INT,                    -- operator-confirmed month
  page_id         INT REFERENCES calendar_pages(id),  -- set after ingestion

  -- Ingestion tracking (crash recovery)
  ingest_phase    TEXT                    -- 'uploading', 'db_insert', 'enqueue_ocr', null
    CHECK (ingest_phase IN ('uploading', 'db_insert', 'enqueue_ocr')),
  ingest_attempts INT NOT NULL DEFAULT 0,
  ingest_error    TEXT,                   -- last error message if ingestion failed
  spaces_object_key TEXT,                 -- deterministic key, set before upload begins

  -- Reshoot tracking
  supersedes_id   INT REFERENCES capture_intake(id),  -- links reshoot to original

  created_at      TIMESTAMPTZ DEFAULT NOW(),
  classified_at   TIMESTAMPTZ,
  approved_at     TIMESTAMPTZ,
  ingested_at     TIMESTAMPTZ,

  UNIQUE (tether_session, camera_filename),
  UNIQUE (content_hash)                   -- prevents same image under different paths
);

CREATE INDEX idx_capture_intake_status ON capture_intake(status);
CREATE INDEX idx_capture_intake_hash ON capture_intake(content_hash);
```

**Lifecycle**: `unclassified` → `classified` (after OCR) → `ingested` (approved + uploaded + DB rows created in one action). `reshoot` means the operator marked it for re-capture. `rejected` means skip entirely (e.g., accidental shot of the room).

**Identity (CODEX P2):** `content_hash` (SHA-256) detects the same image copied into renamed folders. `supersedes_id` links a reshoot to the original capture it replaces.

**Crash recovery (CODEX P1):** `ingest_phase` tracks how far ingestion got. `spaces_object_key` is computed deterministically before upload begins (format: `pages/{year}/{month:02d}/page-{year}-{month:02d}-{hash8}.jpg`). On retry: if object exists in Spaces with matching hash, skip upload. DB page/day/job creation is wrapped in a single transaction — if it fails, the Spaces object is orphaned but harmless (cleaned up on retry or manually). `ingest_attempts` and `ingest_error` track failures.

### Classification Algorithm

**CODEX finding (P1):** Fixed top/bottom 15% header crops plus regex parsing will be brittle. Headers vary in position, and two-strip OCR discards layout context.

**Resolution:** Use a single full-page Google Vision pass for classification. Vision returns structured `fullTextAnnotation` with word-level bounding boxes — we can locate month/year candidates anywhere on the page without guessing header position. Strip crops can be used as a performance optimization later if needed, but the primary path is full-page.

**Step 1: EXIF normalization.** Sharp `.rotate()` to normalize orientation before any analysis (per earlier CODEX finding on `crop.ts`).

**Step 2: Full-page OCR.** Google Vision `DOCUMENT_TEXT_DETECTION` via existing adapter. 1 API call per page. For a 12-page session that's 12 calls, well within the free tier.

**Step 3: Parse month/year from OCR response.** Use word-level bounding boxes to identify text near page edges (top/bottom 20%). Regex cascade on candidate text:
1. Full month name + 4-digit year: `January 2022`
2. Abbreviated month + year: `Jan 2022`, `Jan. 2022`
3. Numeric MM/YY or MM/YYYY: `03/99`, `03/1999` (catches hand-written fallbacks)
4. Year alone + month name elsewhere in the header region

Month name map: all English names + common abbreviations. Two-digit years: 60-99 → 1960-1999, 00-30 → 2000-2030.

**Step 4: Confidence scoring.**
- `high`: Clear month+year match from bounding-box-located header text, OCR word confidence > 0.5
- `medium`: Partial match (year but ambiguous month), or match found outside header region
- `low`: No match, conflicting info, or OCR failure

**Step 5: Duplicate check.** Compare each proposal against `calendar_pages` rows, other images in the same batch, and `content_hash` against existing `capture_intake` rows.

### Image Quality Assessment

Using Sharp's built-in capabilities — no external dependencies. All analysis runs on EXIF-normalized images.

**Sharpness (blur detection):**
```typescript
const { channels } = await sharp(buf)
  .rotate()  // EXIF normalize
  .grayscale()
  .convolve({ width: 3, height: 3, kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0] })
  .stats();
const sharpnessScore = channels[0].stdev;
```

**Corner sharpness (CODEX P2):** Evaluate four corner crops (~10% of each dimension) separately. The minimum corner score catches edge softness from lens issues or slight motion blur that global sharpness might average out.

**Exposure:**
```typescript
const { channels } = await sharp(buf).rotate().stats();
const mean = channels[0].mean; // 0-255
```
Additionally compute **clipped pixel percentage** — % of pixels at < 5 or > 250 — to detect blown highlights or crushed shadows that mean brightness alone misses.

Thresholds (to be calibrated against actual rig captures):
- Mean too dark (< 60) or too bright (> 200) → `reshoot_advised`
- Extreme (< 30 or > 230) or clipped > 5% → `reshoot_required`

**Contrast:**
```typescript
const contrast = channels[0].stdev; // luminance standard deviation
```
Very low contrast (< 20) → `reshoot_advised` (washed out, OCR will struggle).

**Resolution check:** Verify pixel dimensions match expected G9 II output (~5776x4336 for standard JPG, ~8192x6144 for High Res Mode). Unexpected dimensions → warning in `quality_notes`.

**Quality verdict logic:**
- All metrics good → `good`
- One metric marginal → `reshoot_advised` (with human-readable note explaining which metric and its value)
- Sharpness critically low OR worst corner critically soft OR exposure critically off → `reshoot_required`

**Calibration:** Thresholds above are initial estimates. Step 6 in the implementation sequence tests against real captures from the rig and adjusts. The thresholds live in a config object in `quality.ts`, not scattered through the code.

### 4-Row Calendar Handling

**CODEX finding (P1):** If Phase 1 defaults to 5-row but real pages include 4-row wrapped layouts, `calendar_days.crop_bounds` and day images will be wrong.

**Resolution:** Classification detects row count but does NOT auto-ingest pages with unrecognized layouts. The operator selects a grid layout during the review step (default: 5-row Sunday-start). If the detected layout doesn't match an existing template, the page is flagged and ingestion is blocked until the operator either:
1. Confirms the default layout is correct, or
2. Creates a minimal crop template (row count + wrap behavior) inline in the capture UI

The existing `crop_templates` table supports this:
```sql
-- crop_templates.grid_definition stores the layout config
{
  "rows": 4,
  "cols": 7,
  "startDay": "sunday",
  "wrappedRows": true,
  "headerPosition": "top"
}
```

The `day-grid.ts` module handles both 4-row and 5-row layouts. A minimal template selector (dropdown: "5-row standard" / "4-row wrapped" / "custom") ships with the capture UI — the full template editor with drag-to-adjust geometry is Phase 2.

### Path Security

**CODEX finding (P2):** Batch actions should operate on `capture_intake.id`, not arbitrary submitted paths.

**Resolution:**
- File discovery happens server-side only. The server scans `TETHER_DIR` subdirectories and registers files into `capture_intake` with resolved absolute `source_path`.
- All subsequent actions (classify, approve, ingest) operate on `capture_intake.id`, never on user-submitted paths.
- Before reading any file, the server verifies the resolved path is under `TETHER_DIR` and rejects symlinks pointing outside it.
- The preview endpoint validates the requested path against registered `capture_intake` rows.

### Files to Create

| File | Purpose |
|------|---------|
| `src/lib/ingest/classify.ts` | Full-page OCR, bounding-box month/year parsing, confidence scoring |
| `src/lib/ingest/quality.ts` | Image quality assessment: sharpness (global + corners), exposure (mean + clipping), contrast |
| `src/lib/ingest/day-grid.ts` | Calendar math: year/month + grid layout → entry_date mapping |
| `src/lib/ingest/spaces-upload.ts` | DO Spaces S3 upload with deterministic keys, retry-safe |
| `src/lib/ingest/ingest.ts` | Orchestrates approve+ingest: upload → DB transaction (page + days + jobs) → status update |
| `backend/db/migrations/0007_capture_intake.sql` | `capture_intake` table |

### Files to Modify

| File | Change |
|------|--------|
| `src/routes/admin/capture/+page.server.ts` | Server-side file discovery into `capture_intake`, `classify` action (full-page OCR + quality), `ingest` action (combined approve + upload + DB). Actions operate on `capture_intake.id`. Path validation. |
| `src/routes/admin/capture/+page.svelte` | "Classify All" button, confidence + quality badges on cards, grid layout selector, batch ingest controls, "Completed" collapsible section. |
| `src/routes/admin/capture/preview/` | Validate requested path against `capture_intake` rows. |
| `package.json` | Add `@aws-sdk/client-s3` |

### Existing Code Reused

| File | What |
|------|------|
| `src/lib/image/crop.ts` | `cropRegion()` for corner quality crops, `cropGrid()` for day cells |
| `src/lib/ocr/vendors/google-vision.ts` | Full-page OCR for classification |
| `src/lib/credentials.ts` | `credentialService.getCredential()` for API keys and Spaces creds |
| `src/routes/admin/capture/preview/` | Image preview endpoint (existing) |

### UI Behavior Details

**Active view** shows images with status `unclassified`, `classified`, or `reshoot`. Below the active list, a collapsible "Completed" section shows `ingested` images (grayed out, with count badge). No hidden limbo state — there is no `approved` status that hides images before ingestion.

**CODEX finding (P2):** "Approved" images disappearing before ingestion creates a dangerous invisible limbo.

**Resolution:** Approve and ingest are a single combined action. The operator reviews classifications, fixes any errors, then clicks "Ingest Selected" which immediately uploads and creates DB rows. No intermediate hidden state.

**After "Classify All":**
- Each image card shows: thumbnail, filename, proposed month/year (editable dropdowns), confidence badge (`HIGH`/`MED`/`LOW`), quality badge (`GOOD`/`⚠ RESHOOT`), grid layout selector.
- Quality warnings include the specific reason and value: "Blurry (sharpness 12, threshold 25)" or "Corner softness (min corner 8, threshold 15)" or "Clipped highlights (6.2% pixels clipped)".
- Operator can override any proposal, mark images for reshoot, or reject (accidental shots).

**"Ingest Selected" button:** Processes checked images in one pass: compute deterministic Spaces key → upload → create `calendar_pages` + `calendar_days` rows + enqueue OCR jobs in a single DB transaction → update `capture_intake` status to `ingested`. Images move to the "Completed" section.

**Failed ingestion:** If any step fails, `ingest_error` and `ingest_phase` are recorded. The image stays in the active view with an error badge. The operator can retry (idempotent — skips already-uploaded objects, uses the same deterministic key).

**Re-shoot flow:** Operator marks an image as `reshoot` → it stays visible with a "Reshoot" badge. After re-shooting, the new JPG appears in the tether folder. The server discovers it, the operator classifies and ingests it. The new `capture_intake` row links to the original via `supersedes_id`. The old row can be rejected.

### RAW File Handling

JPGs and RAWs pair by camera sequence number (`P1034702.jpg` ↔ `P1034702.RW2`). The `capture_intake` table records the `raw_filename`. Phase 1 does not upload or move RAWs — they stay in `~/Lumix Tether/` and the operator archives them via their backup workflow. The pairing is recorded so RAWs can be located later if needed.

### Implementation Sequence

1. Create migration `0007_capture_intake.sql` — new table with identity, crash recovery, and reshoot columns
2. Build `src/lib/ingest/classify.ts` — full-page OCR + bounding-box month/year parsing + confidence
3. Build `src/lib/ingest/quality.ts` — sharpness (global + corners), exposure (mean + clipping), contrast
4. Add server-side file discovery + `classify` action to `+page.server.ts` — registers files in `capture_intake`, processes all unclassified
5. Update `+page.svelte` — "Classify All" button, badges, grid layout selector, batch controls, "Completed" section
6. Test classification + quality on 8 sample images — calibrate thresholds against actual rig captures
7. Build `src/lib/ingest/spaces-upload.ts` (deterministic keys, retry-safe) and `day-grid.ts`
8. Build `src/lib/ingest/ingest.ts` — orchestrator with transactional DB writes
9. Add `ingest` action to `+page.server.ts` — combined approve + upload + DB
10. End-to-end test: discover → classify → review → ingest → verify DB rows + Spaces objects

### Verification

- `npm run check` — no type errors
- Navigate to `/admin/capture` (localhost:5176) — images from tether folder visible
- "Classify All" → proposals appear with correct month/year for >= 6/8 test images
- Quality badges show `GOOD` for sharp images, `RESHOOT` for intentionally degraded test image
- Duplicate image (same file copied to new folder) detected by `content_hash`
- Ingest selected → images move to "Completed" section, stay visible (collapsed)
- Re-visit page → completed images stay in collapsed section, not in active view
- Retry after simulated failure → idempotent (no duplicate Spaces objects or DB rows)
- (When Spaces + DB wired) Ingest → `calendar_pages` + `calendar_days` rows created, crops in Spaces

---

## CODEX Review Log

Review received 2026-05-30. All findings addressed above:

| # | Severity | Finding | Resolution |
|---|----------|---------|------------|
| 1 | P1 | Filesystem locality — server can't read `~/Lumix Tether` on droplet | Explicit capture-station deployment model (local SvelteKit during shoots) |
| 2 | P1 | Ingestion not crash-recoverable | Added `ingest_phase`, `ingest_attempts`, `ingest_error`, `spaces_object_key`, deterministic keys, transactional DB writes |
| 3 | P1 | Header crop strategy too brittle | Switched to full-page Vision pass with bounding-box-based month/year location |
| 4 | P1 | 4-row layout deferred past data corruption risk | Grid layout selector in capture UI; block ingestion for unrecognized layouts |
| 5 | P2 | Approved-but-not-ingested limbo | Merged approve+ingest into single action; no hidden intermediate state |
| 6 | P2 | Quality thresholds under-specified | Added corner sharpness, clipped pixel %, calibration step against real captures |
| 7 | P2 | Weak table identity | Added `content_hash` (SHA-256), `file_size_bytes`, `file_mtime`, `supersedes_id` |
| 8 | P2 | Path traversal risk | Actions operate on `capture_intake.id`; server-side discovery; symlink rejection |

---

## Implementation Status (2026-05-30)

Steps 1–9 of the implementation sequence are **built and type-clean** (`npm run check` 0/0, `npm run build` ✓). Step 6 (threshold calibration) and step 10 (full E2E) are partially done and require real rig captures at the capture station.

**Built:**
- `0007_capture_intake.sql` — applied (dev box). App-role access verified.
- `src/lib/ingest/classify.ts`, `quality.ts`, `day-grid.ts`, `spaces-upload.ts`, `ingest.ts`
- `src/lib/db.ts` — added `withTransaction()`
- `/admin/capture` `+page.server.ts` (discovery + classify + ingest + setStatus), `+page.svelte` (fit-aware), preview endpoint validation
- `@aws-sdk/client-s3` added to `package.json` (note: 4 transitive npm-audit advisories, non-blocking)

**Calibration findings (tested classify + quality on 4 real samples 1991–2022):**
- **Quality:** corner-sharpness as an absolute threshold false-flags good pages — blank white calendar cells score ~0–2 under the Laplacian, indistinguishable from blur. Removed from the verdict (still recorded for future content-aware use). Clipped-pixel threshold raised to 20% (white paper legitimately sits near 255). All 4 samples now correctly `good`.
- **Classification:** switched from header-region regex to token-geometry: pick the most prominent in-band **4-digit** year, accept a month only if a month token is **adjacent** to it. This eliminated two failure modes — a small `DECEMBER 2021` thumbnail outscoring the real `2022` header, and stray body words (`"may"`, handwritten day-number `"22"`) being read as month/year. Result: **zero confidently-wrong classifications**. Clean headers (1994, 2007) → `high`; ambiguous (2022, month not OCR'd) → correct year + `medium` "confirm manually"; unrecognized (1991, header is handwriting) → `low`/null for manual entry.
- **Grid layouts:** a non-wrapped 5-row grid fits only a minority of months (a 31-day month starting Saturday needs slot 36 > 35). Added `5-row-wrapped` (default) and `6-row-standard` (always fits) alongside `5-row-standard` and `4-row-wrapped`. The capture UI now computes fit client-side, defaults each row to the first fitting layout, disables non-fitting options, and excludes non-fitting rows from the ingest batch.

**Remaining:**
- Step 6: re-calibrate thresholds against true G9 II + 60mm rig captures (current values tuned to old handheld samples).
- Step 10: full E2E (discover → classify → ingest → verify `calendar_pages`/`calendar_days` rows + Spaces objects) — requires the capture station with live tether files and working Spaces creds. Not run here (side-effecting: real DB rows + Spaces objects).
- OCR worker must consume the `ocr` `job_runs` enqueued by ingest, cropping each day cell from the page image + `crop_bounds` (no per-day crops are uploaded at ingest time).
- `/admin` auth guard is still the stubbed pass-through (tracked separately as td-510a34); capture runs capture-station-local for now.
