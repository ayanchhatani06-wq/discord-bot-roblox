const staffRepo = require('../db/repos/staff');
const offersRepo = require('../db/repos/offers');
const assetsRepo = require('../db/repos/assets');
const onboardingRepo = require('../db/repos/onboarding');
const paymentState = require('./paymentState');
const { ACTIVE_STATES, TASK_STATES } = require('../domain/taskState');
const { totalsByCurrency } = require('../domain/money');

/**
 * What somebody leaving the studio takes with them, and what they leave behind.
 *
 * This is deliberately a report rather than an action. Deleting a departing
 * member's records would destroy exactly the information offboarding exists to
 * surface: who was mid-task, what files never arrived, and who is still owed
 * money. Nothing here removes anything.
 */

/**
 * Tasks this person is on, as the artist or as a contributor.
 *
 * Both routes matter here: somebody who only ever helped on other people's
 * tasks still leaves that work half-done when they go.
 */
function tasksInvolving(db, guildId, userId, states) {
  const placeholders = states.map(() => '?').join(', ');
  return db.prepare(`
    SELECT DISTINCT t.* FROM tasks t
    LEFT JOIN task_contributors c ON c.task_id = t.id AND c.removed_at IS NULL
    WHERE t.guild_id = ? AND (t.artist_user_id = ? OR c.user_id = ?) AND t.state IN (${placeholders})
    ORDER BY COALESCE(t.deadline_utc, 9e15), t.id
  `).all(guildId, userId, userId, ...states);
}

/** Work they are holding right now, which somebody else will have to take on. */
function unfinishedWork(db, guildId, userId) {
  return tasksInvolving(db, guildId, userId, ACTIVE_STATES);
}

/** Departments they run, which will be leaderless the moment they go. */
function departmentsLed(db, guildId, userId, departments) {
  const led = new Set(
    db.prepare(`
      SELECT DISTINCT department_id FROM tasks
      WHERE guild_id = ? AND leader_user_id = ? AND state NOT IN ('cancelled', 'client_approved')
    `).all(guildId, userId).map((row) => row.department_id)
  );
  return departments.filter((dept) => led.has(dept.id));
}

/**
 * Approved work of theirs where files were never recorded.
 *
 * Checked against approved work only: unfinished work having no files yet is
 * normal, while approved work without them is something the studio has sold and
 * cannot deliver.
 */
function missingFiles(db, guildId, userId) {
  const approved = tasksInvolving(db, guildId, userId, [TASK_STATES.CLIENT_APPROVED, TASK_STATES.AWAITING_CLIENT]);
  return approved.filter((task) => assetsRepo.listForTask(db, task.id).length === 0);
}

/** Money still owed to them, per currency, with the tasks it comes from. */
function outstandingPay(db, guildId, userId) {
  const lines = [];

  for (const task of tasksInvolving(db, guildId, userId, [
    TASK_STATES.CLIENT_APPROVED, TASK_STATES.AWAITING_CLIENT, ...ACTIVE_STATES,
  ])) {
    const owed = paymentState.owedToContributor(db, task, userId);
    if (owed && owed.remainingMinor > 0) {
      lines.push({ task, minor: owed.remainingMinor, currency: owed.currency });
    }
  }

  // Split shares are owed to them as a person, not as the task's artist, so
  // they are counted separately and never merged into the artist figure.
  const shares = db.prepare(`
    SELECT a.*, t.code AS task_code FROM allocations a
    JOIN tasks t ON t.id = a.task_id
    WHERE t.guild_id = ? AND a.recipient_user_id = ?
  `).all(guildId, userId);

  const shareLines = [];
  for (const share of shares) {
    const paid = db.prepare(`
      SELECT COALESCE(SUM(amount_minor), 0) AS total FROM payments
      WHERE task_id = ? AND allocation_kind = ? AND payee_user_id = ? AND currency = ?
        AND failed_at IS NULL
    `).get(share.task_id, share.recipient_kind, userId, share.currency).total;

    const remaining = share.amount_minor - paid;
    if (remaining > 0) shareLines.push({ share, minor: remaining, currency: share.currency });
  }

  return {
    lines,
    shareLines,
    totals: totalsByCurrency([
      ...lines.map((line) => ({ minor: line.minor, currency: line.currency })),
      ...shareLines.map((line) => ({ minor: line.minor, currency: line.currency })),
    ]),
  };
}

/**
 * Everything one person leaves behind, gathered in one place.
 *
 * Nothing is changed by calling this, so it is safe to run before deciding
 * whether somebody is really leaving.
 */
function buildReport(db, guildId, userId, departments = []) {
  const staff = staffRepo.getStaff(db, guildId, userId);
  const unfinished = unfinishedWork(db, guildId, userId);
  const offers = offersRepo.listPendingForArtist(db, guildId, userId);
  const led = departmentsLed(db, guildId, userId, departments);
  const files = missingFiles(db, guildId, userId);
  const pay = outstandingPay(db, guildId, userId);
  const standIns = onboardingRepo.listBackupLeaders(db, guildId).filter((grant) => grant.user_id === userId);
  const trials = onboardingRepo.listTrials(db, guildId, { status: 'open', userId });

  const blockers = [];
  if (unfinished.length > 0) blockers.push(`${unfinished.length} unfinished task(s) need somebody else`);
  if (offers.length > 0) blockers.push(`${offers.length} unanswered offer(s) should be withdrawn`);
  if (led.length > 0) blockers.push(`${led.length} department(s) have live work led by them`);
  if (files.length > 0) blockers.push(`${files.length} approved task(s) have no files recorded`);
  if (pay.totals.size > 0) blockers.push('they are still owed money');
  if (standIns.length > 0) blockers.push(`${standIns.length} stand-in leadership grant(s) are still open`);
  if (trials.length > 0) blockers.push(`${trials.length} trial(s) are still open`);

  return { staff, unfinished, offers, led, files, pay, standIns, trials, blockers };
}

/** The part of a report worth storing: counts and references, not whole rows. */
function snapshotOf(report) {
  return {
    unfinished_task_codes: report.unfinished.map((task) => task.code),
    pending_offer_task_ids: report.offers.map((offer) => offer.task_id),
    departments_led: report.led.map((dept) => dept.name),
    approved_tasks_without_files: report.files.map((task) => task.code),
    outstanding_pay: [...report.pay.totals.entries()].map(([currency, minor]) => ({ currency, minor })),
    open_stand_in_grants: report.standIns.map((grant) => grant.id),
    open_trials: report.trials.map((trial) => trial.code),
    blockers: report.blockers,
  };
}

module.exports = { tasksInvolving, unfinishedWork, departmentsLed, missingFiles, outstandingPay, buildReport, snapshotOf };
