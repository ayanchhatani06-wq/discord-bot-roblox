const tasksRepo = require('../db/repos/tasks');
const offersRepo = require('../db/repos/offers');
const staffRepo = require('../db/repos/staff');
const submissionsRepo = require('../db/repos/submissions');
const messagingRepo = require('../db/repos/messaging');
const onboardingRepo = require('../db/repos/onboarding');
const clientsRepo = require('../db/repos/clients');
const bonusFlow = require('./bonusFlow');
const paymentState = require('./paymentState');
const reports = require('./reports');
const { CAPABILITIES, can } = require('../domain/permissions');
const { TASK_STATES, ACTIVE_STATES } = require('../domain/taskState');

/**
 * What one person should actually do next.
 *
 * Thirty commands is a lot to remember, and most of the time somebody does not
 * want a command — they want to know whether anything is waiting on them. This
 * works that out from what is recorded and answers in one list, newest concern
 * first, with the command for each one written out so nothing has to be
 * recalled.
 *
 * Every item is scoped by the same permissions as the command it points to, so
 * this can never surface something the person would then be refused.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Urgency, not importance. Something with a deadline that has passed beats
 * something merely waiting, and anything a person has personally agreed to
 * beats a queue they merely oversee.
 */
const URGENCY = Object.freeze({
  BLOCKING: 0,
  OVERDUE: 1,
  WAITING_ON_YOU: 2,
  SOON: 3,
  BACKGROUND: 4,
});

function item({ urgency, icon, text, command = null, count = null }) {
  return { urgency, icon, text, command, count };
}

/** Things that are true for anybody: their own offers, work and reading. */
function personalActions(db, guildId, userId, { now = Date.now() } = {}) {
  const actions = [];

  const offers = offersRepo.listPendingForArtist(db, guildId, userId);
  if (offers.length > 0) {
    actions.push(item({
      urgency: URGENCY.WAITING_ON_YOU,
      icon: '📬',
      count: offers.length,
      text: `${offers.length} task offer${offers.length === 1 ? '' : 's'} waiting for your answer`,
      command: 'Check your DMs, or `/task mine`',
    }));
  }

  const mine = tasksRepo.listTasksForArtist(db, guildId, userId, { states: ACTIVE_STATES })
    .filter((task) => task.state !== TASK_STATES.OFFERED);

  const overdue = mine.filter((task) => task.deadline_utc && task.deadline_utc < now);
  if (overdue.length > 0) {
    actions.push(item({
      urgency: URGENCY.OVERDUE,
      icon: '🔴',
      count: overdue.length,
      text: `${overdue.length} of your task${overdue.length === 1 ? ' is' : 's are'} past the deadline: ${overdue.map((t) => t.code).join(', ')}`,
      command: '`/my-work progress` to say where it stands, or `/my-work blocked` if something is in the way',
    }));
  }

  const dueSoon = mine.filter((task) => task.deadline_utc && task.deadline_utc >= now && task.deadline_utc - now <= 2 * DAY_MS);
  if (dueSoon.length > 0) {
    actions.push(item({
      urgency: URGENCY.SOON,
      icon: '🟡',
      count: dueSoon.length,
      text: `${dueSoon.length} of your task${dueSoon.length === 1 ? ' is' : 's are'} due within two days`,
      command: '`/my-work submit` when ready',
    }));
  }

  const revisions = mine.filter((task) => task.state === TASK_STATES.REVISION_NEEDED);
  if (revisions.length > 0) {
    actions.push(item({
      urgency: URGENCY.WAITING_ON_YOU,
      icon: '🔁',
      count: revisions.length,
      text: `${revisions.length} task${revisions.length === 1 ? '' : 's'} came back for changes`,
      command: '`/my-work history task:<code>` to see what was asked for',
    }));
  }

  // Work that has been quiet a while is worth a nudge before somebody asks.
  const quiet = mine.filter((task) =>
    task.state === TASK_STATES.IN_PROGRESS &&
    (task.last_progress_at || task.updated_at) < now - 5 * DAY_MS);
  if (quiet.length > 0) {
    actions.push(item({
      urgency: URGENCY.BACKGROUND,
      icon: '💬',
      count: quiet.length,
      text: `${quiet.length} of your task${quiet.length === 1 ? ' has' : 's have'} had no update in five days`,
      command: '`/my-work progress` — a line is enough to stop anybody chasing',
    }));
  }

  const staff = staffRepo.getStaff(db, guildId, userId);
  const leadsSomebody = Boolean(
    db.prepare('SELECT 1 FROM staff WHERE guild_id = ? AND leader_user_id = ? LIMIT 1').get(guildId, userId)
  );

  const unreadProcedures = onboardingRepo.outstandingProcedures(db, guildId, userId, {
    departmentId: staff?.department_id ?? null,
    isLeader: leadsSomebody,
  });
  if (unreadProcedures.length > 0) {
    actions.push(item({
      urgency: URGENCY.BACKGROUND,
      icon: '📋',
      count: unreadProcedures.length,
      text: `${unreadProcedures.length} studio procedure${unreadProcedures.length === 1 ? '' : 's'} you have not acknowledged`,
      command: '`/staff-rules list`',
    }));
  }

  const trials = onboardingRepo.listTrials(db, guildId, { status: 'open', userId });
  const offeredTrials = trials.filter((trial) => trial.status === onboardingRepo.TRIAL_STATES.OFFERED);
  if (offeredTrials.length > 0) {
    actions.push(item({
      urgency: URGENCY.WAITING_ON_YOU,
      icon: '🎯',
      count: offeredTrials.length,
      text: `You have a trial brief waiting for an answer`,
      command: '`/trial mine`',
    }));
  }

  if (!staff?.timezone) {
    actions.push(item({
      urgency: URGENCY.BACKGROUND,
      icon: '🕓',
      text: 'Your timezone is not set, so deadlines may be read wrongly',
      command: '`/profile timezone`',
    }));
  }

  return actions;
}

