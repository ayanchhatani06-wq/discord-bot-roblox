const projectsRepo = require('../db/repos/projects');
const paymentsRepo = require('../db/repos/payments');
const { recordAudit } = require('../db/repos/core');
const { formatAmount } = require('../domain/money');

/**
 * What a client owes, in parts.
 *
 * A project used to carry one figure and "paid in full" was all or nothing.
 * Half up front and half on delivery is ordinary for commissions, and without
 * milestones the studio had two bad options: record a deposit as full payment,
 * which breaks the rule that work is only payable once money arrived, or leave
 * artists unpayable on work the client has already funded.
 *
 * Receipts are matched against milestones in order. Nothing here decides who
 * gets paid — that stays with `paymentState` — it only answers how much of the
 * client's money has actually arrived.
 */

/**
 * Adds one part of what the client owes.
 *
 * Every milestone on an order must be in the same currency. `scheduleFor` fills
 * them from receipts in that one currency, so a milestone in another would be
 * counted as due and never be payable by anything — a debt that can never be
 * settled. Refused here rather than in the command, so the website cannot make
 * one either.
 */
function addMilestone(db, guildId, projectId, { label, amountMinor, currency, dueNote = null, sortOrder = null }, actorUserId) {
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
    return { ok: false, reason: 'bad_amount' };
  }

  const existing = listMilestones(db, projectId);
  if (existing.length > 0 && existing[0].currency !== currency) {
    return { ok: false, reason: 'currency_mismatch', expected: existing[0].currency };
  }

  const now = Date.now();
  const nextOrder = sortOrder ?? (
    db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM payment_milestones WHERE project_id = ?')
      .get(projectId).next
  );

  const milestone = db.prepare(`
    INSERT INTO payment_milestones (guild_id, project_id, label, amount_minor, currency, due_note, sort_order, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *
  `).get(guildId, projectId, label, amountMinor, currency, dueNote, nextOrder, actorUserId, now, now);

  recordAudit(db, {
    guildId, actorUserId, action: 'milestone.add', entityType: 'project', entityId: projectId,
    after: { label, amount_minor: amountMinor, currency },
  });
  return { ok: true, milestone };
}

function listMilestones(db, projectId) {
  return db.prepare('SELECT * FROM payment_milestones WHERE project_id = ? ORDER BY sort_order, id').all(projectId);
}

function getMilestone(db, guildId, id) {
  return db.prepare('SELECT * FROM payment_milestones WHERE guild_id = ? AND id = ?').get(guildId, id) || null;
}

function removeMilestone(db, guildId, id, actorUserId) {
  const milestone = getMilestone(db, guildId, id);
  if (!milestone) return null;

  db.prepare('DELETE FROM payment_milestones WHERE id = ?').run(id);
  recordAudit(db, {
    guildId, actorUserId, action: 'milestone.remove', entityType: 'project', entityId: milestone.project_id,
    before: { label: milestone.label, amount_minor: milestone.amount_minor },
  });
  return milestone;
}

function markInvoiced(db, guildId, id, actorUserId) {
  const result = db.prepare(`
    UPDATE payment_milestones SET invoiced_at = ?, invoiced_by = ?, updated_at = ?
    WHERE guild_id = ? AND id = ? AND invoiced_at IS NULL
  `).run(Date.now(), actorUserId, Date.now(), guildId, id);

  if (result.changes === 0) return null;
  recordAudit(db, { guildId, actorUserId, action: 'milestone.invoiced', entityType: 'payment_milestone', entityId: id });
  return getMilestone(db, guildId, id);
}

/** A milestone the studio has decided not to charge. It stops counting as owed. */
function waiveMilestone(db, guildId, id, { reason, actorUserId }) {
  const result = db.prepare(`
    UPDATE payment_milestones SET waived_at = ?, waived_reason = ?, updated_at = ?
    WHERE guild_id = ? AND id = ? AND waived_at IS NULL
  `).run(Date.now(), reason, Date.now(), guildId, id);

  if (result.changes === 0) return null;
  recordAudit(db, {
    guildId, actorUserId, action: 'milestone.waived', entityType: 'payment_milestone', entityId: id, detail: reason,
  });
  return getMilestone(db, guildId, id);
}

