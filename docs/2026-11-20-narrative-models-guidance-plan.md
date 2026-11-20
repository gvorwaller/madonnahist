# td-f1f49b — Year narratives: model choice, saved guidance, draft comparison

Status: plan approved 2026-11-20; reviewed by AGY2 (11 findings, all folded in below, marked **[AGY2 n]**). Code review will be done by Codex after implementation.

## Context

Today a year narrative comes from one hard-coded model (`claude-sonnet-5`, `backend/workers/lib/llm.ts`) and one fixed system prompt (`YEAR_NARRATIVE_SYSTEM`, `backend/workers/enrichment-worker.ts`). Regenerating overwrites the single draft row in `narrative_summaries`. A published year has to be unpublished before it can be regenerated, so the family loses it in the meantime.

Gaylon wants three things:
- Try better models (Claude Opus 5.5, Gemini latest Pro).
- Steer the writing (style, detail, emphasis, factual corrections) with guidance that is saved and reused.
- Compare versions before choosing one.

Decisions (Gaylon, 2026-11-20):
- **Keep every draft.** Each generation is saved as its own candidate. Compare candidates side by side, then promote one with "Use this".
- **Guidance at two levels:** one global "house style" box, plus a notes box for each year. Both are saved and pre-filled.
- **Models:** Claude Opus 5.5 (default) and Gemini latest Pro.

## Design

### 1. Data — `backend/db/migrations/0033_narrative_drafts.sql`

**`narrative_drafts`** — append-only, same idea as `ocr_runs` / `llm_draft_runs`. Columns:
- `id`, `scope`, `scope_key`
- `model_name`, `provider` (`anthropic` | `google` | `legacy` | `manual`)
- `mode` (`fresh` | `revise` | `imported`)
- `base_text` — the exact text that was revised, null for fresh
- `style_guidance`, `year_guidance` — snapshots of the exact text used
- `draft_text`, `day_count`, `input_tokens`, `output_tokens`
- `requested_by INT REFERENCES users(id)` — **nullable** **[AGY2 4]**
- `created_at`
- Index on `(scope, scope_key, created_at DESC)`.

**`narrative_guidance`** — notes per year:
- Primary key `(scope, scope_key)`.
- Columns: `guidance_text`, `updated_by INT REFERENCES users(id)` (nullable), `updated_at`.

**Global house style** lives in `app_state`, key `narrative_style_guidance`, value `{text}`. This copies `src/lib/server/about.ts`, including the length cap and `\r\n` cleanup **[AGY2 11]**.

**Change to `narrative_summaries`:** add `source_draft_id BIGINT REFERENCES narrative_drafts(id)` (nullable). It is null when the text was hand-edited.

**Backfill [AGY2 1]:** each existing `narrative_summaries` row gets one `narrative_drafts` row:
- `mode = 'imported'`, `provider = 'legacy'`
- `model_name = generated_by`, `draft_text = summary_text`, `created_at = generated_at`

Then `source_draft_id` is pointed at that row. Older narratives can be compared and reverted like any other candidate.

**Grants [AGY2 5].** Follow `0032_writers_and_memories.sql`: `REVOKE ALL` on the new tables and sequence first, then grant only what's needed.
- `narrative_drafts`: the worker gets `SELECT, INSERT` plus sequence `USAGE`; the app gets `SELECT` only. Only the worker writes candidates.
- `narrative_guidance`: the worker gets `SELECT`; the app gets `SELECT, INSERT, UPDATE, DELETE`.
- `narrative_summaries`: `REVOKE INSERT, UPDATE ... FROM madonnahist_worker`. This also drops 0021's column grant. The worker can never write family-visible text again, which is stricter than 0021's "can't publish" rule.

**Account deletion:** add `narrative_drafts` and `narrative_guidance` to `CONTENT_WORDS` in `src/routes/admin/users/+page.server.ts`, so a blocked delete names them.

### 2. Model registry — `src/lib/narrative-models.ts` (pure data, no imports)

