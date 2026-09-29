-- The website's own tables.
--
-- Kept separate from the bot's so that what the site can see is a deliberate
-- decision rather than "whatever is in the database". Sessions and login
-- tokens are stored hashed: a leaked database should not hand somebody a live
-- login.

CREATE TABLE web_sessions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash   TEXT NOT NULL UNIQUE,
  guild_id     TEXT NOT NULL,
  subject_kind TEXT NOT NULL,
  client_id    INTEGER REFERENCES clients(id) ON DELETE CASCADE,
  user_id      TEXT,
  email        TEXT,
  display_name TEXT,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at   INTEGER,
  CHECK (subject_kind IN ('client', 'staff'))
);

CREATE INDEX idx_web_sessions_expiry ON web_sessions (expires_at);

-- A one-time login link for a client who is not in the Discord server.
--
-- Single use and short-lived: consumed_at is set the first time it is used, so
-- a link forwarded to somebody else is already spent.
CREATE TABLE web_login_tokens (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id     TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  client_id    INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  email        TEXT,
  issued_by    TEXT,
  issued_at    INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  consumed_at  INTEGER,
  consumed_ip  TEXT
);

CREATE INDEX idx_web_login_tokens_client ON web_login_tokens (client_id, expires_at);

-- Email addresses that may act for a client, for clients with no Discord.
-- Mirrors client_accounts: access is granted explicitly, never derived.
CREATE TABLE client_emails (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id    TEXT NOT NULL,
  client_id   INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  label       TEXT,
  can_approve INTEGER NOT NULL DEFAULT 0,
  added_by    TEXT NOT NULL,
  added_at    INTEGER NOT NULL,
  revoked_at  INTEGER,
  UNIQUE (client_id, email)
);

CREATE INDEX idx_client_emails_lookup ON client_emails (guild_id, email);

-- What the public site says about the studio's services. Written by the owner,
-- shown verbatim: nothing about the public site is generated.
CREATE TABLE web_services (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id    TEXT NOT NULL,
  key         TEXT NOT NULL,
  name        TEXT NOT NULL,
  summary     TEXT NOT NULL,
  detail      TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  published   INTEGER NOT NULL DEFAULT 0,
  created_by  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_by  TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE (guild_id, key)
);

-- Free-text blocks for the public pages, e.g. "about".
CREATE TABLE web_pages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id   TEXT NOT NULL,
  key        TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  published  INTEGER NOT NULL DEFAULT 0,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (guild_id, key)
);
