# Family Viewer redesign — "Vorwaller Family History"

> **Status:** Revised plan, 2026-11-05 (CC4). Peer-reviewed in sequence by CODEX → AGY2 → GROK; the
> reviews are kept verbatim at the end. Gaylon's decisions are folded into the body (see "Decisions
> after peer review"). No code yet: Slice 0, the HTML mockup, is the first approval gate.

## Context

The archive now has enough accepted days (1,600+ days, ~1,150 people/places, thousands of AI tags,
published year narratives, saved stories, year PDFs) to share with the children and grandchildren.
The Family Viewer (`src/routes/app/**`) already has most of the data, but presents it like an admin
tool: coverage statistics everywhere, content reachable only through hidden links, filter dropdowns
with hundreds of options, and long grids of bare day numbers. The goal is a modern, intuitive viewer
in the style of the **birds** and **trips** repos, for **phones and laptops**, with **new views** and
**invite-link onboarding**. `/correct` and `/admin` stay untouched, except for one small "invite
link" addition to `/admin/users` that onboarding needs.

Decisions made in this session:
- Blend birds and trips, keeping madonnahist's warm cream/serif identity.
- Scope is a redesign plus new views.
- Onboarding uses invite links.
- Family-facing name: **Vorwaller Family History**.
- Tabs: **Today · Timeline · People · Stories · Search**.
- **An HTML mockup gets reviewed before any code.**

---

## Deep-dive findings (current state)

### Entry, shell and navigation
1. **A viewer has to click through a landing page first.** A viewer-role user lands on `/`
   (`src/routes/+page.svelte`), which shows a single "Family Viewer" card. The card's labels
   ("Everyone", "Active", the "madonnahist" slug) are admin-speak.
2. **There are two competing navigation bars.**
   - The global dark top bar (`src/routes/+layout.svelte`) shows "madonnahist / Family", a 0.75rem
     "Sign out" well under 44px, and the gray `#fafaf8` body. It sits above the viewer's own cream
     shell (`src/routes/app/+layout.svelte`), so there are two visual systems on one screen.
3. **Half the product has no navigation entry.** The bottom bar has three tabs.
   - **Stories** is reachable only from a link on the Search page.
   - **The book** is reachable only from Browse or a year page.
   - **People and places have no index at all.** You find them only through a chip on a day, or a
     `<select>` holding about 1,150 entities on Search.
4. **There is no desktop layout.** Content is capped at a 640px column, and the phone bottom bar
   stays fixed even on a laptop. Birds and trips switch to top links at 640px or wider and use two
   columns at 1024px or wider.
5. **Type is small for older eyes.** The body is 16px, and many labels are 0.7–0.8rem. The V2
   mockup sets a 17px floor; birds and trips use an 18px root.
6. **There is no PWA support.** There is no `static/` directory at all: no manifest and no
   apple-touch-icon, so "Add to Home Screen" gives a generic icon.
7. **No sense of loading.** There is no progress feedback on slow navigations; Search does three
   queries plus option lists.
8. **Shared links after sign-in lose their query string.** In `src/hooks.server.ts`,
   `returnTo=path` drops the query, so a shared search link loses `?q=` after login.

### Today (`/app`)
9. **No content for the date means a dead end.**
   - The page shows only today's month and day.
   - If nothing is transcribed for that date, it shows an empty box with "N of M days transcribed".
   - There is no way to pick another date, such as a birthday.
10. **The thumbnails show the wrong thing.** Each card spends a 220px image on the cropped
    handwriting cell, which is illegible at that size. The text preview is the real value.
11. **There is no reason to come back.** The page has no "recently transcribed", no story-of-the-year
    teaser, no featured story, and no "surprise me".

### Browse and Year (`/app/browse`, `/app/year/[year]`, `MonthGrid.svelte`)
12. **Browse is all statistics.** Decades start collapsed, and each row reads "1976 · 365 of 365
    days (100%)" with a separate "Read as book" button. Nothing on the page says what is *in* a year.
13. **The year page is about 4,000px of bare numbers.**
    - It stacks 12 MonthGrids of 48px day-number cells with no content preview.
    - Mockup B3's "three highlighted entries per month" was never built.
    - The published **narrative sits below the PDF downloads**, when it is the best thing on the page.
    - `.pdf-link` carries a negative top margin and centering meant for a standalone link, so the
      download rows render oddly.
14. **The month page has no reading view** (`/app/month/[monthKey]`). It shows the page photo plus
    the same grid, with no list of the month's entries. Tap-on-photo is tracked as td-ed1751.

### Day (`/app/day/[date]`)
15. **The order and navigation are weak.**
    - The image comes before the text.
    - "Previous day"/"Next day" doesn't show which date it jumps to, and it skips over untranscribed
      days without saying so.
    - There is no "this date in other years" link and no Share option.
    - On a laptop the image stretches to 640px wide and pushes the text below the fold.

### Search (`/app/search`)
16. **The filters are unusable at this data size.**
    - Four stacked native `<select>`s (Year, Tag, Person, Place) hold hundreds to thousands of
      options, which is unusable on a phone.
    - You have to press Search, and active filters can't be removed as chips.
    - Result cards don't show who or where.

### People and places (`EntityProfile.svelte`)
17. **The profile page is thin.**
    - "← Back" always goes to `/app`, ignoring `?from`.
    - "By year" is a plain list.
    - "All days" is bare date links, possibly hundreds, with no snippets or grouping.
    - There is no "often mentioned with", even though the entity metadata JSONB already exists.
    - Place pages are identical to person pages.

### Across pages
18. **Shared styles are copy-pasted.** Tokens live only on `.app-shell`. The back link, empty state,
    `btn-primary` and zoom overlay are re-declared on roughly 8 pages, with small variations: 44px
    vs 48px minimums, 8px vs 10px radii.
19. **Thumbnails download the full image.** They load the full day crop
    (`/app/day/[date]/image`, `private, max-age=3600`) with no resized variant, which is slow on
    phones.
20. **"N of M days transcribed (x%)" banners appear on Today, Search, Year, Month and the book.**
    That is a pipeline metric, not family content.

---

## Design direction: what to borrow and what to keep

| From **trips** | From **birds** | Keep from **madonnahist** |
|---|---|---|
| Frosted fixed top bar with links at ≥640px; bottom tabs below 640px with safe-area padding (`trips/src/app.css`, `+layout.svelte`) | ☰ drawer with focus trap and `inert` (`birds/src/routes/+layout.svelte` L195-261) | Cream/paper/evergreen/amber palette (AAA pairs already verified) |
| Day cards with a tinted header band and a meta line, collapsed by default but still showing a summary (`places/schedule/+page.svelte`) | Foldable `<details class="card fold">` sections; "At a glance" stat strip | Serif body for diary text, sans for interface |
| Pill chips, date pill, count badge in section headers | Removable filter chips + "Clear all"; `SearchableSelect.svelte` combobox | "AI-generated, reviewed" labels (no machine text without one) |
| 18px root, 48px primary targets, 16px inputs, `touch-action:manipulation` | `Skeleton.svelte`, `NavProgress.svelte`, `PathNavigation.svelte` (back to the named previous page) | Accepted-only predicate in every `/app` query (`src/lib/server/viewer.ts` header) |
| `collapse-state.ts` (persisted fold state) | `MigrationRibbon`-style month heat strip (for the Timeline) | `?from=` back memory (to be centralized) |
| PWA manifest + apple meta tags | `@media (hover:hover)`, reduced-motion kill switch | No toasts; modal confirms; color plus text label for every status |

