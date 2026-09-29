const tasksRepo = require('../db/repos/tasks');
const projectsRepo = require('../db/repos/projects');
const configRepo = require('../db/repos/config');
const paymentsRepo = require('../db/repos/payments');
const { recordAudit } = require('../db/repos/core');
const {
  computeTaskClientSlices,
  computeTaskPool,
  allocatePool,
} = require('../domain/allocations');

const REASON_TEXT = {
  no_client_amount: 'the project has no client payment recorded',
  no_artist_pay: 'the task has no agreed artist pay',
  currency_mismatch: 'the client pays in a different currency from the artist, and there is no conversion rate',
  negative_pool: 'the artist costs more than this task\'s share of the client payment',
  explicit_prices_exceed_client_amount: 'the per-task prices already add up to more than the client payment',
};

/**
 * Who each share belongs to for one task.
 *
 * The leader share follows the department that actually did the work, taken
 * from the task itself. Finder and mod come from the project, because who
 * brought the client and who moderated it is a per-job fact. Anything with
 * nobody attached falls to the owner.
 */
function recipientsFor(db, guildId, task, project, config) {
  return {
    finder: project?.finder_user_id || null,
    leader: task.leader_user_id || null,
    mod: project?.mod_user_id || null,
    owner: config?.owner_user_id || null,
  };
}

/**
 * Works out this task's pool without writing anything.
 *
 * Three sources, in order: an owner-entered override, an explicit per-task
 * client price, or a pro-rata slice of the project's client payment weighted
 * by artist pay.
 */
function computePool(db, guildId, task) {
  if (task.pool_override_minor !== null && task.pool_override_minor !== undefined) {
    return {
      ok: true,
      poolMinor: task.pool_override_minor,
      currency: task.pool_override_currency,
      source: 'owner_override',
    };
  }

  const project = projectsRepo.getProject(db, guildId, task.project_id);
  if (!project) return { ok: false, reason: 'no_client_amount' };

  const siblings = tasksRepo.listTasksForProject(db, project.id)
    .filter((row) => row.state !== 'cancelled')
    .map((row) => ({
      id: row.id,
      artistPayMinor: row.artist_pay_minor,
      artistPayCurrency: row.artist_pay_currency,
      clientPriceMinor: row.client_price_minor,
      clientPriceCurrency: row.client_price_currency,
    }));

  const slices = computeTaskClientSlices({
    clientAmountMinor: project.client_amount_minor,
    clientCurrency: project.client_currency,
    tasks: siblings,
  });

  const slice = slices.get(task.id);
  if (!slice || !slice.ok) return { ok: false, reason: slice?.reason || 'no_client_amount' };

  const pool = computeTaskPool({
    sliceMinor: slice.sliceMinor,
    sliceCurrency: slice.currency,
    artistPayMinor: task.artist_pay_minor,
    artistPayCurrency: task.artist_pay_currency,
  });

  if (!pool.ok) return pool;
  return { ok: true, poolMinor: pool.poolMinor, currency: pool.currency, source: slice.source === 'explicit' ? 'explicit_task_price' : 'derived' };
}

function computeForTask(db, guildId, task) {
  const pool = computePool(db, guildId, task);
  if (!pool.ok) return { ok: false, reason: pool.reason, detail: REASON_TEXT[pool.reason], shortfallMinor: pool.shortfallMinor };

  const project = projectsRepo.getProject(db, guildId, task.project_id);
  const config = configRepo.getConfig(db, guildId);
  const recipients = recipientsFor(db, guildId, task, project, config);

  if (!recipients.owner) {
    return { ok: false, reason: 'no_owner', detail: 'no studio owner is configured, so shares have nowhere to fall back to' };
  }

  const split = allocatePool({
    poolMinor: pool.poolMinor,
    currency: pool.currency,
    percentagesBp: configRepo.getAllocationPercentages(db, guildId),
    recipients,
  });

  return { ok: true, ...split, poolSource: pool.source, recipients };
}

