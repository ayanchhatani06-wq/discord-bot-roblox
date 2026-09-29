-- Studio operations bot: initial schema.
-- All timestamps are epoch milliseconds (UTC). All money is integer minor
-- units paired with an explicit currency column; nothing is ever stored as a
-- float and no cross-currency totals are kept anywhere.

CREATE TABLE guild_config (
  guild_id                TEXT PRIMARY KEY,
  owner_user_id           TEXT,
  owner_role_id           TEXT,
  manager_role_id         TEXT,
  staff_board_channel_id  TEXT,
  audit_log_channel_id    TEXT,
  fallback_channel_id     TEXT,
  summary_channel_id      TEXT,
  board_refresh_minutes   INTEGER NOT NULL DEFAULT 10,
  offer_reminder_hours    INTEGER NOT NULL DEFAULT 12,
  stale_progress_days     INTEGER NOT NULL DEFAULT 3,
  deadline_warning_hours  INTEGER NOT NULL DEFAULT 48,
  quiet_start_minute      INTEGER,
  quiet_end_minute        INTEGER,
  default_currency        TEXT NOT NULL DEFAULT 'USD',
  payment_methods_json    TEXT NOT NULL DEFAULT '["PayPal","Bank transfer","Robux group payout","Roblox gift card"]',
  summary_cron            TEXT NOT NULL DEFAULT '0 9 * * 1',
  setup_completed_at      INTEGER,
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL
);

CREATE TABLE departments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id        TEXT NOT NULL,
  key             TEXT NOT NULL,
  name            TEXT NOT NULL,
  leader_role_id  TEXT,
  member_role_id  TEXT,
  checklist_json  TEXT NOT NULL DEFAULT '[]',
  task_cap        INTEGER,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  archived_at     INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE (guild_id, key)
);

-- Explicit role -> capability grants. Owner capabilities are implicit and are
-- never stored here, so removing every row cannot lock the owner out.
CREATE TABLE role_capabilities (
  guild_id    TEXT NOT NULL,
  role_id     TEXT NOT NULL,
  capability  TEXT NOT NULL,
  granted_by  TEXT,
  granted_at  INTEGER NOT NULL,
  PRIMARY KEY (guild_id, role_id, capability)
);

CREATE TABLE staff (
  guild_id                TEXT NOT NULL,
  user_id                 TEXT NOT NULL,
  display_name            TEXT,
  department_id           INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  leader_user_id          TEXT,
  timezone                TEXT,
  specialties             TEXT,
  software                TEXT,
  portfolio_url           TEXT,
  roblox_username         TEXT,
  working_days            TEXT,
  working_start_minute    INTEGER,
  working_end_minute      INTEGER,
  quiet_start_minute      INTEGER,
  quiet_end_minute        INTEGER,
  availability            TEXT NOT NULL DEFAULT 'accepting',
  availability_updated_at INTEGER,
  away_until              INTEGER,
  away_note               TEXT,
  onboarded_at            INTEGER,
  removed_at              INTEGER,
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id),
  CHECK (availability IN ('accepting', 'at_capacity', 'away'))
);

CREATE INDEX idx_staff_department ON staff (guild_id, department_id);

-- Board messages the bot edits in place; keyed so a deleted message can be
-- detected and re-posted without duplicating boards.
CREATE TABLE board_messages (
  guild_id    TEXT NOT NULL,
  board_key   TEXT NOT NULL,
  channel_id  TEXT NOT NULL,
  message_id  TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (guild_id, board_key)
);

CREATE TABLE id_counters (
  guild_id    TEXT NOT NULL,
  kind        TEXT NOT NULL,
  next_value  INTEGER NOT NULL,
  PRIMARY KEY (guild_id, kind)
);

CREATE TABLE projects (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id                TEXT NOT NULL,
  code                    TEXT NOT NULL,
  name                    TEXT NOT NULL,
  client_ref              TEXT,
  brief                   TEXT,
  reference_links         TEXT,
  deadline_utc            INTEGER,
  client_amount_minor     INTEGER,
  client_currency         TEXT,
  manager_user_id         TEXT,
  finder_user_id          TEXT,
  mod_user_id             TEXT,
  ticket_url              TEXT,
  status                  TEXT NOT NULL DEFAULT 'active',
  client_paid_in_full_at  INTEGER,
  created_by              TEXT NOT NULL,
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL,
  UNIQUE (guild_id, code),
  CHECK (status IN ('active', 'delivered', 'cancelled'))
);

