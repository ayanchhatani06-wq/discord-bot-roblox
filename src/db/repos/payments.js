const { recordAudit } = require('./core');
const { totalsByCurrency } = require('../../domain/money');

const DIRECTIONS = Object.freeze({ CLIENT_RECEIPT: 'client_receipt', PAYOUT: 'payout' });

/**
 * Records money moving, once.
 *
 * The idempotency key is a unique column, so a retried interaction or a
 * double-clicked button can never create a second payment. A genuinely
 * separate payment (a second instalment) uses a different key and is allowed.
 *
 * The bot only ever records that a payment happened; it never moves money and
 * never stores card details, account credentials or gift card codes.
 */
function recordPayment(db, guildId, {
  direction,
  projectId = null,
  taskId = null,
  payeeUserId = null,
  allocationKind = null,
  amountMinor,
  currency,
  methodLabel = null,
  reference = null,
  note = null,
  recordedBy,
  idempotencyKey,
}) {
  if (!Object.values(DIRECTIONS).includes(direction)) {
    throw new Error(`Unknown payment direction: ${direction}`);
  }
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
    throw new Error('A payment amount must be a positive whole number of minor units.');
  }

  const existing = db.prepare('SELECT * FROM payments WHERE idempotency_key = ?').get(idempotencyKey);
  if (existing) return { created: false, payment: existing };

  const payment = db.prepare(`
    INSERT INTO payments (
      guild_id, direction, project_id, task_id, payee_user_id, allocation_kind,
      amount_minor, currency, method_label, reference, note, recorded_by, recorded_at, idempotency_key
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING *
  `).get(
    guildId, direction, projectId, taskId, payeeUserId, allocationKind,
    amountMinor, currency, methodLabel, reference, note, recordedBy, Date.now(), idempotencyKey
  );

  recordAudit(db, {
    guildId,
    actorUserId: recordedBy,
    action: `payment.${direction}`,
    entityType: taskId ? 'task' : 'project',
    entityId: taskId || projectId,
    after: {
      amount_minor: amountMinor,
      currency,
      payee_user_id: payeeUserId,
      allocation_kind: allocationKind,
      method_label: methodLabel,
    },
    detail: note,
  });

  return { created: true, payment };
}

function listPaymentsForTask(db, taskId, { direction = DIRECTIONS.PAYOUT } = {}) {
  return db.prepare(`
    SELECT * FROM payments WHERE task_id = ? AND direction = ?
    ORDER BY recorded_at
  `).all(taskId, direction);
}

function listPaymentsForProject(db, projectId, { direction = null } = {}) {
  if (direction) {
    return db.prepare('SELECT * FROM payments WHERE project_id = ? AND direction = ? ORDER BY recorded_at')
      .all(projectId, direction);
  }
  return db.prepare('SELECT * FROM payments WHERE project_id = ? ORDER BY recorded_at').all(projectId);
}

function listPaymentsForPayee(db, guildId, payeeUserId, { limit = 50 } = {}) {
  return db.prepare(`
    SELECT p.*, t.code AS task_code FROM payments p
    LEFT JOIN tasks t ON t.id = p.task_id
    WHERE p.guild_id = ? AND p.payee_user_id = ? AND p.direction = 'payout'
    ORDER BY p.recorded_at DESC LIMIT ?
  `).all(guildId, payeeUserId, limit);
}

/**
 * Totals are always grouped by currency. There is no combined figure because
 * the studio has no conversion rate between Robux and USD.
 */
function totalsByDirection(db, guildId, { projectId = null } = {}) {
  const rows = projectId
    ? db.prepare('SELECT direction, currency, SUM(amount_minor) AS minor FROM payments WHERE guild_id = ? AND project_id = ? AND failed_at IS NULL GROUP BY direction, currency').all(guildId, projectId)
    : db.prepare('SELECT direction, currency, SUM(amount_minor) AS minor FROM payments WHERE guild_id = ? AND failed_at IS NULL GROUP BY direction, currency').all(guildId);

  const received = [];
  const paidOut = [];
  for (const row of rows) {
    (row.direction === DIRECTIONS.CLIENT_RECEIPT ? received : paidOut).push({ minor: row.minor, currency: row.currency });
  }

  return {
    received: totalsByCurrency(received),
    paidOut: totalsByCurrency(paidOut),
  };
}

function payoutTotalsForPayee(db, guildId, payeeUserId) {
  const rows = db.prepare(`
    SELECT currency, SUM(amount_minor) AS minor FROM payments
    WHERE guild_id = ? AND payee_user_id = ? AND direction = 'payout'
      AND failed_at IS NULL
    GROUP BY currency
  `).all(guildId, payeeUserId);
  return totalsByCurrency(rows.map((row) => ({ minor: row.minor, currency: row.currency })));
}

