-- Task templates, dependencies between tasks, blockers, and deadline changes.

CREATE TABLE task_templates (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id           TEXT NOT NULL,
  key                TEXT NOT NULL,
  label              TEXT NOT NULL,
  department_id      INTEGER REFERENCES departments(id) ON DELETE CASCADE,
  title_pattern      TEXT,
  brief              TEXT,
  deliverables_json  TEXT NOT NULL DEFAULT '[]',
  formats            TEXT,
  tech_requirements  TEXT,
  revision_rounds    INTEGER,
  default_days       INTEGER,
  created_by         TEXT NOT NULL,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  UNIQUE (guild_id, key)
);

-- "This model must exist before the rig can start."
--
-- A dependency never blocks the database from doing anything; it drives
-- notifications and warnings, so a leader can still act against it if they
-- judge that right.
CREATE TABLE task_dependencies (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id            TEXT NOT NULL,
  task_id             INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_task_id  INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  note                TEXT,
  notified_at         INTEGER,
  created_by          TEXT NOT NULL,
  created_at          INTEGER NOT NULL,
  UNIQUE (task_id, depends_on_task_id),
  CHECK (task_id != depends_on_task_id)
);

CREATE INDEX idx_dependencies_upstream ON task_dependencies (depends_on_task_id);

-- An artist saying "I cannot continue, and here is why".
CREATE TABLE task_blockers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id      TEXT NOT NULL,
  task_id       INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  raised_by     TEXT NOT NULL,
  reason        TEXT NOT NULL,
  attachment    TEXT,
  status        TEXT NOT NULL DEFAULT 'open',
  resolution    TEXT,
  cleared_by    TEXT,
  cleared_at    INTEGER,
  created_at    INTEGER NOT NULL,
  CHECK (status IN ('open', 'cleared'))
);

CREATE INDEX idx_blockers_open ON task_blockers (guild_id, status, created_at);
CREATE INDEX idx_blockers_task ON task_blockers (task_id, status);

-- A deadline change is a request with a decision, not an edit. The previous
-- date is kept on the request so what was originally agreed stays visible.
CREATE TABLE deadline_requests (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id          TEXT NOT NULL,
  task_id           INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  requested_by      TEXT NOT NULL,
  previous_deadline INTEGER,
  requested_deadline INTEGER NOT NULL,
  reason            TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending',
  decided_by        TEXT,
  decided_at        INTEGER,
  decision_note     TEXT,
  created_at        INTEGER NOT NULL,
  CHECK (status IN ('pending', 'approved', 'declined'))
);

CREATE INDEX idx_deadline_requests_open ON deadline_requests (guild_id, status, created_at);