Out of scope: dark/theme picker (birds `themes.ts`) and maps (places have no coordinates).

---

## Proposed information architecture

**Tabs:** Today · Timeline · People · Stories · Search. On phones they form the bottom bar; at 640px
and wider they move into the top bar. A ☰ drawer holds "Books & downloads", "About this archive",
"Switch to Corrections/Admin" (role-gated) and "Sign out".

- **Viewer shell.** `/app/**` gets its own complete shell. The root `+layout.svelte` hides its dark
  top bar for `/app`, `/login` and `/invite`, so admin and correct pages render exactly as today.
- **Root redirect.** `/` sends viewer-role users straight to `/app`. Admin and corrector users keep
  the landing cards, renamed.

| Tab | Route | What it shows |
|---|---|---|
| **Today** | `/app` (`?date=MM-DD`) | **"On this day"** hero with ◂ date ▸ and a date picker. Entry cards lead with year and text (thumbnail small, beside the text, not on top). **Recently transcribed** strip (latest accepted, by `corrected_at`). **The story of {year}** narrative teaser. **Latest family story**. A **Surprise me** button (random accepted day; no schema). A friendly "growing every week" line replaces the coverage banners. |
| **Timeline** | `/app/timeline` (replaces `/browse`, which redirects) | Decades → year rows, each with a **12-month density strip** (accepted days per month, color plus count, AAA) and a one-line narrative excerpt or highlight. Tap a month to open the month page; tap a year to open the year page. |
| Year | `/app/year/[year]` | Header with ◂ year ▸. **Narrative card first** (foldable). An action row: Read as book · PDF downloads (fixed styles). Then **12 month cards** (trips day-card pattern): header band with month name and "N days"; 3 highlight snippets (mockup B3); "All N days ▸"; a compact grid in a fold. |
| Month | `/app/month/[monthKey]` | The page photo with **tap-a-day overlays** (td-ed1751, `crop_bounds` %-positioned; inert and labeled for non-accepted days). Then a **reading list** of every accepted day of the month (date pill plus full text) and month ◂ ▸. |
| Day | `/app/day/[date]` | Order: date header, then **text first** (serif, 18px+), then **"Madonna remembers"** (her `day_narrative` memory), then people and place chips and human-confirmed tags. Image in a fold ("See Madonna's handwriting"); side-by-side at 1024px and wider. Prev/next **labeled with the actual date** ("◂ Mon, May 2"). Adds **"This date in other years"** (siblings by month and day) and **Share** (`navigator.share`, falling back to copy link; no schema). |
| **People** | `/app/people` (new) + `/app/places` (sub-tab) | Live-filter search box; **Most mentioned** cards (name, count, years active); A–Z list with counts. All client-side from one accepted-only query. |
| Person/Place | `/app/person/[slug]`, `/app/place/[slug]` | Header with a stat strip (days, first–last year). **Mentions-by-year bar chart** (CSS bars, labeled). Earliest and most recent. **Often mentioned with** (co-occurrence query). Days **grouped by year in folds, with snippets**. "Search their days" deep-links into Search with the person filter. A correct `?from` back link. |
| **Stories** | `/app/stories` | Two sections: **Year stories** (every published year narrative as a card leading to `/app/year/[y]#story`) and **Family Stories** (existing saved stories). The book sits under Year stories ("Read 1976 as a book"). |
| **Search** | `/app/search` | One prominent box with **typeahead suggestions** across people, places and tags (adapted from birds/trips `SearchableSelect.svelte`). Active filters show as **removable chips**. Year becomes a compact year-range control. Result cards show date, snippet and people chips. Query params stay unchanged, so existing links keep working. |

---

## Decisions after peer review (Gaylon, 2026-11-05)

Three reviews are appended at the end (CODEX, AGY2, GROK). Gaylon settled the points where they
disagreed:

