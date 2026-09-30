-- Evidence you actually keep, payment schedules, and payouts that have not
-- landed yet.

-- A screenshot or file kept as proof.
--
-- The bytes are stored by the studio, not linked to. Discord's attachment URLs
-- are signed and expire, and die permanently when the message is deleted, so a
-- stored link is not evidence — it is a promise that Discord will still be
-- holding something for you on the day you need it.
--
-- Files live next to the database so the existing backup takes them with it.
CREATE TABLE evidence (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id     TEXT NOT NULL,
  kind         TEXT NOT NULL,
  project_id   INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  task_id      INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  payment_id   INTEGER REFERENCES payments(id) ON DELETE SET NULL,
  client_id    INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  filename     TEXT NOT NULL,
  stored_path  TEXT NOT NULL,
  content_type TEXT,
  bytes        INTEGER NOT NULL,
  -- The hash is what makes a file provable: it is recorded when the file
  -- arrives, so anybody can check later that the copy is the one that was
  -- filed and has not been swapped.
  sha256       TEXT NOT NULL,
  note         TEXT,
  source_url   TEXT,
  added_by     TEXT NOT NULL,
  added_at     INTEGER NOT NULL,
  -- The same screenshot filed twice is one record, not two.
  UNIQUE (guild_id, sha256),
  CHECK (kind IN ('payment', 'approval', 'dispute', 'issue', 'delivery', 'general'))
);

CREATE INDEX idx_evidence_project ON evidence (guild_id, project_id);
CREATE INDEX idx_evidence_task ON evidence (guild_id, task_id);
CREATE INDEX idx_evidence_payment ON evidence (payment_id);

-- What a client owes, and when.
--
-- A project used to carry one figure and "paid in full" was all or nothing.
-- Half up front and half on delivery is ordinary for commissions, and without
-- this the studio either records a deposit as full payment - breaking the rule
-- that work is only payable once the money arrived - or leaves artists
-- unpayable when it has in fact been funded.
CREATE TABLE payment_milestones (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id      TEXT NOT NULL,
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  label         TEXT NOT NULL,
  amount_minor  INTEGER NOT NULL,
  currency      TEXT NOT NULL,
  due_note      TEXT,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  invoiced_at   INTEGER,
  invoiced_by   TEXT,
  waived_at     INTEGER,
  waived_reason TEXT,
  created_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  CHECK (amount_minor > 0)
);

CREATE INDEX idx_milestones_project ON payment_milestones (project_id, sort_order);

-- A payout can be sent and not arrive.
--
-- Robux goes into the recipient's Pending balance and can sit there for days,
-- or fail eligibility entirely. Recording it as paid the moment it is sent
-- means the ledger says paid while the artist has nothing, and neither side
-- can show what happened.
ALTER TABLE payments ADD COLUMN confirmed_at INTEGER;
ALTER TABLE payments ADD COLUMN confirmed_by TEXT;
ALTER TABLE payments ADD COLUMN failed_at INTEGER;
ALTER TABLE payments ADD COLUMN failure_note TEXT;

-- What a delivered file is on Roblox, so the archive is still useful in a year.
ALTER TABLE assets ADD COLUMN roblox_asset_id TEXT;
