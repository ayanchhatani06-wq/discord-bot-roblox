-- Files, delivery authorization, the archive, and portfolio rights.

-- Working files the client never sees, kept apart from the deliverables.
ALTER TABLE submissions ADD COLUMN internal_links_json TEXT NOT NULL DEFAULT '[]';

-- Portfolio permission usually belongs to the whole job, so it is recorded on
-- the project and may be overridden per asset.
ALTER TABLE projects ADD COLUMN portfolio_staff_allowed INTEGER;
ALTER TABLE projects ADD COLUMN portfolio_studio_allowed INTEGER;
ALTER TABLE projects ADD COLUMN portfolio_from_utc INTEGER;
ALTER TABLE projects ADD COLUMN portfolio_restrictions TEXT;
ALTER TABLE projects ADD COLUMN portfolio_set_by TEXT;
ALTER TABLE projects ADD COLUMN portfolio_set_at INTEGER;

-- What must be true before work may be released to a client. Configurable,
-- because studios differ on whether payment comes before or after delivery.
ALTER TABLE guild_config ADD COLUMN delivery_conditions_json TEXT NOT NULL
  DEFAULT '{"require_client_approval":true,"require_client_paid":false,"require_checklist_complete":true}';

ALTER TABLE tasks ADD COLUMN delivery_note TEXT;

-- One row per file. Assets are derived from submissions, so the archive
-- reflects what was actually produced rather than a separate list somebody has
-- to maintain by hand.
CREATE TABLE assets (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id            TEXT NOT NULL,
  project_id          INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  task_id             INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  submission_id       INTEGER REFERENCES submissions(id) ON DELETE CASCADE,
  version             INTEGER,
  label               TEXT,
  url                 TEXT NOT NULL,
  kind                TEXT NOT NULL,
  asset_type          TEXT,
  created_by          TEXT NOT NULL,
  created_at          INTEGER NOT NULL,
  client_released_at  INTEGER,
  delivered_at        INTEGER,
  -- NULL means "follow the project"; 0 or 1 is an explicit override.
  portfolio_staff_allowed   INTEGER,
  portfolio_studio_allowed  INTEGER,
  portfolio_from_utc        INTEGER,
  portfolio_restrictions    TEXT,
  rights_set_by             TEXT,
  rights_set_at             INTEGER,
  CHECK (kind IN ('deliverable', 'source', 'preview'))
);

CREATE INDEX idx_assets_project ON assets (guild_id, project_id);
CREATE INDEX idx_assets_task ON assets (task_id, kind);
CREATE INDEX idx_assets_type ON assets (guild_id, asset_type);
