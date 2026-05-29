# V4 Addendum A — Three-Stage OCR Pipeline & Correction Feedback Loop

> Referenced from `calendar-history-system-V4.md` §§ 5, 9.2, 9.3, 9.6. This addendum supersedes the local-VLM OCR strategy in V4 § 9.2 based on hands-on vendor evaluation (May 2026).

## A.1 OCR Vendor Evaluation Results

Five grid-line-detected cell crops from 1991-03.jpg tested against human gold transcriptions:

| Vendor | Speed | Cost | Accuracy on family handwriting | Verdict |
|--------|-------|------|-------------------------------|---------|
| Google Cloud Vision (`DOCUMENT_TEXT_DETECTION`) | ~200ms/cell | Free (1,000/month) | Gets structure right, garbles proper nouns and uncommon words (61–69% word confidence) | **Primary OCR vendor** |
| Claude Vision (Sonnet) | ~2–3s/cell | API tokens | Similar raw accuracy, slightly more coherent phrases | Stage 2 cleanup role, not primary OCR |
| Transkribus | N/A | Organisation plan only | English Eagle model: gibberish on modern casual handwriting; API locked behind enterprise paywall | Dead end |

**Decision:** Google Vision is the primary OCR vendor. Claude serves as the LLM cleanup stage, not a competing OCR pass. The local-VLM-via-Ollama strategy in V4 § 9.2 is superseded — Google Vision is faster, free at this volume, and produces comparable results without local GPU concerns.

## A.2 Three-Stage Pipeline

```
Image (day-cell crop)
  │
  ▼
Stage 1: Google Vision  (DOCUMENT_TEXT_DETECTION)
  → raw_text into ocr_runs
  │
  ▼
Stage 2: Claude LLM Cleanup  (raw text + correction_lexicon + notation_key + calendar context)
  → draft_text into llm_draft_runs
  │
  ▼
Stage 3: Human Correction  (Madonna's five-field editor)
  → corrected_text, expanded_text, day_narrative
  │
  ╰──→ accepted corrections feed correction_lexicon (automatic diff on accept)
```

### Stage 1 — Google Vision

- Vendor adapter: `src/lib/ocr/vendors/google-vision.ts`
- `DOCUMENT_TEXT_DETECTION` feature (optimized for handwriting)
- API key auth, synchronous REST, ~200ms per cell
- Free tier: 1,000 requests/month — process in monthly batches
- Word-level confidence scores available in response
- Config: `GOOGLE_VISION_API_KEY` in `.env` (dev) or `private_data.api_credentials` (prod)

### Stage 2 — Claude LLM Cleanup

The cleanup prompt includes:

1. The raw Google Vision text
2. The **correction lexicon** — family-specific substitution table sorted by frequency (see § A.3)
3. The **notation key** — symbol glossary (see § A.5)
4. Calendar context — month, year, day of week
5. Surrounding-day context — already-corrected entries from adjacent days when available

The LLM excels here because it doesn't have to guess: "when OCR says 'Googlen', the family lexicon says that's 'Gaylon'" is a trivial fix for a language model. Common English words it already handles; the lexicon fills in the family-specific vocabulary that OCR garbles worst.

### Stage 3 — Human Correction (five-field editor)

| # | Field | Purpose | Writer |
|---|-------|---------|--------|
| 1 | Image | Day-cell crop | System (read-only) |
| 2 | Machine draft | Latest OCR + LLM cleanup | System (read-only) |
| 3 | `corrected_text` | Faithful transcription — what's literally written, symbols and all | Madonna |
| 4 | `expanded_text` | Decoded version — symbols → full words, abbreviations → spelled out | Madonna |
| 5 | `day_narrative` | Memories, stories, context triggered by the entry — new content not on the page | Madonna |

**Field 3** is archival: preserve exactly what the page says, including personal notation (Ⓡ, *, standalone numbers). The correction lexicon maps OCR garbles to these faithful representations, not to interpretations.

**Field 4** is the interpretation layer: makes the entry searchable and feeds entity extraction. "Ⓡ ballet; *; 125" becomes "Rebekah ballet; [intimate]; weight 125 lbs."

**Field 5** is the narrative layer: the real family history gold. "This was the week after chemo started" or "Caleb was so nervous about that play." Feeds the book view, person profiles, decade summaries.

## A.3 Correction Lexicon

A family-specific substitution table that accumulates automatically as Madonna corrects entries. Fed to the Stage 2 LLM cleanup prompt.

### Table

```sql
CREATE TABLE correction_lexicon (
  id              SERIAL PRIMARY KEY,
  ocr_token       TEXT NOT NULL,
  corrected_token TEXT NOT NULL,
  frequency       INT NOT NULL DEFAULT 1,
  first_seen      DATE NOT NULL,
  last_seen       DATE NOT NULL,
  UNIQUE (ocr_token, corrected_token)
);

CREATE INDEX idx_correction_lexicon_freq ON correction_lexicon(frequency DESC);
```

### Population

On each accepted `day_corrections` insert (i.e., `status_after = 'accepted'`), a function:

