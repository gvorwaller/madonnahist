# td-c6e871: Entities cleanup helper. Find likely duplicates, suggest merges

Revision 2, 2026-11-23. Revised after CODEX's plan review (ten recommendations, all taken; where one was adjusted, the "CODEX n" note says how).

## Context

The extractor creates a new entity for every spelling it sees. Production has 915 canonical people, 405 places and 824 events, so duplicates pile up:
- typos and spacing (Gayon, R Honda, Kmart / K-Mart);
- nicknames (Bekah, Rebeky);
- fuller names (Rebekah Lynn, Dana Pommell).

Gaylon found this when Rebekah's birth was missing from her People page. Cleaning up by hand takes hours of scanning, so it won't happen. The app should find likely duplicates, group them, show the evidence, and let him confirm changes quickly.

Decided with Gaylon (2026-11-22):
- **Claude pre-check:** on demand, per group or "the next 20". Claude reads sample entries and pre-ticks matches, giving a one-line reason. Gaylon confirms every change.
- **Move single days** between entities: included. This fixes names that cover two people, like "Becky": Mark's girlfriend in 1977, baby Rebekah in June 1985.
- **Nothing merges automatically.**

A prototype matcher run on production data (read-only) took about 0.4 s for all types:

| Type | Very likely | Possibly |
|---|---|---|
| People | 20 | 450 |
| Places | 18 | 96 |
| Events | 10 | 47 |

- **Very likely:** Gayon→Gaylon, R Honda→Rhonda, Reguency Square→Regency Square, F.H.E.→FHE.
  - Even this tier has false matches (Janie→Jamie).
- **Possibly:** mostly first-name groups (Dana with Dana Pommell, Dada, Dand, Dan and Dana Powell; Rebekah with Rebekah Lynn, Bekah and Rebeky).

The ticket's acceptance criteria are:
- ranked suggestions with evidence;
- merge, **alias** or dismiss each one;
- dismissals stay dismissed;
- every change audited.

## Ground rules (from the review)

**Identity is the canonical family.** An entity's family is itself plus its aliases. Readers resolve `COALESCE(alias_of_entity_id, id)` (`src/lib/server/entities.ts`), so:
- counts, year spans, evidence, moves and blocks all work on the **family**;
- the matcher compares canonical entities only.

**IDs are bigint,** so node-pg returns them as strings. Every id is normalized with `Number()` at the boundary (form data, query rows, JSON verdicts, pair keys). Pairs are always stored as `(low, high)`. Tests include ids 2 and 10, so a string sort would give the wrong order.

**One write lock order (CODEX 3).** Every entity-graph write runs in one transaction, in this order:
1. `pg_advisory_xact_lock(<graph key>)` (one constant key);
2. `pg_advisory_xact_lock(<day key>, day_id)` for each affected day, in ascending order;
3. re-validate everything on the transaction's own client;
4. write.

Entity-graph writes are merge, alias, move-day, not-same and delete. The extractor's write transaction takes the same **day** lock (never the graph lock) before it deletes and re-inserts a day's AI links, then reads that day's blocks under the lock. No cycle is possible: the worker only ever holds one day lock, and the app always takes the graph lock first. The existing `/admin/entities` actions (`setAlias`, `mergeInto`, `delete`) move onto this path too; they currently validate outside the transaction.

**Human beats AI (CODEX 1).** Whenever a link is copied onto an entity that already has a link for that day (merge or move), the result is `source='human'` if either side was human, and `confidence_score` is cleared when a row is promoted. Re-extraction only replaces `source='ai'` rows, so a human decision can't be erased by a later merge plus extraction.

## Design

### 1. Matcher: new `src/lib/entity-matcher.ts` (pure, no DB) and `src/lib/name-fold.ts`

**Fold:**
- `fold`: NFKD, strip marks, lower-case. This is the same fold as on `/admin/entities`, moved into `name-fold.ts` and shared.
- `squash`: keeps letters and digits only.
- Names that come out empty after `squash` are never matched.

