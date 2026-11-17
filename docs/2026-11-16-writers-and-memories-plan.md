# Writers groundwork (td-ef00c8) + Gaylon's memories, first slice (td-bc2c29 / td-76a40f)

> **Status:** built locally 2026-11-17 (CC4), not yet committed. Plan revised after peer review by
> CODEX (9 points) then AGY2 (10 points), all taken; see "Peer review" at the end.
> `npm run test:memories` covers it (79 checks). Code review by CODEX: 2 findings, both fixed and
> verified (see the end).

## Context

Gaylon wants to add his own memories to the family history, starting with 1976 onward. He'll
probably be the only one adding them for now. Each memory either attaches to a day or covers a
month or year.

**How the tasks connect:**
- td-ef00c8 (writers groundwork) blocks **td-bc2c29** ("First-person memory entries — Madonna
  pre-1976, Gaylon 1976+").
- td-76a40f (multi-author family memories, inside epic td-400142) "builds on" td-ef00c8.
- So td-ef00c8 is a prerequisite for the feature he wants, but only part of it is.

**What td-ef00c8 asks for:**
1. A `writers` table plus a `writer_id` on calendar pages.
2. A decision on one-entry-per-date versus several.
3. Writer-aware OCR and LLM prompts.
4. A viewer filter by writer.

**Gaylon's decisions (2026-11-16):**
- **Build only the cheap part of td-ef00c8:** the `writers` table and the writer link on pages and
  memories.
  - Defer the `UNIQUE(year, month)` / `UNIQUE(entry_date)` changes and the writer-aware OCR prompts
    until a second handwritten source actually arrives. They cost no more then, and there's nothing
    to test them against today.
  - Record this in the docs so it isn't revisited by accident.
- **Madonna's 153 existing memories stay where they are** (`calendar_days.day_narrative`, written
  from `/correct`). `/correct` is untouched. The viewer shows hers ("Madonna remembers") and the
  new ones ("Gaylon remembers") together.
- **Dates:** an exact day, or a whole month or year. Month memories show on the Month page and
  year memories on the Year page.
- **Draft until shared:** a saved memory is private to its author until "Share with family". The
  author can unshare, edit or delete it later.

**Production today (read-only):**
- Users: madonna (1, corrector), gaylon (2, admin), caleb, marcus, marcus-admin, ben.
- 263 pages and 8,004 days (1976–2022). 3,974 days are accepted; 153 have Madonna's memory.

## Approach

### 1. Migration `0032_writers_and_memories.sql`

**`writers`**, one row per voice in the archive:

| Column | Notes |
|---|---|
| `id` | `SERIAL` primary key |
| `slug` | Unique |
| `display_name` | Drives the label ("Gaylon remembers"). Separate from `users.display_name`, which people can now change themselves. |
| `user_id` | `UNIQUE`, nullable, plain FK to `users` (NO ACTION). Null for someone who isn't a user, like Gaylon's father. |
| `adds_memories` | `BOOLEAN NOT NULL DEFAULT false`. Whether the linked user can add memories in the viewer. |
| `created_at` | |

- **Seeds:**
  - Madonna gets id 1, linked to `madonna`, `adds_memories = false` because her memories come from
    her correction screen.
  - Gaylon is linked to `gaylon` with `adds_memories = true`.
  - Seeds look the users up by username, and `setval` runs after the explicit id 1.
- No admin page yet. Turning on another family member later is a one-row change, or a toggle on
  `/admin/users` in a later slice.

**`calendar_pages.writer_id`:**
- `INT NOT NULL DEFAULT 1 REFERENCES writers(id)`, so existing rows backfill to Madonna.
- Capture intake needs no change.
- `UNIQUE(year, month)` stays. A comment states that a second calendar source changes it to
  `(writer_id, year, month)` at that time.

**`memories`:**