1. Retrieves `ocr_runs.raw_text` for the same `day_id` (via `calendar_days.latest_ocr_run_id`)
2. Tokenizes both texts (split on whitespace and punctuation, preserving notation symbols)
3. Aligns tokens using edit-distance alignment
4. For each substitution where `ocr_token ≠ corrected_token`:

```sql
INSERT INTO correction_lexicon (ocr_token, corrected_token, first_seen, last_seen)
VALUES ($1, $2, $3, $3)
ON CONFLICT (ocr_token, corrected_token)
DO UPDATE SET frequency = correction_lexicon.frequency + 1,
             last_seen = EXCLUDED.last_seen;
```

### Learning curve

| Corrections completed | Lexicon state |
|-----------------------|---------------|
| 0 | Empty — LLM cleanup works with raw OCR only |
| ~30 | Covers all family member names, common activities (ballet, scouts, FHE) |
| ~100 | Saturated on recurring vocabulary; LLM fixes 80%+ of proper nouns |
| Ongoing | New vocabulary (friends, locations, life events) added as encountered |

The family calendar is ideal for this — the same ~20 names and ~30 activities repeat across 60 years. A small correction sample covers the long tail fast.

## A.4 New Fields on `calendar_days`

```sql
-- Decoded/expanded version of corrected_text.
-- Symbols → full words, abbreviations → spelled out.
-- e.g., "Ⓡ ballet; *; 125" → "Rebekah ballet; [intimate]; weight 125 lbs"
expanded_text TEXT,

-- Madonna's personal memories, stories, context.
-- New narrative content, not a decoding of the page.
day_narrative TEXT,
```

**Write model:** Unlike `corrected_text`, these fields do not need the trigger-protected write path — no machine process writes to them. The app role can UPDATE them directly. Append-only history can be added later if edit tracking becomes important.

**Search:** Both fields feed the FTS index. The generated `fts` column becomes:

```sql
fts tsvector GENERATED ALWAYS AS (
  to_tsvector('english',
    coalesce(corrected_text, '') || ' ' ||
    coalesce(expanded_text, '') || ' ' ||
    coalesce(day_narrative, '') || ' ' ||
    coalesce(ai_summary, '') || ' ' ||
    coalesce(search_aux_text, '')
  )
) STORED
```

## A.5 Notation Key

Madonna's calendars use a personal shorthand system. Known symbols:

| Input shorthand | Canonical form | Meaning | Category |
|-----------------|---------------|---------|----------|
| `(R)` | Ⓡ | Rebekah | person |
| `*` | * | intimate | private |
| Standalone 3-digit number (e.g., 125) | 125 | Daily weight in lbs | health |

### Table (ships in Phase 1)

```sql
CREATE TABLE notation_key (
  id              SERIAL PRIMARY KEY,
  input_shorthand TEXT UNIQUE NOT NULL,    -- what Madonna types: "(R)", "*"
  canonical_form  TEXT NOT NULL,           -- stored in corrected_text: "Ⓡ", "*"
  meaning         TEXT NOT NULL,           -- used in expanded_text: "Rebekah", "intimate"
  category        TEXT,                    -- person, private, health, etc.
  created_by      INT REFERENCES users(id),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
```

The correction UI reads `notation_key` and auto-expands shorthands as Madonna types — she types `(R)` and the field stores `Ⓡ`. No one needs to know Unicode codepoints. The LLM cleanup prompt also reads this table to decode notation in Stage 2. The expanded_text field uses the `meaning` column to produce the decoded version.

**No hardcoding.** The notation key is a table from day one. New symbols are added through the admin UI as they're discovered in the calendars. The LLM prompt reads the table at runtime; if Madonna and Gaylon find a new symbol in 1974 that wasn't in 1991, they add it and all future (and re-run) processing picks it up automatically.

## A.6 API Billing (Production)

Production workers on the DO droplet make programmatic API calls — separate billing from any interactive subscription:

| Service | Billing model | Cost for ~22,000 calendar days |
|---------|--------------|-------------------------------|
| Google Vision (Stage 1) | 1,000 free/month, then $1.50/1,000 | Free if batched over 22 months; ~$33 if processed all at once |
| Anthropic API (Stage 2) | Per token | ~$5–15 total at Sonnet pricing (~600 tokens/call) |
| Claude Max subscription | Interactive use only (claude.ai, Claude Code CLI) | Not usable by production workers |

## A.7 Phase Alignment

| Addendum component | Ships in |
|--------------------|----------|
| Google Vision adapter + `correction_lexicon` table | Phase 1 |
| `corrected_text` (field 3) in correction UI | Phase 1 |
| `expanded_text` (field 4) + `day_narrative` (field 5) in correction UI | Phase 1 (fields exist from DDL; UI controls can be minimal initially) |
| LLM cleanup with lexicon-augmented prompt (Stage 2) | Phase 3 (per V4 § 11) |
| `notation_key` table + admin UI | Phase 1 |
| Lexicon-driven re-processing of previously cleaned entries | Phase 3 |
