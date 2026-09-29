const { nextCode, recordAudit, claimGuard } = require('./core');
const { assertTransition, nextState, TASK_STATES, ACTIVE_STATES } = require('../../domain/taskState');

const EDITABLE_FIELDS = [
  'title', 'brief', 'deliverables_json', 'formats', 'reference_links',
  'tech_requirements', 'deadline_utc', 'revision_rounds', 'revision_notes',
  'client_price_minor', 'client_price_currency', 'leader_user_id',
];

const PAY_STATES = Object.freeze({ UNSET: 'unset', PROPOSED: 'proposed', APPROVED: 'approved' });
const PAYMENT_STATES = Object.freeze({
  PENDING_CLIENT_PAYMENT: 'pending_client_payment',
  PAYABLE: 'payable',
  PARTIALLY_PAID: 'partially_paid',
  PAID: 'paid',
});

class DuplicateActionError extends Error {
  constructor(message = 'That has already been done.') {
    super(message);
    this.name = 'DuplicateActionError';
  }
}

function createTask(db, guildId, {
  projectId,
  title,
  departmentId,
  brief = null,
  deliverables = [],
  formats = null,
  referenceLinks = null,
  techRequirements = null,
  deadlineUtc = null,
  revisionRounds = null,
  revisionNotes = null,
  leaderUserId = null,
  clientPriceMinor = null,
  clientPriceCurrency = null,
}, actorUserId) {
  return db.transaction(() => {
    const now = Date.now();
    const code = nextCode(db, guildId, 'task');

    const task = db.prepare(`
      INSERT INTO tasks (
        guild_id, project_id, code, title, brief, department_id, deliverables_json,
        formats, reference_links, tech_requirements, deadline_utc, revision_rounds,
        revision_notes, leader_user_id, client_price_minor, client_price_currency,
        created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING *
    `).get(
      guildId, projectId, code, title, brief, departmentId, JSON.stringify(deliverables),
      formats, referenceLinks, techRequirements, deadlineUtc, revisionRounds,
      revisionNotes, leaderUserId, clientPriceMinor, clientPriceCurrency,
      actorUserId, now, now
    );

    recordAudit(db, {
      guildId, actorUserId, action: 'task.create', entityType: 'task', entityId: task.id,
      after: { code: task.code, title, department_id: departmentId, project_id: projectId },
    });
    return task;
  })();
}

function getTask(db, guildId, id) {
  return db.prepare('SELECT * FROM tasks WHERE guild_id = ? AND id = ?').get(guildId, id) || null;
}

function getTaskByCode(db, guildId, code) {
  return db.prepare('SELECT * FROM tasks WHERE guild_id = ? AND code = ?').get(guildId, String(code).toUpperCase()) || null;
}

function listTasksForProject(db, projectId) {
  return db.prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY id').all(projectId);
}

function listQueue(db, guildId, departmentId) {
  return db.prepare(`
    SELECT * FROM tasks
    WHERE guild_id = ? AND department_id = ? AND state = ?
    ORDER BY COALESCE(deadline_utc, 9e15), id
  `).all(guildId, departmentId, TASK_STATES.UNASSIGNED);
}

function listTasksForArtist(db, guildId, artistUserId, { states = ACTIVE_STATES } = {}) {
  const placeholders = states.map(() => '?').join(', ');
  return db.prepare(`
    SELECT * FROM tasks
    WHERE guild_id = ? AND artist_user_id = ? AND state IN (${placeholders})
    ORDER BY COALESCE(deadline_utc, 9e15), id
  `).all(guildId, artistUserId, ...states);
}

function listTasksInStates(db, guildId, states) {
  const placeholders = states.map(() => '?').join(', ');
  return db.prepare(`
    SELECT * FROM tasks WHERE guild_id = ? AND state IN (${placeholders})
    ORDER BY COALESCE(deadline_utc, 9e15), id
  `).all(guildId, ...states);
}

function searchTasks(db, guildId, query, { limit = 25, departmentId = null, states = null } = {}) {
  const like = `%${String(query || '').toLowerCase()}%`;
  const clauses = ['guild_id = ?', '(LOWER(code) LIKE ? OR LOWER(title) LIKE ?)'];
  const params = [guildId, like, like];

  if (departmentId !== null) { clauses.push('department_id = ?'); params.push(departmentId); }
  if (states) {
    clauses.push(`state IN (${states.map(() => '?').join(', ')})`);
    params.push(...states);
  }

  return db.prepare(`SELECT * FROM tasks WHERE ${clauses.join(' AND ')} ORDER BY id DESC LIMIT ?`)
    .all(...params, limit);
}