CREATE TABLE tasks (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id                 TEXT NOT NULL,
  project_id               INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  code                     TEXT NOT NULL,
  title                    TEXT NOT NULL,
  brief                    TEXT,
  department_id            INTEGER NOT NULL REFERENCES departments(id),
  deliverables_json        TEXT NOT NULL DEFAULT '[]',
  formats                  TEXT,
  reference_links          TEXT,
  tech_requirements        TEXT,
  deadline_utc             INTEGER,
  artist_pay_minor         INTEGER,
  artist_pay_currency      TEXT,
  pay_state                TEXT NOT NULL DEFAULT 'unset',
  pay_proposed_minor       INTEGER,
  pay_proposed_currency    TEXT,
  pay_proposed_by          TEXT,
  pay_proposed_at          INTEGER,
  pay_approved_by          TEXT,
  pay_approved_at          INTEGER,
  client_price_minor       INTEGER,
  client_price_currency    TEXT,
  pool_override_minor      INTEGER,
  pool_override_currency   TEXT,
  revision_rounds          INTEGER,
  revision_notes           TEXT,
  leader_user_id           TEXT,
  artist_user_id           TEXT,
  state                    TEXT NOT NULL DEFAULT 'unassigned',
  payment_state            TEXT NOT NULL DEFAULT 'pending_client_payment',
  payable_override_by      TEXT,
  payable_override_reason  TEXT,
  payable_override_at      INTEGER,
  scope_review_flag        INTEGER NOT NULL DEFAULT 0,
  compensation_review_flag INTEGER NOT NULL DEFAULT 0,
  accepted_at              INTEGER,
  accepted_terms_json      TEXT,
  last_progress_at         INTEGER,
  completed_at             INTEGER,
  cancelled_at             INTEGER,
  cancel_reason            TEXT,
  created_by               TEXT NOT NULL,
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL,
  UNIQUE (guild_id, code),
  CHECK (pay_state IN ('unset', 'proposed', 'approved')),
  CHECK (state IN (
    'unassigned', 'offered', 'in_progress', 'internal_review',
    'awaiting_client', 'client_approved', 'revision_needed', 'on_hold', 'cancelled'
  )),
  CHECK (payment_state IN ('pending_client_payment', 'payable', 'partially_paid', 'paid'))
);

CREATE INDEX idx_tasks_project ON tasks (project_id);
CREATE INDEX idx_tasks_queue ON tasks (guild_id, department_id, state);
CREATE INDEX idx_tasks_artist ON tasks (guild_id, artist_user_id, state);
CREATE INDEX idx_tasks_deadline ON tasks (guild_id, deadline_utc);

CREATE TABLE task_offers (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id          INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  artist_user_id   TEXT NOT NULL,
  offered_by       TEXT NOT NULL,
  offered_at       INTEGER NOT NULL,
  expires_at       INTEGER,
  terms_json       TEXT NOT NULL,
  state            TEXT NOT NULL DEFAULT 'pending',
  responded_at     INTEGER,
  decline_reason   TEXT,
  reminder_sent_at INTEGER,
  escalated_at     INTEGER,
  message_ref      TEXT,
  CHECK (state IN ('pending', 'accepted', 'declined', 'withdrawn', 'expired'))
);

-- At most one live offer per task: the database refuses a second one rather
-- than relying on the UI to prevent double offers.
CREATE UNIQUE INDEX idx_offer_single_pending ON task_offers (task_id) WHERE state = 'pending';
CREATE INDEX idx_offer_artist ON task_offers (artist_user_id, state);

-- Material changes to pay, scope or deadline after acceptance.
CREATE TABLE task_term_changes (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id           INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  field             TEXT NOT NULL,
  old_value         TEXT,
  new_value         TEXT,
  changed_by        TEXT NOT NULL,
  changed_at        INTEGER NOT NULL,
  acknowledged_by   TEXT,
  acknowledged_at   INTEGER
);

CREATE TABLE submissions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id         INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  version         INTEGER NOT NULL,
  kind            TEXT NOT NULL,
  notes           TEXT,
  links_json      TEXT NOT NULL DEFAULT '[]',
  checklist_json  TEXT NOT NULL DEFAULT '[]',
  submitted_by    TEXT NOT NULL,
  submitted_at    INTEGER NOT NULL,
  UNIQUE (task_id, version),
  CHECK (kind IN ('progress', 'final'))
);

