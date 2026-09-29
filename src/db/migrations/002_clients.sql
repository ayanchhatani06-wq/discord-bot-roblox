-- Client identity, the client-facing dashboard, and version-bound approvals.

-- A client is an organisation or person, which may hold several Discord
-- accounts. Kept separate from `projects.client_ref` (a private label) so the
-- same client can be recognised across repeat orders.
CREATE TABLE clients (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id            TEXT NOT NULL,
  display_name        TEXT NOT NULL,
  notes               TEXT,
  finder_user_id      TEXT,
  preferred_contact   TEXT,
  promo_opt_in        INTEGER NOT NULL DEFAULT 0,
  promo_stopped_at    INTEGER,
  created_by          TEXT NOT NULL,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE INDEX idx_clients_guild ON clients (guild_id);

-- Which Discord accounts may act for a client. Approval and dashboard access
-- are checked against this table, never against a role, because a client is
-- not staff.
CREATE TABLE client_accounts (
  client_id   INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL,
  label       TEXT,
  can_approve INTEGER NOT NULL DEFAULT 1,
  added_by    TEXT NOT NULL,
  added_at    INTEGER NOT NULL,
  revoked_at  INTEGER,
  PRIMARY KEY (client_id, user_id)
);

CREATE INDEX idx_client_accounts_user ON client_accounts (user_id);

-- A project belongs to at most one client, and may have its own client-facing
-- channel distinct from the staff-side ticket link.
ALTER TABLE projects ADD COLUMN client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL;
ALTER TABLE projects ADD COLUMN client_channel_id TEXT;
ALTER TABLE projects ADD COLUMN dashboard_message_id TEXT;

CREATE INDEX idx_projects_client ON projects (guild_id, client_id);

-- Delivery is a separate fact from client approval: approved work has not
-- necessarily been handed over yet.
ALTER TABLE tasks ADD COLUMN delivered_at INTEGER;
ALTER TABLE tasks ADD COLUMN delivered_by TEXT;
ALTER TABLE tasks ADD COLUMN delivered_version INTEGER;

-- Which submission version a client was actually shown, so an approval can be
-- bound to it and older buttons can be refused.
ALTER TABLE submissions ADD COLUMN client_visible_at INTEGER;
ALTER TABLE submissions ADD COLUMN client_visible_by TEXT;

-- Every client question and its answer. Questions never change project state,
-- so this is a log rather than a workflow table.
CREATE TABLE client_questions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id        TEXT NOT NULL,
  project_id      INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  client_id       INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  asked_by        TEXT NOT NULL,
  kind            TEXT NOT NULL,
  question        TEXT,
  answer_summary  TEXT,
  answered_at     INTEGER,
  escalated_to    TEXT,
  created_at      INTEGER NOT NULL
);

CREATE INDEX idx_client_questions_project ON client_questions (project_id, created_at);

-- Free-text client requests that a person has to action: change requests,
-- questions for the manager, and requests for more work.
CREATE TABLE client_requests (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id      TEXT NOT NULL,
  project_id    INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  task_id       INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  client_id     INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  raised_by     TEXT NOT NULL,
  kind          TEXT NOT NULL,
  body          TEXT NOT NULL,
  attachments   TEXT,
  status        TEXT NOT NULL DEFAULT 'open',
  assigned_to   TEXT,
  resolution    TEXT,
  resolved_by   TEXT,
  resolved_at   INTEGER,
  created_at    INTEGER NOT NULL,
  CHECK (kind IN ('change_request', 'question', 'new_service', 'contact_manager', 'delivery_issue')),
  CHECK (status IN ('open', 'in_progress', 'resolved', 'declined'))
);

CREATE INDEX idx_client_requests_open ON client_requests (guild_id, status, created_at);