/** Things that are true for whoever runs a department. */
function leaderActions(db, guildId, actor, { now = Date.now() } = {}) {
  if (actor.leadDepartmentIds.length === 0) return [];
  const mine = (task) => actor.leadDepartmentIds.includes(task.department_id);
  const actions = [];

  const unassigned = tasksRepo.listTasksInStates(db, guildId, [TASK_STATES.UNASSIGNED]).filter(mine);
  if (unassigned.length > 0) {
    actions.push(item({
      urgency: URGENCY.WAITING_ON_YOU,
      icon: '👥',
      count: unassigned.length,
      text: `${unassigned.length} task${unassigned.length === 1 ? '' : 's'} in your department${unassigned.length === 1 ? ' has' : 's have'} nobody on ${unassigned.length === 1 ? 'it' : 'them'}`,
      command: '`/task queue`',
    }));
  }

  const review = tasksRepo.listTasksInStates(db, guildId, [TASK_STATES.INTERNAL_REVIEW]).filter(mine);
  if (review.length > 0) {
    actions.push(item({
      urgency: URGENCY.WAITING_ON_YOU,
      icon: '🔍',
      count: review.length,
      text: `${review.length} submission${review.length === 1 ? '' : 's'} waiting on your review`,
      command: '`/review queue`',
    }));
  }

  const blocked = reports.filterTasks(db, guildId, reports.FILTERS.BLOCKED, { now }).filter(mine);
  if (blocked.length > 0) {
    actions.push(item({
      urgency: URGENCY.BLOCKING,
      icon: '🚧',
      count: blocked.length,
      text: `${blocked.length} task${blocked.length === 1 ? ' is' : 's are'} blocked and nobody has cleared ${blocked.length === 1 ? 'it' : 'them'}`,
      command: '`/desk group`',
    }));
  }

  const overdue = reports.filterTasks(db, guildId, reports.FILTERS.OVERDUE, { now }).filter(mine);
  if (overdue.length > 0) {
    actions.push(item({
      urgency: URGENCY.OVERDUE,
      icon: '🔴',
      count: overdue.length,
      text: `${overdue.length} task${overdue.length === 1 ? '' : 's'} in your department ${overdue.length === 1 ? 'is' : 'are'} overdue`,
      command: '`/reports filter which:overdue`',
    }));
  }

  return actions;
}

