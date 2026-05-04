# UI Mockups — V1 (First Cut)

> Information-architecture sketches, not pixel-perfect designs. Two surfaces: Madonna's iPad correction UI and the family phone viewer. Visual polish (palette, fonts, exact spacing) intentionally deferred — covers the *what* and *where*, not the *prettiness*.

## A. Madonna's Correction UI (iPad-first)

iPad landscape primary, iPad portrait acceptable, desktop fine. Touch-first; keyboard shortcuts as a power-user accelerator. Large tap targets (minimum 56×56pt — bigger than the 48px guideline because Madonna's older and on a tablet).

---

### A1. Sign-in & Session Home (`/correct`)

```
┌──────────────────────────────────────────────────────────────────────┐
│  madonnahist                            [ Madonna ▾ ]   [ Sign out ] │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│   Welcome back, Madonna.                                             │
│                                                                      │
│   You have 47 days waiting for review.                               │
│                                                                      │
│   ┌────────────────────────────────────────────────────────────┐    │
│   │                                                            │    │
│   │   [▶  Resume where you left off ]                          │    │
│   │      Last: March 1968, day 12                              │    │
│   │                                                            │    │
│   └────────────────────────────────────────────────────────────┘    │
│                                                                      │
│   ┌────────────────────────────────────────────────────────────┐    │
│   │   [📅  Pick a specific month ]                              │    │
│   └────────────────────────────────────────────────────────────┘    │
│                                                                      │
│   ┌────────────────────────────────────────────────────────────┐    │
│   │   [🏷️  Days flagged 'illegible' (8)  ]                      │    │
│   │      Days you marked as needing another look                │    │
│   └────────────────────────────────────────────────────────────┘    │
│                                                                      │
│   ─────────────────────────────────────────────────────────────      │
│   This week you corrected 73 days. (See progress ▸)                  │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

**Behavior:**
- Three big buttons. No menus, no settings. Madonna has one job: review days.
- "Resume where you left off" is the dominant CTA.
- Progress link is muted; positive reinforcement, not pressure.

---

### A2. Day Correction (`/correct/day/[date]`) — iPad landscape

The main work surface. Three columns, equal width, with a bottom action bar.

```
┌───────────────────────────────────────────────────────────────────────────────────┐
│ ← Back                  Tuesday, March 12, 1968                       Day 12 / 31 │
├──────────────────────────────┬────────────────────────────┬───────────────────────┤
│                              │                            │                       │
│   [ scanned image ]          │  OCR draft                 │  What it says         │
│                              │  ─────────────             │  ────────────         │
│   ┌──────────────────────┐   │                            │                       │
│   │                      │   │  Marcus to dentist 9am.    │  ┌─────────────────┐  │
│   │                      │   │  Snow ail day.             │  │ Marcus to       │  │
│   │   [ image of the     │   │  Pot roast - too dry.      │  │ dentist 9am.    │  │
│   │     day-cell crop ]  │   │  Bill called from work.    │  │ Snow all day.   │  │
│   │                      │   │                            │  │ Pot roast — too │  │
│   │                      │   │  ─────────────             │  │ dry. Bill called│  │
│   │   pinch to zoom      │   │  Suggested fix:            │  │ from work.      │  │
│   │   double-tap to fit  │   │  ──────────                │  └─────────────────┘  │
│   └──────────────────────┘   │                            │                       │
│                              │  Marcus to dentist 9am.    │  Tags: ┌────────────┐ │
│   View full month page ▸     │  Snow all day.             │       │ marcus     │ │
│                              │  Pot roast — too dry.      │       │ snowstorm  │ │
│                              │  Bill called from work.    │       │ + add tag  │ │
│                              │                            │       └────────────┘ │
│                              │  [✓ Use this suggestion]   │                       │
│                              │                            │                       │
│                              │  Confidence: ●●●○○         │  Status: in progress  │
│                              │                            │                       │
├──────────────────────────────┴────────────────────────────┴───────────────────────┤
│                                                                                   │
│  [⚑ Flag illegible]      [↩ Skip for now]      [💾 Save]      [→ Save & Next]    │
│                                                                                   │
└───────────────────────────────────────────────────────────────────────────────────┘
```

**Three columns:**
1. **Image** (left) — the day-cell crop. Pinch-to-zoom, double-tap to fit. "View full month page" link expands to the full scanned page in a modal.
2. **OCR draft** (middle) — read-only. Top half: raw OCR. Bottom half: LLM-cleaned suggestion with "Use this suggestion" button (one tap copies it into the right pane).
3. **Corrected text** (right) — the editable field. Auto-saves on debounce. Tags below. Status indicator.

**Bottom action bar (always visible, large buttons):**
- `Flag illegible` — sets `correction_status = 'flagged'`, prompts for an optional note
- `Skip for now` — leaves status `pending`, advances to next
- `Save` — saves and stays on this day
- `Save & Next` — saves and advances (the dominant action)

**Keyboard shortcuts** (when paired keyboard present):
- `⌘S` — save
- `⌘→` — save & next
- `⌘↑` — accept LLM suggestion
- `⌘F` — flag illegible
- `⌘Z` — undo last save (within 30s)

**Surrounding-day context** (optional sidebar, dismissible):
- Tap an "i" icon top-right → reveals "Day before" and "Day after" already-corrected entries from the same year. Helps Madonna recognize handwriting patterns and disambiguate.

---

### A3. Calendar Navigation (`/correct/calendar`)

```
┌──────────────────────────────────────────────────────────────────────┐
│  ← Back                                                              │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│    [ ◂ 1967 ]      March  1968      [ April ▸ ]      [ 1969 ▸ ]      │
│                                                                      │
│    ┌────┬────┬────┬────┬────┬────┬────┐                              │
│    │  S │  M │  T │  W │  T │  F │  S │                              │
│    ├────┼────┼────┼────┼────┼────┼────┤                              │
│    │    │    │    │    │    │  1 │  2 │  ●  done                     │
│    │    │    │    │    │    │  ● │  ● │                              │
│    ├────┼────┼────┼────┼────┼────┼────┤  ◐  in progress              │
│    │  3 │  4 │  5 │  6 │  7 │  8 │  9 │                              │
│    │  ● │  ● │  ◐ │  ◐ │  ◐ │  ○ │  ○ │  ○  pending                  │
│    ├────┼────┼────┼────┼────┼────┼────┤                              │
│    │ 10 │ 11 │ 12 │ 13 │ 14 │ 15 │ 16 │  ⚑  flagged                  │
│    │  ○ │  ○ │  ◐ │  ○ │  ⚑ │  ○ │  ○ │                              │
│    ├────┼────┼────┼────┼────┼────┼────┤                              │
│    │ 17 │ 18 │ 19 │ 20 │ 21 │ 22 │ 23 │                              │
│    │  ○ │  ○ │  ○ │  ○ │  ○ │  ○ │  ○ │                              │
│    ├────┼────┼────┼────┼────┼────┼────┤                              │
│    │ 24 │ 25 │ 26 │ 27 │ 28 │ 29 │ 30 │                              │
│    │  ○ │  ○ │  ○ │  ○ │  ○ │  ○ │  ○ │                              │
│    ├────┼────┴────┴────┴────┴────┴────┘                              │
│    │ 31 │                                                            │
│    │  ○ │                                                            │
│    └────┘                                                            │
│                                                                      │
│    Progress: 10 / 31 days corrected this month                       │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

**Behavior:**
- Tap any day → opens that day in the editor.
- Status dot under each day number; matches the legend on the right.
- Year and month chevrons for moving across time. Year picker is a single tap → big year-grid.
- Bottom shows progress for the current month.

---

### A4. Session Done (`/correct/done`)

```
┌──────────────────────────────────────────────────────────────────────┐
│  Nice work, Madonna.                                                 │
│                                                                      │
│   Today's session                                                    │
│   ───────────────                                                    │
│                                                                      │
│   ✓ 27 days corrected                                                │
│   ⚑  3 days flagged for another look                                 │
│   ↩  1 day skipped                                                   │
│                                                                      │
│   Time:  41 minutes                                                  │
│                                                                      │
│   [ Continue with the next month ]                                   │
│   [ Stop for now ]                                                   │
│                                                                      │
│   ─────────────────────────────────                                  │
│                                                                      │
│   This week:  73 days                                                │
│   This month: 287 days                                               │
│   All time:  1,142 days corrected (of 21,915 total — 5%)             │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

**Tone:** warm, encouraging. The "all time" progress is shown but as an aside — not a guilt trip.

---

## B. Family Viewer (phone-first)

Mobile-first single column. Vertical scroll dominant. Swipe gestures for adjacent-day navigation. Works fine on tablet/desktop; layout stretches but information density stays modest.

---

### B1. Home / "On This Day" (`/app` or `/`) — phone portrait

```
┌─────────────────────────────┐
│  madonnahist          [ ☰ ] │
├─────────────────────────────┤
│                             │
│  On May 3 in our history    │
│  ─────────────────────────  │
│                             │
│  ┌───────────────────────┐  │
│  │                       │  │
│  │  [thumb of day cell]  │  │
│  │                       │  │
│  │  May 3, 2018          │  │
│  │  ──                   │  │
│  │  Marcus moved into    │  │
│  │  the new place. Big   │  │
│  │  rain. Pizza after.   │  │
│  │                       │  │
│  │  marcus · seattle     │  │
│  └───────────────────────┘  │
│                             │
│  ┌───────────────────────┐  │
│  │                       │  │
│  │  [thumb of day cell]  │  │
│  │                       │  │
│  │  May 3, 1995          │  │
│  │  ──                   │  │
│  │  G. graduated.        │  │
│  │  Family lunch at      │  │
│  │  Olive Garden.        │  │
│  │                       │  │
│  │  gaylon · graduation  │  │
│  └───────────────────────┘  │
│                             │
│  ┌───────────────────────┐  │
│  │  May 3, 1972          │  │
│  │  ──                   │  │
│  │  Marcus's first       │  │
│  │  steps! Bill home     │  │
│  │  early to see.        │  │
│  └───────────────────────┘  │
│                             │
│  [ See all of May 1972 ▸ ]  │
│                             │
├─────────────────────────────┤
│  [🏠]  [📅]  [🔍]  [📖]      │
└─────────────────────────────┘
```

**Bottom nav (4 items):**
- 🏠 Today / On this day
- 📅 Browse (year/decade)
- 🔍 Search
- 📖 Book mode

**Cards:**
- Image thumbnail (lazy-loaded, served from Cloudflare cache)
- Date in human form
- First ~2 sentences of corrected text
- Inline tags as muted chips
- Tap card → day detail

---

### B2. Day Detail (`/app/day/[date]`) — phone portrait

```
┌─────────────────────────────┐
│  ← Back                     │
├─────────────────────────────┤
│                             │
│  Tuesday, May 3, 1972       │
│                             │
│  ┌───────────────────────┐  │
│  │                       │  │
│  │   [ day-cell image,   │  │
│  │     full-width,       │  │
│  │     tap to zoom ]     │  │
│  │                       │  │
│  └───────────────────────┘  │
│                             │
│  Marcus's first steps!      │
│  Bill home early to see.    │
│  Pot roast for dinner.      │
│  Marc fell asleep on        │
│  Bill's lap watching the    │
│  Tonight Show.              │
│                             │
│  ───                        │
│                             │
│  Tags                       │
│  [ marcus ] [ bill ]        │
│  [ first-steps ]            │
│                             │
│  ───                        │
│                             │
│  In context                 │
│                             │
│  Marcus was 11 months old.  │
│  This was the first         │
│  documented walking in      │
│  the calendars. The next    │
│  mention of his walking     │
│  is May 7. — generated      │
│                             │
│  ───                        │
│                             │
│  [ ◂ May 2 ]   [ May 4 ▸ ]  │
│                             │
│  See full page: March 1972  │
│                             │
├─────────────────────────────┤
│  [🏠]  [📅]  [🔍]  [📖]      │
└─────────────────────────────┘
```

**Sections:**
1. Date header
2. Day-cell image (tap to zoom; pinch in modal)
3. Corrected text in full
4. Tag chips (tappable; lead to `/app/person/marcus` or `/app/tag/first-steps`)
5. AI-generated context paragraph (when present; gracefully absent otherwise). Marked `— generated` so readers know it's not from the calendar.
6. Prev/next day swipe arrows (also: swipe gesture on the image)
7. Link to the full month page

---

### B3. Year Browse / Timeline (`/app/year/[year]`) — phone

```
┌─────────────────────────────┐
│  ← Back                     │
├─────────────────────────────┤
│                             │
│   [ ◂ 1971 ]   1972         │
│                  [ 1973 ▸ ] │
│                             │
│  ─── January                │
│                             │
│  ┌───┬───┬───┬───┬───┬───┐  │
│  │ 1 │ 2 │ 3 │ 4 │ 5 │ 6 │  │
│  └───┴───┴───┴───┴───┴───┘  │
│  3rd: Bill back to work...  │
│  7th: Snow day, no school...│
│  15th: Marcus pulled up...  │
│                             │
│  [ See January in detail ▸ ]│
│                             │
│  ─── February               │
│                             │
│  ┌───┬───┬───┬───┬───┬───┐  │
│  │ 1 │ 2 │ 3 │ 4 │ 5 │ 6 │  │
│  └───┴───┴───┴───┴───┴───┘  │
│  4th: Madonna sick all...   │
│  ...                        │
│                             │
│  [ Read 1972 as a book ▸ ]  │
│                             │
├─────────────────────────────┤
│  [🏠]  [📅]  [🔍]  [📖]      │
└─────────────────────────────┘
```

**Behavior:**
- Each month section: micro-grid of day numbers (tappable) + 3 highlighted entries (tap → day detail)
- Year chevrons at top
- Footer: "Read 1972 as a book" → enters book view

---

### B4. Search (`/app/search`)

```
┌─────────────────────────────┐
│  ← Back                     │
├─────────────────────────────┤
│                             │
│  ┌───────────────────────┐  │
│  │ 🔍  marcus and snow   │  │
│  └───────────────────────┘  │
│                             │
│  Filter: any year ▾         │
│                             │
│  ───                        │
│                             │
│  37 results                 │
│                             │
│  ┌─────────────────────┐    │
│  │ Mar 12, 1968        │    │
│  │ "Marcus to dentist  │    │
│  │  9am. Snow all day." │    │
│  │ marcus · snowstorm  │    │
│  └─────────────────────┘    │
│                             │
│  ┌─────────────────────┐    │
│  │ Feb 4, 1974         │    │
│  │ "Marcus and the     │    │
│  │  neighbor kids made │    │
│  │  a snow fort..."    │    │
│  │ marcus · snow       │    │
│  └─────────────────────┘    │
│                             │
│  [ ... more results ... ]   │
│                             │
├─────────────────────────────┤
│  [🏠]  [📅]  [🔍]  [📖]      │
└─────────────────────────────┘
```

**Behavior:**
- Full-text search via Postgres `tsvector`. Supports natural-language queries.
- Match snippet shows the surrounding text. Match terms highlighted.
- Year filter, tag filter, person filter (Phase 2+).
- Tap a result → day detail.

---

### B5. Book View (`/app/book/year/1972`) — phone, immersive

```
┌─────────────────────────────┐
│  ⨯                          │
├─────────────────────────────┤
│                             │
│     1972                    │
│     ──── March              │
│                             │
│     Tuesday, March 12       │
│                             │
│     [thumb]  Marcus to      │
│              dentist 9am.   │
│              Snow all day.  │
│              Pot roast      │
│              too dry. Bill  │
│              called from    │
│              work.          │
│                             │
│     ───                     │
│                             │
│     Wednesday, March 13     │
│                             │
│     [thumb]  More snow.     │
│              School closed. │
│              Marcus and I   │
│              made a fort    │
│              in the kitchen │
│              with chairs    │
│              and the kept   │
│              quilts.        │
│                             │
│     ───                     │
│                             │
│     Thursday, March 14      │
│                             │
│     [thumb]  Roads cleared. │
│              ...            │
│                             │
│                             │
│  ◂ swipe                    │
│            page 23 / 92     │
│                             swipe ▸ │
└─────────────────────────────┘
```

**Behavior:**
- Distraction-free. No bottom nav. Single close button (X) returns to wherever you came from.
- Each "page" of the book holds 3–5 days, depending on text length.
- Chapter breaks at month boundaries — month name shown big.
- Swipe horizontally to advance pages. Optional auto-paginate-on-tap-edge.
- Image thumbs are small left-margin elements; tap any thumb → modal with full image.
- End of year: "Continue to 1973" button.

---

### B6. Person Profile (`/app/person/marcus`) — phone

```
┌─────────────────────────────┐
│  ← Back                     │
├─────────────────────────────┤
│                             │
│         Marcus              │
│                             │
│   142 days mention Marcus   │
│   1971 — 2018               │
│                             │
│   [ See on a timeline ▸ ]   │
│                             │
│  ───                        │
│                             │
│   Earliest                  │
│                             │
│  ┌───────────────────────┐  │
│  │ June 4, 1971          │  │
│  │ "Marcus born at 3am.  │  │
│  │  6 lbs 4 oz. Healthy." │  │
│  └───────────────────────┘  │
│                             │
│   Most recent               │
│                             │
│  ┌───────────────────────┐  │
│  │ Dec 25, 2018          │  │
│  │ "Marcus brought the   │  │
│  │  kids for Christmas..." │  │
│  └───────────────────────┘  │
│                             │
│   By decade                 │
│                             │
│   1970s — 47 mentions       │
│   1980s — 61 mentions       │
│   1990s — 18 mentions       │
│   2000s — 8 mentions        │
│   2010s — 8 mentions        │
│                             │
│   Tap a decade for the list │
│                             │
├─────────────────────────────┤
│  [🏠]  [📅]  [🔍]  [📖]      │
└─────────────────────────────┘
```

**Behavior:**
- Phase 3 surface (depends on entity extractor + alias resolution)
- Earliest + most-recent give a quick frame
- Decade roll-ups link to filtered list views

---

## Cross-Surface Notes

### Color & typography (deferred, but baseline)
- **Body**: a serif (Georgia / "Iowan Old Style") for the corrected-text reading experience — feels like a written record, not a database
- **UI chrome**: sans (system-ui / "SF Pro Text")
- **Palette**: warm domestic, similar to giftlist — cream backgrounds, paper cards, evergreen primary, amber attention. Avoid the BTC dashboard's clinical white/gray.

### Accessibility floor (non-negotiable)
- Base font 18px (correction UI), 17px (viewer); larger on tablet
- WCAG AAA contrast (7:1) for body text
- All status indicators use color + icon + text label, never color alone
- Tap targets ≥48×48px (≥56×56pt on the iPad correction UI)
- No gesture-only navigation; everything reachable via visible labeled controls

### What's NOT in V1
- Visual polish (will iterate after Madonna does her first real session and tells us what's annoying)
- Comments / annotations on entries (Phase 3+)
- Sharing entries to family group chats (Phase 4)
- Print/PDF export (Phase 4 — would feed the "book" form factor for real)
- Notification system for "new entries this week"

These mockups should be enough to start coding Phase 1 from. Everything else iterates from there.