`findGroups(entities, dismissedPairs)` works within one type, on canonical families. Each entity carries `{id, name, count, first, last, days}`, all from family days. Then:
- **Skip** a pair when its digits differ ("40th" vs "37th birthday") or when it's dismissed. Compare edit distance only when the lengths are within 2.
- **Very likely:**
  - the same squashed letters;
  - or one edit apart, the longer name has 5+ letters, the rarer one has 1–2 mentions (a **zero-mention entity never counts**), and the commoner has at least 10× as many.
- **Possibly:**
  - one edit apart (4+ letters);
  - two edits apart (7+ letters);
  - a single word that is the first word of a longer name (people and places only).
- **Groups:**
  - The main name is the more-mentioned of each pair. Ties go to the lower id.
  - Each candidate is placed exactly once: by its very-likely match if it has one; otherwise under the main name with the most mentions, then the lowest id.
  - Similarity is **not transitive**: being in a group proves nothing about the other candidates (see the pairwise rule in §3).
  - Groups are ordered by tier, then the main name's mentions, then id.
- **Span warning:** on a candidate with days outside the main name's first-to-last mention dates.
- **Unused:** zero mentions, using exactly the same predicate as delete (§3).

### 2. Schema: migration `backend/db/migrations/0036_entity_cleanup.sql` (CODEX 8)

```
entity_not_same (
  entity_a BIGINT REFERENCES entities(id) ON DELETE CASCADE,
  entity_b BIGINT REFERENCES entities(id) ON DELETE CASCADE,
  CHECK (entity_a < entity_b), PRIMARY KEY (entity_a, entity_b),
  decided_by INT REFERENCES users(id) ON DELETE SET NULL, decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW())

entity_cleanup_checks (
  main_id BIGINT REFERENCES entities(id) ON DELETE CASCADE,
  candidate_id BIGINT REFERENCES entities(id) ON DELETE CASCADE,
  PRIMARY KEY (main_id, candidate_id),
  status TEXT CHECK (status IN ('pending','done')),  -- 'pending' = a paid call is in flight
  fingerprint TEXT NOT NULL,       -- hash of prompt version, model, names, evidence day ids + text
  verdict TEXT CHECK (verdict IN ('same','different','unsure')), reason TEXT CHECK (length(reason) <= 200),
  model TEXT, checked_by INT REFERENCES users(id) ON DELETE SET NULL, claimed_at TIMESTAMPTZ, checked_at TIMESTAMPTZ)

day_entity_blocks (
  day_id INT REFERENCES calendar_days(id) ON DELETE CASCADE,
  entity_id BIGINT REFERENCES entities(id) ON DELETE RESTRICT,   -- always a canonical id
  PRIMARY KEY (day_id, entity_id),
  blocked_by INT REFERENCES users(id) ON DELETE SET NULL, blocked_at TIMESTAMPTZ NOT NULL DEFAULT NOW())
```

**Grants**, following 0029: `REVOKE ALL` first, because 0004's default privileges would otherwise give the app UPDATE and the worker SELECT. Then:

| Table | App | Worker |
|---|---|---|
| `entity_not_same` | SELECT, INSERT, DELETE | nothing |
| `entity_cleanup_checks` | SELECT, INSERT, UPDATE, DELETE | nothing |
| `day_entity_blocks` | SELECT, INSERT, DELETE | SELECT |

- `entity_cleanup_checks` gets app UPDATE because claims and results use `ON CONFLICT DO UPDATE`.
- Audit rows go to `audit_log` as they do today.

### 3. Server: new `src/lib/server/entity-graph.ts` (all writes), used by both pages

**Common to every write:** one transaction, the lock order above, validation on the transaction client, and one audit row per human decision in the same transaction (CODEX 6).