Allowlist entries have the shape `{ id, label, provider, effort? }`.
- `claude-opus-5-5`: Anthropic, `effort: 'high'`. Opus 5.5 defaults to `medium`, so the effort must be set explicitly.
- Gemini Pro: `gemini-3.1-pro-preview` (Google's docs, Nov 2026). Confirm with a live `GET /v1beta/models` once the key exists. *(As built: a constant, not an env var, so the model used for family-visible text changes only through a code change.)*

Also exports `DEFAULT_NARRATIVE_MODEL` and `LEGACY_DEFAULT_MODEL`. Queued jobs from before this change have no `model`, so they are treated as `claude-opus-5-5`.

The worker imports this file by relative path, as it already does for `src/lib/server/tags.ts`. The app checks every requested model id against the list.

### 3. Provider dispatch — `backend/workers/lib/llm.ts`

New function: `completeNarrative({ model, system, user }) → { text, inputTokens, outputTokens }`, dispatching on `provider`.

**Anthropic [AGY2 9]:**
- SDK 0.98 already types `output_config.effort` and the `refusal` stop reason, so no upgrade is needed.
- Request: `max_tokens: 16000` (thinking counts against it) and `output_config: { effort }`.
- Throw unless `stop_reason === 'end_turn'`, and throw if the text comes back empty.
- Keep only text blocks.
- Confirm the model id with a live call before release.

**Gemini [AGY2 2]:**
- Plain `fetch` to `https://generativelanguage.googleapis.com/v1beta/models/{id}:generateContent` with `systemInstruction` + `contents`.
- The key goes in an `x-goog-api-key` header, never in the URL, so it can't leak into logs or `last_error`.
- `AbortSignal.timeout(180_000)`.
- No candidates → throw, including `promptFeedback.blockReason` in the message.
- Throw if `finishReason !== 'STOP'`.
- Join only parts where `!p.thought`.
- `outputTokens = candidatesTokenCount + thoughtsTokenCount`, so the count can be compared with Anthropic's, which includes thinking.
- Credential: `getApiKey('google_gemini', 'API_KEY', 'GEMINI_API_KEY')`.

**Stub mode [AGY2 11]:**
- Returns `MADONNAHIST_LLM_STUB_TEXT` with `[model=<id>]` appended.
- When `MADONNAHIST_LLM_STUB_ECHO=1`, it also appends the full system and user prompts, so tests can check that the guidance and base text reached the prompt.
- Token counts are non-zero (the lengths of the strings).

`completeText` and `getEnrichmentModel` are unchanged; entity extraction and `/admin/ask` are not affected.

### 4. Worker — `processNarrativeSummary`

**Payload:** `{ scope, scope_key, model?, mode?, base_text?, style_guidance?, year_guidance?, requested_by? }`.
- Guidance and base text are **copied into the payload when the job is queued [AGY2 6.3]**. Editing notes while a job waits doesn't change it.
- An old payload with only `{scope, scope_key}` runs as Opus 5.5 in `fresh` mode, with the guidance currently saved and `requested_by = null`.
- `requested_by` is parsed defensively, the same way `processPdfExport` does it.

**Validation:** the model must be on the list. `revise` requires a non-empty `base_text`. Anything else fails the job with a clear `last_error`.

**System prompt, in this order [AGY2 8]:**
1. The base instructions. The faithfulness rule distinguishes two inputs:
   - `<house_style>` governs voice, tone, structure and length only. It never adds facts, people, places or events.
   - `<editor_notes year="…">` are authoritative family identifications, shorthand disambiguation, and corrections to how the entries read. The model may state background facts that the notes give explicitly and use them to interpret entries. It must not invent scenes beyond what the notes literally say. It must not tie a note's fact to a month or date unless that month's or date's entries support it.
2. `<house_style>…</house_style>`, if any.
3. `<editor_notes year="YYYY">…</editor_notes>`, if any.
4. The output-format rule **last**: plain prose, no headings or lists, narrative text only.

**User message:** always contains the accepted entries (same `buildYearNarrativePrompt`). In `revise` mode it adds `<current_narrative>…</current_narrative>` and asks for a revision that follows the editor's notes and keeps whatever they don't address.

**Base text [AGY2 1]:** revise uses the **current `narrative_summaries.summary_text`**, captured when the job is queued. Hand edits are therefore what gets revised, not an older AI candidate.

**Output:** INSERT one `narrative_drafts` row. No write to `narrative_summaries`; the published guard and the race guard go away. The job note reads `draft #N from K accepted day(s) via <model>`.

**Dedupe [AGY2 6]:** one pending/in-progress job per (year, model). The comparison uses `COALESCE(payload->>'model', 'claude-opus-5-5')`, so a queued old-style job counts as an Opus job.

### 5. Admin UI — `src/routes/admin/narratives/+page.{server.ts,svelte}`

**`load`:**
- Years, house style, notes for each year, and candidates for each year (a lean list; full text included because each year has only a handful).
- `pendingModels: string[]` for each year **[AGY2 6]**.
- Whether `ANTHROPIC`/Gemini keys exist is not checked; a missing key fails the job, and the error shows on the row.

**Actions:** all use absolute paths (`/admin/narratives?/x`) because of the Safari bfcache issue.
- `saveStyle`: app_state, audited with `entity_type='app_state'`, `entity_id=0`.
- `saveNotes` **[AGY2 11]**: saves a year's notes without generating anything; audited.
- `generate`:
  - Validates the models (one or more), the mode and the year.
  - Saves the notes.
  - Rejects with 409 if any requested model is already pending.
  - `revise` with no current text → 400.
  - Inserts one job per model with the copied payload, in one transaction, with audit rows.
- `useDraft` **[AGY2 7]**:
  - In one transaction: `SELECT … FROM narrative_summaries … FOR UPDATE`.
  - Load the candidate with `WHERE id=$1 AND scope='year' AND scope_key=$2`.
  - If the row is published and `confirmPublished !== '1'`, return 409 asking for confirmation.
  - Upsert, keeping `is_published` as it is, and set `generated_by`, `generated_at` and `source_draft_id`. *(As built: `generated_at` is the draft's own `created_at`, the date the text was written, not the date it was chosen.)*
  - Audit the before and after text.
- `saveEdit`: unchanged, plus it sets `source_draft_id = NULL` (the "from" line then says "edited by hand").
- `publish` / `unpublish`: unchanged.
- **`unpublishAndRegenerate` is removed.** Generating no longer touches published text.

**Page:**
- **House style:** a collapsible box at the top, with its own Save.
- **Every year row can expand [AGY2 3]**, even with no narrative yet. `waiting` and the decade badges also count years that have candidates but no narrative.
- **Expanded year:**
  1. **Current text:** preview, Edit, and a "From: model · date" or "Edited by hand" line.
  2. **Generate panel:**
     - Model checkboxes. Opus is ticked by default; any model already pending is disabled and marked "generating…".
     - Mode radio: "Fresh from entries" / "Revise current text". Revise is disabled when there's no current text.
     - Year notes textarea, with "Save notes" and "Generate".
  3. **Candidates**, newest first:
     - Model, date, mode, token counts, and a short preview of the notes used.
     - Actions: View, a Compare tick (pick two), and "Use this". On a published year, "Use this" opens a confirm modal first.
     - **Compare** is a two-column grid using `minmax(0,1fr)` and `overflow-wrap`, stacking to one column at ≤760px **[AGY2 10]**.
- **Auto-refresh [AGY2 10]:** the 30s `invalidateAll` pauses when Edit is open, the house style has unsaved changes, or any year's notes have unsaved changes. Focus doesn't matter, because tapping a checkbox blurs the textarea.
- Forms use `update({ reset: false })` **[AGY2 10]**.

**Accessibility fixes on this page [AGY2 10]:**
- Muted text `#595959` or darker.
- Status-tag text darkened to 7:1: draft `#5c3e00`, published `#144927`.
- Buttons and checkbox/radio labels at least 44px tall.

### 5b. Changes after CODEX's code review (2026-11-20)

CODEX found 13 issues (3 high, 7 medium, 3 low). Gaylon approved fixing these:
- **[CODEX 1]** Every write to a year's narrative (generate, use, edit, publish, unpublish) takes the year's advisory lock first. A row lock can't protect the first "Use this", because there is no row yet.
- **[CODEX 2]** A hand edit is saved as a draft of its own (provider `human`, mode `edit`), so the "you can switch back" promise in the replace dialog is true. The app may insert drafts, but never update or delete them.
- **[CODEX 3]** `narrative_drafts.job_run_id` is UNIQUE. The draft insert and the job's completion share one transaction, and that transaction is fenced on the claim's `attempts` value, so a stale attempt can't finish a job a newer attempt owns.
- **[CODEX 4]** Notes adopt changes saved elsewhere when nothing has been typed. Unsaved notes survive switching years. Generate sends `notesBase`, and notes left untouched use what is saved instead of writing stale text back.
- **[CODEX 5]** Deploy order (the migration runs before PM2 restarts the worker): check before deploying that no narrative jobs are pending or running in production. No code change.
- **[CODEX 6]** Revise treats the current text as a draft that may be wrong: keep only what the entries or notes support. Day entries are wrapped in `<entries>`, and prompt tags are stripped from them too.
- **[CODEX 7]** A Gemini HTTP error keeps only Google's status and reason codes, never the response body.
- **[CODEX 8]** The worker accepts exactly two payload shapes, legacy or complete; anything else fails before a paid call. A requester deleted while the job waited is stored as NULL.
- **[CODEX 9]** The test no longer deletes other suites' jobs.
- **[CODEX 10]** Years with text or drafts stay listed even if their accepted days are reopened. Generate is disabled there.
- **[CODEX 11]** Save notes shows "Notes saved", not "Queued".
- **[CODEX 12]** Gemini output tokens are NULL when Google sends no counts.
- **[CODEX 13]** The dialog focus trap is deferred to td-eb28c8, for all admin dialogs at once.

### 5c. Changes after CODEX's second review (2026-11-20)
Gaylon approved all eight findings:
- **[CODEX2 1]** Publish and Edit send `expectedDraftId`, the draft the dialog or editor was opened on. Under the year lock, the server returns 409 if the text changed since (another tab); a refused edit stays in the box.
- **[CODEX2 2]** PdfShare keeps nothing between taps. Pages call `reset()` when the year or story (or its PDF edition) changes, and a download that finishes after a reset is dropped.
- **[CODEX2 3]** The PDF fetch uses `redirect: 'manual'`. A redirect means the session expired, which shows a "Sign in" link; a response that isn't `application/pdf` is an error. In the installed app the link never navigates: with no file sharing, it shows the "use Safari" message.
- **[CODEX2 4]** The worker takes `--job-ids=`, and `test-narratives` runs only its own jobs. Its guard also requires port 15434 and the local object store. Not changed: `narrative_invariants.sh` still truncates the narrative tables of the isolated test DB, which only tests use and which gets reset.
- **[CODEX2 5]** `claimJobs` marks a job failed when its final attempt went stale, so it no longer blocks Generate. A dry run returns its claim's attempt.
- **[CODEX2 6]** A non-object payload (JSON null) fails through the fenced path. `MAX_NARRATIVE_LENGTH` (50,000) is shared: hand edits over it are refused, and Generate refuses to revise over-long text.
- **[CODEX2 7]** Save notes takes the year lock.
- **[CODEX2 8]** The draft insert runs under a SAVEPOINT. If the requester's account was deleted meanwhile, it retries with no requester instead of losing the paid result.

### 6. Out of scope
- `/admin/ask` model choice; the registry could feed it later.
- Decade and person narratives (td-e25bd4) can reuse this machinery.
- A cost display in dollars (token counts are shown).

## Setup steps needing Gaylon's OK at the time
1. **Gemini API key:** I create it in the `gaylonphotos` GCP project through his signed-in Safari (enable the Generative Language API, create a restricted key), then confirm the model id with `GET /v1beta/models`.
2. **Store the key** in production `private_data.api_credentials` (`google_gemini` / `API_KEY`). This is a production write.
3. Commit, deploy (`./scripts/deploy-to-DO.sh`), and run 0033 on production. Codex code review comes before that.

## Verification
- `npm run check`: 0 warnings.
- Test stack: `test:db:reset`, `test:db:migrate`, `test:db:invariants`.
- `backend/db/tests/narrative_invariants.sh` **[AGY2 5]**:
  - **Flip** the old Tests 2/3: worker UPDATE/INSERT on `narrative_summaries` must now be denied.
  - Add: the worker can INSERT `narrative_drafts` but can't UPDATE/DELETE it; the app can't INSERT/UPDATE/DELETE drafts; the worker can't write `narrative_guidance`; the app can.
- `scripts/test-narratives.mjs` (stubbed worker + HTTP as admin and viewer):
  - An old-style payload still works.
  - Two models queued together produce two candidates.
  - A duplicate model is rejected with 409.
  - Notes are copied at queue time; editing them afterwards doesn't change the queued job.
  - The echoed prompt contains `<house_style>` / `<editor_notes>` / `<current_narrative>`.
  - Revise uses the hand-edited text.
  - "Use this" promotes the text and writes an audit row.
  - A cross-year `useDraft` is rejected.
  - Publishing without confirmation returns 409.
  - A published year is never changed by generation.
  - A viewer never sees candidates.
  - Cleanup runs through an owner pool (`MIGRATION_PGUSER`), since the app can't delete drafts **[AGY2 5]**.
- Live check on the test stack: one real narrative per model for a small year (a few cents). Pass the Anthropic key explicitly, since Claude Code blanks `ANTHROPIC_API_KEY`.
- Safari check (safaridriver, test dev server on :5177):
  - House-style save.
  - Generate with both models.
  - Compare.
  - "Use this" with the modal.
  - Auto-refresh doesn't wipe typed notes.
- Devlog entry, V5 spec narratives section, `td review td-f1f49b`.