CREATE TABLE reviews (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id         INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  submission_id   INTEGER REFERENCES submissions(id) ON DELETE SET NULL,
  reviewer_user_id TEXT NOT NULL,
  decision        TEXT NOT NULL,
  notes           TEXT,
  created_at      INTEGER NOT NULL,
  CHECK (decision IN ('changes_requested', 'ready_for_client'))
);

-- What the client decided, as recorded by an authorised member of staff.
-- Append-only: a later decision adds a row rather than editing history.
CREATE TABLE client_decisions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id         INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  submission_id   INTEGER REFERENCES submissions(id) ON DELETE SET NULL,
  decision        TEXT NOT NULL,
  feedback        TEXT,
  reference_url   TEXT,
  out_of_scope    INTEGER NOT NULL DEFAULT 0,
  recorded_by     TEXT NOT NULL,
  recorded_at     INTEGER NOT NULL,
  CHECK (decision IN ('approved', 'revisions_requested'))
);

-- Both directions of money movement live here, kept apart by `direction` so
-- client receipts are never mixed into staff payout totals.
CREATE TABLE payments (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id         TEXT NOT NULL,
  direction        TEXT NOT NULL,
  project_id       INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  task_id          INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  payee_user_id    TEXT,
  allocation_kind  TEXT,
  amount_minor     INTEGER NOT NULL,
  currency         TEXT NOT NULL,
  method_label     TEXT,
  reference        TEXT,
  note             TEXT,
  recorded_by      TEXT NOT NULL,
  recorded_at      INTEGER NOT NULL,
  idempotency_key  TEXT NOT NULL,
  UNIQUE (idempotency_key),
  CHECK (direction IN ('client_receipt', 'payout')),
  CHECK (amount_minor > 0)
);

CREATE INDEX idx_payments_task ON payments (task_id, direction);
CREATE INDEX idx_payments_payee ON payments (guild_id, payee_user_id, direction);

-- Computed split of a task's leftover pool. Recomputed only while unpaid;
-- once a line is paid it is frozen so history cannot be rewritten.
CREATE TABLE allocations (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id           INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  recipient_kind    TEXT NOT NULL,
  recipient_user_id TEXT,
  percent_bp        INTEGER NOT NULL,
  amount_minor      INTEGER NOT NULL,
  currency          TEXT NOT NULL,
  pool_minor        INTEGER NOT NULL,
  pool_source       TEXT NOT NULL,
  frozen_at         INTEGER,
  computed_at       INTEGER NOT NULL,
  UNIQUE (task_id, recipient_kind),
  CHECK (recipient_kind IN ('finder', 'leader', 'mod', 'owner')),
  CHECK (pool_source IN ('derived', 'explicit_task_price', 'owner_override'))
);

CREATE TABLE allocation_config (
  guild_id        TEXT NOT NULL,
  recipient_kind  TEXT NOT NULL,
  percent_bp      INTEGER NOT NULL,
  updated_by      TEXT,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (guild_id, recipient_kind),
  CHECK (recipient_kind IN ('finder', 'leader', 'mod', 'owner'))
);

-- Remembers what has already been chased so restarts do not re-send a
-- reminder and quiet hours can defer rather than drop a notification.
CREATE TABLE reminder_state (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id     TEXT NOT NULL,
  kind         TEXT NOT NULL,
  entity_type  TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  last_sent_at INTEGER,
  deferred_to  INTEGER,
  send_count   INTEGER NOT NULL DEFAULT 0,
  UNIQUE (guild_id, kind, entity_type, entity_id)
);

CREATE TABLE audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id      TEXT NOT NULL,
  actor_user_id TEXT,
  action        TEXT NOT NULL,
  entity_type   TEXT NOT NULL,
  entity_id     TEXT,
  before_json   TEXT,
  after_json    TEXT,
  detail        TEXT,
  created_at    INTEGER NOT NULL
);

CREATE INDEX idx_audit_entity ON audit_log (guild_id, entity_type, entity_id);
CREATE INDEX idx_audit_created ON audit_log (guild_id, created_at);

-- Guards against a repeated button click producing two identical actions.
CREATE TABLE interaction_guards (
  guard_key   TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL
);