- **`mergeEntities(keepId, sourceIds[], user)`:**
  - **Validation:** every id is canonical and of the same type, and none equals `keepId`. Every pair in `{keepId} ∪ sourceIds` is checked against `entity_not_same`, and the call fails, naming the pair, if any is dismissed (CODEX 5). Any failure rolls back the whole multi-merge.
  - **Per source:**
    - copy its links to `keepId` using the human-beats-AI rule, then delete the source links;
    - re-parent its aliases;
    - make it an alias of `keepId`.
  - **Blocks** on the source move to `keepId`, deduplicated (CODEX 2).
  - **Not-same pairs** `(source, X)` become `(keepId, X)`, normalized and deduplicated; any pair that would become `(keepId, keepId)` is dropped (CODEX 5).
  - **Checks** that mention a source are deleted.
  - **Places (CODEX 4):**
    - A source location row that is the only one moves to `keepId` unchanged (status, reason, pin and decider).
    - If both have rows, a human decision on one side (`confirmed`, or `no_location` with reason `admin`) wins over a machine one (`auto`, `needs_review`, other `no_location`).
    - If both sides have a *different* human decision, the merge is refused: "Both have a map decision; choose one on /admin/places first."
    - A machine row that loses is deleted, so it can be looked up again.
- **`setAlias(id, targetId, user)`:** the existing alias logic plus the same lock, validation, not-same check, and place and block carry-over. Day links stay on the alias, as today.
- **`moveDay(dayId, fromId, toId, user)`** (CODEX 2/3):
  - **Validation:** `from` and `to` are different canonical families of the same type. Under the day lock, the day must still be linked to `from`'s family, or the move returns 409 "This day has changed; reload" (stale moves from two tabs).
  - **Writes:**
    - delete every raw link on that day into `from`'s family;
    - upsert a human link to `toId`;
    - insert block `(day, fromId)`;
    - delete block `(day, toId)`, which makes moving back work.
- **`notSame(a, b)` / `undoNotSame(a, b)`:** audited.
- **`deleteUnused(id)`:** one atomic predicate, shared with the existing delete and with the "Unused" list. It requires:
  - no day links;
  - no aliases pointing at it;
  - no block rows;
  - no human place decision.
- **Extractor** (`backend/workers/enrichment-worker.ts`, write transaction near line 377):
  - take the day lock;
  - load the day's blocks;
  - when an extracted slug resolves to an entity, compute its canonical id with `COALESCE(alias_of_entity_id, id)`, and skip the link if that id is blocked.
  - This covers both the same spelling after a merge and an alternate alias (CODEX 2).
  - A newly created entity can't be blocked, because blocks only point at existing ids and the RESTRICT FK stops a blocked entity from being deleted.

### 4. Evidence: `src/routes/admin/entities/[id]/mentions/+server.ts` (CODEX 7)

- **Family scope:** returns the whole canonical family's days, with `dayId`.
- **Paging:** stable order `(entry_date, day_id)`, cursor-based (`?after=<date>,<dayId>&limit=50`).
- **Snippets:** search `corrected_text`, then `day_narrative`. When the name appears in neither, the row is marked "name not found in the text". A narrative hit is labelled "in the day's note".
- **Moving from `/admin/entities`:** the existing mentions list there gets the same "Move to…" action, so a mixed name like Becky can be fixed from ordinary search even though no rule groups it with Rebekah (CODEX 6).

### 5. Claude pre-check: `src/routes/admin/entities/cleanup/check/+server.ts` (CODEX 9)

