# Plan: Vocabulary Tables + Correction UI MVP

## Context

Madonna needs to start correcting OCR drafts ASAP. The OCR pipeline (Google Vision → Claude cleanup) is producing usable drafts, but three tables are missing from the DB (`notation_key`, `correction_lexicon`, `ocr_vocabulary`), two columns are missing from `calendar_days` (`expanded_text`, `day_narrative`), and there's no correction UI yet. This plan creates the tables, seeds them, builds a basic correction UI, and includes a minimal correction lexicon population function so that accepted corrections immediately begin improving future OCR.

**Scope reduction note:** V4 Addendum A § A.4 specifies five editor fields including `expanded_text` and `day_narrative` as Phase 1. This MVP deliberately reduces to a single `corrected_text` field to get Madonna working sooner. The columns are created in the migration so the UI can be extended without another migration.

---

## Part A: Migration 0012

**File:** `backend/db/migrations/0012_correction_ui_tables.sql`

### Tables to create

1. **`notation_key`** — shorthand → canonical → meaning (e.g., `(R)` → `Ⓡ` → "Rebekah")
   - Seed: `(R)`/Rebekah, `(G)`/Gaylon, `*`/intimate

2. **`correction_lexicon`** — OCR garble → correct word, auto-populated from accepted corrections
   - Index on `frequency DESC`
   - Not populated at creation — grows as Madonna works via the lexicon population function (Part C)

3. **`ocr_vocabulary`** — family names, activities, places that feed the OCR prompt
   - Seed with all values currently hardcoded in `CLEANUP_PROMPT` (14 names, 8 activities, 2 places, 7 terms)
   - Replaces hardcoded strings in `backend/workers/ocr-worker.ts`

### Columns to add

4. `calendar_days.expanded_text TEXT` — decoded version (symbols → words)
5. `calendar_days.day_narrative TEXT` — Madonna's memories, not on the page

### FTS rebuild

The `fts` generated column must be dropped and re-added to include `expanded_text` and `day_narrative`. Drop the GIN index first, drop the column, re-add with expanded expression, re-create index.

### Grants

- `GRANT UPDATE (expanded_text, day_narrative) ON calendar_days TO madonnahist_app` (column-level UPDATE was restricted in migration 0006)
- `notation_key`, `ocr_vocabulary`: SELECT for both app and worker roles; INSERT/UPDATE/DELETE for app role only (admin-managed)
- `correction_lexicon`: SELECT for both roles; INSERT/UPDATE for app role only (auto-populated from corrections)
- Worker role gets SELECT only on all three tables — no writes
- Sequence grants for the new tables (app role only)

### User seed

Insert Madonna using `INSERT ... ON CONFLICT (username) DO NOTHING`. Do NOT hardcode `id=1` — let the serial assign it. The auth stub (Part B) queries Madonna by username to get her actual ID. Placeholder password hash — real auth lands later (td-510a34).

---

## Part B: Correction UI MVP

### Auth stub

Modify `src/hooks.server.ts` — for `/correct` routes, query the `users` table for username `'madonna'` and set `event.locals.user` with the returned ID (as a string, matching the `App.Locals` type in `src/app.d.ts` where `user.id` is typed as `string`). Cast to `Number()` when passing to queries. Marked with TODO for td-510a34.

### Routes

| File | Purpose |
|------|---------|
| `src/routes/correct/+page.server.ts` | Load months with progress stats, find resume target |
| `src/routes/correct/+page.svelte` | Month list with progress bars, "Resume" button |
| `src/routes/correct/day/[date]/+page.server.ts` | Load day data + 3 form actions: save, skip, flag |
| `src/routes/correct/day/[date]/+page.svelte` | Two-column editor (image + textarea) |
| `src/routes/correct/day/[date]/cell-image/+server.ts` | Serve cropped day image (reuse pattern from `ocr-review/.../crop/[dayId]/+server.ts`) |

### Editor layout (iPad landscape, two columns)

**Left (50%):** Cell image (tappable lightbox), date header, day counter

**Right (50%):** Machine draft (read-only block), corrected text (textarea, pre-filled from LLM draft), action bar

**Bottom action bar (sticky, large touch targets >= 58px):**
- Flag Illegible (secondary, left) — opens confirmation modal with optional note
- Skip (secondary, middle) — writes `status_after='in_progress'` with `review_note='skipped'` so skipped days are distinguishable from untouched pending days and won't reappear in resume
- Save & Next (primary, right) — saves `day_corrections` row with `status_after='accepted'`, advances to next uncorrected day

### Form actions

All actions re-query the day by `params.date` server-side and verify that `source_llm_draft_run_id` belongs to that day — never trust hidden form values alone.

- **save**: `INSERT INTO day_corrections` with `status_after='accepted'`. The existing trigger (`trg_after_correction_insert`) propagates to `calendar_days.corrected_text`. After insert, call the lexicon population function (Part C) to extract word-level diffs. Redirect to next uncorrected day.
- **skip**: `INSERT INTO day_corrections` with `status_after='in_progress'`, `corrected_text=''`, `review_note='skipped'`. This marks the day as seen so the resume query skips it. Redirect to next day with `correction_status='pending'`.
- **flag**: `INSERT INTO day_corrections` with `status_after='illegible'` (not `'flagged'` — use the specific semantic since the button says "Flag Illegible"), `corrected_text=''`, optional `review_note`. Redirect to next.