/** What has been paid against a specific allocation line. */
function paidForAllocation(db, taskId, recipientKind, payeeUserId, currency) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(amount_minor), 0) AS total FROM payments
    WHERE task_id = ? AND direction = 'payout' AND allocation_kind = ?
      AND payee_user_id = ? AND currency = ?
      AND failed_at IS NULL
  `).get(taskId, recipientKind, payeeUserId, currency);
  return row.total;
}

function getPaymentByKey(db, idempotencyKey) {
  return db.prepare('SELECT * FROM payments WHERE idempotency_key = ?').get(idempotencyKey) || null;
}


/**
 * A payout the person says actually reached them.
 *
 * Sending is not landing. A Robux group payout, a gift card, a PayPal transfer
 * — each can be sent and still not arrive, and the studio's word against the
 * artist's is a bad place to end up. So "sent" and "landed" are two separate
 * facts with two separate timestamps, and this records the second one.
 *
 * Confirmation is idempotent: confirming twice keeps the first timestamp,
 * because the first one is when it actually happened.
 */
function confirmReceived(db, guildId, paymentId, { confirmedBy, note = null }) {
  const payment = getPayment(db, guildId, paymentId);
  if (!payment) return { ok: false, reason: 'not_found' };
  if (payment.direction !== DIRECTIONS.PAYOUT) return { ok: false, reason: 'not_a_payout' };
  if (payment.failed_at) return { ok: false, reason: 'already_failed', payment };
  if (payment.confirmed_at) return { ok: true, changed: false, payment };

  const updated = db.prepare(`
    UPDATE payments SET confirmed_at = ?, confirmed_by = ?
    WHERE id = ? AND confirmed_at IS NULL RETURNING *
  `).get(Date.now(), confirmedBy, paymentId);

  recordAudit(db, {
    guildId, actorUserId: confirmedBy, action: 'payment.confirmed_received',
    entityType: 'payment', entityId: paymentId, detail: note,
    after: { confirmed_by: confirmedBy },
  });

  return { ok: true, changed: true, payment: updated };
}

/**
 * A payout that was sent and did not arrive.
 *
 * The record is not deleted. A failed transfer is a thing that happened, and
 * erasing it would leave the ledger claiming money went out when it did not.
 * Marking it failed takes it out of the paid-out total instead, so the artist
 * is owed again without anybody having to pretend the attempt never existed.
 */
function markFailed(db, guildId, paymentId, { failedBy, reason }) {
  const payment = getPayment(db, guildId, paymentId);
  if (!payment) return { ok: false, reason: 'not_found' };
  if (payment.direction !== DIRECTIONS.PAYOUT) return { ok: false, reason: 'not_a_payout' };
  if (payment.confirmed_at) return { ok: false, reason: 'already_confirmed', payment };
  if (payment.failed_at) return { ok: true, changed: false, payment };

  const updated = db.prepare(`
    UPDATE payments SET failed_at = ?, failure_note = ?
    WHERE id = ? AND failed_at IS NULL RETURNING *
  `).get(Date.now(), reason, paymentId);

  recordAudit(db, {
    guildId, actorUserId: failedBy, action: 'payment.failed',
    entityType: 'payment', entityId: paymentId, detail: reason,
    after: { failed_at: updated.failed_at, failure_note: reason },
  });

  return { ok: true, changed: true, payment: updated };
}

function getPayment(db, guildId, paymentId) {
  return db.prepare('SELECT * FROM payments WHERE guild_id = ? AND id = ?').get(guildId, paymentId) || null;
}

/** Payouts recorded as sent that nobody has confirmed arrived yet. */
function unconfirmedPayouts(db, guildId, { limit = 25 } = {}) {
  return db.prepare(`
    SELECT p.*, t.code AS task_code, t.title AS task_title FROM payments p
    LEFT JOIN tasks t ON t.id = p.task_id
    WHERE p.guild_id = ? AND p.direction = 'payout'
      AND p.confirmed_at IS NULL AND p.failed_at IS NULL
    ORDER BY p.recorded_at LIMIT ?
  `).all(guildId, limit);
}

module.exports = {
  DIRECTIONS,
  recordPayment,
  listPaymentsForTask,
  listPaymentsForProject,
  listPaymentsForPayee,
  totalsByDirection,
  payoutTotalsForPayee,
  paidForAllocation,
  getPaymentByKey,
  getPayment,
  confirmReceived,
  markFailed,
  unconfirmedPayouts,
};
