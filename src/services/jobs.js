const cron = require('node-cron');
const configRepo = require('../db/repos/config');
const boardScheduler = require('./boardScheduler');
const enquiryAlerts = require('./enquiryAlerts');
const { runSweep } = require('./reminders');
const { postWeeklySummary } = require('./summary');
const clientMessaging = require('./clientMessaging');
const messageTriggers = require('./messageTriggers');
const automation = require('./automation');
const webRepo = require('../db/repos/web');
const { pruneGuards } = require('../db/repos/core');

const ENQUIRY_CRON = '*/2 * * * *';
const REMINDER_CRON = '*/10 * * * *';
const HOUSEKEEPING_CRON = '30 4 * * *';
// Queued client messages are sent on their own beat, separate from the sweep
// that queues them, so a burst still goes out under the same rate limits.
const OUTBOX_CRON = '*/5 * * * *';
const CLIENT_SWEEP_CRON = '15 10 * * *';
const AUTOMATION_CRON = '40 10 * * *';

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

  // The website writes a quote request and has no way to tell anybody — it runs
  // as its own process with no Discord connection. This is the half that does.
  // Every two minutes rather than every ten: an enquiry is somebody waiting.
  safeSchedule(ENQUIRY_CRON, async () => {
    try {
      for (const { guild_id: guildId } of configRepo.listConfiguredGuilds(db)) {
        const result = await enquiryAlerts.announcePending(client, db, guildId);
        if (result.posted > 0) console.log(`Announced ${result.posted} new quote request(s).`);
        if (result.reason && result.skipped > 0) {
          console.warn(`${result.skipped} quote request(s) not announced: ${result.reason}.`);
        }
      }
    } catch (error) {
      console.error('Quote request announcement failed:', error);
    }
  }, 'quote request alerts');

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

  // Expired rows are already ignored wherever they are read, so this is
  // housekeeping rather than a safety measure: without it the tables grow
  // forever on a box that is meant to run for years untouched.
  safeSchedule(HOUSEKEEPING_CRON, () => {
    try {
      const guards = pruneGuards(db);
      const sessions = webRepo.pruneSessions(db);
      const logins = webRepo.pruneLoginTokens(db);

      const removed = guards + sessions + logins;
      if (removed > 0) {
        console.log(`Pruned ${guards} guard(s), ${sessions} expired session(s), ${logins} spent login link(s).`);
      }
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

  // Only rules the owner switched on, and each task acted on once per rule.
  safeSchedule(AUTOMATION_CRON, async () => {
    for (const config of configRepo.listConfiguredGuilds(db)) {
      try {
        await automation.runAll(client, db, config.guild_id);
      } catch (error) {
        console.error(`Automation rules failed for guild ${config.guild_id}:`, error);
      }
    }
  }, 'automation rules');

  const summaries = scheduleAllSummaries(client, db);
  console.log(`Jobs started: boards, reminders every 10 minutes, ${summaries} weekly summary schedule(s).`);
}

function stopAll() {
  for (const task of summaryTasks.values()) task.stop();
  summaryTasks.clear();
}

module.exports = { REMINDER_CRON, OUTBOX_CRON, CLIENT_SWEEP_CRON, AUTOMATION_CRON, startAll, stopAll, scheduleSummaryFor, scheduleAllSummaries, summaryTasks };
