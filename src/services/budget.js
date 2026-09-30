const tasksRepo = require('../db/repos/tasks');
const projectsRepo = require('../db/repos/projects');
const contributorsRepo = require('../db/repos/contributors');
const paymentSchedule = require('./paymentSchedule');
const { recordAudit } = require('../db/repos/core');
const { formatAmount } = require('../domain/money');
const { TASK_STATES } = require('../domain/taskState');

/**
 * What a project has committed to pay people, per currency.
 *
 * Cancelled work is excluded, and currencies are kept apart: a Robux
 * commitment cannot be weighed against a USD budget, so it is reported
 * separately rather than converted.
 */
function committedByCurrency(db, guildId, projectId, { excludeTaskId = null, excludeUserId = null } = {}) {
  const totals = new Map();

  for (const task of tasksRepo.listTasksForProject(db, projectId)) {
    if (task.state === TASK_STATES.CANCELLED) continue;

    // A figure being replaced is not a figure already committed. No name given
    // means the task's main artist, which is what `/task pay` sets.
    const isSubject = task.id === excludeTaskId;
    const replacing = excludeUserId ?? task.artist_user_id;

    const contributors = contributorsRepo.listForTask(db, task.id);
    if (contributors.length > 0) {
      for (const contributor of contributors) {
        if (contributor.pay_minor === null || !contributor.pay_currency) continue;
        if (isSubject && contributor.user_id === replacing) continue;
        totals.set(contributor.pay_currency, (totals.get(contributor.pay_currency) || 0) + contributor.pay_minor);
      }
      continue;
    }

    if (task.artist_pay_minor === null || !task.artist_pay_currency) continue;
    // Without contributor rows the task's column is the main artist's figure,
    // so it is skipped whenever they are the one being re-priced — including
    // when the task has no artist yet and the pay is simply being changed.
    if (isSubject && (excludeUserId === null || excludeUserId === task.artist_user_id)) continue;
    totals.set(task.artist_pay_currency, (totals.get(task.artist_pay_currency) || 0) + task.artist_pay_minor);
  }

  return totals;
}

/**
 * Checks a proposed pay figure against what the client is paying.
 *
 * Returns a refusal rather than a warning: the studio's rule is that
 * allocations must not *silently* exceed the budget, so this is the point at
 * which somebody has to decide deliberately. The owner can override, and that
 * override is recorded against the project.
 */
function checkBudget(db, guildId, task, { amountMinor, currency, userId = null }) {
  const project = projectsRepo.getProject(db, guildId, task.project_id);
  if (!project) return { ok: true, reason: 'no_budget_set' };

  // The budget is whatever the client owes in total. On an order split into
  // named parts that is the sum of the parts, not the single price column —
  // otherwise an order priced entirely through deposits would have no budget at
  // all and the guard would quietly stop guarding.
  const schedule = paymentSchedule.scheduleFor(db, guildId, project);
  const budgetMinor = schedule.hasSchedule ? schedule.totalMinor : project.client_amount_minor;
  const budgetCurrency = schedule.hasSchedule ? schedule.currency : project.client_currency;

  if (budgetMinor === null || !budgetCurrency) {
    return { ok: true, reason: 'no_budget_set' };
  }
  if (budgetCurrency !== currency) {
    // No conversion rate exists, so this pay simply is not measured against
    // that budget. Said plainly rather than silently passing.
    return { ok: true, reason: 'different_currency', budgetCurrency };
  }
  if (project.budget_override_by) {
    return { ok: true, reason: 'override_in_place', overriddenBy: project.budget_override_by };
  }

  const committed = committedByCurrency(db, guildId, project.id, {
    excludeTaskId: task.id,
    excludeUserId: userId,
  }).get(currency) || 0;

  const wouldBe = committed + amountMinor;
  if (wouldBe <= budgetMinor) {
    return {
      ok: true,
      committed,
      wouldBe,
      budget: budgetMinor,
      currency,
      remaining: budgetMinor - wouldBe,
    };
  }

  return {
    ok: false,
    reason: 'over_budget',
    committed,
    wouldBe,
    budget: budgetMinor,
    currency,
    excessMinor: wouldBe - budgetMinor,
    project,
    fromSchedule: schedule.hasSchedule,
  };
}

function describeBudgetFailure(check) {
  return (
    `This would commit **${formatAmount(check.wouldBe, check.currency)}** against a client payment of ` +
    `**${formatAmount(check.budget, check.currency)}** on ${check.project.code} — ` +
    `**${formatAmount(check.excessMinor, check.currency)}** over.\n` +
    `Already committed: ${formatAmount(check.committed, check.currency)}.`
  );
}

function setBudgetOverride(db, guildId, projectId, { actorUserId, reason }) {
  db.prepare(`
    UPDATE projects SET budget_override_by = ?, budget_override_reason = ?, budget_override_at = ?, updated_at = ?
    WHERE guild_id = ? AND id = ?
  `).run(actorUserId, reason, Date.now(), Date.now(), guildId, projectId);

  recordAudit(db, {
    guildId, actorUserId, action: 'project.budget.override', entityType: 'project', entityId: projectId,
    after: { reason },
    detail: 'Pay may now exceed the recorded client payment on this project.',
  });
  return projectsRepo.getProject(db, guildId, projectId);
}

function clearBudgetOverride(db, guildId, projectId, actorUserId) {
  db.prepare(`
    UPDATE projects SET budget_override_by = NULL, budget_override_reason = NULL, budget_override_at = NULL, updated_at = ?
    WHERE guild_id = ? AND id = ?
  `).run(Date.now(), guildId, projectId);

  recordAudit(db, {
    guildId, actorUserId, action: 'project.budget.override_cleared', entityType: 'project', entityId: projectId,
  });
  return projectsRepo.getProject(db, guildId, projectId);
}

/** Projects whose committed pay has met or passed what the client pays. */
function projectsOverBudget(db, guildId) {
  const results = [];

  for (const project of projectsRepo.listProjects(db, guildId, { status: 'active', limit: 200 })) {
    // Same budget as the guard uses, so this sweep cannot disagree with the
    // refusal an owner gets when they try to approve the figure.
    const schedule = paymentSchedule.scheduleFor(db, guildId, project);
    const budgetMinor = schedule.hasSchedule ? schedule.totalMinor : project.client_amount_minor;
    const currency = schedule.hasSchedule ? schedule.currency : project.client_currency;

    if (budgetMinor === null || !currency) continue;
    const committed = committedByCurrency(db, guildId, project.id).get(currency) || 0;
    if (committed >= budgetMinor) {
      results.push({ project, committed, budget: budgetMinor, currency });
    }
  }

  return results;
}

module.exports = {
  committedByCurrency,
  checkBudget,
  describeBudgetFailure,
  setBudgetOverride,
  clearBudgetOverride,
  projectsOverBudget,
};
