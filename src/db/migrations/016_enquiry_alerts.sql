-- A quote request from the website used to notify nobody.
--
-- It was recorded correctly and then sat there: you would only find it by
-- running /quotes list. A request that arrives at 2am and is read on Thursday
-- is usually a lost client, and the studio would never know it had one.
--
-- The website runs as its own process with no Discord connection, so it cannot
-- post the alert itself. It writes the row; the bot notices and announces it.
-- This column is how the bot knows which ones it has already announced — a fact
-- in the database rather than something held in memory, so a restart does not
-- re-announce a week of enquiries or silently skip them.
ALTER TABLE enquiries ADD COLUMN announced_at INTEGER;
ALTER TABLE enquiries ADD COLUMN announced_message_id TEXT;

CREATE INDEX idx_enquiries_unannounced ON enquiries (guild_id, announced_at);

-- Where to announce them. Null means nowhere, and the bot says so in the doctor
-- rather than quietly dropping them.
ALTER TABLE guild_config ADD COLUMN enquiry_channel_id TEXT;
