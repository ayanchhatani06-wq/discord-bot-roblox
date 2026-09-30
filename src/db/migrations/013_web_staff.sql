-- Staff sign-in for the website's read-only staff area.
--
-- A login token belonged to a client and nothing else. Staff need one too, and
-- a staff token has no client, so client_id has to stop being required.
--
-- The table is recreated rather than altered because SQLite cannot drop a NOT
-- NULL constraint in place. Nothing is lost: a login token lives 30 minutes,
-- and any in flight during an upgrade are ones somebody can simply ask for
-- again. Sessions, which people would notice losing, are untouched.

DROP TABLE web_login_tokens;

CREATE TABLE web_login_tokens (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id      TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  -- Exactly one of these is set. A client's link can never open the staff
  -- area, and a staff link can never open somebody's orders, because the two
  -- routes read different columns.
  client_id     INTEGER REFERENCES clients(id) ON DELETE CASCADE,
  staff_user_id TEXT,
  email         TEXT,
  issued_by     TEXT,
  issued_at     INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  consumed_at   INTEGER,
  consumed_ip   TEXT,
  CHECK ((client_id IS NOT NULL) <> (staff_user_id IS NOT NULL))
);

CREATE INDEX idx_web_login_tokens_client ON web_login_tokens (client_id, expires_at);
CREATE INDEX idx_web_login_tokens_staff ON web_login_tokens (staff_user_id, expires_at);
