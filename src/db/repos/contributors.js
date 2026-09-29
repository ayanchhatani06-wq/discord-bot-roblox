const { recordAudit } = require('./core');

const PAY_STATES = Object.freeze({ UNSET: 'unset', PROPOSED: 'proposed', APPROVED: 'approved' });

function listForTask(db, taskId, { includeRemoved = false } = {}) {
  const sql = includeRemoved
    ? 'SELECT * FROM task_contributors WHERE task_id = ? ORDER BY is_primary DESC, added_at'
    : 'SELECT * FROM task_contributors WHERE task_id = ? AND removed_at IS NULL ORDER BY is_primary DESC, added_at';
  return db.prepare(sql).all(taskId);
}

function getContributor(db, taskId, userId) {
  return db.prepare('SELECT * FROM task_contributors WHERE task_id = ? AND user_id = ?').get(taskId, userId) || null;
}

function hasContributors(db, taskId) {
  return db.prepare('SELECT COUNT(*) AS n FROM task_contributors WHERE task_id = ? AND removed_at IS NULL').get(taskId).n > 0;
}

/**
 * Moves a task from the single-artist path to the contributor model.
 *
 * The existing artist and their agreed pay become the primary contributor row,
 * so nobody is counted twice and nothing about their terms changes.
 */
function ensurePrimaryContributor(db, guildId, task, actorUserId) {
  if (!task.artist_user_id) return null;
  const existing = getContributor(db, task.id, task.artist_user_id);
  if (existing) return existing;

  const now = Date.now();
  return db.prepare(`
    INSERT INTO task_contributors (
      guild_id, task_id, user_id, responsibility, is_primary, pay_minor, pay_currency,
      pay_state, approved_by, approved_at, accepted_at, accepted_terms_json, added_by, added_at
    ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING *
  `).get(
    guildId, task.id, task.artist_user_id, 'Main work',
    task.artist_pay_minor, task.artist_pay_currency,
    task.artist_pay_minor === null ? PAY_STATES.UNSET : PAY_STATES.APPROVED,
    task.pay_approved_by, task.pay_approved_at, task.accepted_at, task.accepted_terms_json,
    actorUserId, now
  );
}

function addContributor(db, guildId, task, { userId, responsibility, actorUserId }) {
  return db.transaction(() => {
    // Adding a second person converts the task, so the first one is preserved.
    ensurePrimaryContributor(db, guildId, task, actorUserId);

    const existing = getContributor(db, task.id, userId);
    if (existing && !existing.removed_at) return { ok: false, reason: 'already_contributor' };

    if (existing) {
      db.prepare(`
        UPDATE task_contributors SET removed_at = NULL, responsibility = ?, added_by = ?, added_at = ?
        WHERE id = ?
      `).run(responsibility, actorUserId, Date.now(), existing.id);
      recordAudit(db, {
        guildId, actorUserId, action: 'contributor.restore', entityType: 'task', entityId: task.id,
        after: { user_id: userId, responsibility },
      });
      return { ok: true, contributor: getContributor(db, task.id, userId) };
    }

    const contributor = db.prepare(`
      INSERT INTO task_contributors (guild_id, task_id, user_id, responsibility, added_by, added_at)
      VALUES (?, ?, ?, ?, ?, ?) RETURNING *
    `).get(guildId, task.id, userId, responsibility, actorUserId, Date.now());

    recordAudit(db, {
      guildId, actorUserId, action: 'contributor.add', entityType: 'task', entityId: task.id,
      after: { user_id: userId, responsibility },
    });
    return { ok: true, contributor };
  })();
}

function removeContributor(db, guildId, taskId, userId, actorUserId) {
  const contributor = getContributor(db, taskId, userId);
  if (!contributor || contributor.removed_at) return { ok: false, reason: 'not_a_contributor' };
  if (contributor.is_primary) return { ok: false, reason: 'primary_contributor' };

  db.prepare('UPDATE task_contributors SET removed_at = ? WHERE id = ?').run(Date.now(), contributor.id);
  recordAudit(db, {
    guildId, actorUserId, action: 'contributor.remove', entityType: 'task', entityId: taskId,
    before: { user_id: userId, responsibility: contributor.responsibility },
  });
  return { ok: true, contributor: getContributor(db, taskId, userId) };
}