| Column | Notes |
|---|---|
| `id` | `SERIAL` primary key. `audit_log.entity_id` is `INT` (CODEX #8). |
| `writer_id` | `INT NOT NULL`, FK to `writers`. Whose memory it is. |
| `created_by` | `INT NOT NULL`, plain FK to `users` (NO ACTION). Who typed it. |
| `memory_date` | `DATE NOT NULL`. The first day of the period. |
| `date_precision` | `'day'` / `'month'` / `'year'` |
| `body` | `TEXT NOT NULL`, not blank, at most 10,000 characters |
| `shared_at` | `TIMESTAMPTZ`. Null means a draft. |
| `created_at`, `updated_at` | |
| `fts` | Generated tsvector on `body`, for search in the next slice |

- `created_by` stops anyone who has written a memory from being hard-deleted, as 0031 intended.
- Keeping `writer_id` and `created_by` separate lets Gaylon type a memory Madonna dictates later
  (td-bc2c29) without another migration.
- **Checks:** a month memory must be dated the 1st. A year memory must be dated January 1.
- **Indexes:**
  - a partial index on `(memory_date)` where `shared_at IS NOT NULL`;
  - an index on `(created_by)`.

**`memory_revisions`**, a private, append-only body history (CODEX #1):
- One row per save, share, unshare and delete: `memory_id INT` (no FK, so the history survives a
  delete), `action`, `body`, `memory_date`, `date_precision`, `shared`, `revised_by`, `revised_at`.
- The generic `audit_log` row for each action holds **metadata only**: memory id, date,
  precision, shared yes/no and body length, never the text.
  - Without this, workers (0004 grants them `SELECT` on every existing table, including
    `audit_log`) and the admin activity log (`src/routes/admin/audit/+page.server.ts` shows
    before/after values) would be a second way to read a draft.
- A deleted memory can be recovered from `memory_revisions` by hand with `psql`. No UI does this
  in this slice.

**Grants** (0028 pattern: revoke tables **and sequences** first, CODEX #7):
- `REVOKE ALL` on `writers`, `memories`, `memory_revisions`, `writers_id_seq`,
  `memories_id_seq` and `memory_revisions_id_seq` from app and worker.
- **App:**
  - `SELECT` on `writers`;
  - `SELECT, INSERT, UPDATE, DELETE` on `memories`;
  - `SELECT, INSERT` on `memory_revisions`, so the history really is append-only;
  - `USAGE` only on the memories and memory_revisions sequences.
- **Worker:** nothing on any of them. Enrichment and narratives get a narrow grant (shared rows
  only, likely through a view) when they start reading memories.

### 2. Server module `src/lib/server/memories.ts`

**Functions:**
- `getWriterForUser(userId)`: returns the writer only when `adds_memories` is true. This is the
  single permission check, used by every action and loader.
- `getDayMemories(date, viewerId)`: shared day memories for the date, plus the viewer's own drafts
  flagged `draft: true`.
- `getPeriodMemories('month' | 'year', key, viewerId)`: the same, for month and year memories.
- `listMyMemories(userId)`: everything this user typed, drafts first, then by **memory date**
  (newest first), then by last edit. A retrospective writer finds memories by when they happened,
  not when they were typed (AGY2 #10).
- **Writes:** `createMemory`, `updateMemory`, `setShared`, `deleteMemory`.

**Write rules:**
- **Authorization on every loader and action** (CODEX #2). `/app` lets every signed-in role in
  (`src/hooks.server.ts`), so the menu flag is not a guard.
  - Every memories loader and action calls `getWriterForUser` and returns 403 unless
    `adds_memories` is true.
  - `writer_id` and `created_by` always come from the session, never from the posted form.
  - Every read-for-edit and every mutation is scoped in SQL: `WHERE id = $1 AND created_by = $me`,
    with `SELECT … FOR UPDATE` inside the transaction. Someone else's id gets 404, not 403, so it
    doesn't confirm the memory exists.
- **Each write is one transaction:** lock the row, change it, append a `memory_revisions` row, and
  write a metadata-only `audit_log` row. The actions are `memory_create`, `memory_edit`,
  `memory_share`, `memory_unshare` and `memory_delete`.
- **Explicit intent; no stale overwrites** (CODEX #3):
  - Each button posts its own action. A draft gets *Save draft* and *Save and share*; a shared
    memory gets *Save changes* (stays shared) and *Unshare*. A save never changes sharing as a side
    effect.
  - The form carries the `updated_at` it loaded. The UPDATE requires it to match. Otherwise it
    returns 409, "This memory was changed in another window. Reload to see the latest", and keeps
    the typed text in the form.
- **Date validation** (CODEX #9):
  - Build the date from the selects, then validate it with `isValidEntryDate`
    (`src/lib/server/viewer.ts`) **before** normalizing month and year memories to the 1st, so
    Feb 30 is refused rather than rolled over.
  - Range: 1900-01-01 to "today" meaning today's date **in UTC+14** (the earliest time zone), so
    an evening entry on an iPhone in the US is never refused as a future date (AGY2 #10).
  - Precision must be one of the three values.
  - Malformed input gets a plain-words error.

**Account deletion:** add `memories: 'memories'` and `writers: 'a writer profile'` to
`CONTENT_WORDS` in `src/routes/admin/users/+page.server.ts` (CODEX #6). Linking a user to a writer
is itself a NO ACTION FK, so an enabled writer with zero memories also can't be hard-deleted. Both
cases are tested. (To delete such a throwaway account, unlink the writer first; no UI for that in
this slice.)

### 3. Writing memories: `/app/memories` (signed-in writers only; anyone else gets 403)

**`/app/memories`, "My memories":**
- **Add a memory** button.
- A list of the user's memories. Each shows the date label ("Mon, May 2, 1983", "June 1978",
  "1978"), the first lines, and a status badge: **Draft — only you** or **Shared with family**
  (color plus text).
- Each row has Edit and View-on-page links.

**`/app/memories/new` and `/app/memories/[id]`:** one form.
- **"When"** radio buttons: *A specific day*, *A month*, *A year*.
- Then Year / Month / Day `<select>`s. Selects, not `type=month`, because desktop Safari has no
  month picker.
- The date is prefilled from `?date=` / `?month=` / `?year=` when you come from a Day, Month or
  Year page.
- **"When" options as large tap cards** (AGY2 #5): each radio sits inside its `<label>` with a
  border, at least 48 px tall, styled like the existing `.v-segmented` group in
  `src/lib/viewer/viewer.css`.
- **Selects:** add `.app-shell .v-field select` to the shared field rule in `viewer.css` (52 px,
  18 px text), so they match the inputs.
- **Only the relevant selects exist:** Month is hidden for *A year*, and Day is hidden for *A
  month* or *A year*. Hidden, not disabled, so iOS Safari's picker Prev/Next doesn't step through
  them. The day is clamped when the month changes (31 → 30 or 28/29) (AGY2 #6).
- A large textarea for the memory with a real `<label for>`, `maxlength="10000"`, and a quiet
  character count that appears near the limit.
- Buttons: **Save draft**, **Save and share with family**. When editing, also **Unshare** and
  **Delete**; Delete uses a modal confirm, per the rules.

**Implementation:**
- Absolute form actions (`/app/memories/new?/save`, …) and `use:enhance`.
- 44–48 px tap targets and AAA contrast.
- Viewer CSS tokens (`v-field`, `v-btn`, `v-alert`) as on `/app/account`.

**Menu:** `src/routes/app/+layout.svelte` gets "✍️ My memories" for writers only, in the main
drawer list just above "👤 Your account". It does **not** go in the staff-only "Your other tools"
group (AGY2 #8). The flag `canWriteMemories` comes from `+layout.server.ts`.

**Back links:** `backLabel()` in `src/lib/viewer/nav.ts` learns `/app/memories` → "My memories", so
"View on page" and "+ Add your memory" round trips show "◂ My memories" (AGY2 #8).

**Status badges** (AGY2 #7), shown as color plus text plus icon, both AAA:
- **✓ Shared with family:** `--color-evergreen-soft` background, `--color-evergreen-dark` text
  (about 11.9:1).
- **🔒 Draft — only you:** paper background with a dashed `--color-ink-muted` border (about
  9.3:1).
- On the Day, Month and Year pages, a draft memory block also gets the dashed border and an
  inline **Edit draft** link.

### 4. Reading memories

**Rule: memories and calendar availability are independent** (CODEX #4, #5).
- Each page loads visible memories (shared ones plus the viewer's own drafts) **before** any
  "calendar not found" early return.
- The calendar queries keep their own publication filters exactly as today. A memory never widens
  what calendar text, tags, chips or images are returned.

**Day `/app/day/[date]`:**
- Order under the calendar text:
  1. "Madonna remembers": her `day_narrative`, unchanged, accepted days only as today.
  2. One block per shared memory: "{writer} remembers".
  3. The viewer's own drafts, with a Draft badge.
- Body text uses `white-space: pre-line` and plain-text escaping, never `{@html}`.
- **A date whose calendar day isn't accepted but has a visible memory (shared, or your own
  draft)** renders the date header, a line "Madonna's calendar for this day isn't transcribed yet",
  and the memories. Today that branch returns early at `src/routes/app/day/[date]/+page.server.ts`
  around line 37, and the template gates on `found`.
- A writer on any valid empty date still sees "+ Add your memory of this day".
- **Separate "has calendar" from "has memories" in the page data** (AGY2 #1). Today a single
  `found` flag drives everything. On a memory-only day:
  - the handwriting side panel (`.day-side`) is not rendered, so its "photo isn't available… the
    words are complete" note can't contradict "isn't transcribed yet";
  - `getAdjacentAcceptedDates` still runs, so Prev/Next works.
- **Placement and labels** (AGY2 #2):
  - Memories and the add button go above the page's action row (`.v-actions`).
  - Each block gets `aria-label="{writer}'s memory of this day"`, matching the existing
    "Madonna's memory of this day".
- **Share on a memory-only day:** the Share button is hidden until slice B teaches it to quote
  memories. Otherwise it would share an empty quote.
  - The calendar text, tags, chips and image stay hidden exactly as now, so the publication rule
    doesn't change.
  - Prev/next stays accepted-days-only.
- Writers see **"+ Add your memory of this day"**.

**Month and Year pages:** a "Memories from June 1978" / "Memories from 1978" block showing those
memories, plus "+ Add a memory of this month/year" for writers.
- **Month:** today a captured month shows its page photo even with zero accepted days (a
  deliberate exception), and an uncaptured month returns early
  (`month/[monthKey]/+page.server.ts` around lines 47–61). Keep both behaviors. An uncaptured
  month with visible memories shows the memories instead of the empty state.
  - In that case the header chevrons still come from `getAdjacentCapturedMonths`, and the photo
    column is omitted, so the page never requests a missing page image or shows the broken-photo
    note (AGY2 #4).
- **Year:** any valid year is already valid (`year/[year]/+page.server.ts`). The memories block
  renders **above** the `totalDays > 0` gate, so a year with memories (or your draft) doesn't end
  at "No days from {year} yet" (AGY2 #3).
- **Add buttons live in the empty states too** (AGY2 #3): the Day "not transcribed" state, an
  uncaptured Month, a Month with no days, and a Year with no days all offer the writer
  "+ Add a memory of this day/month/year".

### 5. Docs and td

**Docs:**
- `docs/calendar-history-system-V5.md` gets a short "Writers and memories" section. It covers the
  model, the `writer_id` versus `created_by` split, precision, drafts, and the **deferred** items
  with the reason (the per-writer uniqueness change, writer-aware OCR, the many-per-date journal
  model). This meets td-bc2c29's "design doc first".
- `docs/2026-11-05-family-viewer-v3-redesign-plan.md` gets a pointer line.

**td:**
- Close td-ef00c8 with the deferred list noted.
- Log the slice on td-bc2c29 and td-76a40f.
- File a follow-up task for slice B.

### Next slice (B, not in this plan)

- Search includes memories.
- `has_memory` flags count shared memories (`viewer.ts` ×3, `app/+page.server.ts`, search).
- Share and Book view include memories.
- The include/exclude-by-writer toggle (td-76a40f), worth building once there's a second
  non-Madonna writer.
- The enrichment worker reads memories, so people and places get chips.
- Madonna's pre-1976 memories, typed by Gaylon for her.

## Critical files

- **New:**
  - `backend/db/migrations/0032_writers_and_memories.sql` (`writers`, `memories`,
    `memory_revisions`, `calendar_pages.writer_id`)
  - `src/lib/server/memories.ts`
  - `src/routes/app/memories/+page.server.ts` and `+page.svelte`
  - `src/routes/app/memories/new/…` and `src/routes/app/memories/[id]/…` (one shared
    `MemoryForm.svelte` in `src/lib/components/viewer/`)
  - `scripts/test-memories.mjs`, with a `test:memories` script in `package.json`
- **Modified:**
  - `src/lib/viewer/viewer.css` (selects, the "When" tap cards, badges, draft blocks)
  - `src/lib/viewer/nav.ts` (`backLabel`)
  - `src/routes/app/day/[date]/+page.server.ts` and `+page.svelte`
  - `src/routes/app/month/[monthKey]/…` and `src/routes/app/year/[year]/…`
  - `src/routes/app/+layout.server.ts` and `+layout.svelte`
  - `src/routes/admin/users/+page.server.ts` (`CONTENT_WORDS`)
  - the V5 and V3 plan docs
- **Untouched:** `/correct`, the workers, and the capture intake code.

## Verification

**Test stack only** (`madonnahist_test` on 15434, dev server on 5177 with `--mode test`):
- `npm run test:db:migrate` and `test:db:invariants`. Existing pages backfill to writer 1 and a
  new capture insert gets writer 1.
- `npm run check`: 0 errors and 0 warnings.

**New `test:memories`** (run twice, nothing left behind):
- **Who can write:**
  - Only a user whose writer has `adds_memories` can open `/app/memories` or save. A viewer and
    Madonna (corrector) get 403, and signed-out visitors are redirected.
  - A writer with `adds_memories` turned off gets 403.
  - A **second enabled test writer** gets 404 on another writer's memory for GET edit, edit,
    delete, share and unshare. Posted `writer_id` / `created_by` fields are ignored.
- **Drafts and sharing:**
  - A draft is invisible to another viewer on the Day, Month and Year pages; sharing shows it, and
  unsharing hides it again.
  - You can't edit or delete someone else's memory.
- **Dates:**
  - The DB rejects a month or year memory not dated the 1st, a blank body, and an over-long body.
  - The app rejects 1899, future dates, Feb 30, a valid Feb 29 that isn't in a leap year,
    malformed dates and an unknown precision. A real leap day (1980-02-29) is accepted.
- **Stale edits:** two saves made from the same loaded version: the second gets 409 and changes
  nothing. Save on a shared memory leaves it shared.
- **Private text stays private:**
  - No `audit_log` row contains the body.
  - The worker role can't read `memories` or `memory_revisions`, and the app can't
    UPDATE/DELETE `memory_revisions`.
  - After unsharing, the text is gone from every viewer-visible page.
- **Dates near midnight:** the date that is "today" in UTC+14 is accepted; the day after it is
  refused.
- **Memory-only Day page:** no handwriting panel, no Share button, Prev/Next present.
- **Uncaptured month with a memory:** no page-image request, and the chevrons are present.
- **Draft-only and empty pages:** a Day page with only your draft shows the draft to you and the
  plain empty state to anyone else. The same holds for an uncaptured month and for a year.
- **Audit:** each action writes a metadata-only audit row (no body text) and a
  `memory_revisions` row holding the text (AGY2 #9).
- **Non-accepted dates:** a shared memory on a non-accepted date shows the memory but never that
  day's draft calendar text.
- **Escaping:** `<script>` in a body comes back escaped.
- **Account deletion:** deleting an account that wrote a memory returns 409 "(memories)". An
  enabled writer with no memories returns 409 "(a writer profile)".
- **Worker:** the worker role can't read `memories`.

**Existing suites must still pass:** invites, auth, viewer, admin-audit, places,
correction-workflow, invariants, accounts.

**Browsers:**
- Chrome screenshots at 390 px and 1280 px: My memories, the form, a Day page with Madonna's and
  Gaylon's memories plus a draft, and a memory-only Day page.
- The same flow in Safari through raw safaridriver HTTP.

**Deploy, only on Gaylon's go-ahead:** `./scripts/deploy-to-DO.sh` applies 0032. Afterwards,
read-only checks:
- `writers` has the two rows.
- All 263 pages have `writer_id = 1`.
- `/app/memories` loads for gaylon.

## Peer review

### CODEX (2026-11-17, static source review): all 9 taken

| # | Point | Change in this plan |
|---|---|---|
| 1 (High) | Draft text would leak through `audit_log`: workers read every table (0004:59) and `/admin/audit` shows before/after | Private append-only `memory_revisions`; audit rows are metadata only |
| 2 (High) | Ownership must be enforced on every loader and action; `/app` admits every role | `getWriterForUser` on every route; SQL-scoped `id AND created_by`; server-derived ownership; 404 for others |
| 3 | Save draft on a shared memory, and stale tabs | Separate buttons per intent; `updated_at` check → 409 |
| 4 | Day/Month return early before memories could load; own drafts too | Memories loaded independently, before the early returns |
| 5 | Month photo exception and year validity misdescribed | Described as they really are; both preserved |
| 6 | `writers.user_id` is itself a delete blocker | `CONTENT_WORDS` gets writers; both blockers tested |
| 7 | Sequences inherit grants from 0004 default privileges | Explicit sequence revokes; app gets `USAGE` only |
| 8 | `audit_log.entity_id` is `INT` | `SERIAL` ids |
| 9 | Boundary tests missing | Leap/malformed dates, precision, ownership, stale edits, private-text checks added |

### AGY2 (2026-11-17, UX and accessibility review): all 10 taken

| # | Point | Change in this plan |
|---|---|---|
| 1 | Memory-only Day would show a contradictory "photo isn't available" panel, and no Prev/Next | Separate calendar and memory flags; hide `.day-side`; keep adjacent dates |
| 2 | Placement, labels and Share on memory-only days | Memories above `.v-actions`; per-writer `aria-label`; Share hidden until slice B |
| 3 | Add buttons missing from empty states; Year dead-ends at "No days" | Add buttons in every empty state; Year memories above the gate |
| 4 | Uncaptured month would request a missing photo | Omit the photo column; keep the chevrons |
| 5 | Selects and radios would miss 44–48 px targets | Shared select style; radios as 48 px tap cards |
| 6 | iOS picker steps through disabled selects; invalid days | Hide irrelevant selects; clamp the day; labeled textarea with a count |
| 7 | Badges need non-color cues and AAA contrast | ✓ / 🔒 icons, the dashed draft border, contrast ratios specified |
| 8 | Back links and menu placement | `backLabel` for `/app/memories`; the menu link above Your account |
| 9 | Verification still said audit holds the text | Fixed: metadata audit plus `memory_revisions` |
| 10 | Evening entries refused as "future"; list sort | "Today" in UTC+14; sort by memory date |

### CODEX code review (2026-11-17, after build): 2 findings, both fixed and verified

| # | Finding | Fix |
|---|---|---|
| 1 (Medium) | Unshare had no version check. A stale tab's Unshare succeeded, the page reloaded the new version under the old text, and the next Save overwrote newer text without a 409. Share and delete had the same gap. | `setShared` and `deleteMemory` take the loaded version and 409 on a mismatch. The edit page keeps its own `loadedVersion`, which only advances from its own successful share/unshare. Tests cover stale share, unshare and delete; a Chrome two-tab regression passes. |
| 2 (P1) | Without JS, a refused save re-rendered with the latest version beside the stale text, so a second Save overwrote. | Refused saves return the submitted version with the typed values, and the page seeds `loadedVersion` from it. A plain-HTML regression test passes. |
