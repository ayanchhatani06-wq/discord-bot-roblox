const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'timezones.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS user_timezones (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    timezone TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS guild_settings (
    guild_id TEXT PRIMARY KEY,
    channel_id TEXT,
    message_id TEXT
  );
`);

const statements = {
  upsertTimezone: db.prepare(`
    INSERT INTO user_timezones (guild_id, user_id, timezone, updated_at)
    VALUES (@guildId, @userId, @timezone, @updatedAt)
    ON CONFLICT(guild_id, user_id) DO UPDATE SET
      timezone = excluded.timezone,
      updated_at = excluded.updated_at
  `),
  deleteTimezone: db.prepare(`
    DELETE FROM user_timezones WHERE guild_id = ? AND user_id = ?
  `),
  getTimezone: db.prepare(`
    SELECT timezone FROM user_timezones WHERE guild_id = ? AND user_id = ?
  `),
  getGuildTimezones: db.prepare(`
    SELECT user_id AS userId, timezone FROM user_timezones WHERE guild_id = ?
    ORDER BY updated_at ASC
  `),
  upsertGuildChannel: db.prepare(`
    INSERT INTO guild_settings (guild_id, channel_id, message_id)
    VALUES (@guildId, @channelId, NULL)
    ON CONFLICT(guild_id) DO UPDATE SET
      channel_id = excluded.channel_id,
      message_id = NULL
  `),
  setGuildMessageId: db.prepare(`
    UPDATE guild_settings SET message_id = ? WHERE guild_id = ?
  `),
  getGuildSettings: db.prepare(`
    SELECT guild_id AS guildId, channel_id AS channelId, message_id AS messageId
    FROM guild_settings WHERE guild_id = ?
  `),
  getAllGuildSettings: db.prepare(`
    SELECT guild_id AS guildId, channel_id AS channelId, message_id AS messageId
    FROM guild_settings WHERE channel_id IS NOT NULL
  `),
};

function setUserTimezone(guildId, userId, timezone) {
  statements.upsertTimezone.run({ guildId, userId, timezone, updatedAt: Date.now() });
}

function removeUserTimezone(guildId, userId) {
  const result = statements.deleteTimezone.run(guildId, userId);
  return result.changes > 0;
}

function getUserTimezone(guildId, userId) {
  const row = statements.getTimezone.get(guildId, userId);
  return row ? row.timezone : null;
}

function getGuildTimezones(guildId) {
  return statements.getGuildTimezones.all(guildId);
}

function setGuildChannel(guildId, channelId) {
  statements.upsertGuildChannel.run({ guildId, channelId });
}

function setGuildMessageId(guildId, messageId) {
  statements.setGuildMessageId.run(messageId, guildId);
}

function getGuildSettings(guildId) {
  return statements.getGuildSettings.get(guildId) || null;
}

function getAllGuildSettings() {
  return statements.getAllGuildSettings.all();
}

module.exports = {
  setUserTimezone,
  removeUserTimezone,
  getUserTimezone,
  getGuildTimezones,
  setGuildChannel,
  setGuildMessageId,
  getGuildSettings,
  getAllGuildSettings,
};
