const configRepo = require('../db/repos/config');
const staffRepo = require('../db/repos/staff');
const tasksRepo = require('../db/repos/tasks');
const offersRepo = require('../db/repos/offers');
const remindersRepo = require('../db/repos/reminders');
const paymentState = require('./paymentState');
const planningRepo = require('../db/repos/planning');
const { notifyUser } = require('./notify');
const { TASK_STATES, ACTIVE_STATES } = require('../domain/taskState');
const { formatAmount } = require('../domain/money');
const { discordTimestamp, isWithinQuietHours, quietHoursEndAt, HOUR_MS, DAY_MS } = require('../utils/time');

const { KINDS } = remindersRepo;

// How long before the same reminder may be repeated.
const REPEAT_INTERVAL = {
  [KINDS.OFFER_UNANSWERED]: 12 * HOUR_MS,
  [KINDS.OFFER_ESCALATED]: 24 * HOUR_MS,
  [KINDS.DEADLINE_UPCOMING]: 24 * HOUR_MS,
  [KINDS.DEADLINE_OVERDUE]: 24 * HOUR_MS,
  [KINDS.STALE_PROGRESS]: 2 * DAY_MS,
  [KINDS.AWAITING_REVIEW]: DAY_MS,
  [KINDS.AWAITING_CLIENT]: 3 * DAY_MS,
  [KINDS.APPROVED_UNPAID]: 3 * DAY_MS,
  [KINDS.DEPENDENCY_READY]: 7 * DAY_MS,
  [KINDS.BLOCKER_OPEN]: 2 * DAY_MS,
  [KINDS.AWAY_RETURNED]: 3 * DAY_MS,
};

/**
 * Quiet hours are the staff member's own, falling back to the studio default,
 * and are always read in that person's timezone.
 */
function quietWindowFor(db, guildId, userId, config) {
  const staff = staffRepo.getStaff(db, guildId, userId);
  if (!staff?.timezone) return null;

  const start = staff.quiet_start_minute ?? config.quiet_start_minute;
  const end = staff.quiet_end_minute ?? config.quiet_end_minute;
  if (start === null || start === undefined || end === null || end === undefined) return null;

  return { timeZone: staff.timezone, quietStartMinute: start, quietEndMinute: end };
}

/**
 * Collects reminders per recipient during a sweep so each person gets one
 * batched message rather than a burst of separate pings.
 */
class Batch {
  constructor(db, guildId, config, now) {
    this.db = db;
    this.guildId = guildId;
    this.config = config;
    this.now = now;
    this.byUser = new Map();
    this.deferred = [];
  }

  add(userId, kind, entityType, entityId, line, { minIntervalMs } = {}) {
    if (!userId) return false;

    const interval = minIntervalMs ?? REPEAT_INTERVAL[kind] ?? DAY_MS;
    if (!remindersRepo.isDue(this.db, this.guildId, kind, entityType, entityId, { minIntervalMs: interval, now: this.now })) {
      return false;
    }

    // Routine reminders wait for quiet hours to end; nothing is discarded.
    const quiet = quietWindowFor(this.db, this.guildId, userId, this.config);
    if (quiet && isWithinQuietHours({ at: new Date(this.now), ...quiet })) {
      const until = quietHoursEndAt({ at: new Date(this.now), ...quiet });
      remindersRepo.defer(this.db, this.guildId, kind, entityType, entityId, until || this.now + HOUR_MS);
      this.deferred.push({ userId, kind, entityId, until });
      return false;
    }

    if (!this.byUser.has(userId)) this.byUser.set(userId, []);
    this.byUser.get(userId).push({ kind, entityType, entityId, line });
    return true;
  }

  async send(client) {
    const results = { sent: 0, failed: [], deferred: this.deferred.length };

    for (const [userId, entries] of this.byUser) {
      const grouped = new Map();
      for (const entry of entries) {
        if (!grouped.has(entry.kind)) grouped.set(entry.kind, []);
        grouped.get(entry.kind).push(entry.line);
      }

      const body = [...grouped.entries()]
        .map(([kind, lines]) => `**${HEADINGS[kind] || kind}**\n${lines.join('\n')}`)
        .join('\n\n');

      const delivery = await notifyUser(client, this.db, this.guildId, userId, {
        content: `${body}\n\n_Studio reminder. Change your quiet hours with \`/profile me\`._`.slice(0, 2000),
      }, { fallbackNote: 'You have studio reminders waiting.' });

      if (delivery.delivered) {
        results.sent += 1;
        for (const entry of entries) {
          remindersRepo.markSent(this.db, this.guildId, entry.kind, entry.entityType, entry.entityId, this.now);
        }
      } else {
        // Left unmarked so the next sweep tries again rather than losing it.
        results.failed.push({ userId, reason: delivery.reason });
      }
    }

    return results;
  }
}