function updateTask(db, guildId, id, patch, actorUserId, { action = 'task.update' } = {}) {
  const before = getTask(db, guildId, id);
  if (!before) return null;

  const entries = Object.entries(patch).filter(([key]) => EDITABLE_FIELDS.includes(key));
  if (entries.length === 0) return before;

  db.prepare(`UPDATE tasks SET ${entries.map(([key]) => `${key} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
    .run(...entries.map(([, value]) => value), Date.now(), id);

  const after = getTask(db, guildId, id);
  recordAudit(db, {
    guildId, actorUserId, action, entityType: 'task', entityId: id,
    before: Object.fromEntries(entries.map(([key]) => [key, before[key]])),
    after: Object.fromEntries(entries.map(([key]) => [key, after[key]])),
  });
  return after;
}

/**
 * The single place a task changes state.
 *
 * The state is re-read and checked inside the transaction, so two clicks
 * racing each other cannot both succeed: the second no longer matches a legal
 * "from" state. An optional guard key additionally rejects the exact same
 * click being replayed.
 */
function applyTransition(db, guildId, taskId, action, {
  actorUserId,
  patch = {},
  guardKey = null,
  detail = null,
} = {}) {
  return db.transaction(() => {
    if (guardKey && !claimGuard(db, guardKey)) {
      throw new DuplicateActionError('That action was already recorded.');
    }

    const before = getTask(db, guildId, taskId);
    if (!before) throw new Error('Task not found.');

    assertTransition(action, before.state);
    const state = nextState(action);

    const columns = { ...patch, state };
    if (state === TASK_STATES.CANCELLED) columns.cancelled_at = Date.now();
    if (state === TASK_STATES.CLIENT_APPROVED) columns.completed_at = Date.now();

    const keys = Object.keys(columns);
    db.prepare(`UPDATE tasks SET ${keys.map((key) => `${key} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...keys.map((key) => columns[key]), Date.now(), taskId);

    const after = getTask(db, guildId, taskId);
    recordAudit(db, {
      guildId, actorUserId, action: `task.${action}`, entityType: 'task', entityId: taskId,
      before: { state: before.state, artist_user_id: before.artist_user_id },
      after: { state: after.state, artist_user_id: after.artist_user_id },
      detail,
    });
    return after;
  })();
}

function proposePay(db, guildId, taskId, { amountMinor, currency, actorUserId }) {
  const before = getTask(db, guildId, taskId);
  if (!before) return null;

  db.prepare(`
    UPDATE tasks SET pay_proposed_minor = ?, pay_proposed_currency = ?, pay_proposed_by = ?,
      pay_proposed_at = ?, pay_state = ?, updated_at = ?
    WHERE id = ?
  `).run(amountMinor, currency, actorUserId, Date.now(), PAY_STATES.PROPOSED, Date.now(), taskId);

  const after = getTask(db, guildId, taskId);
  recordAudit(db, {
    guildId, actorUserId, action: 'task.pay.propose', entityType: 'task', entityId: taskId,
    before: { pay_state: before.pay_state, pay_proposed_minor: before.pay_proposed_minor },
    after: { pay_state: after.pay_state, pay_proposed_minor: after.pay_proposed_minor, currency },
    detail: 'Proposal only; the owner sets the agreed pay.',
  });
  return after;
}

/**
 * Only ever called for the owner. Records a term change for acknowledgement if
 * the task has already been accepted at a different figure.
 */
function approvePay(db, guildId, taskId, { amountMinor, currency, actorUserId }) {
  return db.transaction(() => {
    const before = getTask(db, guildId, taskId);
    if (!before) return null;

    const changed = before.pay_state === PAY_STATES.APPROVED &&
      (before.artist_pay_minor !== amountMinor || before.artist_pay_currency !== currency);

    db.prepare(`
      UPDATE tasks SET artist_pay_minor = ?, artist_pay_currency = ?, pay_state = ?,
        pay_approved_by = ?, pay_approved_at = ?, updated_at = ?
      WHERE id = ?
    `).run(amountMinor, currency, PAY_STATES.APPROVED, actorUserId, Date.now(), Date.now(), taskId);

    if (changed && before.artist_user_id) {
      recordTermChange(db, taskId, {
        field: 'artist_pay',
        oldValue: `${before.artist_pay_minor} ${before.artist_pay_currency}`,
        newValue: `${amountMinor} ${currency}`,
        changedBy: actorUserId,
      });
    }

    const after = getTask(db, guildId, taskId);
    recordAudit(db, {
      guildId, actorUserId, action: 'task.pay.approve', entityType: 'task', entityId: taskId,
      before: { artist_pay_minor: before.artist_pay_minor, artist_pay_currency: before.artist_pay_currency, pay_state: before.pay_state },
      after: { artist_pay_minor: amountMinor, artist_pay_currency: currency, pay_state: PAY_STATES.APPROVED },
    });
    return { task: after, requiresAcknowledgement: Boolean(changed && before.artist_user_id) };
  })();
}

function isPayApproved(task) {
  return task.pay_state === PAY_STATES.APPROVED &&
    task.artist_pay_minor !== null &&
    Boolean(task.artist_pay_currency);
}

function recordTermChange(db, taskId, { field, oldValue, newValue, changedBy }) {
  return db.prepare(`
    INSERT INTO task_term_changes (task_id, field, old_value, new_value, changed_by, changed_at)
    VALUES (?, ?, ?, ?, ?, ?) RETURNING *
  `).get(taskId, field, oldValue === null ? null : String(oldValue), newValue === null ? null : String(newValue), changedBy, Date.now());
}

function acknowledgeTermChanges(db, taskId, userId) {
  const result = db.prepare(`
    UPDATE task_term_changes SET acknowledged_by = ?, acknowledged_at = ?
    WHERE task_id = ? AND acknowledged_at IS NULL
  `).run(userId, Date.now(), taskId);
  return result.changes;
}

function unacknowledgedTermChanges(db, taskId) {
  return db.prepare('SELECT * FROM task_term_changes WHERE task_id = ? AND acknowledged_at IS NULL ORDER BY changed_at').all(taskId);
}

/** A snapshot of what an artist is agreeing to, stored with their acceptance. */
function termsSnapshot(task) {
  return {
    code: task.code,
    title: task.title,
    deadline_utc: task.deadline_utc,
    artist_pay_minor: task.artist_pay_minor,
    artist_pay_currency: task.artist_pay_currency,
    revision_rounds: task.revision_rounds,
    revision_notes: task.revision_notes,
    deliverables: deliverables(task),
  };
}

function deliverables(task) {
  try {
    const parsed = JSON.parse(task?.deliverables_json || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function setDeliverables(db, guildId, taskId, items, actorUserId) {
  return updateTask(db, guildId, taskId, { deliverables_json: JSON.stringify(items) }, actorUserId, { action: 'task.deliverables' });
}

function touchProgress(db, taskId) {
  db.prepare('UPDATE tasks SET last_progress_at = ?, updated_at = ? WHERE id = ?').run(Date.now(), Date.now(), taskId);
}

function setFlag(db, guildId, taskId, flag, value, actorUserId, detail = null) {
  const column = flag === 'scope' ? 'scope_review_flag' : 'compensation_review_flag';
  db.prepare(`UPDATE tasks SET ${column} = ?, updated_at = ? WHERE id = ?`).run(value ? 1 : 0, Date.now(), taskId);
  recordAudit(db, {
    guildId, actorUserId, action: `task.flag.${flag}`, entityType: 'task', entityId: taskId,
    after: { [column]: value ? 1 : 0 }, detail,
  });
  return getTask(db, guildId, taskId);
}

function setPaymentState(db, guildId, taskId, paymentState, actorUserId, detail = null) {
  const before = getTask(db, guildId, taskId);
  if (!before || before.payment_state === paymentState) return before;

  db.prepare('UPDATE tasks SET payment_state = ?, updated_at = ? WHERE id = ?').run(paymentState, Date.now(), taskId);
  recordAudit(db, {
    guildId, actorUserId, action: 'task.payment_state', entityType: 'task', entityId: taskId,
    before: { payment_state: before.payment_state }, after: { payment_state: paymentState }, detail,
  });
  return getTask(db, guildId, taskId);
}

function overridePayable(db, guildId, taskId, { actorUserId, reason }) {
  db.prepare(`
    UPDATE tasks SET payment_state = ?, payable_override_by = ?, payable_override_reason = ?,
      payable_override_at = ?, updated_at = ?
    WHERE id = ?
  `).run(PAYMENT_STATES.PAYABLE, actorUserId, reason, Date.now(), Date.now(), taskId);

  recordAudit(db, {
    guildId, actorUserId, action: 'task.payable.override', entityType: 'task', entityId: taskId,
    after: { payment_state: PAYMENT_STATES.PAYABLE, reason },
    detail: 'Marked payable before the client payment was recorded as received.',
  });
  return getTask(db, guildId, taskId);
}

function assignArtist(db, guildId, taskId, artistUserId, actorUserId) {
  db.prepare('UPDATE tasks SET artist_user_id = ?, updated_at = ? WHERE id = ?').run(artistUserId, Date.now(), taskId);
  recordAudit(db, {
    guildId, actorUserId, action: 'task.artist.set', entityType: 'task', entityId: taskId,
    after: { artist_user_id: artistUserId },
  });
  return getTask(db, guildId, taskId);
}

module.exports = {
  EDITABLE_FIELDS,
  PAY_STATES,
  PAYMENT_STATES,
  DuplicateActionError,
  createTask,
  getTask,
  getTaskByCode,
  listTasksForProject,
  listQueue,
  listTasksForArtist,
  listTasksInStates,
  searchTasks,
  updateTask,
  applyTransition,
  proposePay,
  approvePay,
  isPayApproved,
  recordTermChange,
  acknowledgeTermChanges,
  unacknowledgedTermChanges,
  termsSnapshot,
  deliverables,
  setDeliverables,
  touchProgress,
  setFlag,
  setPaymentState,
  overridePayable,
  assignArtist,
};
