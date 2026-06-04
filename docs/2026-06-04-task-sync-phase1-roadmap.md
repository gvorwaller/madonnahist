# Plan: Task Synchronization & Phase 1 Completion Roadmap

## Context

The madonnahist project has been under active development for about a month. Significant work has been done — OCR worker, capture intake, grid alignment, vocabulary UI, correction editor — but the td task list is out of sync with reality. Several completed tasks are still marked open, blocking relationships are stale, and Phase 1's remaining work is a small, well-defined set. This plan synchronizes tasks with the codebase, closes what's done, and charts the path to Phase 1 completion.

---

## Part 1: Task Closures (completed work)

### Close td-ad0db9 — "OCR vocabulary hints CRUD UI"
**Rationale:** Fully implemented at `/admin/vocabulary` with 7 form actions (addVocab, updateVocab, toggleVocab, deleteVocab, suppressLexicon, restoreLexicon, promoteToVocab). All actions wrapped in `withTransaction` with audit_log entries. Vocabulary grouped by category with add/edit/toggle/delete. Lexicon with suppress/restore/promote-to-vocab. CODEX-reviewed and deployed.

### Close td-b10bd3 — "Monitor DO droplet memory after image cache fix"
**Rationale:** Root cause identified and fixed (three unbounded module-scope Sharp buffer caches → single 2-entry LRU with active eviction). RSS dropped 409 MB → 16-34 MB. Deployed to production. Ongoing monitoring is BAU operations, not a task.

### Close td-064f40 — "Re-evaluate OCR model accuracy against accumulated corrections"
**Rationale:** The table-driven dynamic prompt (ocr_vocabulary + correction_lexicon → `buildCleanupPrompt()`) IS the mechanism for auto-improving OCR/LLM cleanup. The correction_lexicon auto-populates from Madonna's accepted corrections and feeds back into the prompt. The feedback loop is live. Future accuracy evaluation happens naturally as more corrections accumulate — it's a continuous process, not a discrete task.

---

## Part 2: Task Updates (scope adjustments)

### td-3adb8a — Correction UI: reduce Phase 1 scope, close when auth lands

**Current state:** The correction editor at `/correct/day/[date]` is functional with:
- Machine draft display (OCR raw text + LLM draft)
- Corrected text textarea with draft restore from latest `day_corrections` row
- Save & Next (status='accepted'), Skip (status='in_progress'), Flag Illegible (status='illegible')
- Cell image + full-page lightbox
- Prev/next uncorrected navigation
- Lexicon auto-population on save

**Missing from original spec (defer to Phase 2):**
- `expanded_text` and `day_narrative` editor fields (DB columns exist, no UI)
- Auto-save (1s debounce) — currently manual save only
- `correction_sessions` tracking (table exists, not used by app)
- Notation auto-expand from `notation_key` table
- Keyboard shortcuts (⌘S, ⌘→, etc.)
- Surrounding-day context sidebar

**Action:** Update the task description to note the Phase 1 scope is the core editor. Create a new Phase 2 task for the polish features. Close td-3adb8a after auth (td-510a34) is live and the editor is verified with real sessions.

### td-8ea4c5 — Notation key admin UI: move to Phase 2

**Current state:** `notation_key` table exists with 3 seed rows (Ⓡ, Ⓖ, *). No admin UI. No consumers — neither the correction UI auto-expand nor the OCR worker reads this table yet.

**Action:** Move to Phase 2. Group with correction UI polish since its primary consumer is the notation auto-expand feature. Remove td-510a34 as a blocker (the existing `/admin` auth stub is sufficient).

### td-7229cc — E2E smoke test: add td-510a34 as explicit blocker

The acceptance criteria requires login/logout role switching. Auth is an implicit dependency. Make it explicit.

---

## Part 3: Remaining Phase 1 Work (implementation order)

### Step 1: Auth — td-510a34 (~2-3 hours)

Port the giftlist auth pattern (argon2id + cookie sessions) to madonnahist. The giftlist has a complete reference implementation. The madonnahist schema already has `users` and `sessions` tables. `argon2` is already in `package.json`.

**Files to create/modify:**
| File | Action |
|------|--------|
| `src/lib/server/auth.ts` | Replace placeholder with argon2id hash/verify functions |
| `src/lib/server/session.ts` | New — session create/validate/destroy using `sessions` table |
| `src/hooks.server.ts` | Replace hardcoded stubs with real cookie resolution + route guards |
| `src/routes/login/+page.svelte` | New — login form |
| `src/routes/login/+page.server.ts` | New — login/logout form actions |
| `src/routes/+layout.svelte` | Add user display + logout link to header bar |

