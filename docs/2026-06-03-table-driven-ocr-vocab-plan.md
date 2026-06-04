# Plan: Table-Driven OCR Prompt + Admin Vocabulary/Lexicon UI

## Context

The OCR worker's Claude cleanup prompt has family names, activities, places, and terms hardcoded in a string constant (`CLEANUP_PROMPT` in `ocr-worker.ts:29-48`). The `ocr_vocabulary` table already exists with 30 seed rows matching those hardcoded values, but the worker doesn't read it yet. Similarly, `correction_lexicon` is being populated from Madonna's corrections (word-level substitution pairs like "Nirdac"→"Nordic"), but nothing feeds those pairs back into the OCR prompt. There's also no admin UI to review, add, edit, or delete vocabulary entries or curate the lexicon.

This plan closes the loop: the OCR prompt reads from the DB tables, Madonna's corrections feed the lexicon, and Gaylon can manage both tables through an admin UI.

---

## TD Task Status Assessment

| Task | Status | Notes |
|------|--------|-------|
| **td-9a30ae** (OCR worker) | **Partially complete** | Original spec was for a single-stage Google Vision worker. We built a two-stage pipeline (Google Vision full-page → Claude cleanup) that exceeds the original spec. What's missing: the worker still uses a hardcoded prompt instead of reading `ocr_vocabulary`, and the acceptance criteria around confidence-based auto-flagging via trigger haven't been verified. The core worker functionality (poll jobs, OCR images, write `ocr_runs`, enqueue `llm_cleanup`) is done. |
| **td-f28797** (Correction lexicon population) | **Complete** | `src/lib/correction-lexicon.ts` — `populateLexicon()` runs on accepted corrections, compares LLM draft against corrected text, upserts substitution pairs with frequency tracking and character-level similarity filter. Done and deployed. |
| **td-ad0db9** (OCR vocabulary CRUD UI) | **Open** | Table exists with seed data, no admin UI yet. |
| **td-064f40** (Re-evaluate OCR accuracy) | **Open** | Depends on having enough corrections to measure against. Conceptually separate from this plan — a future analysis task once the lexicon has more data. |
| **td-510a34** (Cookie sessions + auth) | **Open** | Real auth with argon2id + cookie sessions + route guards. Currently stubbed: `/correct` routes hardcode Madonna's user, `/admin` routes are unprotected. Important but orthogonal to this plan. |

---

## CODEX Review Integration

CODEX reviewed this plan (2026-06-04T00:11:55Z). Five findings integrated below:

| # | Severity | Finding | Resolution |
|---|----------|---------|------------|
| 1 | P1 | Admin stub assigns admin identity to all `/admin` requests — not a guard. Destructive form actions make this worse. | Add a temporary guard: reject `/admin` requests unless from localhost or known IP. Not real auth, but prevents drive-by mutations until td-510a34. |
| 2 | P1 | Re-granting DELETE on `correction_lexicon` undoes migration 0013 and reopens the reviewed privilege issue. | Use soft-delete instead: add `is_active` + `suppressed_at` columns to `correction_lexicon`. Admin "deletes" set `is_active = false`. Worker query filters `WHERE is_active = true`. No DELETE grant needed. |
| 3 | P2 | Missing audit logging for vocabulary/lexicon mutations. Grid-align already writes `audit_log` rows for every mutation. | All 6 form actions write `audit_log` rows with `user_id`, `action`, `entity_type`, `entity_id`, `before_value`, `after_value`. Follow the grid-align pattern exactly. |
| 4 | P2 | Dynamic prompt lacks provenance. `llm_draft_runs.prompt_version` exists but won't capture which vocabulary/lexicon content produced a draft. | Store a deterministic prompt content hash in `prompt_version` (e.g., `"dynamic-v1-{sha256_first8}"` where the hash covers the assembled vocab+lexicon text). Allows tracing which prompt content produced each draft. |
| 5 | P3 | `--dry-run` exits before building the Claude prompt, so verification step 8 can't actually exercise the dynamic prompt. | Add `--show-prompt` flag: builds and prints the assembled prompt, then exits. Separate from `--dry-run` (which tests job polling). |

