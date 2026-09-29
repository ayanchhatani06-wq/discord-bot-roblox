-- Procedures, trials, recommendations, temporary leadership and offboarding.

-- Something the studio expects staff to have read. Acknowledgement is bound to
-- a version: editing a procedure raises its version, which makes every earlier
-- acknowledgement stale rather than silently carrying it forward.
CREATE TABLE procedures (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id      TEXT NOT NULL,
  key           TEXT NOT NULL,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  version       INTEGER NOT NULL DEFAULT 1,
  audience      TEXT NOT NULL DEFAULT 'all',
  department_id INTEGER REFERENCES departments(id) ON DELETE CASCADE,
  active        INTEGER NOT NULL DEFAULT 1,
  created_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_by    TEXT NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE (guild_id, key),
  CHECK (audience IN ('all', 'leaders', 'department'))
);

CREATE TABLE procedure_acknowledgements (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id        TEXT NOT NULL,
  procedure_id    INTEGER NOT NULL REFERENCES procedures(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL,
  version         INTEGER NOT NULL,
  acknowledged_at INTEGER NOT NULL,
  UNIQUE (procedure_id, user_id, version)
);

CREATE INDEX idx_procedure_acks_user ON procedure_acknowledgements (guild_id, user_id);

-- A paid trial brief with its terms written down before the work starts.
CREATE TABLE trials (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id            TEXT NOT NULL,
  code                TEXT NOT NULL,
  user_id             TEXT NOT NULL,
  department_id       INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  title               TEXT NOT NULL,
  brief               TEXT NOT NULL,
  terms               TEXT NOT NULL,
  pay_minor           INTEGER,
  pay_currency        TEXT,
  deadline_utc        INTEGER,
  status              TEXT NOT NULL DEFAULT 'offered',
  accepted_at         INTEGER,
  accepted_terms_json TEXT,
  declined_reason     TEXT,
  submitted_at        INTEGER,
  submission_links    TEXT,
  submission_note     TEXT,
  feedback            TEXT,
  decided_by          TEXT,
  decided_at          INTEGER,
  created_by          TEXT NOT NULL,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  UNIQUE (guild_id, code),
  CHECK (status IN ('offered', 'accepted', 'declined', 'submitted', 'passed', 'failed', 'withdrawn'))
);

CREATE INDEX idx_trials_user ON trials (guild_id, user_id);
CREATE INDEX idx_trials_status ON trials (guild_id, status);

-- A leader putting somebody forward. It is a recommendation, never a promotion:
-- who may actually grant a role is decided by the configured permissions.
CREATE TABLE recommendations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id        TEXT NOT NULL,
  subject_user_id TEXT NOT NULL,
  kind            TEXT NOT NULL,
  department_id   INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  note            TEXT NOT NULL,
  recommended_by  TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  decided_by      TEXT,
  decided_at      INTEGER,
  decision_note   TEXT,
  CHECK (kind IN ('trial', 'promotion', 'leader')),
  CHECK (status IN ('pending', 'accepted', 'declined'))
);

CREATE INDEX idx_recommendations_status ON recommendations (guild_id, status);

-- Somebody standing in for a group leader for a stated period.
--
-- The window is checked whenever their permissions are worked out, so the power
-- ends on time even if no scheduled job runs and even if the bot was offline.
CREATE TABLE backup_leaders (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id         TEXT NOT NULL,
  department_id    INTEGER NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  user_id          TEXT NOT NULL,
  responsibilities TEXT NOT NULL,
  starts_at        INTEGER NOT NULL,
  expires_at       INTEGER NOT NULL,
  granted_by       TEXT NOT NULL,
  granted_at       INTEGER NOT NULL,
  revoked_at       INTEGER,
  revoked_by       TEXT,
  CHECK (expires_at > starts_at)
);

CREATE INDEX idx_backup_leaders_lookup ON backup_leaders (guild_id, user_id, expires_at);

-- An offboarding in progress. The record is kept: the point of offboarding is
-- to know what was left behind, which is not knowable once it is deleted.
CREATE TABLE departures (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id        TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  reason          TEXT,
  handover_note   TEXT,
  snapshot_json   TEXT NOT NULL,
  started_by      TEXT NOT NULL,
  started_at      INTEGER NOT NULL,
  completed_by    TEXT,
  completed_at    INTEGER
);

CREATE INDEX idx_departures_user ON departures (guild_id, user_id);
