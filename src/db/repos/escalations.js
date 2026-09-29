const { recordAudit } = require('./core');

const CATEGORIES = Object.freeze({
  ASSIGNMENT: 'assignment',
  PAYMENT: 'payment',
  WORKLOAD: 'workload',
  CONDUCT: 'conduct',
  OTHER: 'other',
});

const CATEGORY_LABELS = Object.freeze({
  assignment: 'Assignment or reassignment',
  payment: 'Pay or a missing payment',
  workload: 'Workload or capacity',
  conduct: 'Conduct',
  other: 'Something else',
});

/**
 * A staff member raising a concern privately.
 *
 * These never route through a group leader. A concern about an assignment is
 * often a concern about the person who made it, so sending it to them would
 * defeat the point; it goes to the owner instead.
 */
function raise(db, guildId, { raisedBy, category, subject, body, taskId = null, aboutUserId = null }) {
  const escalation = db.prepare(`
    INSERT INTO staff_escalations (guild_id, raised_by, category, subject, body, task_id, about_user_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *
  `).get(guildId, raisedBy, category, subject, body, taskId, aboutUserId, Date.now());

  // The audit entry deliberately records that something was raised, not its
  // contents, so the detail stays between the raiser and the owner.
  recordAudit(db, {
    guildId,
    actorUserId: raisedBy,
    action: 'escalation.raise',
    entityType: 'escalation',
    entityId: escalation.id,
    after: { category },
  });
  return escalation;
}

function get(db, guildId, id) {
  return db.prepare('SELECT * FROM staff_escalations WHERE guild_id = ? AND id = ?').get(guildId, id) || null;
}

function list(db, guildId, { status = 'open', limit = 25 } = {}) {
  if (status === 'all') {
    return db.prepare('SELECT * FROM staff_escalations WHERE guild_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(guildId, limit);
  }
  return db.prepare('SELECT * FROM staff_escalations WHERE guild_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?')
    .all(guildId, status, limit);
}

function listForRaiser(db, guildId, raisedBy, { limit = 25 } = {}) {
  return db.prepare(`
    SELECT * FROM staff_escalations WHERE guild_id = ? AND raised_by = ?
    ORDER BY created_at DESC LIMIT ?
  `).all(guildId, raisedBy, limit);
}

function acknowledge(db, guildId, id, actorUserId) {
  const result = db.prepare(`
    UPDATE staff_escalations SET status = 'acknowledged', acknowledged_at = ?, acknowledged_by = ?
    WHERE guild_id = ? AND id = ? AND status = 'open'
  `).run(Date.now(), actorUserId, guildId, id);

  if (result.changes > 0) {
    recordAudit(db, {
      guildId, actorUserId, action: 'escalation.acknowledge', entityType: 'escalation', entityId: id,
    });
  }
  return get(db, guildId, id);
}

function resolve(db, guildId, id, { status = 'resolved', resolution, actorUserId }) {
  db.prepare(`
    UPDATE staff_escalations SET status = ?, resolution = ?, resolved_by = ?, resolved_at = ?
    WHERE guild_id = ? AND id = ?
  `).run(status, resolution, actorUserId, Date.now(), guildId, id);

  recordAudit(db, {
    guildId, actorUserId, action: 'escalation.resolve', entityType: 'escalation', entityId: id,
    after: { status },
  });
  return get(db, guildId, id);
}

function openCount(db, guildId) {
  return db.prepare("SELECT COUNT(*) AS n FROM staff_escalations WHERE guild_id = ? AND status IN ('open', 'acknowledged')")
    .get(guildId).n;
}

module.exports = { CATEGORIES, CATEGORY_LABELS, raise, get, list, listForRaiser, acknowledge, resolve, openCount };