function proposePay(db, guildId, taskId, userId, { amountMinor, currency, actorUserId }) {
  const result = db.prepare(`
    UPDATE task_contributors SET proposed_minor = ?, proposed_currency = ?, proposed_by = ?,
      proposed_at = ?, pay_state = ?
    WHERE task_id = ? AND user_id = ? AND removed_at IS NULL
  `).run(amountMinor, currency, actorUserId, Date.now(), PAY_STATES.PROPOSED, taskId, userId);

  if (result.changes === 0) return null;

  recordAudit(db, {
    guildId, actorUserId, action: 'contributor.pay.propose', entityType: 'task', entityId: taskId,
    after: { user_id: userId, proposed_minor: amountMinor, currency },
    detail: 'Proposal only; the owner sets agreed pay.',
  });
  return getContributor(db, taskId, userId);
}

/**
 * Only the owner reaches this. Each contributor's terms are approved on their
 * own, so one person's rate is never implied by another's.
 */
function approvePay(db, guildId, taskId, userId, { amountMinor, currency, actorUserId }) {
  const before = getContributor(db, taskId, userId);
  if (!before || before.removed_at) return null;

  const changed = before.pay_state === PAY_STATES.APPROVED &&
    (before.pay_minor !== amountMinor || before.pay_currency !== currency);

  db.prepare(`
    UPDATE task_contributors SET pay_minor = ?, pay_currency = ?, pay_state = ?, approved_by = ?, approved_at = ?
    WHERE id = ?
  `).run(amountMinor, currency, PAY_STATES.APPROVED, actorUserId, Date.now(), before.id);

  recordAudit(db, {
    guildId, actorUserId, action: 'contributor.pay.approve', entityType: 'task', entityId: taskId,
    before: { user_id: userId, pay_minor: before.pay_minor, pay_currency: before.pay_currency },
    after: { user_id: userId, pay_minor: amountMinor, pay_currency: currency },
  });

  return { contributor: getContributor(db, taskId, userId), requiresAcknowledgement: Boolean(changed && before.accepted_at) };
}

function recordAcceptance(db, taskId, userId, termsJson) {
  db.prepare(`
    UPDATE task_contributors SET accepted_at = ?, accepted_terms_json = ?
    WHERE task_id = ? AND user_id = ? AND removed_at IS NULL
  `).run(Date.now(), termsJson, taskId, userId);
  return getContributor(db, taskId, userId);
}

/**
 * What this task costs in artist pay.
 *
 * Contributors win when any exist; otherwise the single-artist column applies.
 * Returned per currency, because contributors may legitimately be paid in
 * different ones and those totals must never be added together.
 */
function costByCurrency(db, task) {
  const contributors = listForTask(db, task.id);

  if (contributors.length === 0) {
    if (task.artist_pay_minor === null || !task.artist_pay_currency) return new Map();
    return new Map([[task.artist_pay_currency, task.artist_pay_minor]]);
  }

  const totals = new Map();
  for (const contributor of contributors) {
    if (contributor.pay_minor === null || !contributor.pay_currency) continue;
    totals.set(contributor.pay_currency, (totals.get(contributor.pay_currency) || 0) + contributor.pay_minor);
  }
  return totals;
}

/** Contributors still without approved pay, which blocks offering the work. */
function unapproved(db, taskId) {
  return listForTask(db, taskId).filter((row) => row.pay_state !== PAY_STATES.APPROVED || row.pay_minor === null);
}

function listForUser(db, guildId, userId, { limit = 50 } = {}) {
  return db.prepare(`
    SELECT c.*, t.code, t.title, t.state, t.payment_state
    FROM task_contributors c
    JOIN tasks t ON t.id = c.task_id
    WHERE c.guild_id = ? AND c.user_id = ? AND c.removed_at IS NULL
    ORDER BY c.added_at DESC LIMIT ?
  `).all(guildId, userId, limit);
}

module.exports = {
  PAY_STATES,
  listForTask,
  getContributor,
  hasContributors,
  ensurePrimaryContributor,
  addContributor,
  removeContributor,
  proposePay,
  approvePay,
  recordAcceptance,
  costByCurrency,
  unapproved,
  listForUser,
};