### Resume query

The `/correct` home and Save & Next navigation query for the next day to correct:

```sql
SELECT entry_date::text FROM calendar_days
 WHERE correction_status = 'pending'
   AND latest_llm_draft_run_id IS NOT NULL
 ORDER BY entry_date LIMIT 1
```

This excludes `in_progress` (skipped), `accepted`, `flagged`, and `illegible` days — only truly untouched `pending` days with drafts ready appear in the queue.

### Key patterns to reuse

- `enhance()` from `$app/forms` (pattern from grid-align)
- Lightbox from ocr-review `+page.svelte`
- Image crop serving from `ocr-review/.../crop/[dayId]/+server.ts`
- `query()` and `withTransaction()` from `src/lib/db.ts`

### CSS constraints

- `font-size: 18px` on textarea (prevents iOS Safari zoom on focus)
- `min-height: 58px` on action buttons (44pt touch target)
- WCAG AAA 7:1 contrast
- `@media (max-width: 768px)` single-column fallback
- Component-scoped, no Tailwind

---

## Part C: Correction Lexicon Population

**File:** `src/lib/correction-lexicon.ts`

A function called after each accepted correction that word-diffs the OCR raw text against the corrected text and upserts substitution pairs into `correction_lexicon`.

1. Retrieve `ocr_runs.raw_text` via `calendar_days.latest_ocr_run_id` for the day
2. Tokenize both texts (split on whitespace/punctuation, preserve notation symbols)
3. Align tokens using simple edit-distance alignment
4. For each substitution where `ocr_token ≠ corrected_token`:
   ```sql
   INSERT INTO correction_lexicon (ocr_token, corrected_token, first_seen, last_seen)
   VALUES ($1, $2, CURRENT_DATE, CURRENT_DATE)
   ON CONFLICT (ocr_token, corrected_token)
   DO UPDATE SET frequency = correction_lexicon.frequency + 1,
                  last_seen = CURRENT_DATE;
   ```
5. Called from the `save` form action after the `day_corrections` INSERT succeeds

This is intentionally a simple application-level function, not a DB trigger — keeps the logic visible and testable. The OCR worker does not yet read from `correction_lexicon` (deferred), but the table accumulates data from day one so it's ready when the prompt integration is built.

---

## Deliberately deferred

- Fields 4 & 5 UI (expanded_text, day_narrative) — columns exist, no editor fields yet (scope reduction from Addendum A § A.4)
- Notation key auto-expand in textarea
- OCR worker reading `correction_lexicon` or `ocr_vocabulary` tables (still uses hardcoded prompt)
- Session tracking via `correction_sessions`
- Surrounding-day context sidebar
- Keyboard shortcuts (Cmd+S, Cmd+Right, etc.)
- Auto-save with debounce
- `/correct/calendar` month-grid navigator
- `/correct/done` session summary

---

## Verification

1. `./backend/db/migrate_pg.sh` — apply 0012
2. Verify tables: `notation_key` (3 rows), `ocr_vocabulary` (~25 rows), `correction_lexicon` (0 rows), `users` (1 row for madonna)
3. Verify grants: app role can INSERT into `day_corrections`, UPDATE `expanded_text`/`day_narrative`; worker role has SELECT only on new tables
4. `npm run check` — 0 errors, 0 warnings
5. Navigate to `/correct` — see January 2022 with progress
6. Click into a day — image loads, draft text shows, textarea pre-filled
7. Edit and Save & Next — verify `day_corrections` row created, `calendar_days.corrected_text` updated by trigger, `correction_lexicon` has new rows from word diff
8. Flag a day — verify status changes to `illegible` with note
9. Skip — verify `correction_status` changes to `in_progress`, day no longer appears in resume queue
10. Test on iPad Safari landscape — verify touch targets, no input zoom

---

## Codex Review Log

| # | Severity | Finding | Resolution |
|---|----------|---------|------------|
| 1 | P1 | Auth stub user.id type mismatch (string vs number) | Store as string in locals, cast with Number() in queries |
| 2 | P1 | Hardcoded user_id=1 is fragile | INSERT ON CONFLICT, query by username in stub |
| 3 | P1 | Lexicon auto-population deferred but stated as goal | Added Part C: lexicon population function in MVP |
| 4 | P2 | Flag Illegible writes 'flagged' not 'illegible' | Changed to `status_after='illegible'` |
| 5 | P2 | Skip has no durable state, resume loops back | Skip now writes `status_after='in_progress'` with review_note='skipped' |
| 6 | P2 | Grants too vague, may overgrant worker | Explicit: worker gets SELECT only on all three new tables |
| 7 | P2 | Save action trusts hidden form value for draft ID | Re-query by params.date server-side, verify draft belongs to that day |
| 8 | P3 | MVP scope conflicts with Addendum A Phase 1 | Added explicit scope reduction note in Context section |