**Reference:** giftlist auth implementation at `~/giftlist/src/lib/server/auth.ts`, `session.ts`, `src/hooks.server.ts`, `src/routes/login/`

**Key decisions:**
- Cookie: httpOnly, secure (prod only), SameSite=Strict, 30-day expiry, sliding refresh
- Route guards: `/admin/*` → admin role, `/correct/*` → admin or corrector, `/app/*` → any authenticated user
- Keep the nginx `location /admin { return 403; }` block as defense-in-depth
- Password seeding: migration or one-time script to set real argon2id hashes for madonna + gaylon

### Step 2: Family Viewer Day Detail — td-bb8def (~2 hours)

Create the minimal `/app/day/[date]` route per V4 spec Phase 1 requirements.

**Files to create:**
| File | Action |
|------|--------|
| `src/routes/app/day/[date]/+page.server.ts` | New — load calendar_days + image path, auth-required |
| `src/routes/app/day/[date]/+page.svelte` | New — SSR day detail: corrected text, image, prev/next |

**Behavior:**
- Query `calendar_days` for `corrected_text`, `expanded_text`, `day_narrative`, image path
- Show "(not yet transcribed)" for days without accepted corrections
- Prev/next day arrows (all days, not just corrected)
- Date header (weekday + full date)
- Day image from Spaces via Cloudflare cache
- Auth-required (any role)
- Update `/app` stub to link to a real day if data exists

### Step 3: Verify & Close

1. Deploy auth + viewer
2. Run E2E smoke test (td-7229cc): upload → OCR → correct → view as family member
3. Document in devlog
4. Close td-510a34, td-3adb8a, td-bb8def, td-7229cc, td-42320b (Phase 1 epic)

---

## Part 4: V4 Spec Alignment

### Accepted for Phase 1 (as-is):
- DB schema complete (all V4 tables + Addendum A tables)
- Auth with argon2id + cookie sessions
- Capture intake pipeline (upload, classify, ingest)
- Automated day-cell cropping with grid templates + perspective warp
- OCR worker (Google Vision + Claude LLM cleanup, two-stage)
- Core correction editor (corrected_text field, save/skip/flag)
- Basic day-detail viewer (/app/day/[date])

### Deferred to Phase 2 (relaxed from V4 Phase 1 scope):
- Five-field editor (expanded_text, day_narrative UI fields)
- Auto-save with debounce
- Correction session tracking ("resume where you left off")
- Notation key admin UI + auto-expand in editor
- Keyboard shortcuts, context sidebar
- Calendar navigator (/correct/calendar)

**Justification:** V4 Addendum A § A.7 says expanded_text and day_narrative controls "can be minimal initially." The core correction pipeline works end-to-end. Madonna is already using it. The polish features improve workflow efficiency but don't block the Phase 1 DoD: "Madonna can correct a day and a family member can view it."

---

## Part 5: Task Commands Summary

**Immediate (this session):**
```
td close td-ad0db9 --reason "Fully implemented: admin UI at /admin/vocabulary with CRUD + lexicon management + audit log"
td close td-b10bd3 --reason "Memory leak fixed (409MB→16-34MB), deployed, monitoring is BAU"
td close td-064f40 --reason "Table-driven prompt feedback loop is the accuracy mechanism; continuous, not discrete"
td update td-3adb8a --note "Core editor complete. Five-field editor, auto-save, sessions, shortcuts → Phase 2"
td update td-8ea4c5 --note "Defer to Phase 2. Table seeded. No consumers yet. Group with correction UI polish."
```

**After implementation:**
```
td close td-510a34 --reason "Auth: argon2id + cookie sessions + route guards, ported from giftlist"
td close td-3adb8a --reason "Core correction editor verified with real auth"
td close td-bb8def --reason "/app/day/[date] viewer with corrected text, image, navigation"
td close td-7229cc --reason "Full pipeline smoke test passed, documented in devlog"
td close td-42320b --reason "Phase 1 Foundation complete"
```

**New tasks to create:**
```
td add --priority P2 --epic td-5f7fca "Correction UI polish: five-field editor, auto-save, correction_sessions, notation auto-expand, keyboard shortcuts, context sidebar"
```

---

## Verification

1. Run all `td close` / `td update` commands
2. `td list` — confirm closed tasks no longer show, Phase 1 stories reflect reality
3. Implement auth (Step 1) → `npm run check` clean → deploy → verify login/logout
4. Implement viewer (Step 2) → `npm run check` clean → deploy → verify day detail
5. Run E2E smoke test (Step 3) → write devlog entry
6. Close remaining tasks → `td list` shows Phase 1 epic closed, Phase 2 epic unblocked