---

## What This Plan Builds

### Part 1: Table-Driven OCR Prompt

**File:** `backend/workers/ocr-worker.ts`

Replace the hardcoded `CLEANUP_PROMPT` with a function that queries both tables at runtime:

1. **Query `ocr_vocabulary`** — `SELECT term, category, context_note FROM ocr_vocabulary WHERE is_active = true ORDER BY category, term`
2. **Query `correction_lexicon`** — `SELECT ocr_token, corrected_token, frequency FROM correction_lexicon WHERE is_active = true ORDER BY frequency DESC LIMIT 50` (top 50 most-seen active substitutions)
3. **Build the prompt dynamically** — same structure as today's hardcoded prompt, but populated from query results:
   - "Names: ..." from `category='person'` rows, appending `context_note` in parens when present
   - "Activities: ..." from `category='activity'`
   - "Places: ..." from `category='place'`
   - "Terms: ..." from `category='term'`
   - New section: "KNOWN OCR ERRORS (the handwriting OCR often misreads these):" listing lexicon pairs as `"Nirdac" → "Nordic"` etc.
4. **Prompt provenance** — compute a SHA-256 hash of the assembled vocab+lexicon text. Store as `prompt_version = "dynamic-v1-{hash_first8}"` in `llm_draft_runs`. This lets us trace which vocabulary/lexicon state produced each draft.
5. **Cache the prompt per worker run** — query once at startup and refresh every N jobs (e.g., 50) so new vocabulary/lexicon entries take effect without restarting the worker. Not per-job (unnecessary DB load). Re-hash on each refresh.
6. **`--show-prompt` flag** — builds and prints the assembled prompt to stdout, then exits. For verifying the dynamic prompt without running jobs.

**Key design point:** The lexicon pairs become OCR hints, not auto-corrections. Claude still makes the judgment call — the prompt says "the OCR often misreads these" as context, not "always replace X with Y."

### Part 2: Migration 0014

**File:** `backend/db/migrations/0014_lexicon_soft_delete.sql`

Add soft-delete columns to `correction_lexicon` (preserves the 0013 DELETE revoke):

```sql
ALTER TABLE correction_lexicon ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE correction_lexicon ADD COLUMN suppressed_at TIMESTAMPTZ;
```

No new DELETE grants needed. The app role can UPDATE `is_active` to false (already has UPDATE). The worker filters `WHERE is_active = true` when building the prompt.

### Part 3: Admin Vocabulary UI (`/admin/vocabulary`)

**New files:**
- `src/routes/admin/vocabulary/+page.server.ts` — load + form actions
- `src/routes/admin/vocabulary/+page.svelte` — admin UI

**Layout:** Two-section page:

#### Section A: OCR Vocabulary

- Table listing all `ocr_vocabulary` rows, grouped by category (person/activity/place/term)
- Each row: term, category, context_note, is_active toggle, created_at
- **Add row:** inline form at bottom of each category group (term + context_note fields, category pre-set from group)
- **Edit row:** click to edit term or context_note inline (or modal — whichever is simpler with SvelteKit form actions)
- **Toggle active:** checkbox per row, immediate form submit
- **Delete row:** button with confirmation modal (per cs.md — destructive = modal, not toast)
- **Every mutation writes an `audit_log` row** — `user_id`, `action` (e.g., `'vocab_add'`, `'vocab_update'`, `'vocab_toggle'`, `'vocab_delete'`), `entity_type = 'ocr_vocabulary'`, `entity_id`, `before_value`/`after_value` as JSONB. Pattern from `grid-align/[pageId]/+page.server.ts`.

