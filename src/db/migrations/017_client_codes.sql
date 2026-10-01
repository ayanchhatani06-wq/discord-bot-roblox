-- Weekly access codes for clients who sign in to the website.
--
-- A one-time link is the safest thing to hand somebody, but it is a poor fit
-- for a client who checks progress every day for a week: they end up asking for
-- a new link each time, and the studio ends up posting links in places links
-- should not be posted. A code that lasts the week is the compromise. It is
-- still bounded, still revocable, and still tied to an email address, so a code
-- found on its own is not enough to read a client's prices.
--
-- Codes are stored hashed, for the same reason session tokens are: a copy of
-- this database must not hand over live access to anybody who reads it. That
-- means a code cannot be read back after it is issued, only replaced — which is
-- also why `display_hint` exists.

CREATE TABLE client_access_codes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id     TEXT NOT NULL,
  client_id    INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  code_hash    TEXT NOT NULL UNIQUE,
  -- The last four characters only, so a list can tell two codes apart without
  -- storing anything that would let somebody sign in with it.
  display_hint TEXT NOT NULL,
  -- Null when the weekly rotation minted it rather than a person.
  issued_by    TEXT,
  issued_at    INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  revoked_at   INTEGER,
  revoked_by   TEXT,
  last_used_at INTEGER,
  use_count    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_client_access_codes_client ON client_access_codes (client_id, expires_at);
CREATE INDEX idx_client_access_codes_guild ON client_access_codes (guild_id, expires_at);

-- Whether the code alone signs somebody in, or the code and a known email
-- together. On by default: the safer reading of "whichever".
ALTER TABLE guild_config ADD COLUMN client_code_require_email INTEGER NOT NULL DEFAULT 1;

-- Whether the bot mints a fresh week of codes on its own.
ALTER TABLE guild_config ADD COLUMN client_code_rotate_weekly INTEGER NOT NULL DEFAULT 1;

-- How long an issued code lives. Seven days is the studio's choice, not a
-- constant, because a studio that works in fortnights will want fourteen.
ALTER TABLE guild_config ADD COLUMN client_code_days INTEGER NOT NULL DEFAULT 7;
