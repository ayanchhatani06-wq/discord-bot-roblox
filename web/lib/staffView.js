const configRepo = require('../../src/db/repos/config');
const staffRepo = require('../../src/db/repos/staff');
const tasksRepo = require('../../src/db/repos/tasks');
const offersRepo = require('../../src/db/repos/offers');
const onboardingRepo = require('../../src/db/repos/onboarding');
const paymentState = require('../../src/services/paymentState');
const reports = require('../../src/services/reports');
const { resolveActor, can, CAPABILITIES } = require('../../src/domain/permissions');
const { formatAmount, formatTotals, totalsByCurrency } = require('../../src/domain/money');
const { TASK_STATES, ACTIVE_STATES } = require('../../src/domain/taskState');

/**
 * What the staff area is allowed to show one person.
 *
 * Permissions are worked out with the same `resolveActor` the bot uses, from
 * the same stored grants, so the website cannot accidentally be more generous
 * than Discord. There is one difference, and it is a restriction: the web
 * session knows a Discord user id but not their current roles, because roles
 * only arrive with an interaction. So department leadership is read from who
 * reports to them, and anything role-derived is simply absent rather than
 * guessed at.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * An actor built from stored facts only.
 *
 * Deliberately conservative: without the live role list, somebody who is owner
 * by role rather than by recorded user id will see the artist's view. That is
 * the safe direction to be wrong in, and they still have Discord.
 */
function actorFor(db, guildId, userId) {
  const config = configRepo.getConfig(db, guildId);
  const departments = configRepo.listDepartments(db, guildId);

  const leadIds = new Set(
    db.prepare('SELECT DISTINCT department_id FROM staff WHERE guild_id = ? AND leader_user_id = ? AND department_id IS NOT NULL')
      .all(guildId, userId)
      .map((row) => row.department_id)
  );

  const actor = resolveActor({
    userId,
    roleIds: [],
    config,
    departments,
    roleCapabilities: [],
    standInDepartmentIds: [
      ...leadIds,
      ...onboardingRepo.activeBackupDepartmentIds(db, guildId, userId),
    ],
  });

  return { actor, departments, config };
}

function decorate(db, guildId, tasks, departments) {
  const names = new Map(departments.map((department) => [department.id, department.name]));
  return tasks.map((task) => ({ ...task, departmentName: names.get(task.department_id) || null }));
}

function nameOf(db, guildId, userId) {
  return staffRepo.getStaff(db, guildId, userId)?.display_name || 'your account';
}

/** One person's own work, and their own pay. Never anybody else's. */
function myWork(db, guildId, userId) {
  const { actor, departments } = actorFor(db, guildId, userId);

  const offerTaskIds = offersRepo.listPendingForArtist(db, guildId, userId).map((offer) => offer.task_id);
  const offers = offerTaskIds
    .map((taskId) => tasksRepo.getTask(db, guildId, taskId))
    .filter(Boolean);

  const assigned = tasksRepo.listTasksForArtist(db, guildId, userId, { states: ACTIVE_STATES });
  const active = assigned.filter((task) => task.state !== TASK_STATES.OFFERED);

  const now = Date.now();
  const deadlines = active
    .filter((task) => task.deadline_utc && task.deadline_utc - now <= 7 * DAY_MS)
    .sort((a, b) => a.deadline_utc - b.deadline_utc);

  // Their own agreed figures, gathered exactly as the Discord desk does it.
  const owed = [];
  for (const task of tasksRepo.listTasksForArtist(db, guildId, userId, {
    states: [TASK_STATES.CLIENT_APPROVED, TASK_STATES.AWAITING_CLIENT, ...ACTIVE_STATES],
  })) {
    const entry = paymentState.owedToContributor(db, task, userId);
    if (entry && entry.remainingMinor > 0) {
      owed.push({ minor: entry.remainingMinor, currency: entry.currency });
    }
  }

  return {
    who: nameOf(db, guildId, userId),
    offers: decorate(db, guildId, offers, departments),
    active: decorate(db, guildId, active, departments),
    deadlines: decorate(db, guildId, deadlines, departments),
    owedText: formatTotals(totalsByCurrency(owed)),
    showPay: true,
    isOwner: actor.isOwner,
  };
}

/**
 * The queues, scoped to what this person runs.
 *
 * Somebody who leads nothing and is not the owner sees empty queues rather
 * than the whole studio's workload — the same rule the Discord desks follow.
 */
function queues(db, guildId, userId) {
  const { actor, departments } = actorFor(db, guildId, userId);

  const scoped = (tasks) => {
    if (actor.isOwner || can(actor, CAPABILITIES.SUMMARY_VIEW)) return tasks;
    return tasks.filter((task) => actor.leadDepartmentIds.includes(task.department_id));
  };

  const mine = departments
    .filter((department) => actor.leadDepartmentIds.includes(department.id))
    .map((department) => department.name);

  return {
    who: nameOf(db, guildId, userId),
    departments: actor.isOwner ? [] : mine,
    unassigned: decorate(db, guildId, scoped(reports.filterTasks(db, guildId, reports.FILTERS.UNASSIGNED)), departments),
    review: decorate(db, guildId, scoped(tasksRepo.listTasksInStates(db, guildId, [TASK_STATES.INTERNAL_REVIEW])), departments),
    awaitingClient: decorate(db, guildId, scoped(reports.filterTasks(db, guildId, reports.FILTERS.AWAITING_CLIENT)), departments),
    overdue: decorate(db, guildId, scoped(reports.filterTasks(db, guildId, reports.FILTERS.OVERDUE)), departments),
  };
}

module.exports = { DAY_MS, actorFor, decorate, myWork, queues, formatAmount };