Form actions: `addVocab`, `updateVocab`, `toggleVocab`, `deleteVocab`

#### Section B: Correction Lexicon

- Table listing all `correction_lexicon` rows (both active and suppressed, with suppressed visually muted), sorted by frequency DESC
- Each row: ocr_token → corrected_token, frequency, first_seen, last_seen, is_active status
- **Suppress row:** soft-delete junk pairs — sets `is_active = false`, `suppressed_at = NOW()` (button with confirmation modal)
- **Restore row:** re-activate suppressed pairs — sets `is_active = true`, `suppressed_at = NULL`
- **Promote to vocabulary:** button that creates an `ocr_vocabulary` row from `corrected_token` (category selected via small dropdown). Does NOT delete/suppress the lexicon row — both can coexist.
- **No add/edit** — the lexicon is auto-populated from corrections; admin can only curate (suppress junk, restore, promote good entries)
- **Every mutation writes an `audit_log` row** — same pattern as vocabulary section.

Form actions: `suppressLexicon`, `restoreLexicon`, `promoteToVocab`

### Part 4: Auth Guard for `/admin` Routes

**File:** `src/hooks.server.ts`

Two changes:
1. **Extend the auth stub** to cover `/admin` routes — query Gaylon's user by username (role: 'admin'), same pattern as the Madonna stub for `/correct`.
2. **Add a temporary IP guard** — for `/admin` routes, reject requests not from `127.0.0.1`, `::1`, or the Cloudflare-forwarded IP matching the known home IP. This isn't real auth, but it prevents anonymous web requests from hitting destructive form actions until td-510a34 lands. Log rejected attempts.

Still marked TODO td-510a34 for real auth.

---

## Deliberately Deferred

- **td-510a34** (real auth) — important but orthogonal; the IP guard + stub is acceptable for now since this is a private app on a private domain behind Cloudflare
- **td-064f40** (OCR accuracy re-evaluation) — needs more correction data; separate analysis task
- **Notation key admin UI** — could go on this same page as a third section, but it's small (3 rows) and less urgent; defer to keep scope tight
- **Auto-expand notation in textarea** — Phase 2 correction UI feature
- **ocr_vocabulary → CLEANUP_PROMPT live preview** — nice-to-have admin feature showing what the prompt would look like with current table state

---

## File Summary

| File | Action |
|------|--------|
| `backend/workers/ocr-worker.ts` | Replace hardcoded CLEANUP_PROMPT with dynamic prompt builder + `--show-prompt` flag |
| `backend/db/migrations/0014_lexicon_soft_delete.sql` | New — add `is_active` + `suppressed_at` to `correction_lexicon` |
| `src/routes/admin/vocabulary/+page.server.ts` | New — load both tables + form actions with audit logging |
| `src/routes/admin/vocabulary/+page.svelte` | New — two-section admin UI |
| `src/hooks.server.ts` | Extend auth stub to cover `/admin` routes + temporary IP guard |

---

## Verification

1. `./backend/db/migrate_pg.sh` — apply 0014
2. `npm run check` — 0 errors, 0 warnings
3. Navigate to `/admin/vocabulary` — see both tables with existing data
4. Add a new vocabulary term → verify it appears in the list, audit_log row written
5. Toggle a vocabulary term inactive → verify the OCR prompt builder excludes it
6. Suppress a lexicon junk pair → verify `is_active = false`, row appears muted in UI, audit_log row written
7. Restore a suppressed pair → verify `is_active = true` again
8. Promote a lexicon entry to vocabulary → verify new `ocr_vocabulary` row created
9. Run `node backend/workers/ocr-worker.ts --show-prompt` → verify prompt includes DB-sourced vocabulary + lexicon hints, and shows the prompt version hash
10. Run OCR worker on a test page → verify `llm_draft_runs.prompt_version` contains dynamic hash
11. Test `/admin` IP guard — request from non-allowed IP gets rejected
