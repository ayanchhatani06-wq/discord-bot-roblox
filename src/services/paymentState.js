const tasksRepo = require('../db/repos/tasks');
const projectsRepo = require('../db/repos/projects');
const contributorsRepo = require('../db/repos/contributors');
const paymentSchedule = require('./paymentSchedule');
const { TASK_STATES } = require('../domain/taskState');

const { PAYMENT_STATES } = tasksRepo;

/**
 * What one person is owed on one task, whether they are the single artist or
 * one of several contributors. Their own terms only: nobody sees anyone
 * else's figure through this.
 */
function owedToContributor(db, task, userId) {
  const contributor = contributorsRepo.getContributor(db, task.id, userId);

  const agreed = contributor && !contributor.removed_at
    ? { minor: contributor.pay_minor, currency: contributor.pay_currency }
    : (task.artist_user_id === userId
      ? { minor: task.artist_pay_minor, currency: task.artist_pay_currency }
      : null);

  if (!agreed || agreed.minor === null || !agreed.currency) return null;

  // Counts both what reached them and what was taken out of their pay on the
  // way — the recruiter's one-time cut. Without the second clause the ledger
  // would see $28 against $35 agreed and conclude they are still owed $7, when
  // their pay is settled and $7 of it went to whoever brought them in.
  const paid = db.prepare(`
    SELECT COALESCE(SUM(amount_minor), 0) AS total FROM payments
    WHERE task_id = ? AND direction = 'payout' AND currency = ? AND failed_at IS NULL
      AND (
        (payee_user_id = ? AND allocation_kind IS NULL AND deducted_from_user_id IS NULL)
        OR deducted_from_user_id = ?
      )
  `).get(task.id, agreed.currency, userId, userId).total;

  return {
    agreedMinor: agreed.minor,
    currency: agreed.currency,
    paidMinor: paid,
    remainingMinor: Math.max(0, agreed.minor - paid),
  };
}

/** Everyone owed something on this task, for the owner's payout view. */
function owedOnTask(db, task) {
  const contributors = contributorsRepo.listForTask(db, task.id);
  const people = contributors.length > 0
    ? contributors.map((row) => row.user_id)
    : (task.artist_user_id ? [task.artist_user_id] : []);

  return people
    .map((userId) => ({ userId, ...(owedToContributor(db, task, userId) || {}) }))
    .filter((entry) => entry.currency);
}

/**
 * Whether everyone on the task has been paid in full. With several
 * contributors the task is only settled when the last of them is.
 */
function settlementOf(db, task) {
  const owed = owedOnTask(db, task);
  if (owed.length === 0) return { known: false, anyPaid: false, allSettled: false, outstanding: 0 };

  const outstanding = owed.reduce((sum, entry) => sum + entry.remainingMinor, 0);
  const agreed = owed.reduce((sum, entry) => sum + entry.agreedMinor, 0);
  const anyPaid = owed.some((entry) => entry.paidMinor > 0);

  // A task that owes nobody anything is not "paid" — nothing was ever due, so
  // it keeps following the ordinary payable/pending rules instead.
  return { known: true, anyPaid, allSettled: agreed > 0 && outstanding === 0, outstanding, agreed };
}

/**
 * Works out the payment state from facts rather than storing a guess.
 *
 * The studio's rule: work is only payable once the client's money has actually
 * arrived, so client approval alone is not enough. The owner can override that
 * for deposits, and the override is respected here.
 */
function computePaymentState(db, guildId, task) {
  const settlement = settlementOf(db, task);

  if (settlement.known && settlement.allSettled) return PAYMENT_STATES.PAID;
  if (settlement.anyPaid) return PAYMENT_STATES.PARTIALLY_PAID;
  if (task.payable_override_by) return PAYMENT_STATES.PAYABLE;
  if (task.state !== TASK_STATES.CLIENT_APPROVED) return PAYMENT_STATES.PENDING_CLIENT_PAYMENT;

  const project = projectsRepo.getProject(db, guildId, task.project_id);
  if (!project) return PAYMENT_STATES.PENDING_CLIENT_PAYMENT;

  return coveredByClientMoney(db, guildId, project, task)
    ? PAYMENT_STATES.PAYABLE
    : PAYMENT_STATES.PENDING_CLIENT_PAYMENT;
}

/**
 * Whether the client's money stretches to paying this task.
 *
 * The studio's rule: never pay out more than has come in. So what matters is
 * not whether the order is settled in full, but whether what has arrived still
 * covers this task's cost after everything already paid out on the project.
 * A deposit therefore funds work, in order, up to the value of the deposit.
 *
 * Currencies are kept apart. Robux received does not fund a dollar payout,
 * because there is no rate to make that true.
 */
function coveredByClientMoney(db, guildId, project, task) {
  const owed = owedOnTask(db, task);
  if (owed.length === 0) return false;

  const available = paymentSchedule.availableToPayOut(db, guildId, project);
  if (!available.currency || available.minor <= 0) return false;

  // What this project has already handed out, in the currency the client paid.
  const paidOut = db.prepare(`
    SELECT COALESCE(SUM(amount_minor), 0) AS total FROM payments
    WHERE guild_id = ? AND project_id = ? AND direction = 'payout' AND currency = ?
      AND failed_at IS NULL
  `).get(guildId, project.id, available.currency).total;

  const headroom = available.minor - paidOut;
  if (headroom <= 0) return false;

  // What is still owed on this task, in that same currency.
  const stillOwed = owed
    .filter((entry) => entry.currency === available.currency)
    .reduce((sum, entry) => sum + entry.remainingMinor, 0);

  if (stillOwed === 0) return false;
  return headroom >= stillOwed;
}

function recomputeTaskPaymentState(db, guildId, taskId, actorUserId = null, detail = null) {
  const task = tasksRepo.getTask(db, guildId, taskId);
  if (!task) return null;

  const next = computePaymentState(db, guildId, task);
  if (next === task.payment_state) return task;
  return tasksRepo.setPaymentState(db, guildId, taskId, next, actorUserId, detail);
}

/**
 * Re-checks every task on a project. Called when a client receipt is recorded,
 * because that is what can turn approved work payable.
 */
function recomputeProjectPaymentStates(db, guildId, projectId, actorUserId = null) {
  const tasks = tasksRepo.listTasksForProject(db, projectId);
  const changed = [];

  for (const task of tasks) {
    const before = task.payment_state;
    const after = recomputeTaskPaymentState(db, guildId, task.id, actorUserId, 'Client receipt recorded');
    if (after && after.payment_state !== before) changed.push(after);
  }

  return changed;
}

/** Approved work that is waiting on money, split by what is blocking it. */
function pendingPayouts(db, guildId) {
  const tasks = tasksRepo.listTasksInStates(db, guildId, [TASK_STATES.CLIENT_APPROVED]);
  const payable = [];
  const awaitingClientMoney = [];

  for (const task of tasks) {
    if (task.payment_state === PAYMENT_STATES.PAID) continue;
    if (task.payment_state === PAYMENT_STATES.PENDING_CLIENT_PAYMENT) awaitingClientMoney.push(task);
    else payable.push(task);
  }

  return { payable, awaitingClientMoney };
}

module.exports = {
  PAYMENT_STATES,
  coveredByClientMoney,
  owedToContributor,
  owedOnTask,
  settlementOf,
  computePaymentState,
  recomputeTaskPaymentState,
  recomputeProjectPaymentStates,
  pendingPayouts,
};
