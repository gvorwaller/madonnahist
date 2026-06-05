# Plan: Add Day Narrative Field to Correction Editor

## Context

The V4 spec (Addendum A, Stage 3) defines a five-field editor. We currently have three fields: image, machine draft, corrected text. The spec also calls for "expanded text" and "day narrative," but in practice Madonna already expands abbreviations as she corrects (and the substitution engine pre-expands notation). So expanded text is redundant — drop it.

The one field worth adding is **day narrative** (`day_narrative`) — memories, stories, context triggered by the entry. New content not written on the calendar page. This is the family history gold that feeds book view, person profiles, and decade summaries. Best captured while Madonna is in the flow of correcting each day — "tomorrow never comes."

**DB column already exists.** Migration `0012_correction_ui_tables.sql` added `day_narrative` to `calendar_days`, granted UPDATE to `madonnahist_app`, and wired it into the FTS index. No schema changes needed.

**Write model differs from corrected_text.** This field is a direct UPDATE on `calendar_days` (app role has permission). It does NOT go through the `day_corrections` append-only trigger path. No history tracking required per spec.

---

## Implementation

### 1. Day editor load — read existing value

**File:** `src/routes/correct/day/[date]/+page.server.ts`

Add `day_narrative` to the existing `dayRes` SELECT query and its TypeScript type.

### 2. Day editor save — persist the field

**File:** `src/routes/correct/day/[date]/+page.server.ts`

In the `save` action, after the existing `day_corrections` INSERT:
- Read `dayNarrative` from form data
- Direct UPDATE: `UPDATE calendar_days SET day_narrative = $1 WHERE id = $2`
- Always write (even if empty — allows clearing a previously-entered narrative)

### 3. Day editor UI — add the narrative field

**File:** `src/routes/correct/day/[date]/+page.svelte`

Add below the corrected text textarea in `.col-editor`, always visible (variant A):
- New `$state` variable `dayNarrative`, initialized from `data.day.day_narrative ?? ''`
- Visual separator (subtle border-top)
- Label: "Day narrative" with hint text: "Memories, context, stories this entry brings to mind"
- Textarea with warm-toned styling (border: `#c4b5a0`, background: `#fdfcf9`) to distinguish from the correction field
- Smaller than main textarea: `min-height: 80px`, `font-size: 16px`
- Placeholder: "What do you remember about this day? Any stories or context not written on the page..."
- Hidden input in the save form to submit the value

### 4. Month view — show indicator when narrative exists

**File:** `src/routes/correct/month/[monthKey]/+page.server.ts`

Add `day_narrative` to the query (just need to know if non-null/non-empty).

**File:** `src/routes/correct/month/[monthKey]/+page.svelte`

Show a small visual indicator next to the text preview for days that have narrative content — helps Madonna see which days she's already added stories to.

---

## Files to modify

| File | Change |
|------|--------|
| `src/routes/correct/day/[date]/+page.server.ts` | Add `day_narrative` to load query; add UPDATE in save action |
| `src/routes/correct/day/[date]/+page.svelte` | Add narrative textarea, state variable, form input |
| `src/routes/correct/month/[monthKey]/+page.server.ts` | Add `day_narrative` to query |
| `src/routes/correct/month/[monthKey]/+page.svelte` | Show narrative indicator |

No migrations needed.

---

## Verification

1. `npm run check` — zero errors, zero warnings
2. Open a corrected day in browser — narrative field appears below corrected text
3. Type narrative text, click Save — reload, confirm value persisted
4. Open a pending day — field appears empty with placeholder, Save & Next still advances
5. Check month view — days with narratives show indicator
6. Deploy and verify on production