/**
 * Stores the computed split. Lines that have already been paid are frozen and
 * left alone, so recalculating after a change cannot rewrite settled history.
 */
function persistForTask(db, guildId, task, actorUserId) {
  const computed = computeForTask(db, guildId, task);
  if (!computed.ok) return computed;

  const existing = db.prepare('SELECT * FROM allocations WHERE task_id = ?').all(task.id);
  const frozen = new Set(existing.filter((row) => row.frozen_at).map((row) => row.recipient_kind));

  db.transaction(() => {
    const upsert = db.prepare(`
      INSERT INTO allocations (task_id, recipient_kind, recipient_user_id, percent_bp, amount_minor, currency, pool_minor, pool_source, computed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (task_id, recipient_kind) DO UPDATE SET
        recipient_user_id = excluded.recipient_user_id,
        percent_bp = excluded.percent_bp,
        amount_minor = excluded.amount_minor,
        currency = excluded.currency,
        pool_minor = excluded.pool_minor,
        pool_source = excluded.pool_source,
        computed_at = excluded.computed_at
      WHERE allocations.frozen_at IS NULL
    `);

    for (const entry of computed.byKind) {
      if (frozen.has(entry.kind)) continue;
      upsert.run(
        task.id, entry.kind, entry.userId, entry.percentBp, entry.amountMinor,
        entry.currency, computed.poolMinor, computed.poolSource, Date.now()
      );
    }

    recordAudit(db, {
      guildId, actorUserId, action: 'allocation.compute', entityType: 'task', entityId: task.id,
      after: {
        pool_minor: computed.poolMinor,
        currency: computed.currency,
        source: computed.poolSource,
        lines: computed.byKind.map((entry) => ({ kind: entry.kind, user: entry.userId, amount: entry.amountMinor })),
      },
      detail: frozen.size > 0 ? `${frozen.size} already-paid line(s) left untouched` : null,
    });
  })();

  return { ok: true, ...computed, frozenKinds: [...frozen] };
}

function listAllocations(db, taskId) {
  return db.prepare('SELECT * FROM allocations WHERE task_id = ? ORDER BY percent_bp DESC').all(taskId);
}

/** Marks a line settled so later recalculation cannot move it. */
function freezeAllocation(db, taskId, recipientKind) {
  db.prepare('UPDATE allocations SET frozen_at = ? WHERE task_id = ? AND recipient_kind = ? AND frozen_at IS NULL')
    .run(Date.now(), taskId, recipientKind);
}

function allocationOutstanding(db, task, allocation) {
  const paid = paymentsRepo.paidForAllocation(db, task.id, allocation.recipient_kind, allocation.recipient_user_id, allocation.currency);
  return Math.max(0, allocation.amount_minor - paid);
}

/**
 * Every unpaid split line across the studio, for the owner's payout view.
 * Only tasks the client has approved are included: unfinished work is not a
 * payout waiting to happen.
 */
function outstandingAllocations(db, guildId) {
  const rows = db.prepare(`
    SELECT a.*, t.code AS task_code, t.title AS task_title, t.payment_state, t.state
    FROM allocations a
    JOIN tasks t ON t.id = a.task_id
    WHERE t.guild_id = ? AND t.state = 'client_approved'
    ORDER BY a.task_id, a.percent_bp DESC
  `).all(guildId);

  return rows
    .map((row) => {
      const paid = paymentsRepo.paidForAllocation(db, row.task_id, row.recipient_kind, row.recipient_user_id, row.currency);
      return { ...row, paid_minor: paid, outstanding_minor: Math.max(0, row.amount_minor - paid) };
    })
    .filter((row) => row.outstanding_minor > 0);
}

module.exports = {
  REASON_TEXT,
  recipientsFor,
  computePool,
  computeForTask,
  persistForTask,
  listAllocations,
  freezeAllocation,
  allocationOutstanding,
  outstandingAllocations,
};