const HEADINGS = {
  [KINDS.OFFER_UNANSWERED]: '⏳ Task offers waiting for your answer',
  [KINDS.OFFER_ESCALATED]: '⏳ Offers your team has not answered',
  [KINDS.DEADLINE_UPCOMING]: '📅 Deadlines coming up',
  [KINDS.DEADLINE_OVERDUE]: '🔴 Overdue work',
  [KINDS.STALE_PROGRESS]: '💤 No progress posted recently',
  [KINDS.AWAITING_REVIEW]: '🔍 Waiting for your internal review',
  [KINDS.AWAITING_CLIENT]: '📤 Waiting on a client decision',
  [KINDS.APPROVED_UNPAID]: '💰 Approved work with payouts outstanding',
  [KINDS.DEPENDENCY_READY]: '🔗 Ready for you to start',
  [KINDS.BLOCKER_OPEN]: '🚧 Blockers still open',
  [KINDS.AWAY_RETURNED]: '👋 Back from being away?',
};

function sweepGuild(db, guildId, { now = Date.now() } = {}) {
  const config = configRepo.getConfig(db, guildId);
  if (!config) return null;

  const batch = new Batch(db, guildId, config, now);
  const offerWindow = (config.offer_reminder_hours || 12) * HOUR_MS;
  const deadlineWindow = (config.deadline_warning_hours || 48) * HOUR_MS;
  const staleWindow = (config.stale_progress_days || 3) * DAY_MS;

  // 1. Unanswered offers: the artist first.
  for (const offer of offersRepo.listPendingNeedingReminder(db, guildId, now - offerWindow)) {
    const added = batch.add(
      offer.artist_user_id, KINDS.OFFER_UNANSWERED, 'offer', offer.id,
      `**${offer.task_code}** — offered ${discordTimestamp(offer.offered_at, 'R')}. Accept or decline from the message I sent you.`
    );
    if (added) offersRepo.markReminded(db, offer.id);
  }

  // 2. Then their leader, once the artist has been chased and still not replied.
  for (const offer of offersRepo.listPendingNeedingEscalation(db, guildId, now - offerWindow)) {
    const added = batch.add(
      offer.leader_user_id, KINDS.OFFER_ESCALATED, 'offer', offer.id,
      `**${offer.task_code}** — <@${offer.artist_user_id}> has not answered since ${discordTimestamp(offer.offered_at, 'R')}. ` +
      `Withdraw with \`/task withdraw task:${offer.task_code}\` to offer it elsewhere.`
    );
    if (added) offersRepo.markEscalated(db, offer.id);
  }

  // 3. Deadlines, upcoming and overdue.
  for (const task of tasksRepo.listTasksInStates(db, guildId, ACTIVE_STATES)) {
    if (!task.deadline_utc || !task.artist_user_id) continue;

    if (task.deadline_utc < now) {
      batch.add(
        task.artist_user_id, KINDS.DEADLINE_OVERDUE, 'task', task.id,
        `**${task.code}** ${task.title} — was due ${discordTimestamp(task.deadline_utc, 'R')}.`
      );
      batch.add(
        task.leader_user_id, KINDS.DEADLINE_OVERDUE, 'task', `${task.id}:leader`,
        `**${task.code}** ${task.title} — <@${task.artist_user_id}> is past the deadline (${discordTimestamp(task.deadline_utc, 'R')}).`
      );
    } else if (task.deadline_utc - now <= deadlineWindow) {
      batch.add(
        task.artist_user_id, KINDS.DEADLINE_UPCOMING, 'task', task.id,
        `**${task.code}** ${task.title} — due ${discordTimestamp(task.deadline_utc, 'R')}.`
      );
    }
  }

  // 4. Work in progress with nothing posted for a while.
  for (const task of tasksRepo.listTasksInStates(db, guildId, [TASK_STATES.IN_PROGRESS, TASK_STATES.REVISION_NEEDED])) {
    if (!task.artist_user_id) continue;
    const since = task.last_progress_at || task.accepted_at || task.updated_at;
    if (!since || now - since < staleWindow) continue;

    const added = batch.add(
      task.artist_user_id, KINDS.STALE_PROGRESS, 'task', task.id,
      `**${task.code}** ${task.title} — nothing posted since ${discordTimestamp(since, 'R')}. ` +
      `A quick note with \`/work progress\` is enough.`
    );
    if (!added) {
      batch.add(
        task.leader_user_id, KINDS.STALE_PROGRESS, 'task', `${task.id}:leader`,
        `**${task.code}** — no update from <@${task.artist_user_id}> since ${discordTimestamp(since, 'R')}.`
      );
    }
  }

  // 5. Submissions sitting with a leader.
  for (const task of tasksRepo.listTasksInStates(db, guildId, [TASK_STATES.INTERNAL_REVIEW])) {
    batch.add(
      task.leader_user_id, KINDS.AWAITING_REVIEW, 'task', task.id,
      `**${task.code}** ${task.title} — submitted ${discordTimestamp(task.updated_at, 'R')} by <@${task.artist_user_id}>. ` +
      `Review with \`/review decide task:${task.code}\`.`
    );
  }

  // 6. Sent to a client with no decision recorded, and 7. approved but unpaid:
  //    both land with whoever records client decisions and payments.
  if (config.owner_user_id) {
    for (const task of tasksRepo.listTasksInStates(db, guildId, [TASK_STATES.AWAITING_CLIENT])) {
      batch.add(
        config.owner_user_id, KINDS.AWAITING_CLIENT, 'task', task.id,
        `**${task.code}** ${task.title} — with the client since ${discordTimestamp(task.updated_at, 'R')}. ` +
        `Record their answer with \`/review client task:${task.code}\`.`
      );
    }

    const pending = paymentState.pendingPayouts(db, guildId);
    for (const task of pending.payable) {
      const remaining = paymentState.remainingForArtist(db, task);
      if (!remaining) continue;
      batch.add(
        config.owner_user_id, KINDS.APPROVED_UNPAID, 'task', task.id,
        `**${task.code}** — <@${task.artist_user_id}> is owed ${formatAmount(remaining, task.artist_pay_currency)}. ` +
        `Record it with \`/finance pay task:${task.code}\`.`
      );
    }
  }

  // 8. A prerequisite has become ready: tell the team waiting on it, once.
  for (const dependency of planningRepo.newlyReadyDependencies(db, guildId)) {
    const recipient = dependency.down_artist || dependency.down_leader;
    const added = batch.add(
      recipient, KINDS.DEPENDENCY_READY, 'dependency', dependency.id,
      `**${dependency.up_code}** ${dependency.up_title} has passed review, so **${dependency.down_code}** ` +
      `${dependency.down_title} can start.${dependency.note ? `\n_${dependency.note}_` : ''}`
    );
    // Marked whether or not it was due, so a prerequisite cannot be announced
    // twice; the batch itself will not re-add an entry it has already sent.
    if (added) planningRepo.markDependencyNotified(db, dependency.id);
  }

  // 9. People whose away date has passed, asked rather than switched for them.
  for (const staff of staffRepo.listReturnedFromAway(db, guildId, now)) {
    batch.add(
      staff.user_id, KINDS.AWAY_RETURNED, 'staff', staff.user_id,
      `Your away period ended ${discordTimestamp(staff.away_until, 'R')}. ` +
      'Set yourself back to accepting work with `/profile availability` when you are ready — ' +
      'I have not changed it for you.'
    );
  }

  return batch;
}

async function runSweep(client, db, { now = Date.now() } = {}) {
  const summary = { guilds: 0, sent: 0, deferred: 0, failed: [] };

  for (const config of configRepo.listConfiguredGuilds(db)) {
    try {
      const batch = sweepGuild(db, config.guild_id, { now });
      if (!batch) continue;

      const result = await batch.send(client);
      summary.guilds += 1;
      summary.sent += result.sent;
      summary.deferred += result.deferred;
      summary.failed.push(...result.failed.map((entry) => ({ ...entry, guildId: config.guild_id })));
    } catch (error) {
      console.error(`Reminder sweep failed for guild ${config.guild_id}:`, error);
    }
  }

  return summary;
}

module.exports = { KINDS, HEADINGS, REPEAT_INTERVAL, quietWindowFor, Batch, sweepGuild, runSweep };