| Topic | Decision |
|---|---|
| Rollout order | **Thin slice first** (GROK #3). After the mockup, ship a minimal family-usable viewer with invites, then upgrade it in later slices. |
| Unconfirmed AI tags | **Hidden from the family.** Viewer tag queries add `source = 'human'`. Covers `/app/day`, `getAcceptedTagOptions`, search tag filters, and anything derived from tags (AGY2 #5). |
| Session cookie | **Switch to `SameSite=Lax`.** Fixes Messages/Mail link taps showing the login page (GROK #4). Gaylon approved changing the cs.md §60 rule to "SameSite=Lax"; edit cs.md in the same slice. |
| Month page | **Photo tap-a-day plus a full-text reading list; the number grid is dropped** (plan + AGY2 #10, over GROK #5). |

**Folded in from the reviews.**
- **Day memories:** `day_narrative` is **Madonna's own memory**, not AI text. Label it "In Madonna's
  words" and place it directly under the day text (CODEX #5, AGY2 #1). The existing "In context —
  generated" label is a live bug.
- **Publication exceptions documented** (CODEX #5). Three things are visible regardless of a day's
  status:
  - the month photo, by policy;
  - coverage aggregates;
  - saved stories, which an admin curates by saving them.
- **Styling stays inside the viewer** (CODEX #7, AGY2 #2):
  - The 18px base and tokens go on `.app-shell`, not `html`, so `/correct` and `/admin` don't
    change.
  - Size floors: 18px prose, 15px labels, 16px inputs.
  - Resolve the shared-stylesheet idea against cs.md's component-scoped rule: viewer tokens plus a
    small set of `:global` classes under `.app-shell`.
- **Corrected findings** (CODEX #6):
  - Viewers already land on `/app` after login; finding 1 applies only when someone visits `/`.
  - The book is exempt from the 640px cap.
  - Co-mentions are computed from accepted `day_entities` joins, not from `entities.metadata`.
- **Search gets a year range:** new params `from_year` and `to_year`, inclusive and validated.
  - Old `year=` links keep working.
  - A search with only a year set now counts as a search.
  - `page` resets whenever a filter changes.
  - Filter option lists load only when a filter control opens.

  (CODEX #4, GROK #8.)
- **People and places** (GROK #10): `event` entities stay out of this round. No inferred "Immediate
  family" row; if Gaylon wants one later, he writes the list himself (GROK #6 over AGY2 #4).
- **Timeline:** each year row is a single tap target. The 12-month strip is a visual summary with
  an `aria-label`, not 12 links (AGY2 #6).
- **Laptop layout:** at ≥1024px the shell widens to about 1080px. The day page goes side by side,
  but prose stays at 60–65 characters wide (AGY2 #8).
- **Share:** shares the quote plus date plus link, because messaging apps can't preview a page
  behind sign-in (AGY2 #11). Cancelling the share sheet is handled, and a selectable-link fallback
  covers browsers without clipboard access (CODEX #9).
- **Images** (CODEX #8):
  - Thumbnails come in a few fixed widths (e.g. 320/640), with a cap on how many resize at once.
    The authorization check runs before any cache lookup.
  - Photo-tap overlays are positioned against the image actually served, and days without crop
    bounds are handled.
- **Home-screen install metadata only, no service worker** (CODEX #12, AGY2 #3). The manifest and
  icons get exact public-path entries in `hooks.server.ts`. `returnTo` keeps the query string. The
  login form uses an absolute action, `/login?/login` (GROK #3).
- **Navigation helper** (CODEX #10): `backTarget(from)` rejects external and backslash
  destinations and keeps the full search query string.

---

## Mockup review: Gaylon's answers (2026-11-07)

These answer the questions on each mockup screen; they override the mockup where the two differ.

| Screen | Decision | Lands in |
|---|---|---|
| Today | **The year story leads**, above "On this day". | Slice 1 |
| Today | Keep phone thumbnails. **Tapping one opens the full day image, and from there you can go on to the month page image.** | Slice 1 (day image), Slice 3 (month link) |
| Today, empty date | **Nearest date with entries** is the main fallback. | Slice 1 |
| Timeline | **Oldest decade first**, with a sort-order toggle (remembered per viewer). | Slice 2 |
| Year | The story **starts open and can be folded**. | Slice 2 |
| Day | The label becomes **"Madonna remembers"** (shipped 2026-11-08 with Slice 1T, on Day and Book). **New requirement:** memories from logged-in family members are planned, so the memory block must allow several authors, and the reader needs a way to include or exclude other family members' memories. Slice 1 builds the display for one author only; the multi-author schema belongs with td-ef00c8 (multi-writer groundwork). | Slice 1 (label); new task (family memories) |
| Day | **Share includes the memory.** | Slice 3 |
| Day | **Keep** the "N days not transcribed yet" skip note. | Slice 1 |
| Person | **Add a placeholder button** for the printable personal history (td-ef90ab), disabled and labeled "Coming later". | Slice 1 |
| Places | **Keep the place index.** **New:** attempt to map each place automatically with Google geocoding, reusing the trips `geocode.ts` pattern and the shared `GOOGLE_GEOCODING_KEY`. When a place isn't recognizable, the admin gets a **"Search on map"** picker (the trips MapPicker pattern) to set it by hand. This adds coordinates to place entities, so maps are back in scope for place pages. | Slice 4 + new task |
| Stories | **"Questions answered" is rejected.** The saved stories are called **"Family Stories"** (Gaylon, 2026-11-08). | Slice 1 |
| Search | **Best match first** by default. | Slice 1 / 4 |
| Menu | **"About this archive" text is editable in admin** (stored in `app_state`; plain text with paragraphs). | Slice 1 |
| Invite | **Family members can change their display name** on the invite page, and later from the menu. | Slice 1 |
| Invite | Add-to-Home-Screen steps for **iPhone and Android**, with the matching set shown first based on the browser's user agent. | Slice 1 |
| Invite | Expired-link copy: **"Ask the admin (Gaylon / Dad / Papa) for a new link."** | Slice 1 |

**Saved stories name: decided — "Family Stories"** (Gaylon, 2026-11-08). Proposals that were
considered: "Through the years", "Family topics", "Story collections", "Looking back".

---

## Invite-link onboarding (revised per CODEX #1–3, GROK #1–2, #4, #11)

- **Migration `0028_user_invites.sql`.**
  - Table: `user_invites`
    - `id`
    - `user_id` FK
    - `token_hash`: SHA-256 of a 32-byte random token, UNIQUE indexed
    - `expires_at`: **30 days**, matching the session window
    - `used_at`, `revoked_at`
    - `created_by`, `created_at`
  - Grants: **first REVOKE** the app's default UPDATE/DELETE (migration 0004 applies them to every
    new table), plus all worker privileges, including the sequence. Then grant the app SELECT,
    INSERT, and UPDATE on `used_at` and `revoked_at` only.
  - Check the effective privileges as both roles in the invariants test.
  - Enforce at most one outstanding invite per user (a partial unique index).
- **Admin: a new "Invite a family member" action on `/admin/users`, separate from `create`.**
  - Gaylon enters the display name and a **username** (normalized with `normalizeUsername`). The
    role is fixed to `viewer`.
  - The password hash is computed from a random secret that is then thrown away, so nobody knows
    the password.
  - The URL is shown in a selectable field with a Copy button and the line "Send this in Messages.
    It expires {date}." Admins can re-issue (this revokes the old link) or revoke.
  - Invites are for onboarding only. Established accounts keep using the existing reset flow.
- **Public `/invite/[token]`.**
  - Public-path rule: exact single segment plus token syntax and length checks. Tests cover GET,
    POST, sibling prefixes, extra segments, and malformed tokens.
  - Every response sends `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.
  - Logs and the audit trail redact the token; the audit records IDs and outcomes only.
  - Rate limits apply to token checks and to the expensive argon2 password hashing.
  - **GET never uses up the token.** If the browser is already signed in, the page names who is
    signed in and who the link is for.
  - The page shows "Welcome, {display_name}" and the **username in large type**. The form uses
    `autocomplete="username"` and `autocomplete="new-password"` so iOS Keychain saves the pair.
  - **Redeeming is one atomic POST transaction:**
    1. Lock the user.
    2. Consume the token only if it is unexpired, unused, and for a viewer.
    3. Set the password.
    4. Revoke old sessions.
    5. Create the new session.
    6. Write the audit row.
  - **Success screen:** repeats the username, explains Add to Home Screen, then a button continues
    to `/app`. An expired or used link shows "Ask Gaylon for a new link."
- **Lax cookie follow-up:** check that no GET handler anywhere has side effects. Lax sends the
  cookie on cross-site top-level GETs. SvelteKit's default `csrf.checkOrigin` still protects form
  POSTs (`svelte.config.js` doesn't override it).

---

## Implementation slices (each slice is a reviewable commit set; no commit, push or deploy without explicit go-ahead)

**Slice 0: HTML mockup (approval gate).** `docs/mockups/family-viewer-v3.html` plus `mockup.css`,
with a phone (390px) / laptop (1280px) toggle and realistic sample text. It must show:
- Today, Timeline, Year, Month, Day, People, Person, Place, Stories, Search, and the invite flow
  (welcome, success, and expired screens).
- **A day that has both diary text and Madonna's memory**, to sign off the attribution.
- The 5-tab bar at 375/390px with no label wrapping.
- The month photo with tap targets plus the reading list.
- Sparse and error states: an empty date, Feb 29, a missing image, an expired invite, and long
  names (CODEX #11, AGY2 #9).

Then `docs/ui-mockups-V2.md` §B is superseded by a V3 section.

**Slice 1: Thin family rollout (the first thing the family sees).**

*Split 2026-11-08 into two deploys:* **1a** (no schema): the shell, Today, Day, Stories,
People/Places, Timeline order, Search clean-up, install icons, thumbnails. **1b** (migration
0028): invites, login restyle, `returnTo`, `SameSite=Lax` + cs.md, editable About text, display
name. 1a is safe to ship alone; families are invited only after 1b.

*1a shipped 2026-11-11 (98ea9e8).* **1b built 2026-11-11:**
- Migration 0028 `user_invites`. The app can SELECT and INSERT, and UPDATE only `used_at`/`revoked_at`;
  the worker has no access.
- `/admin/users`: "Invite a family member", New link, Cancel link. A password reset cancels any open
  link.
- `/invite/<token>`: public at the exact token shape (a trailing slash redirects), no-store and
  no-referrer headers, and in-memory caps on attempts.
- Sign-in page restyled, with an absolute action. `returnTo` keeps the query and rides in a hidden
  field.
- Cookie is now `SameSite=Lax`; cs.md updated.
- `/admin/about` and `/app/about` for the editable About text; `/app/account` for "Your name" and
  home-screen steps.
- Invite tokens are redacted in nginx access logs and the app error log.
- Gaylon, 2026-11-11: year stories on the Stories tab are grouped by decade, collapsed, with
  Expand/Collapse all and the shared oldest/newest choice, like the Timeline.
- Login, invite and account fields use `defaultValue`, so text typed or autofilled before the page
  finishes loading isn't wiped.

- Invite onboarding (above), the login restyle, the `returnTo` fix, the absolute login action, and
  the `SameSite=Lax` + cs.md change.
- Viewer shell with the 5 tabs (top links on laptop, bottom tabs on phone, a drawer), the new name
  "Vorwaller Family History", and `/` redirecting viewers. The dark admin bar is hidden on viewer
  routes. Install metadata and icons.
- Viewer-scoped tokens and type floors; `BackLink` and the `backTarget` helper.
- **Today:** `?date=` picker, text-first cards, coverage banners removed. An empty date falls back
  to a published year story or the latest accepted day.
- **Day:** text first, then "Madonna remembers", then chips; prev/next labeled with dates.
- **AI tags hidden:** `source = 'human'` on viewer tag queries. Ships even if the rest of the slice
  slips.
- **Stories** in the tab bar, including a list of published year stories.
- **People:** an A–Z list from `getAcceptedEntityOptions`. Profiles get snippets, a capped day list,
  and a correct Back link.
- **Timeline** tab points at the existing `/app/browse` until Slice 2.

**Slice 1T: Tag approval, alongside Slice 1 (added 2026-11-05).** Today the only way to show an
AI tag is to confirm it one day at a time in the correction editor. With about 5,700 AI tag rows
under free-form names ("sick", "illness", "doctor"), that doesn't scale, and the family would face
too many tags anyway. Gaylon approved deciding **per tag name**, not per day.
- **Migration `0027_tag_vocabulary.sql` (built 2026-11-07 — took 0027 because it ships first; invites move to 0028).**
  - Table: `tag_vocabulary`
    - `tag_slug` (primary key), `label` (the display label)
    - `status`: `approved` or `hidden`
    - `merged_into_slug`: nullable; must point at an approved slug, and can't chain
    - `decided_by`, `decided_at`
  - Grants: first REVOKE 0004's default app UPDATE/DELETE and all worker privileges, including the
    sequence. Then grant the app SELECT/INSERT/UPDATE (admin action) and the worker SELECT only (for
    the prompt). Check both roles in the invariants test.
- **Where a decision lives.**
  - Decisions are recorded on the tag name; `day_tags.source` is never rewritten.
  - Provenance stays honest: each tag still shows whether a person or the AI put it on that day.
  - New AI tags with an approved name show up automatically.
- **Viewer rule (replaces the plain `source = 'human'` from td-06d79a).**
  - A tag shows if its canonical name is approved, or if a person added or confirmed it. The
    canonical name is the merge target if there is one, otherwise the tag itself.
  - Hidden names never show unless a person added the tag.
  - Merges are applied when the page is built, and each canonical tag appears once per day.
  - The Search tag filter matches on the canonical name, so old `?tag=sick` links still work after
    a merge.
  - Put the rule in one SQL fragment in `viewer.ts` and use it everywhere. Its comment sits next to
    the accepted-only predicate.
- **`/admin/tags`, the first `/admin` change in this project.**
  - One row per tag name, showing the label, the number of accepted days, and an AI vs. human
    breakdown.
  - Filters: Undecided / Approved / Hidden / Merged. A search box and sort by count.
  - Actions: **Show to family**, **Hide**, **Merge into…** (a searchable picker of approved names),
    and **Undo**, plus multi-select for bulk approve or hide.
  - Every action writes to the audit log. Decisions are reversible, so there's no modal, but they
    are confirmed inline with a count, e.g. "Show 'church' on 412 days?".
  - The page lives in the admin nav with the existing pages, and is admin-only.
- **Fewer names going forward.** The enrichment worker's prompt gets the approved labels as the
  preferred vocabulary (capped, like `ocr_vocabulary`) and is told to reuse them. It still writes
  `source = 'ai'` rows, and the display layer handles merges.
- **Family side.** The Search "topic" control lists only approved canonical tags, which also makes
  a "Browse by topic" chip row possible later.
- **Tests:**
  - viewer-security cases:
    - an undecided AI tag is absent;
    - an approved one is present;
    - a merged pair shows as the canonical tag once;
    - a hidden tag is absent;
    - a human tag on a hidden name is present;
    - an old merged `?tag=` link still finds its days;
  - the worker can't write `tag_vocabulary`;
  - a non-admin gets a 403 on `/admin/tags`.

**Slice 2: Timeline, Year, and Today extras.**
- `/app/timeline` (`/browse` redirects) with month-density strips.
- Year page: narrative first, month cards with highlights. Highlights are deterministic, ranked by
  human tags and memories with a date tie-breaker.
- Today: recently transcribed, "Surprise me", and "this date in other years".
- Thumbnail widths and `NavProgress`.

*Slice 2 built 2026-11-12, shipped 2026-11-14 (67fb047):*
- `/app/timeline` replaces Browse (`/app/browse` → 308). Decade folds, collapsed, with
  Expand/Collapse all and the shared oldest/newest order. Each year row is one link with a 12-month
  bar strip (a dashed stub for an empty month), a visible day count, and a story line or highlight.
  Ingested years with nothing accepted show dashed "Not transcribed yet".
- Year page: story first (open, foldable), then "Read as a book" and the PDF buttons in one row,
  then a card per month with up to three highlights and "All N days ▸". Months with nothing yet are
  listed in one line. Highlight rank: has Madonna's memory, then family-visible tags, then
  people/places mentioned, then earliest date (`getMonthHighlights`, `getTimelineYears`).
- Today: "Recently added" (latest accepted by `corrected_at`) and "🎲 Surprise me"
  (`/app/surprise`, a no-store 303 to a random accepted day).
- "This date in other years" went on the **Day** page rather than Today, because Today already
  lists every year for its date. It links each year plus "Read them together on one page".
- `NavProgress` (from birds) in the viewer shell. Thumbnail widths shipped in 1a.
- Tests: viewer 76 (17 new), narratives' leak check now matches story sentences (day highlights
  share the fixture marker).

**Slice 3: Month and Day upgrades.** Month photo tap-a-day (td-ed1751) plus the full-text reading
list, with the grid dropped. On the laptop, the day page goes side by side. Share as quote plus
link.

*Slice 3 built 2026-11-14, shipped 2026-11-14 (f4e9244):*
- Month page: the page photo is the navigator. Accepted days get a green outline with a ✓ and
  link to the day; other days get a hatched cream wash and are inert (position only, never text).
  Cells come from `crop_bounds` against the served image's size (warped when there is one) and are
  drawn only after the browser confirms the served image has that shape. "Zoom in" opens the shared
  `ImageZoom`, which now takes an `overlay` so the zoomed photo is tappable too. Arriving from a day
  outlines that day in amber.
- Reading list "Every day this month": every accepted day in full, with a date pill linking to the
  day, the "Madonna remembers" flag, and a line per run of untranscribed days ("March 14–19 aren't
  transcribed yet."). The number grid and the "N of M transcribed" line are gone; `MonthGrid` is
  deleted. ‹ › go to the neighbouring captured months. Two columns at ≥1024px with the photo sticky.
- Day: "↗ Share this day" sends the quote, "— Madonna's calendar, {date}", Madonna's memory when
  there is one, and the link. Cancel does nothing; no share sheet copies to the clipboard
  ("Copied…"); no clipboard shows the text in a box to copy by hand. Laptop two-column, dated
  prev/next and other years were already in from Slices 1–2.
- Tests: month 23 (rewritten for the reading list and cells).

**Slice 4: People, Places, and Search depth.** `/app/places`. Person/place layouts that differ
(a place shows who was there; a person shows who they're often mentioned with), a mentions-by-year
bar chart, and days grouped by year. Search gets typeahead with removable chips and the year range
(separate `person` and `place` params kept).

*Slice 4 built 2026-11-14 (uncommitted):*
- Person and place pages: co-mentions from accepted `day_entities` joins (aliases resolved,
  distinct days, self excluded, top 8 per type). A person shows "Often mentioned with" and "Places
  linked to {Name}"; a place shows "Who was here" and "Visits by year". The People/Places index,
  year chart and year folds were already in from Slice 1. Maps stay with td-085e19.
- Search: one box with typeahead from `/app/search/suggest` (people, places and family-visible tags
  whose name contains the text, alias names included; accepted-only). Picking one adds it as a
  filter; Enter or the last option searches the words. Active filters are removable chips with
  "Clear filters". Year range `from_year`/`to_year` (inclusive, swapped when reversed); old `year=`
  links still work as a one-year range, and a range alone counts as a search. Results show the
  date, highlighted words, the memory flag and people/place chips. The four dropdowns and their
  option lists are gone. Chip labels show a name only when it has an accepted mention.
- Tests: viewer 90 (14 new or rewritten), tags 35 (dropdown checks moved to the typeahead).

**Tracking.** After approval, create a td epic "Family Viewer V3" with one task per slice, plus a
standalone task for the AI-tag hiding and the memory relabel. Link td-ed1751 (Slice 3) and td-ae212d
(book pagination stays separate). Note td-ef90ab (individual history PDF) as a follow-on on the
person page.

### Critical files
- **Modified:**
  - `src/routes/+layout.svelte`, `src/routes/+page.svelte`
  - `src/hooks.server.ts`: public paths, `returnTo`, cookie
  - `cs.md` §60 (SameSite rule)
  - `src/routes/app/+layout.svelte` and every `src/routes/app/**/+page.{svelte,server.ts}`
  - `src/lib/components/MonthGrid.svelte`, `src/lib/components/EntityProfile.svelte`
  - `src/lib/server/viewer.ts`, `src/lib/server/entities.ts`
  - `src/routes/app/day/[date]/image/+server.ts`
  - `src/routes/app/book/[scope]/[key]/+page.svelte` (memory label)
  - `src/routes/login/+page.{svelte,server.ts}`
  - `src/routes/admin/users/*` (invite action only)
  - `src/app.html`
- **New:**
  - `src/lib/viewer/`, `src/lib/components/viewer/`
  - `src/routes/app/{timeline,people,places}/`, `src/routes/invite/[token]/`
  - `backend/db/migrations/0028_user_invites.sql`
  - `static/` (manifest, icons), `docs/mockups/`
- **Port sources:**
  - `birds/src/lib/components/{SearchableSelect,Skeleton,NavProgress,PathNavigation,CollapsibleCard}.svelte`
  - `trips/src/lib/collapse-state.ts`
  - The shell CSS in `trips/src/app.css`

---

## Verification

- **Test stack only:**
  - Use `.env.test`, `madonnahist_test` on 15434, `MADONNAHIST_ENV=test`, local object store.
  - Run `npm run test:db:migrate` and `npm run test:db:invariants`.
  - Serve with `npx vite dev --host 127.0.0.1 --port 5177 --strictPort --mode test`.
  - Never use 5433, 5435 or production data.
- **`npm run check`** passes with 0 warnings, and the existing test suites pass, including the
  auth-matrix script.
- **New accepted-only regression tests** (pending, in-progress or flagged days must never surface):
  - Every new viewer query: recent, random, density, highlights, other-years, directory,
    co-mention.
  - Invite flow: expired, used, reissued and tampered tokens; double-submit and concurrent redeem;
    the worker role can't read invites; the app can't UPDATE token or expiry columns; the public
    route is reachable only at `/invite/<token>`.
  - AI tags: an accepted day with `source = 'ai'` tags shows none of them on any viewer surface.
  - Every new viewer query, plus the publication exceptions, documented in the
    `src/lib/server/viewer.ts` header.
- **Safari first:**
  - Extend a `safaridriver` + `selenium-webdriver` smoke script, following the trips
    `scripts/safari-smoke-*.mjs` pattern with test-env guard, self-provisioned fixtures and
    cleanup in `finally`.
  - Tour: invite → set password → Today → Timeline → Year → Month photo tap → Day → Person →
    Search chip → Stories.
  - Also covers:
    - combobox taps before blur;
    - drawer focus return;
    - the software keyboard showing up with the bottom tabs;
    - a home-screen launch that keeps its session;
    - a link tapped from Messages carrying the Lax session;
    - book/PDF render layout unchanged (CODEX #9).
  - Run it twice to confirm it's idempotent.
- **Chrome via claude-in-chrome:** screenshots at 390px and 1280px for each screen.
- **Tap-target audit:** 48px or more for primary controls, in the style of trips'
  `test:safari:tap-targets`.
- **AAA contrast:** spot-check any new color pairs.
- **Gaylon on iPhone and laptop** against the test stack before any deploy, which goes only via
  `./scripts/deploy-to-DO.sh` with explicit approval.

---

## Peer reviews

Reviewers appended a section here, in order: CODEX, then AGY2, then GROK. Read the earlier reviews
first, and don't repeat their points; agree, disagree, or extend them instead.

<!-- reviews below -->


### CODEX review (2026-11-05)

Source review only; no application changes, DB access, browser measurements, or live-count verification. The direction is sound and preserves Gaylon's decisions; the refinements below fit within the proposed phases.

**Must fix**

1. **Revoke the app's ambient table UPDATE and DELETE before granting UPDATE(used_at).** Migration 0004 grants new tables full app CRUD automatically; a column grant alone leaves token/user/expiry fields writable. Also revoke worker table access and, if an invite sequence is used, its inherited sequence privileges; verify effective privileges as both roles (refs: `backend/db/migrations/0004_grants_rls.sql:28–33`, `0023_adhoc_narratives.sql`, `0024_pdf_exports.sql`). Rationale: the intended invite permission boundary otherwise does not exist.
2. **Specify atomic invite redemption and reissue.** After password validation/hash computation, lock the target user and conditionally consume an unexpired, unused token, update only that viewer's password/name, invalidate old sessions, insert the new session and audit entry in one transaction; serialize reissue on the same user lock and enforce at most one outstanding invite. GET must never consume a token. Reject non-viewer targets and define invites as onboarding, with the existing reset flow handling established accounts (refs: `src/routes/admin/users/+page.server.ts`, `src/lib/server/session.ts`). Rationale: double submissions or concurrent reissue must not produce two successful redemptions or turn onboarding into privileged account recovery.
3. **Treat the link as a bearer credential throughout its lifecycle.** Use cryptographic random tokens (e.g. 32 bytes), unique indexed hashes, strict token syntax/length, no-store responses and no-referrer policy; redact `/invite/<token>` in access/error/monitoring logs and audit only IDs/outcomes, never the link/hash/password. Rate-limit public validation and expensive argon2 work; use an exact one-segment public route match and test GET plus form POST, sibling prefixes, extra segments and malformed tokens (refs: `src/hooks.server.ts`, `src/lib/server/auth.ts`, `src/routes/login/+page.server.ts`). Rationale: hashing at rest does not protect tokens leaked through URLs or an unbounded public password endpoint.
4. **Make the Search range contract concrete before mockup approval.** The current loader accepts one `year`, and `searched` ignores a year-only request; a year-range control cannot retain exactly the same parameter contract without a defined extension. Preserve old `year` links, specify inclusive range parameters and validation, reset `page` when filters change, and test year-only/range-only searches (ref: `src/routes/app/search/+page.server.ts:45–73`). Rationale: the proposed UI otherwise promises a filter the current backend cannot express.
5. **Document the existing publication exceptions and preserve human narrative text.** The full month image is deliberately family-visible before acceptance; coverage aggregates also include unaccepted rows. Saved answers use admin-save curation, not `is_published`, while year summaries require that flag. Keep these distinctions explicit, and retain `day_narrative` as human-authored material distinct from generated context (refs: `src/routes/app/month/[monthKey]/page-image/+server.ts:30`, `src/lib/server/viewer.ts`, `src/routes/app/stories/+page.server.ts`, `src/routes/app/day/[date]/+page.server.ts`). Rationale: a blanket accepted-only/published-only rule would either change agreed policy or mislabel family-authored memories.

**Should consider**

6. **Tighten three deep-dive claims.** Normal viewer login already lands at `/app` (`landingFor`), so finding 1 applies to visiting `/`, not every sign-in. The book explicitly escapes the 640px cap, so finding 4 has an immersive-reader exception. `entities.metadata` exists but no migration or current entity helper defines co-mention content: compute co-mentions from accepted `day_entities` joins, canonicalize aliases and count distinct days, excluding self (refs: `src/routes/login/+page.server.ts`, `src/routes/app/+layout.svelte`, `backend/db/migrations/0003_schema.sql:199–205`, `src/lib/server/entities.ts`). Rationale: these corrections keep implementation grounded in the actual contracts; visual height and live population claims remain unmeasured.
7. **Scope foundation styling to the viewer.** A global 18px root changes rem-based admin/correction layouts even with the dark bar hidden; retain their root metrics and scope viewer typography, tokens and selectors. Resolve the proposed shared stylesheet against cs.md's component-scoped-style rule before coding, and regression-check `/correct` and `/admin` (refs: `cs.md`, `src/routes/+layout.svelte`, `src/routes/app/+layout.svelte`). Rationale: out-of-scope screens should not change through inherited CSS.
8. **Bound image work and separate image coordinates from layout coordinates.** Accept a small width allow-list, cap decode/output size and concurrent Sharp jobs, coalesce duplicate transforms, bound any cache and keep authorization ahead of cache hits; test the existing day-image role behavior explicitly. For overlays, normalize crop bounds against the same warped/original image dimensions actually served, account for letterboxing and missing bounds, and keep the reading list as keyboard/touch access (refs: `src/routes/app/day/[date]/image/+server.ts`, `src/routes/app/month/[monthKey]/page-image/+server.ts`, `src/routes/admin/ocr-review/[pageId]/crop/[dayId]/+server.ts`). Rationale: arbitrary widths can exhaust shared memory, and mismatched geometry can open the wrong day.
9. **Add Safari interaction cases to the mockup and smoke tour.** Exercise combobox option taps before blur, keyboard selection/Escape, drawer focus return/inert background, enlarged text, iPad portrait/landscape and the software keyboard with bottom tabs. Use absolute form actions; provide share cancellation handling and a selectable-link fallback when Clipboard is unavailable. Keep the book/PDF render layout stable after shell changes (refs: `CLAUDE.md` Browser Compatibility, `src/lib/components/EntityPicker.svelte`, `src/routes/app/book/[scope]/[key]/+page.svelte`, `src/lib/server/render-token.ts`). Rationale: desktop width screenshots alone miss the repository's documented WebKit failure modes.
10. **Keep navigation and new query costs explicit.** Preserve complete search query strings in `from`, reject external/backslash destinations in shared navigation/returnTo helpers, and retain browser Back/scroll state. Batch Search result chips instead of querying per result, measure query plans and payloads on representative isolated fixtures, and use visible pagination/load-more if entity/story lists outgrow one response. Folds alone do not reduce server payload or DOM cost (refs: `src/routes/app/search/+page.server.ts`, `src/lib/server/entities.ts`, `src/routes/login/+page.server.ts`). Rationale: a warmer interface should not increase shared-droplet work or lose a reader's place.

**Nice to have**

11. **Make Phase 0 include sparse and failure states.** Show no entries for a chosen date, February 29, a missing image/narrative, an expired invite, and long names at phone width; preserve `todayInAppTz()` and make “highlights” deterministic with a date tie-breaker rather than implying editorial selection (refs: `src/routes/app/+page.server.ts`, `src/lib/server/time.ts`). Rationale: these small mockup cases settle behavior before implementation.
12. **Keep PWA scope to install metadata unless offline behavior is separately approved.** Verify manifest/icon fetches through the auth hook, standalone safe areas and a useful install icon, and avoid introducing a service-worker cache of private archive content (refs: `src/hooks.server.ts`, proposed `static/manifest.webmanifest`). Rationale: installability does not require a new offline privacy/cache lifecycle.

Verification: inspected the named plan, repository rules, viewer/entity helpers, shell, login/session/admin-user actions, search loader, month/day image routes, publication rules and migration grants. Existing untracked plan preserved with this section appended only. No tests/build/browser run: this is a document-only review; implementation evidence remains a future phase gate.


### AGY2 review (2026-11-05)

Reviewed the plan, CODEX's section, and the verified routes/server modules in `/Users/gaylonvorwaller/madonnahist`. I concur with CODEX's security, SQL-grant, and coordinate-math points (1–12); the suggestions below extend those points and cover the family-reader experience, visual hierarchy, Today/Timeline/Person UX, Phase 0 mockup gates, and scope trims.

**Must fix**

1. **Relabel `day_narrative` as Madonna's own memory and elevate it above metadata chips on Day and Book views.** Extending CODEX #5 (confirmed): `/correct/day/[date]` collects `day_narrative` under "Memories, context, stories this entry brings to mind" (`src/routes/correct/day/[date]/+page.svelte:471–481`), yet `/app/day/[date]` (`+page.svelte:125–130`) and `/app/book/[scope]/[key]` (`+page.svelte:153–158`) label it `In context — generated` in amber. Rename it to a warm human attribution (e.g., "Madonna's memory" or "In Madonna's words", without an AI badge) and place it directly beneath `corrected_text` before entity/tag chips. Rationale: misattributing Madonna's firsthand memories to AI inverts the archive's core human-truth value and hides the most emotionally resonant content on the page.
2. **Enforce an 18px (`1rem`) floor for diary prose and 15px (`0.833rem`) floor for metadata/nav labels inside `.app-shell`, keeping `<input>`/`<select>` at `>=16px` (`1rem`).** Extending CODEX #7: `src/routes/+layout.svelte` leaves `html` at the browser default 16px, and `/app` currently drops to `0.72rem` (~11.5px) on `.nav-item`, `0.7rem` on `.zoom-hint`, and `0.65rem` (~10.4px) on `MonthGrid` `.weekday-label` (`src/routes/app/+layout.svelte:125`, `src/lib/components/MonthGrid.svelte:168`). Set `font-size: 1.125rem` on `.app-shell` and use `em`-based sizing or CSS custom properties (`--text-prose: 1.125rem`, `--text-ui: 1rem`, `--text-meta: 0.875rem`) rather than `rem` (which resolves against `<html>` at 16px). Rationale: older readers on phones cannot comfortably read 10–12px labels, and iOS Safari auto-zooms any form control below 16px computed font size.
3. **Allow public static assets (`/manifest.webmanifest`, `/apple-touch-icon.png`, `/icon-*.png`) in `src/hooks.server.ts` alongside `/invite/[token]`, and fix `returnTo` to include `event.url.search`.** Extending CODEX #3 and #12: `hooks.server.ts:32–39` denies every non-public path without a session (redirecting GETs to `/login?returnTo=...`), and iOS Safari fetches `apple-touch-icon` and `manifest.webmanifest` without session cookies during "Add to Home Screen". Also update `hooks.server.ts:84` from `encodeURIComponent(path)` to `encodeURIComponent(path + event.url.search)`. Rationale: without explicit public allow-listing in `isPublic()`, home-screen icons and manifests receive a 303 HTML redirect to `/login`, breaking PWA installation, and shared search/today links (`?q=`, `?date=`) lose their query parameters on sign-in.

**Should consider**

4. **Lead "Today" and "People" with grandkid-friendly entry points: family quick-chips, birthday/anniversary jumps, and relative-age framing.** When children or grandkids open the app, their first impulse is to tap their own name, a parent's name, or their birthday. On Today (`/app`), pair the `?date=MM-DD` picker with a one-tap "Jump to a date / birthday" control and show years-ago badges on cards (`1972 · 54 years ago`); on `/app/people`, curate a top "Immediate Family" row above the raw mention-count sort. Rationale: grandkids rarely know archive tag slugs or historical years up front, so self-discovery ("find me / find Mom / my birthday") is the primary hook that turns a first visit into a habit.
5. **Filter `day_tags` in viewer queries and highlights to exclude unconfirmed AI suggestions (`source = 'human'`), or visually distinguish them.** In `src/routes/correct/day/[date]/+page.svelte:58–59`, AI-suggested tags (`source = 'ai'`) require explicit corrector acceptance to become `source = 'human'`, but `src/routes/app/day/[date]/+page.server.ts:40–46` and `src/lib/server/viewer.ts:203–210` (`getAcceptedTagOptions`) currently surface all `day_tags` on an accepted day regardless of `source`. Similarly, if Phase 3's `getMonthHighlights(year)` ranks days by entity/tag richness, weight human-confirmed tags and `day_narrative` presence ahead of raw character length. Rationale: unreviewed AI tags on accepted days should not leak into family navigation or skew month highlights toward verbose weather/chore entries over family milestones.
6. **Keep 12-month density strips on Timeline scannable and accessible at 390px without nested small tap targets.** In `/app/timeline`, making each of the 12 month cells inside every year row an independent link (`<a href="/app/month/...">`) across 390px yields ~24px-wide targets—half the 48px floor (`cs.md` / `CLAUDE.md`). Instead, make the entire year row one primary tap target to `/app/year/[year]` (with the 12-month bar as a visual + screen-reader summary, e.g., `aria-label="182 days across 12 months"`), or expand month pills only when a year or decade is opened. Rationale: preserving >=48px touch targets on phones prevents mis-taps while keeping the visual rhythm borrowed from `birds`'s `MigrationRibbon`.
7. **Give `/app/person/[slug]` and `/app/place/[slug]` distinct storytelling layouts and open the person's richest decade by default.** `src/lib/components/EntityProfile.svelte` currently renders a centered title, flat year list, and bare date links with no snippets (`L203–220`), and ignores `?from=` (`L16`). In the rebuild, honour `backTarget(from)` (defaulting to `/app/people` or `/app/places`), render day snippets under each year fold with the first/richest year pre-expanded, and differentiate Places ("Who was here" top people chips) from People ("Often mentioned with" people + "Places linked to {Name}"). Rationale: scrolling hundreds of bare date strings hides the story, and a place page is most interesting for *who* visited it, whereas a person page is about relationships and life chapters.
8. **Use a side-by-side reader layout at `>=1024px` only where it aids reading, keeping diary prose capped at `60–65ch`.** The plan notes borrowing two columns at `>=1024px` (`src/routes/app/+layout.svelte:91` currently hard-caps `.app-content` at `640px`). Widen the shell container at `>=1024px` (e.g., `1080px`) so `/app/day/[date]` can place the handwriting crop beside the transcription+memories column, and `/app/timeline` or `/app/people` can use a 2-column card grid, while keeping single-column prose measure (`60–65ch`) for Year narratives, Stories, and Book view. Rationale: wide viewports should eliminate the "giant 640px image pushing text below the fold" problem on laptops without stretching diary sentences into hard-to-track lines.
9. **Make Phase 0 (`docs/mockups/family-viewer-v3.html`) an interactive typography, contrast, and layout gate before Phase 1.** Extending CODEX #11: in addition to empty/error states, the single-file HTML mockup should include (a) a side-by-side phone (390px) and laptop (1280px) toggle, (b) a real day entry that has *both* `corrected_text` and Madonna's `day_narrative` to sign off on the corrected attribution, (c) a 5-tab mobile bottom bar showing exact label lengths (`Today · Timeline · People · Stories · Search`) at 375px/390px with no wrapping or truncation, and (d) the month page with both tap-a-day photo overlays and the chronological reading list below. Rationale: catching label crowding, font-size legibility, and the `day_narrative` treatment in static HTML costs minutes before Svelte components are touched.

**Nice to have**

10. **Trim scope on `/app/month/[monthKey]` and `/app/year/[year]` by retiring redundant `MonthGrid` instances when better views are present.** On `/app/month/[monthKey]`, once the page photo has tap-a-day overlays and the full chronological reading list sits directly below it, the third representation (`MonthGrid.svelte` at `src/routes/app/month/[monthKey]/+page.svelte:85–90`) is redundant and can be dropped. On `/app/year/[year]`, keep the 3 highlights + "Read all N days in {Month} ▸" link (to `/app/month/[monthKey]#list`) and omit the folded `MonthGrid` unless Gaylon specifically wants a number grid on the year page. Rationale: removing duplicate calendar grids cuts DOM weight and vertical scroll while steering family readers toward stories and full-month reading lists rather than bare numbers.
11. **Add a lightweight "Share / Copy quote" format on `/app/day/[date]` that includes the date, snippet, and deep link.** When a family member taps Share on a day (`navigator.share` or clipboard fallback), pre-format the shared text as `"Tuesday, May 3, 1972 — Madonna's calendar: «…»"` plus the URL, rather than a bare URL (since open-graph previews cannot be scraped by iMessage/WhatsApp behind the `/login` auth wall). Rationale: family links are shared primarily in group texts, and an auth-gated URL shows no preview card unless the share payload itself carries the quote and date.


### GROK review (2026-11-05)

Reviewed the plan, both earlier reviews, and the viewer, login, session, admin-user, and entity code. I agree with CODEX 1–12 and with AGY2 1–3, 5–9, and 11. Below are rollout order, the invite as a grandparent or grandchild actually experiences it, and a few places the plan adds machinery for data the app already loads. No application code, database, or browser run.

**Must fix**

1. **The invite has to choose and show a username, because that is the only sign-in key.** `users.username` is `UNIQUE NOT NULL` (`backend/db/migrations/0003_schema.sql:15–20`). Login asks for username and password (`src/routes/login/+page.svelte:30–46`); `findUserByUsername` is the lookup (`src/lib/server/auth.ts:32–38`). The plan's invite page confirms `display_name` and sets a password. Gaylon should pick the username when he creates the invite, using the same trim-and-lowercase as `normalizeUsername` (`src/routes/admin/users/+page.server.ts:20–22`). The invitee sees it in large type. The form uses `autocomplete="username"` and `autocomplete="new-password"` so iOS Keychain stores the pair. Editing the display name leaves the username unchanged. The success screen repeats the username before `/app`. Rationale: the session lasts 30 days (`src/hooks.server.ts:9–15`), and the next sign-in asks for a username they were never given.

2. **Make invite its own admin action, and define what a browser that is already signed in should do.** `create` rejects a password shorter than 8 characters (`src/routes/admin/users/+page.server.ts:54–56`), so it cannot mint an account whose password Gaylon never learns. The invite action takes display name, username, and role fixed to `viewer`, and stores `hashPassword` of a discarded random secret (`verifyPassword` already returns false on a malformed hash, `src/lib/server/auth.ts:15–20`). Show the URL in a selectable field beside Copy, and keep it on screen until Gaylon leaves. GET `/invite/[token]` never consumes the token. If that browser already has a session, name who is signed in and who the link is for; only the successful POST replaces that browser's session. Use a 30-day expiry, the same window as the session cookie, and keep CODEX's single outstanding invite and revoke-on-reissue. Rationale: Gaylon is the only person who can replace a link, and a 7-day expiry turns next weekend's open into a support call.

3. **After the mockup, ship a thin slice the family can use, and add the new visual systems after they can sign in.** Invites are Phase 6, behind a component port, density strips, month overlays, typeahead, co-mention, and the stories hub. Accepted days are already readable. The first build should be this invite; login `returnTo` carried in a hidden field with absolute action `/login?/login` (the form is relative `?/login` at `src/routes/login/+page.svelte:19–21`, which `CLAUDE.md` says Safari can mis-resolve, while `safeReturnTo` at `src/routes/login/+page.server.ts:17–23` already allows a query); the viewer shell and the five decided tabs; Today with `?date=`, text ahead of the crop, the coverage line removed, and an empty month-day falling through to one published year story (`getPublishedNarrative`, `src/lib/server/viewer.ts:107–114`) or one latest accepted day; the day page text-first with AGY2's memory label; Stories in the tab bar; People as an A–Z list from `getAcceptedEntityOptions` (`src/lib/server/entities.ts:175–189`), which is already accepted-only and alias-canonical, linking to the profiles that already exist. Point Timeline at `/app/browse` until `/app/timeline` is real, and add the browse redirect in that same change. Rationale: that slice is a family rollout; later phases are improvements for people who can already read.

4. **Teach Add to Home Screen on the invite success screen, because `SameSite=Strict` withholds the session on a Messages tap.** `SESSION_COOKIE_OPTS` sets `sameSite: 'strict'` (`src/hooks.server.ts:9–15`), and `cs.md` requires it. Opening a link from iMessage or Mail is cross-site, so an existing session is not sent and the reader gets the login page. Leave the cookie as it is. The success screen should say this browser is now signed in as {name}, give the username, and say a later tap in Messages will ask for it again. Put AGY2's manifest and icon allow-list in this slice, and have the Safari smoke tour confirm a home-screen launch still sends the session. Rationale: the second tap on Gaylon's text looks like a broken account unless the success screen already explained how to come back.

**Should consider**

5. **Keep the month page a date index, and keep full diary text in the book.** `/app/book/[scope]/[key]` is already the continuous reader, and its pagination stays the separate td-ae212d task. Leave `MonthGrid` on `/app/month/[monthKey]` as the way to jump to a remembered date, and defer both the full-text month reading list and the tap-on-photo overlays (CODEX #8). Rationale: a second full-text month page is a large response on the shared droplet, and the grid is the control that already answers "what about the 14th?"

6. **Let a start-here family row wait until Gaylon can name the people himself.** `entities.entity_type` is only `person`, `place`, or `event` (`backend/db/migrations/0003_schema.sql:203`), plus aliases, with no household or generation column. A row sorted by mention count names whoever the diaries mention most. The `?date=` control already covers a birthday jump. If the mockup still wants an "Immediate Family" strip (AGY2 #4), it is a short list Gaylon writes, after the first rollout. Rationale: an inferred row will be the wrong people, and the schema has nowhere to store a correction.

7. **Treat the person page as a rendering and size problem.** `loadEntityProfile` already loads every accepted `corrected_text`, builds a snippet, and returns year counts (`src/lib/server/entities.ts:94–128`). `EntityProfile.svelte` shows snippets for earliest and latest (`:37–52`), date-only links for every other day (`:72–78`), and a back link hardcoded to `/app` (`:16`), while the day links already append `?from=`. Cap or page that list, show the snippet, and send Back through `backTarget`. Leave co-mention and the CSS bar chart until after rollout. Rationale: the page a chip opens is already paid for on the server.

8. **Stop Search from loading every filter list before anyone filters.** `src/routes/app/search/+page.server.ts:65–73` always loads coverage, years, tags, people, and places, and `:73` leaves `searched` false for a year alone (CODEX #4). Skip those option queries until a filter control opens. When typeahead arrives, keep separate `person` and `place` params; migration 0020 allows the same slug on both types. Rationale: the wait on a phone is those unused lists, and a combobox port on top of them waits longer for the same data.

9. **Put published year stories on the Stories tab in the first slice.** `/app/stories` lists only `adhoc_narratives` (`src/routes/app/stories/+page.server.ts:22–32`). Year narratives live in `narrative_summaries` and are loaded one year at a time. One list of published year rows, each linking to `/app/year/[y]#story` and the existing book, is enough for the decided tab; the two-section card redesign can wait. Rationale: saved Ask answers can be few, and the writing the family was invited to read is the year narratives.

**Nice to have**

10. **Leave `event` entities out of this round on purpose.** Day chips and profiles already drop `entity_type = 'event'` (`src/lib/server/entities.ts:140–156`). People, Places, and later typeahead stay person and place. Rationale: the mockup never showed a third type, and the "about 1,150" figure should stay people and places.

11. **Show the expiry date beside the admin invite link.** Copy such as "Send this in Messages. It expires {date}." Rationale: the URL is on screen once, and Gaylon is the person copying it by hand.

Verification: read the plan and both reviews; inspected hooks, login, admin users, auth, the viewer narrative helper, the search loader, the entity loader and profile, the today and stories loaders, and the user and entity schema through migration 0026. No tests, build, browser, or database. Append-only edit.
