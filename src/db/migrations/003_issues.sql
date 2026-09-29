-- Delivery issues raised by clients, and the private route for staff to raise
-- concerns about their own assignments or pay.

-- How a reported issue was judged. Kept apart from `status` because "resolved"
-- says the matter is closed, while `decision` says what it was found to be.
ALTER TABLE client_requests ADD COLUMN decision TEXT;
ALTER TABLE client_requests ADD COLUMN decided_by TEXT;
ALTER TABLE client_requests ADD COLUMN decided_at INTEGER;
ALTER TABLE client_requests ADD COLUMN charge_approved_by TEXT;
ALTER TABLE client_requests ADD COLUMN follow_up_task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL;

-- Staff raising a concern about an assignment or about being paid.
--
-- Deliberately not routed through the group leader: a concern about a leader
-- must not land in that leader's inbox, so these go to the owner.
CREATE TABLE staff_escalations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id      TEXT NOT NULL,
  raised_by     TEXT NOT NULL,
  category      TEXT NOT NULL,
  subject       TEXT NOT NULL,
  body          TEXT NOT NULL,
  task_id       INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  about_user_id TEXT,
  status        TEXT NOT NULL DEFAULT 'open',
  acknowledged_at INTEGER,
  acknowledged_by TEXT,
  resolution    TEXT,
  resolved_by   TEXT,
  resolved_at   INTEGER,
  created_at    INTEGER NOT NULL,
  CHECK (category IN ('assignment', 'payment', 'workload', 'conduct', 'other')),
  CHECK (status IN ('open', 'acknowledged', 'resolved', 'closed'))
);

CREATE INDEX idx_escalations_open ON staff_escalations (guild_id, status, created_at);
CREATE INDEX idx_escalations_raiser ON staff_escalations (guild_id, raised_by);
