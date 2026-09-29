const cron = require('node-cron');
const configRepo = require('../db/repos/config');
const { refreshGuildBoards } = require('./staffBoard');
const { MINUTE_MS } = require('../utils/time');

const lastRefreshAt = new Map();

/**
 * Seeds the in-memory clock from what is already on disk, so a restart does not
 * immediately re-edit every board message.
 */
function primeFromDatabase(db) {
  for (const config of configRepo.listConfiguredGuilds(db)) {
    const rows = configRepo.listBoardMessages(db, config.guild_id);
    const latest = rows.reduce((max, row) => Math.max(max, row.updated_at || 0), 0);
    if (latest > 0) lastRefreshAt.set(config.guild_id, latest);
  }
}

function isDue(config, now) {
  const intervalMs = Math.max(1, config.board_refresh_minutes || 10) * MINUTE_MS;
  const last = lastRefreshAt.get(config.guild_id) || 0;
  return now - last >= intervalMs;
}

async function tick(client, db, now = Date.now()) {
  for (const config of configRepo.listConfiguredGuilds(db)) {
    if (!config.staff_board_channel_id) continue;
    if (!isDue(config, now)) continue;

    try {
      await refreshGuildBoards(client, config.guild_id, db);
      lastRefreshAt.set(config.guild_id, Date.now());
    } catch (error) {
      // Recorded and retried next tick rather than crashing the scheduler.
      console.error(`Board refresh failed for guild ${config.guild_id}:`, error);
      lastRefreshAt.set(config.guild_id, Date.now());
    }
  }
}

/**
 * Runs every minute and refreshes only the guilds whose own interval has
 * elapsed, so each server can pick its own refresh rate without a timer each.
 */
function start(client, db) {
  primeFromDatabase(db);
  const task = cron.schedule('* * * * *', () => {
    tick(client, db).catch((error) => console.error('Board scheduler tick failed:', error));
  });
  console.log('Staff board scheduler started (checks every minute, refreshes per-guild interval).');
  return task;
}

function markRefreshed(guildId, at = Date.now()) {
  lastRefreshAt.set(guildId, at);
}

/** Forces this guild's boards to refresh on the next tick. */
function invalidate(guildId) {
  lastRefreshAt.set(guildId, 0);
}

module.exports = { start, tick, isDue, primeFromDatabase, markRefreshed, invalidate, lastRefreshAt };
