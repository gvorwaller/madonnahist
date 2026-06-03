-- Migration 0012: Correction UI tables, vocabulary seed, user seed, FTS rebuild.

-- 1. notation_key — shorthand → canonical → meaning
CREATE TABLE notation_key (
  id              SERIAL PRIMARY KEY,
  input_shorthand TEXT UNIQUE NOT NULL,
  canonical_form  TEXT NOT NULL,
  meaning         TEXT NOT NULL,
  category        TEXT,
  created_by      INT REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO notation_key (input_shorthand, canonical_form, meaning, category) VALUES
  ('(R)', 'Ⓡ', 'Rebekah', 'person'),
  ('(G)', 'Ⓖ', 'Gaylon', 'person'),
  ('*', '*', 'intimate', 'private');

-- 2. correction_lexicon — OCR garble → corrected word, auto-populated
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

-- 3. ocr_vocabulary — family names, activities, places for OCR prompt
CREATE TABLE ocr_vocabulary (
  id            SERIAL PRIMARY KEY,
  term          TEXT NOT NULL,
  category      TEXT NOT NULL CHECK (category IN ('person', 'activity', 'place', 'term')),
  context_note  TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO ocr_vocabulary (term, category, context_note) VALUES
  ('Rebekah',    'person',   'often abbreviated Ⓡ or (R)'),
  ('Gaylon',     'person',   'often abbreviated Ⓖ or (G)'),
  ('Dagny',      'person',   NULL),
  ('Sophia',     'person',   NULL),
  ('Benjamin',   'person',   NULL),
  ('Caleb',      'person',   NULL),
  ('Sather',     'person',   NULL),
  ('Carmen',     'person',   NULL),
  ('Rob',        'person',   NULL),
  ('Lisa',       'person',   NULL),
  ('Bruce',      'person',   NULL),
  ('Clark',      'person',   NULL),
  ('Brailyn',    'person',   NULL),
  ('Millie',     'person',   NULL),
  ('NordicTrack','activity', 'exercise machine, often written as Nordac Track'),
  ('Seminary',   'activity', NULL),
  ('CFM',        'activity', 'Come Follow Me'),
  ('Study',      'activity', NULL),
  ('Walk',       'activity', NULL),
  ('Weights',    'activity', NULL),
  ('Zoom',       'activity', NULL),
  ('FHE',        'activity', 'Family Home Evening'),
  ('Washoe Canyon', 'place', NULL),
  ('Ikea',       'place',    NULL),
  ('call mom',   'term',     NULL),
  ('visit',      'term',     NULL),
  ('drive',      'term',     NULL),
  ('laundry',    'term',     NULL),
  ('vacuum',     'term',     NULL),
  ('change sheets', 'term',  NULL);

-- 4. New columns on calendar_days
ALTER TABLE calendar_days ADD COLUMN expanded_text TEXT;
ALTER TABLE calendar_days ADD COLUMN day_narrative TEXT;

-- 5. Rebuild FTS generated column to include new fields
DROP INDEX IF EXISTS idx_calendar_days_fts;
ALTER TABLE calendar_days DROP COLUMN fts;
ALTER TABLE calendar_days ADD COLUMN fts tsvector GENERATED ALWAYS AS (
  to_tsvector('english',
    coalesce(corrected_text, '') || ' ' ||
    coalesce(expanded_text, '') || ' ' ||
    coalesce(day_narrative, '') || ' ' ||
    coalesce(ai_summary, '') || ' ' ||
    coalesce(search_aux_text, '')
  )
) STORED;
CREATE INDEX idx_calendar_days_fts ON calendar_days USING gin(fts);

-- 6. Grants
GRANT SELECT ON notation_key, correction_lexicon, ocr_vocabulary TO madonnahist_app, madonnahist_worker;
GRANT INSERT, UPDATE, DELETE ON notation_key, ocr_vocabulary TO madonnahist_app;
GRANT INSERT, UPDATE ON correction_lexicon TO madonnahist_app;
GRANT USAGE, SELECT, UPDATE ON SEQUENCE notation_key_id_seq, correction_lexicon_id_seq, ocr_vocabulary_id_seq TO madonnahist_app;

GRANT UPDATE (expanded_text, day_narrative) ON calendar_days TO madonnahist_app;

-- 7. Seed Madonna user (placeholder password — real auth in td-510a34)
INSERT INTO users (username, display_name, role, password_hash)
VALUES ('madonna', 'Madonna', 'corrector', '$argon2id$v=19$m=65536,t=3,p=4$placeholder$not_yet_implemented')
ON CONFLICT (username) DO NOTHING;