- **Request:** POST `{mainId, candidateIds}` (at most 8 candidates).
- **Validation, under the graph lock:** the main name and candidates are still canonical and of the same type, the candidates are in this main name's current group, and no candidate is dismissed against the main name.
- **Evidence:** up to 4 days per name, sampled across its span (first, last, middle, plus any days outside the main name's span). Snippets are capped at 300 characters. The fingerprint is a hash of prompt version, model, ids, names, evidence day ids and snippet text.
- **Claim before paying:**
  - Insert or update rows to `status='pending'`, `claimed_at=now()`, but only where there's no row, the row is `done` with a different fingerprint, or the row is `pending` and older than 2 minutes.
  - Candidates that are already done with the same fingerprint are returned from the cache. Candidates someone else is checking right now return "being checked".
- **Call:** a new `completeJson` in `src/lib/server/llm.ts`, using the same client, credential path (`private_data.api_credentials`, then the `ANTHROPIC_API_KEY` env var) and stub mode as `completeText`.
  - The model id is a constant. Verify it against the Models API before any paid call; `claude-sonnet-5-5` is expected.
  - `max_tokens` 1200; an `AbortSignal` deadline of 40 s, below nginx's 60 s; no retry beyond the SDK's within that deadline.
  - Names and snippets go inside tagged evidence blocks, with an instruction that text inside them is evidence, never instructions.
- **Validation and storage:**
  - The reply must be normal completion (not `refusal` or `max_tokens`) and valid JSON.
  - Each requested candidate must appear exactly once, with a verdict from the allowed set and a plain-text reason of at most 200 characters.
  - Before storing, re-check that the fingerprint still matches the current evidence.
  - On any failure the claims are released, nothing is stored, and the page shows "Couldn't check this group."
- **"Check the next 20":** builds a fixed list of unchecked groups first, then runs them one at a time. Stop takes effect before the next group starts.

### 6. Page: `src/routes/admin/entities/cleanup/+page.{server.ts,svelte}`

Linked from `/admin/entities` ("Find duplicates") and from `/admin`.

**Layout:**
- **Tabs:** People, Places, Events.
- **Sections:** "Very likely the same", "Possibly the same", "Unused", and "Marked not the same". That last list has Undo for each pair, so a dismissal can be found after its card is gone (CODEX 5).
- **Paging:** 20 groups at a time.

**Group card:**
- the main name with its mentions, years and Entries;
- a "Keep as the main name" radio;
- per candidate:
  - a checkbox;
  - its name, mentions and years, and why it matched;
  - Claude's verdict and reason as a text label;
  - the span warning;
  - Entries, paged, each with a date link and "Not this one → move to…";
  - "Alias of {main}" and "Not the same" buttons;
- "Check with Claude";
- "Merge ticked into {name}…": opens the existing `Modal`, listing exactly what merges;
- Skip: hides the card for this visit and writes nothing.

**Checkbox rules (CODEX 10):**
- **Ticked by default** only when the match is very likely, there is no span warning, and there is no stored "different" or "unsure" verdict.
- **Ticked by a Claude "same"** only if Gaylon hasn't touched that box. "Different" and "unsure" never tick, and a late answer never changes a box he has touched.

**After an action:** the page reloads data in place and keeps scroll. If the card is gone, focus moves to the next card's heading, or to the section heading when there is none.

House rules apply: 44px targets, AAA contrast, nothing hover-only, absolute action paths, Safari focus via `Modal` and `dialog-opener`.

## Verification

- **Static:** `npm run check` 0/0; `npm run test:dialogs`.
- **`scripts/test-entity-matcher.ts`** (tsx):
  - Gayon→Gaylon, K-Mart/Kmart and F.H.E./FHE are very likely.
  - Janie/Jamie shows up as a match but is never auto-merged. It's a false positive the reviewer has to reject.
  - Mother's/Father's Day is not very likely.
  - 40th/37th birthday and event first-word pairs are skipped; dismissed pairs are skipped.
  - Zero-mention entities don't count toward the 10× rule; empty folds are skipped.
  - Each candidate is placed once, ties are stable, and the span warning is computed.
- **`scripts/test-entity-cleanup.mjs`** (test stack, real app and worker roles, ids including 2 and 10):
  - **Merges:**
    - a multi-merge is audited, refuses alias or stale targets, and rolls back completely when one source is stale;
    - a bulk merge with a dismissed pair inside it is refused, and dismissals carry over to the survivor;
    - human-beats-AI in both orders, then a stubbed extraction that omits the name: the human link survives.
  - **Moves and blocks:**
    - move-day with re-extraction of the same spelling, of another alias spelling, and after the blocked entity is merged: none brings the link back;
    - moving back clears the block;
    - delete is refused while a block exists;
    - two connections with barriers: a move against extraction of the same day, and two moves of the same day (one 409); merge against extraction.
  - **Places:** source-only pin moves; conflicting human pins are refused; a human "no map" beats a machine row.
  - **Mentions:** day 16+ is reachable by cursor; a narrative-only mention is labelled.
  - **Claude check (stubbed):**
    - claims are taken before calling: two simultaneous checks give one paid call;
    - bad JSON, missing or duplicate ids, a wrong verdict or an over-long reason store nothing and release the claim;
    - a changed fingerprint means the old verdict isn't used;
    - a candidate that left the group is refused.
  - **Access:** a viewer is refused on every new route and action.
- **`backend/db/tests/enrichment_invariants.sh`:** the worker can SELECT blocks but can't write them, and has no access to the other two tables; the app has the exact grants.
- **Safari** (safaridriver, test server 5177, about 2,000 seeded entities with planted duplicates):
  - tabs, groups and default ticks;
  - merge through the modal; focus after the card disappears;
  - Alias; Not the same, plus Undo from the list;
  - "Check with Claude" (stubbed) ticks only untouched boxes; "next 20" can be stopped;
  - move-a-day from the cleanup page and from `/admin/entities`;
  - narrow width.
- **Live:** one real check of two planted groups on the test stack.
  - The key comes from Gaylon's shell environment into the dev server's environment, never on a command line and never into the test DB.
  - The model id is verified first.
- **Review and deploy:** CODEX review until clean, then ask before commit and deploy. Migration 0036 runs through `./scripts/deploy-to-DO.sh`. Write a devlog entry, then `td review td-c6e871`.

## Out of scope

- **td-4b8347** (tell the extractor who the family is): stops new duplicates at the source.
- **Undo for merges and moves:** both are confirmed and audited, and a move can be reversed by moving back.

## Implementation notes (2026-11-23)

Where the build differs from the plan above, and why:

- **Span warning:** compares whole years, with a one-year margin (`SPAN_MARGIN_YEARS`), not exact first-to-last dates.
  - The Safari run showed that exact dates flag a typo mentioned a week after the main name's last mention. That stopped very likely matches from being ticked.
  - Becky (1977, against a Rebekah first mentioned in 1985) is still caught.
- **Check fingerprint:** a hash of prompt version, model, both names, both families' day lists, and each family's `rev`.
  - `rev` is an md5 over the family's alias names and every family day's corrected text and note, computed in the same query that loads the day lists.
  - It covers every family day, not just the 4 sampled, so it errs towards asking again. That's still cheap enough to recompute for every suggestion on page load, so a stale answer is never shown or pre-ticked.
  - Earlier builds left text out. CODEX9 (#8) pointed out that correcting the passage that tells two people apart, or adding an alias, left the old "same" cached.
- **Claims:** taken in one short transaction (all or none; no paid call inside), outside the graph lock. The answer is stored under the graph lock, on that transaction's own connection, and only if the fingerprint still matches; otherwise the claim is dropped and the result is "changed".
- **Lock order:** graph lock, then day locks, then entity rows `FOR NO KEY UPDATE`.
  - The worker holds a day lock while its link insert takes a foreign-key share lock on an entity row. Locking rows `FOR UPDATE` before waiting for day locks deadlocked with it (CODEX9 #1).
  - `deleteUnused` locks its row `FOR UPDATE` in a separate statement first, so its DELETE sees a link the extractor was making at that moment (CODEX9 #3).
- **Unused** also excludes a name with a "not the same" mark, since deleting it would cascade the decision away (CODEX9 #5).
- **Merge evidence check:** the cleanup page's merge sends the group's main name and the fingerprint it showed for every other name; the server requires them.
  - `mergeEntities` checks them through its `verify` hook once it holds the graph lock and its day locks, so an extraction it waited for, or another tab, can't change the entries unnoticed. A mismatch is a 409 ("changed since this page loaded") with nothing merged.
  - A pair Claude reports as changed is unticked and locked on the page until a reload.
  - `GET /admin/entities/cleanup/check?mainId=&candidateIds=` returns current fingerprints for scripts and tests.
- **Page state:** this visit's Claude answers and manual ticks are keyed by pair plus fingerprint, so a move, merge or regroup drops them.
  - Choosing a name to keep ticks it.
  - Entry lists mount on first opening and reload whenever the page data does.
- **Model:** `claude-sonnet-5-5`, confirmed through the Models API. It runs at `effort: 'low'` with `max_tokens` 3000, because SDK 0.98 can't express "thinking off".
  - The live check on the test stack answered two groups in about 1 s each.
- **Day locks:** taken in one statement (`count(pg_advisory_xact_lock(...))` over the sorted ids), so a merge into a 1,000-day name is one round trip.
