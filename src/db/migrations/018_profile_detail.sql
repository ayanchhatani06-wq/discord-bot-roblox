-- What a staff member's own post about themselves actually contains.
--
-- Taken from how the team already introduces people by hand: a title inside
-- their department ("Interior Builder" within Building), how long they have
-- been doing it, and a handful of pictures of the work. The first two were
-- being written into the specialties field or lost in a channel; the pictures
-- were a Discord post that scrolls away and whose links eventually die.

-- The title inside their department. Distinct from specialties, which is the
-- list of what they are good at: one person is an Interior Builder who is good
-- at lighting, modular kits and set dressing.
ALTER TABLE staff ADD COLUMN sub_role TEXT;

-- Free text, not a number of years. "10+ years", "3 years, 1 of them on Roblox"
-- and "since 2019" are all real answers people give, and forcing an integer
-- turns every one of them into a lie or a blank.
ALTER TABLE staff ADD COLUMN experience TEXT;

-- Portfolio pictures, kept as files rather than links.
--
-- The same reasoning as the evidence store: a Discord attachment URL dies with
-- the message it was posted in, so a portfolio built from them quietly empties
-- itself. These are copied onto the server and travel with the backups.
CREATE TABLE staff_portfolio_images (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id     TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  filename     TEXT NOT NULL,
  stored_path  TEXT NOT NULL,
  content_type TEXT,
  bytes        INTEGER NOT NULL,
  sha256       TEXT NOT NULL,
  caption      TEXT,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  added_by     TEXT NOT NULL,
  added_at     INTEGER NOT NULL,
  -- The same picture added twice is one entry, so a double-tap on a phone
  -- does not produce a portfolio with everything in it twice.
  UNIQUE (guild_id, user_id, sha256)
);

CREATE INDEX idx_staff_portfolio_owner ON staff_portfolio_images (guild_id, user_id, sort_order);
