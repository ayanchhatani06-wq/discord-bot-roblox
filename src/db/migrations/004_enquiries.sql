-- Enquiries and quotes.
--
-- An enquiry can arrive from Discord or, later, from the studio website, so it
-- records its source and can carry a contact that is not a Discord account.

CREATE TABLE enquiries (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id            TEXT NOT NULL,
  code                TEXT NOT NULL,
  client_id           INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  raised_by           TEXT,
  contact_ref         TEXT,
  source              TEXT NOT NULL DEFAULT 'discord',
  service_request     TEXT NOT NULL,
  parsed_json         TEXT,
  references_text     TEXT,
  formats_text        TEXT,
  desired_deadline_utc INTEGER,
  deadline_text       TEXT,
  budget_text         TEXT,
  notes               TEXT,
  status              TEXT NOT NULL DEFAULT 'new',
  assigned_leader     TEXT,
  project_id          INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  closed_reason       TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  UNIQUE (guild_id, code),
  CHECK (source IN ('discord', 'web', 'staff')),
  CHECK (status IN ('new', 'needs_info', 'quote_prepared', 'quote_sent', 'accepted', 'declined', 'closed'))
);

CREATE INDEX idx_enquiries_status ON enquiries (guild_id, status, created_at);

-- Reusable pricing starting points. A template never sets a price by itself:
-- it only pre-fills a draft that the owner has to approve.
CREATE TABLE quote_templates (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id             TEXT NOT NULL,
  key                  TEXT NOT NULL,
  label                TEXT NOT NULL,
  department_id        INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  unit_amount_minor    INTEGER,
  currency             TEXT,
  turnaround_days      INTEGER,
  deliverables_json    TEXT NOT NULL DEFAULT '[]',
  revision_rounds      INTEGER,
  notes                TEXT,
  created_by           TEXT NOT NULL,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  UNIQUE (guild_id, key)
);

-- Quotes are versioned: a revised price is a new version, so what was offered
-- and when stays on the record.
CREATE TABLE quotes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id        TEXT NOT NULL,
  enquiry_id      INTEGER NOT NULL REFERENCES enquiries(id) ON DELETE CASCADE,
  version         INTEGER NOT NULL,
  lines_json      TEXT NOT NULL DEFAULT '[]',
  total_minor     INTEGER NOT NULL,
  currency        TEXT NOT NULL,
  turnaround_days INTEGER,
  delivery_note   TEXT,
  terms           TEXT,
  status          TEXT NOT NULL DEFAULT 'draft',
  prepared_by     TEXT NOT NULL,
  prepared_at     INTEGER NOT NULL,
  approved_by     TEXT,
  approved_at     INTEGER,
  sent_by         TEXT,
  sent_at         INTEGER,
  responded_at    INTEGER,
  decline_reason  TEXT,
  UNIQUE (enquiry_id, version),
  CHECK (status IN ('draft', 'approved', 'sent', 'accepted', 'declined', 'superseded')),
  CHECK (total_minor >= 0)
);

CREATE INDEX idx_quotes_enquiry ON quotes (enquiry_id, version);
