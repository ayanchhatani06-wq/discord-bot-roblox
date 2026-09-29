const tasksRepo = require('../db/repos/tasks');
const projectsRepo = require('../db/repos/projects');
const { TASK_STATES } = require('../domain/taskState');

const { PAYMENT_STATES } = tasksRepo;

/**
 * What has actually been paid to the artist for this task.
 *
 * Allocation payouts (finder, leader, mod, owner shares) are excluded: the
 * task's payment state tracks the artist's agreed amount, and the split lines
 * are settled separately.
 */
function paidToArtist(db, task) {
  if (!task.artist_user_id || !task.artist_pay_currency) return 0;

  const row = db.prepare(`
    SELECT COALESCE(SUM(amount_minor), 0) AS total FROM payments
    WHERE task_id = ? AND direction = 'payout' AND payee_user_id = ?
      AND allocation_kind IS NULL AND currency = ?
  `).get(task.id, task.artist_user_id, task.artist_pay_currency);

  return row.total;
}

function remainingForArtist(db, task) {
  if (task.artist_pay_minor === null) return null;
  return Math.max(0, task.artist_pay_minor - paidToArtist(db, task));
}

/**
 * Works out the payment state from facts rather than storing a guess.
 *
 * The studio's rule: work is only payable once the client's money has actually
 * arrived, so client approval alone is not enough. The owner can override that
 * for deposits, and the override is respected here.
 */
function computePaymentState(db, guildId, task) {
  const paid = paidToArtist(db, task);

  if (task.artist_pay_minor !== null && paid >= task.artist_pay_minor && task.artist_pay_minor > 0) {
    return PAYMENT_STATES.PAID;
  }
  if (paid > 0) return PAYMENT_STATES.PARTIALLY_PAID;
  if (task.payable_override_by) return PAYMENT_STATES.PAYABLE;
  if (task.state !== TASK_STATES.CLIENT_APPROVED) return PAYMENT_STATES.PENDING_CLIENT_PAYMENT;

  const project = projectsRepo.getProject(db, guildId, task.project_id);
  if (!project) return PAYMENT_STATES.PENDING_CLIENT_PAYMENT;

  return projectsRepo.isClientPaidInFull(db, project)
    ? PAYMENT_STATES.PAYABLE
    : PAYMENT_STATES.PENDING_CLIENT_PAYMENT;
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
  paidToArtist,
  remainingForArtist,
  computePaymentState,
  recomputeTaskPaymentState,
  recomputeProjectPaymentStates,
  pendingPayouts,
};
