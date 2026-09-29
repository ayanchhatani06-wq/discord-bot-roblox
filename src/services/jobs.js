const cron = require('node-cron');
const configRepo = require('../db/repos/config');
const boardScheduler = require('./boardScheduler');
const { runSweep } = require('./reminders');
const { postWeeklySummary } = require('./summary');
const clientMessaging = require('./clientMessaging');
const messageTriggers = require('./messageTriggers');
const { pruneGuards } = require('../db/repos/core');

const REMINDER_CRON = '*/10 * * * *';
const HOUSEKEEPING_CRON = '30 4 * * *';
// Queued client messages are sent on their own beat, separate from the sweep
// that queues them, so a burst still goes out under the same rate limits.
const OUTBOX_CRON = '*/5 * * * *';
const CLIENT_SWEEP_CRON = '15 10 * * *';

const summaryTasks = new Map();

function safeSchedule(expression, handler, label) {
  try {
    return cron.schedule(expression, handler);
  } catch (error) {
    console.error(`Could not schedule ${label} with "${expression}":`, error.message);
    return null;
  }
}

/**
 * Each guild gets its own cron for the weekly summary, so servers can pick
 * different days and times. Rescheduling replaces the old task rather than
 * stacking a second one.
 */
function scheduleSummaryFor(client, db, guildId) {
  const existing = summaryTasks.get(guildId);
  if (existing) {
    existing.stop();
    summaryTasks.delete(guildId);
  }

  const config = configRepo.getConfig(db, guildId);
  if (!config?.summary_cron) return null;

  const task = safeSchedule(config.summary_cron, async () => {
    try {
      const result = await postWeeklySummary(client, db, guildId);
      if (!result.delivered) {
        console.warn(`Weekly summary for guild ${guildId} was not delivered: ${result.reason}`);
      }
    } catch (error) {
      console.error(`Weekly summary failed for guild ${guildId}:`, error);
    }
  }, `weekly summary for ${guildId}`);

  if (task) summaryTasks.set(guildId, task);
  return task;
}

function scheduleAllSummaries(client, db) {
  for (const config of configRepo.listConfiguredGuilds(db)) {
    scheduleSummaryFor(client, db, config.guild_id);
  }
  return summaryTasks.size;
}

function startAll(client, db) {
  boardScheduler.start(client, db);

  safeSchedule(REMINDER_CRON, async () => {
    try {
      const result = await runSweep(client, db);
      if (result.failed.length > 0) {
        console.warn(`Reminder sweep could not reach ${result.failed.length} recipient(s).`);
      }
    } catch (error) {
      console.error('Reminder sweep failed:', error);
    }
  }, 'reminder sweep');

  // Old idempotency guards are only needed while a click could still be
  // replayed, so they are pruned rather than kept forever.
  safeSchedule(HOUSEKEEPING_CRON, () => {
    try {
      const removed = pruneGuards(db);
      if (removed > 0) console.log(`Pruned ${removed} expired interaction guard(s).`);
    } catch (error) {
      console.error('Housekeeping failed:', error);
    }
  }, 'housekeeping');

  safeSchedule(OUTBOX_CRON, async () => {
    for (const config of configRepo.listConfiguredGuilds(db)) {
      try {
        const result = await clientMessaging.processQueue(client, db, config.guild_id);
        if (result.failed > 0) {
          console.warn(`${result.failed} client message(s) could not be sent in guild ${config.guild_id}.`);
        }
      } catch (error) {
        console.error(`Client outbox failed for guild ${config.guild_id}:`, error);
      }
    }
  }, 'client outbox');

  // Once a day, and only queueing: nothing is sent from here.
  safeSchedule(CLIENT_SWEEP_CRON, () => {
    for (const config of configRepo.listConfiguredGuilds(db)) {
      try {
        messageTriggers.sweep(db, config.guild_id);
      } catch (error) {
        console.error(`Client follow-up sweep failed for guild ${config.guild_id}:`, error);
      }
    }
  }, 'client follow-up sweep');

  const summaries = scheduleAllSummaries(client, db);
  console.log(`Jobs started: boards, reminders every 10 minutes, ${summaries} weekly summary schedule(s).`);
}

function stopAll() {
  for (const task of summaryTasks.values()) task.stop();
  summaryTasks.clear();
}

module.exports = { REMINDER_CRON, OUTBOX_CRON, CLIENT_SWEEP_CRON, startAll, stopAll, scheduleSummaryFor, scheduleAllSummaries, summaryTasks };
