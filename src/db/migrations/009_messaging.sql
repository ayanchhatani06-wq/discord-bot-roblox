-- Messages the studio sends clients, and the rules that stop the bot becoming
-- a nuisance.

-- Text the owner has approved. Editing the body sends it back to draft, so a
-- message can never go out in wording nobody signed off.
CREATE TABLE message_templates (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id      TEXT NOT NULL,
  key           TEXT NOT NULL,
  label         TEXT NOT NULL,
  kind          TEXT NOT NULL,
  trigger_event TEXT,
  subject       TEXT,
  body          TEXT NOT NULL,
  version       INTEGER NOT NULL DEFAULT 1,
  status        TEXT NOT NULL DEFAULT 'draft',
  approved_by   TEXT,
  approved_at   INTEGER,
  active        INTEGER NOT NULL DEFAULT 1,
  created_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_by    TEXT NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE (guild_id, key),
  CHECK (kind IN ('transactional', 'promotional')),
  CHECK (status IN ('draft', 'approved'))
);

-- Per-client messaging preferences. Promotional consent lives on the clients
-- table already; this holds the rest.
CREATE TABLE client_message_prefs (
  client_id            INTEGER PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
  guild_id             TEXT NOT NULL,
  max_per_week         INTEGER,
  paused_until         INTEGER,
  paused_reason        TEXT,
  follow_up_user_id    TEXT,
  digest_minutes       INTEGER,
  updated_by           TEXT NOT NULL,
  updated_at           INTEGER NOT NULL
);

-- Every message the bot has queued, sent, or failed to send.
--
-- dedupe_key is unique and is what makes re-triggering an event harmless: the
-- second attempt to queue the same message for the same thing is rejected by
-- the database rather than by a check somebody might forget.
CREATE TABLE client_messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id        TEXT NOT NULL,
  client_id       INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  project_id      INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  template_key    TEXT,
  template_version INTEGER,
  kind            TEXT NOT NULL,
  trigger_event   TEXT,
  body            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'queued',
  dedupe_key      TEXT NOT NULL,
  digest_key      TEXT,
  send_after      INTEGER NOT NULL,
  sent_at         INTEGER,
  channel_id      TEXT,
  message_id      TEXT,
  blocked_reason  TEXT,
  failure_reason  TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  queued_by       TEXT,
  created_at      INTEGER NOT NULL,
  UNIQUE (dedupe_key),
  CHECK (kind IN ('transactional', 'promotional')),
  CHECK (status IN ('queued', 'sent', 'failed', 'blocked', 'cancelled'))
);

CREATE INDEX idx_client_messages_queue ON client_messages (guild_id, status, send_after);
CREATE INDEX idx_client_messages_client ON client_messages (client_id, created_at);

-- A client writing back is a conversation, so the automation gets out of the
-- way until a person has dealt with it.
CREATE TABLE client_replies (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id       TEXT NOT NULL,
  client_id      INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  project_id     INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  user_id        TEXT NOT NULL,
  channel_id     TEXT NOT NULL,
  message_id     TEXT NOT NULL,
  excerpt        TEXT NOT NULL,
  received_at    INTEGER NOT NULL,
  handled_by     TEXT,
  handled_at     INTEGER,
  UNIQUE (message_id)
);

CREATE INDEX idx_client_replies_open ON client_replies (guild_id, handled_at);

-- The studio's own name, used in messages to clients and by the public site.
ALTER TABLE guild_config ADD COLUMN studio_name TEXT;
ALTER TABLE guild_config ADD COLUMN studio_tagline TEXT;
