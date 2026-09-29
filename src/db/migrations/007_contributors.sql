-- Several people on one deliverable, and bonus milestones.
--
-- tasks.artist_user_id and artist_pay_minor stay as the single-artist path.
-- Contributor rows are authoritative whenever any exist, and the primary
-- artist is copied into one at that moment, so the two can never both be
-- counted for the same person.

CREATE TABLE task_contributors (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id            TEXT NOT NULL,
  task_id             INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id             TEXT NOT NULL,
  responsibility      TEXT NOT NULL,
  is_primary          INTEGER NOT NULL DEFAULT 0,
  pay_minor           INTEGER,
  pay_currency        TEXT,
  pay_state           TEXT NOT NULL DEFAULT 'unset',
  proposed_minor      INTEGER,
  proposed_currency   TEXT,
  proposed_by         TEXT,
  proposed_at         INTEGER,
  approved_by         TEXT,
  approved_at         INTEGER,
  accepted_at         INTEGER,
  accepted_terms_json TEXT,
  added_by            TEXT NOT NULL,
  added_at            INTEGER NOT NULL,
  removed_at          INTEGER,
  UNIQUE (task_id, user_id),
  CHECK (pay_state IN ('unset', 'proposed', 'approved'))
);

CREATE INDEX idx_contributors_task ON task_contributors (task_id, removed_at);
CREATE INDEX idx_contributors_user ON task_contributors (guild_id, user_id);

-- An owner-set rule such as "every 10 approved animations earns a bonus".
CREATE TABLE bonus_rules (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id       TEXT NOT NULL,
  key            TEXT NOT NULL,
  label          TEXT NOT NULL,
  department_id  INTEGER REFERENCES departments(id) ON DELETE CASCADE,
  threshold      INTEGER NOT NULL,
  amount_minor   INTEGER NOT NULL,
  currency       TEXT NOT NULL,
  active         INTEGER NOT NULL DEFAULT 1,
  created_by     TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  UNIQUE (guild_id, key),
  CHECK (threshold > 0),
  CHECK (amount_minor > 0)
);

-- One row per milestone reached. The unique key is what makes double counting
-- impossible: the tenth approved item can only ever earn milestone 1 once.
CREATE TABLE bonus_awards (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id         TEXT NOT NULL,
  rule_id          INTEGER NOT NULL REFERENCES bonus_rules(id) ON DELETE CASCADE,
  user_id          TEXT NOT NULL,
  milestone_index  INTEGER NOT NULL,
  qualifying_count INTEGER NOT NULL,
  amount_minor     INTEGER NOT NULL,
  currency         TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending',
  approved_by      TEXT,
  approved_at      INTEGER,
  declined_reason  TEXT,
  created_at       INTEGER NOT NULL,
  UNIQUE (rule_id, user_id, milestone_index),
  CHECK (status IN ('pending', 'approved', 'declined', 'paid'))
);

CREATE INDEX idx_bonus_awards_status ON bonus_awards (guild_id, status);

-- Lets the owner override a budget guard deliberately, on the record.
ALTER TABLE projects ADD COLUMN budget_override_by TEXT;
ALTER TABLE projects ADD COLUMN budget_override_reason TEXT;
ALTER TABLE projects ADD COLUMN budget_override_at INTEGER;
