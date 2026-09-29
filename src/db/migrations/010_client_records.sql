-- Standing requirements a client has, and repeat orders drafted from old ones.

-- Something this client always wants, recorded once instead of remembered.
-- Optionally scoped to a department, because "always 4K textures" is a note
-- for the modellers and noise for everybody else.
CREATE TABLE client_requirements (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id      TEXT NOT NULL,
  client_id     INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  label         TEXT NOT NULL,
  detail        TEXT NOT NULL,
  department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  created_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_by    TEXT NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX idx_client_requirements ON client_requirements (client_id, active);

-- A repeat order, copied from a previous one but not yet real.
--
-- It is a separate table rather than a project with a "draft" flag so that
-- nothing downstream — queues, boards, the ledger, the client dashboard — can
-- ever see it by accident. It becomes a project only when somebody confirms
-- the three things that actually change between orders.
CREATE TABLE order_drafts (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id              TEXT NOT NULL,
  client_id             INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  source_project_id     INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  name                  TEXT NOT NULL,
  brief                 TEXT,
  reference_links       TEXT,
  items_json            TEXT NOT NULL DEFAULT '[]',
  deadline_utc          INTEGER,
  client_amount_minor   INTEGER,
  client_currency       TEXT,
  scope_confirmed_by    TEXT,
  scope_confirmed_at    INTEGER,
  price_confirmed_by    TEXT,
  price_confirmed_at    INTEGER,
  deadline_confirmed_by TEXT,
  deadline_confirmed_at INTEGER,
  status                TEXT NOT NULL DEFAULT 'draft',
  project_id            INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  created_by            TEXT NOT NULL,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  CHECK (status IN ('draft', 'confirmed', 'discarded'))
);

CREATE INDEX idx_order_drafts_status ON order_drafts (guild_id, status);