/**
 * How much of the client's money has actually arrived, per currency.
 *
 * Read from receipts rather than stored, so it cannot drift from the ledger.
 */
function receivedByCurrency(db, guildId, projectId) {
  const rows = db.prepare(`
    SELECT currency, SUM(amount_minor) AS total FROM payments
    WHERE guild_id = ? AND project_id = ? AND direction = 'client_receipt'
      AND failed_at IS NULL
    GROUP BY currency
  `).all(guildId, projectId);

  return new Map(rows.map((row) => [row.currency, row.total]));
}

/**
 * The schedule with each milestone marked covered, part-covered or not.
 *
 * Receipts fill milestones in order. There is no attempt to guess which
 * payment was meant for which milestone: the client sent money, and it counts
 * towards what they owe soonest.
 */
function scheduleFor(db, guildId, project) {
  const milestones = listMilestones(db, project.id);
  const received = receivedByCurrency(db, guildId, project.id);

  if (milestones.length === 0) {
    // No schedule: the project's single figure is the whole of it, which is
    // how every order worked before milestones existed.
    const currency = project.client_currency;
    const total = project.client_amount_minor;
    const paid = currency ? (received.get(currency) || 0) : 0;

    return {
      hasSchedule: false,
      currency,
      totalMinor: total,
      receivedMinor: paid,
      outstandingMinor: total === null ? null : Math.max(0, total - paid),
      milestones: [],
      fullyPaid: total !== null && paid >= total,
    };
  }

  const currency = milestones[0].currency;
  let remaining = received.get(currency) || 0;
  let totalDue = 0;

  const lines = milestones.map((milestone) => {
    if (milestone.waived_at) {
      return { milestone, waived: true, coveredMinor: 0, outstandingMinor: 0, covered: true };
    }

    totalDue += milestone.amount_minor;
    const covered = Math.min(remaining, milestone.amount_minor);
    remaining -= covered;

    return {
      milestone,
      waived: false,
      coveredMinor: covered,
      outstandingMinor: milestone.amount_minor - covered,
      covered: covered >= milestone.amount_minor,
    };
  });

  const receivedTotal = received.get(currency) || 0;

  return {
    hasSchedule: true,
    currency,
    totalMinor: totalDue,
    receivedMinor: receivedTotal,
    outstandingMinor: Math.max(0, totalDue - receivedTotal),
    // Money beyond the schedule is reported rather than silently absorbed: it
    // usually means a milestone is missing or somebody paid twice.
    overpaidMinor: Math.max(0, receivedTotal - totalDue),
    milestones: lines,
    fullyPaid: receivedTotal >= totalDue,
    nextDue: lines.find((line) => !line.covered && !line.waived) || null,
  };
}

/**
 * How much client money is available to pay people out of.
 *
 * This is the figure the payable rule uses: the studio's choice was that an
 * artist becomes payable once the money received covers their pay, so nothing
 * is ever paid out that has not come in.
 */
function availableToPayOut(db, guildId, project) {
  const schedule = scheduleFor(db, guildId, project);
  return { currency: schedule.currency, minor: schedule.receivedMinor };
}

function describe(schedule) {
  if (!schedule.hasSchedule) {
    return schedule.totalMinor === null
      ? 'No client amount is recorded on this order.'
      : `${formatAmount(schedule.receivedMinor, schedule.currency)} of ${formatAmount(schedule.totalMinor, schedule.currency)} received.`;
  }

  return [
    `${formatAmount(schedule.receivedMinor, schedule.currency)} of ${formatAmount(schedule.totalMinor, schedule.currency)} received`,
    schedule.nextDue
      ? `next due: ${schedule.nextDue.milestone.label} (${formatAmount(schedule.nextDue.outstandingMinor, schedule.currency)})`
      : 'nothing outstanding',
  ].join(' — ');
}

module.exports = {
  addMilestone,
  listMilestones,
  getMilestone,
  removeMilestone,
  markInvoiced,
  waiveMilestone,
  receivedByCurrency,
  scheduleFor,
  availableToPayOut,
  describe,
};