/** Things only the owner is asked to decide. */
function ownerActions(db, guildId, actor, { now = Date.now() } = {}) {
  if (!can(actor, CAPABILITIES.TASK_PAY_APPROVE)) return [];
  const actions = [];

  const proposedPay = db.prepare(`
    SELECT COUNT(*) AS n FROM tasks WHERE guild_id = ? AND pay_state = 'proposed'
  `).get(guildId).n;
  if (proposedPay > 0) {
    actions.push(item({
      urgency: URGENCY.BLOCKING,
      icon: '💰',
      count: proposedPay,
      text: `${proposedPay} pay figure${proposedPay === 1 ? '' : 's'} proposed and waiting on you — the work cannot be offered until you decide`,
      command: '`/task approve-pay`',
    }));
  }

  const awaitingClient = tasksRepo.listTasksInStates(db, guildId, [TASK_STATES.AWAITING_CLIENT]);
  const stale = awaitingClient.filter((task) => task.updated_at < now - 3 * DAY_MS);
  if (stale.length > 0) {
    actions.push(item({
      urgency: URGENCY.WAITING_ON_YOU,
      icon: '⏳',
      count: stale.length,
      text: `${stale.length} item${stale.length === 1 ? ' has' : 's have'} been with a client over three days with no answer recorded`,
      command: '`/review awaiting-client`',
    }));
  }

  const unpaid = reports.filterTasks(db, guildId, reports.FILTERS.UNPAID, { now });
  if (unpaid.length > 0) {
    actions.push(item({
      urgency: URGENCY.WAITING_ON_YOU,
      icon: '💸',
      count: unpaid.length,
      text: `${unpaid.length} approved task${unpaid.length === 1 ? '' : 's'} still ${unpaid.length === 1 ? 'owes' : 'owe'} somebody money`,
      command: '`/reports payouts`',
    }));
  }

  const flagged = db.prepare(`
    SELECT COUNT(*) AS n FROM tasks
    WHERE guild_id = ? AND (scope_review_flag = 1 OR compensation_review_flag = 1)
  `).get(guildId).n;
  if (flagged > 0) {
    actions.push(item({
      urgency: URGENCY.WAITING_ON_YOU,
      icon: '⚠️',
      count: flagged,
      text: `${flagged} task${flagged === 1 ? '' : 's'} flagged for a decision about scope or compensation`,
      command: '`/change flags`',
    }));
  }

  const replies = messagingRepo.openReplies(db, guildId);
  if (replies.length > 0) {
    actions.push(item({
      urgency: URGENCY.BLOCKING,
      icon: '💬',
      count: replies.length,
      text: `${replies.length} client${replies.length === 1 ? ' has' : 's have'} written in and nobody has answered — their automated messages are paused until somebody does`,
      command: '`/messages replies`',
    }));
  }

  const bonuses = bonusFlow.listAwards(db, guildId, { status: 'pending' });
  if (bonuses.length > 0) {
    actions.push(item({
      urgency: URGENCY.BACKGROUND,
      icon: '🏅',
      count: bonuses.length,
      text: `${bonuses.length} bonus milestone${bonuses.length === 1 ? '' : 's'} reached and waiting on your approval`,
      command: '`/bonuses pending`',
    }));
  }

  const recommendations = onboardingRepo.listRecommendations(db, guildId, { status: 'pending' });
  if (recommendations.length > 0) {
    actions.push(item({
      urgency: URGENCY.BACKGROUND,
      icon: '👤',
      count: recommendations.length,
      text: `${recommendations.length} recommendation${recommendations.length === 1 ? '' : 's'} from your leaders`,
      command: '`/recommend list`',
    }));
  }

  const trials = onboardingRepo.listTrials(db, guildId, { status: onboardingRepo.TRIAL_STATES.SUBMITTED });
  if (trials.length > 0) {
    actions.push(item({
      urgency: URGENCY.WAITING_ON_YOU,
      icon: '🎯',
      count: trials.length,
      text: `${trials.length} trial${trials.length === 1 ? '' : 's'} submitted and waiting on a decision`,
      command: '`/trial list`',
    }));
  }

  return actions;
}

/**
 * Everything waiting on this person, most pressing first.
 *
 * An empty list is a real answer and the caller should say so plainly rather
 * than inventing something to suggest.
 */
function forUser(db, guildId, userId, actor, { now = Date.now(), limit = 8 } = {}) {
  const actions = [
    ...personalActions(db, guildId, userId, { now }),
    ...leaderActions(db, guildId, actor, { now }),
    ...ownerActions(db, guildId, actor, { now }),
  ];

  actions.sort((a, b) => a.urgency - b.urgency);
  return { actions: actions.slice(0, limit), total: actions.length };
}

module.exports = { DAY_MS, URGENCY, item, personalActions, leaderActions, ownerActions, forUser };
