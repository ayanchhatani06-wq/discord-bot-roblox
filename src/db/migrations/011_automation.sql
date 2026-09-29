-- Owner-configurable automation rules.
--
-- Both the condition and the action come from closed lists in code. A rule is
-- a choice between things the bot already knows how to do safely, never a
-- script: nothing here can be made to move money, change pay, approve work or
-- write words to a client that were not already approved.
CREATE TABLE automation_rules (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id       TEXT NOT NULL,
  key            TEXT NOT NULL,
  label          TEXT NOT NULL,
  trigger_key    TEXT NOT NULL,
  threshold      INTEGER,
  department_id  INTEGER REFERENCES departments(id) ON DELETE CASCADE,
  action_key     TEXT NOT NULL,
  target_user_id TEXT,
  note           TEXT,
  enabled        INTEGER NOT NULL DEFAULT 0,
  last_run_at    INTEGER,
  created_by     TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_by     TEXT NOT NULL,
  updated_at     INTEGER NOT NULL,
  UNIQUE (guild_id, key)
);

-- What a rule has actually done, and to what. The unique key means a rule
-- cannot act twice on the same thing, however often it runs.
CREATE TABLE automation_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id    TEXT NOT NULL,
  rule_id     INTEGER NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  dedupe_key  TEXT NOT NULL,
  detail      TEXT,
  created_at  INTEGER NOT NULL,
  UNIQUE (dedupe_key)
);

CREATE INDEX idx_automation_events_rule ON automation_events (rule_id, created_at);
