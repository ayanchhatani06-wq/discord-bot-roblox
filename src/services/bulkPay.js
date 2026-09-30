const tasksRepo = require('../db/repos/tasks');
const contributorsRepo = require('../db/repos/contributors');
const budget = require('./budget');
const paymentState = require('./paymentState');
const { formatAmount } = require('../domain/money');

/**
 * Approving several proposed pay figures in one go.
 *
 * Leaders propose what an artist should be paid and the owner decides. On a busy
 * week that is a dozen separate commands, and the work cannot be offered until
 * each one is decided — so the queue becomes the bottleneck.
 *
 * Two things this does not do. It does not skip the budget guard: each figure is
 * checked as if approved on its own, in order, so approving five together can
 * refuse the fifth for exactly the reason approving it last would have. And it
 * does not approve a figure nobody proposed — it only says yes to what a leader
 * already put forward, so the owner is still the one deciding, just faster.
 */

/** Every pay figure proposed and waiting on the owner. */
function pending(db, guildId, { projectId = null } = {}) {
  const taskClause = projectId ? 'AND t.project_id = ?' : '';
  const params = projectId ? [guildId, projectId] : [guildId];

  const taskLevel = db.prepare(`
    SELECT t.* FROM tasks t
    WHERE t.guild_id = ? AND t.pay_state = 'proposed' AND t.state != 'cancelled' ${taskClause}
    ORDER BY t.pay_proposed_at
  `).all(...params).map((task) => ({
    scope: 'task',
    task,
    userId: task.artist_user_id,
    amountMinor: task.pay_proposed_minor,
    currency: task.pay_proposed_currency,
    proposedBy: task.pay_proposed_by,
    proposedAt: task.pay_proposed_at,
  }));

  const contributorLevel = db.prepare(`
    SELECT c.*, t.id AS task_id FROM task_contributors c
    JOIN tasks t ON t.id = c.task_id
    WHERE t.guild_id = ? AND c.pay_state = 'proposed' AND c.removed_at IS NULL
      AND t.state != 'cancelled' ${taskClause}
    ORDER BY c.proposed_at
  `).all(...params).map((row) => ({
    scope: 'contributor',
    task: tasksRepo.getTask(db, guildId, row.task_id),
    userId: row.user_id,
    amountMinor: row.proposed_minor,
    currency: row.proposed_currency,
    proposedBy: row.proposed_by,
    proposedAt: row.proposed_at,
  }));

  return [...taskLevel, ...contributorLevel]
    .filter((entry) => entry.task && entry.amountMinor !== null && entry.currency)
    .sort((a, b) => (a.proposedAt || 0) - (b.proposedAt || 0));
}

/**
 * Approves each proposal in turn, reporting what went through and what did not.
 *
 * Not one transaction. Five good figures should not be thrown away because the
 * sixth would blow the budget — the owner asked for the queue cleared, and a
 * partial result they can see beats an all-or-nothing they have to unpick.
 */
function approveAll(db, guildId, { actorUserId, projectId = null, dryRun = false } = {}) {
  const proposals = pending(db, guildId, { projectId });
  const approved = [];
  const refused = [];

  for (const proposal of proposals) {
    // Re-read the task: an earlier approval in this same run may have changed
    // what is already committed on its project.
    const task = tasksRepo.getTask(db, guildId, proposal.task.id);
    if (!task) continue;

    const check = budget.checkBudget(db, guildId, task, {
      amountMinor: proposal.amountMinor,
      currency: proposal.currency,
      userId: proposal.scope === 'contributor' ? proposal.userId : null,
    });

    if (!check.ok) {
      refused.push({ ...proposal, task, check, reason: 'over_budget' });
      continue;
    }

    if (dryRun) {
      approved.push({ ...proposal, task, check, requiresAcknowledgement: false });
      continue;
    }

    const result = proposal.scope === 'contributor'
      ? contributorsRepo.approvePay(db, guildId, task.id, proposal.userId, {
        amountMinor: proposal.amountMinor, currency: proposal.currency, actorUserId,
      })
      : tasksRepo.approvePay(db, guildId, task.id, {
        amountMinor: proposal.amountMinor, currency: proposal.currency, actorUserId,
      });

    if (!result) {
      refused.push({ ...proposal, task, reason: 'could_not_apply' });
      continue;
    }

    paymentState.recomputeTaskPaymentState(db, guildId, task.id, actorUserId, 'Pay approved in bulk');

    approved.push({
      ...proposal,
      task: tasksRepo.getTask(db, guildId, task.id),
      check,
      requiresAcknowledgement: Boolean(result.requiresAcknowledgement),
    });
  }

  return { approved, refused, considered: proposals.length };
}

/** A one-line summary per proposal, for the owner to read before deciding. */
function describe(entry) {
  return `**${entry.task.code}** · ${entry.task.title} — ` +
    `${formatAmount(entry.amountMinor, entry.currency)}` +
    `${entry.userId ? ` to <@${entry.userId}>` : ' (nobody on it yet)'}` +
    `${entry.scope === 'contributor' ? ' _(their share)_' : ''}` +
    `${entry.proposedBy ? `, proposed by <@${entry.proposedBy}>` : ''}`;
}

/** Totals per currency, kept apart because there is no rate between them. */
function totals(entries) {
  const byCurrency = new Map();
  for (const entry of entries) {
    byCurrency.set(entry.currency, (byCurrency.get(entry.currency) || 0) + entry.amountMinor);
  }
  return [...byCurrency.entries()].map(([currency, minor]) => formatAmount(minor, currency)).join(' + ');
}

module.exports = { pending, approveAll, describe, totals };
