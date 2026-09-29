const { recordAudit } = require('./core');
const { TASK_STATES } = require('../../domain/taskState');

/** Upstream work counts as ready once it has passed internal review. */
const READY_STATES = [TASK_STATES.AWAITING_CLIENT, TASK_STATES.CLIENT_APPROVED];

// --- templates -----------------------------------------------------------

function upsertTemplate(db, guildId, {
  key, label, departmentId, titlePattern = null, brief = null, deliverables = [],
  formats = null, techRequirements = null, revisionRounds = null, defaultDays = null,
}, actorUserId) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO task_templates (
      guild_id, key, label, department_id, title_pattern, brief, deliverables_json,
      formats, tech_requirements, revision_rounds, default_days, created_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (guild_id, key) DO UPDATE SET
      label = excluded.label, department_id = excluded.department_id,
      title_pattern = excluded.title_pattern, brief = excluded.brief,
      deliverables_json = excluded.deliverables_json, formats = excluded.formats,
      tech_requirements = excluded.tech_requirements, revision_rounds = excluded.revision_rounds,
      default_days = excluded.default_days, updated_at = excluded.updated_at
  `).run(
    guildId, key, label, departmentId, titlePattern, brief, JSON.stringify(deliverables),
    formats, techRequirements, revisionRounds, defaultDays, actorUserId, now, now
  );

  const saved = getTemplate(db, guildId, key);
  recordAudit(db, {
    guildId, actorUserId, action: 'task_template.upsert', entityType: 'task_template', entityId: saved.id,
    after: { key, label },
  });
  return saved;
}

function getTemplate(db, guildId, key) {
  return db.prepare('SELECT * FROM task_templates WHERE guild_id = ? AND key = ?').get(guildId, key) || null;
}

function listTemplates(db, guildId) {
  return db.prepare('SELECT * FROM task_templates WHERE guild_id = ? ORDER BY label').all(guildId);
}

function templateDeliverables(template) {
  try {
    const parsed = JSON.parse(template?.deliverables_json || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function deleteTemplate(db, guildId, key, actorUserId) {
  const result = db.prepare('DELETE FROM task_templates WHERE guild_id = ? AND key = ?').run(guildId, key);
  if (result.changes > 0) {
    recordAudit(db, { guildId, actorUserId, action: 'task_template.delete', entityType: 'task_template', entityId: key });
  }
  return result.changes > 0;
}

// --- dependencies --------------------------------------------------------

/**
 * Records that one task needs another finished first.
 *
 * Refuses a cycle, because a chain that depends on itself can never start and
 * would make "what is ready?" unanswerable.
 */
function addDependency(db, guildId, { taskId, dependsOnTaskId, note = null }, actorUserId) {
  if (taskId === dependsOnTaskId) return { ok: false, reason: 'self_dependency' };
  if (wouldCycle(db, taskId, dependsOnTaskId)) return { ok: false, reason: 'cycle' };

  try {
    const row = db.prepare(`
      INSERT INTO task_dependencies (guild_id, task_id, depends_on_task_id, note, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?) RETURNING *
    `).get(guildId, taskId, dependsOnTaskId, note, actorUserId, Date.now());

    recordAudit(db, {
      guildId, actorUserId, action: 'dependency.add', entityType: 'task', entityId: taskId,
      after: { depends_on: dependsOnTaskId },
    });
    return { ok: true, dependency: row };
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) return { ok: false, reason: 'already_exists' };
    throw error;
  }
}

/** Walks upstream from the proposed prerequisite looking for the task itself. */
function wouldCycle(db, taskId, dependsOnTaskId) {
  const seen = new Set();
  const stack = [dependsOnTaskId];

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === taskId) return true;
    if (seen.has(current)) continue;
    seen.add(current);

    const parents = db.prepare('SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ?').all(current);
    for (const parent of parents) stack.push(parent.depends_on_task_id);
  }
  return false;
}

function removeDependency(db, guildId, taskId, dependsOnTaskId, actorUserId) {
  const result = db.prepare('DELETE FROM task_dependencies WHERE task_id = ? AND depends_on_task_id = ?')
    .run(taskId, dependsOnTaskId);
  if (result.changes > 0) {
    recordAudit(db, {
      guildId, actorUserId, action: 'dependency.remove', entityType: 'task', entityId: taskId,
      before: { depends_on: dependsOnTaskId },
    });
  }
  return result.changes > 0;
}

function dependenciesOf(db, taskId) {
  return db.prepare(`
    SELECT d.*, t.code, t.title, t.state, t.deadline_utc, t.department_id
    FROM task_dependencies d
    JOIN tasks t ON t.id = d.depends_on_task_id
    WHERE d.task_id = ?
    ORDER BY t.id
  `).all(taskId);
}

function dependentsOf(db, taskId) {
  return db.prepare(`
    SELECT d.*, t.code, t.title, t.state, t.deadline_utc, t.department_id, t.leader_user_id, t.artist_user_id
    FROM task_dependencies d
    JOIN tasks t ON t.id = d.task_id
    WHERE d.depends_on_task_id = ?
    ORDER BY t.id
  `).all(taskId);
}

/** Prerequisites not yet past internal review. */
function unmetDependencies(db, taskId) {
  return dependenciesOf(db, taskId).filter((dep) => !READY_STATES.includes(dep.state) && !dep.delivered_at);
}

/**
 * Downstream tasks whose prerequisite is late.
 *
 * Reported rather than acted on: the bot never moves a deadline on its own,
 * because the consequences of a slip are a human decision.
 */
function downstreamAtRisk(db, guildId, { now = Date.now() } = {}) {
  const rows = db.prepare(`
    SELECT d.task_id, d.depends_on_task_id,
           down.code AS down_code, down.title AS down_title, down.deadline_utc AS down_deadline,
           down.leader_user_id AS down_leader, down.department_id AS down_department,
           up.code AS up_code, up.title AS up_title, up.state AS up_state, up.deadline_utc AS up_deadline
    FROM task_dependencies d
    JOIN tasks down ON down.id = d.task_id
    JOIN tasks up ON up.id = d.depends_on_task_id
    WHERE d.guild_id = ? AND down.state NOT IN ('cancelled', 'client_approved')
  `).all(guildId);

  return rows.filter((row) => {
    const upstreamReady = READY_STATES.includes(row.up_state);
    if (upstreamReady) return false;
    // At risk when the prerequisite is already late, or when it is due after
    // the work that depends on it.
    const upstreamLate = row.up_deadline && row.up_deadline < now;
    const orderWrong = row.up_deadline && row.down_deadline && row.up_deadline > row.down_deadline;
    return Boolean(upstreamLate || orderWrong);
  });
}

/** Dependencies that have just become ready and whose team has not been told. */
function newlyReadyDependencies(db, guildId) {
  const placeholders = READY_STATES.map(() => '?').join(', ');
  return db.prepare(`
    SELECT d.*, up.code AS up_code, up.title AS up_title, up.state AS up_state,
           down.code AS down_code, down.title AS down_title, down.department_id AS down_department,
           down.leader_user_id AS down_leader, down.artist_user_id AS down_artist, down.state AS down_state
    FROM task_dependencies d
    JOIN tasks up ON up.id = d.depends_on_task_id
    JOIN tasks down ON down.id = d.task_id
    WHERE d.guild_id = ? AND d.notified_at IS NULL AND up.state IN (${placeholders})
  `).all(guildId, ...READY_STATES);
}

function markDependencyNotified(db, dependencyId) {
  db.prepare('UPDATE task_dependencies SET notified_at = ? WHERE id = ?').run(Date.now(), dependencyId);
}

// --- blockers ------------------------------------------------------------

function raiseBlocker(db, guildId, { taskId, raisedBy, reason, attachment = null }) {
  const blocker = db.prepare(`
    INSERT INTO task_blockers (guild_id, task_id, raised_by, reason, attachment, created_at)
    VALUES (?, ?, ?, ?, ?, ?) RETURNING *
  `).get(guildId, taskId, raisedBy, reason, attachment, Date.now());

  recordAudit(db, {
    guildId, actorUserId: raisedBy, action: 'blocker.raise', entityType: 'task', entityId: taskId,
    after: { blocker_id: blocker.id }, detail: reason,
  });
  return blocker;
}

function clearBlocker(db, guildId, blockerId, { actorUserId, resolution = null }) {
  const result = db.prepare(`
    UPDATE task_blockers SET status = 'cleared', resolution = ?, cleared_by = ?, cleared_at = ?
    WHERE id = ? AND status = 'open'
  `).run(resolution, actorUserId, Date.now(), blockerId);

  if (result.changes === 0) return null;

  const blocker = db.prepare('SELECT * FROM task_blockers WHERE id = ?').get(blockerId);
  recordAudit(db, {
    guildId, actorUserId, action: 'blocker.clear', entityType: 'task', entityId: blocker.task_id,
    after: { blocker_id: blockerId }, detail: resolution,
  });
  return blocker;
}

function openBlockersForTask(db, taskId) {
  return db.prepare("SELECT * FROM task_blockers WHERE task_id = ? AND status = 'open' ORDER BY created_at").all(taskId);
}

function listOpenBlockers(db, guildId, { departmentId = null } = {}) {
  if (departmentId !== null) {
    return db.prepare(`
      SELECT b.*, t.code, t.title, t.department_id, t.leader_user_id
      FROM task_blockers b JOIN tasks t ON t.id = b.task_id
      WHERE b.guild_id = ? AND b.status = 'open' AND t.department_id = ?
      ORDER BY b.created_at
    `).all(guildId, departmentId);
  }
  return db.prepare(`
    SELECT b.*, t.code, t.title, t.department_id, t.leader_user_id
    FROM task_blockers b JOIN tasks t ON t.id = b.task_id
    WHERE b.guild_id = ? AND b.status = 'open'
    ORDER BY b.created_at
  `).all(guildId);
}

// --- deadline changes ----------------------------------------------------

function requestDeadlineChange(db, guildId, { taskId, requestedBy, previousDeadline, requestedDeadline, reason }) {
  const request = db.prepare(`
    INSERT INTO deadline_requests (guild_id, task_id, requested_by, previous_deadline, requested_deadline, reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *
  `).get(guildId, taskId, requestedBy, previousDeadline, requestedDeadline, reason, Date.now());

  recordAudit(db, {
    guildId, actorUserId: requestedBy, action: 'deadline.request', entityType: 'task', entityId: taskId,
    before: { deadline_utc: previousDeadline }, after: { requested: requestedDeadline }, detail: reason,
  });
  return request;
}

/**
 * Approving applies the new date and keeps the old one on the request, so what
 * was originally agreed and who changed it stay visible.
 */
function decideDeadlineRequest(db, guildId, requestId, { approve, actorUserId, note = null }) {
  const request = db.prepare('SELECT * FROM deadline_requests WHERE guild_id = ? AND id = ?').get(guildId, requestId);
  if (!request || request.status !== 'pending') return null;

  return db.transaction(() => {
    db.prepare(`
      UPDATE deadline_requests SET status = ?, decided_by = ?, decided_at = ?, decision_note = ?
      WHERE id = ?
    `).run(approve ? 'approved' : 'declined', actorUserId, Date.now(), note, requestId);

    if (approve) {
      db.prepare('UPDATE tasks SET deadline_utc = ?, updated_at = ? WHERE id = ?')
        .run(request.requested_deadline, Date.now(), request.task_id);
    }

    recordAudit(db, {
      guildId, actorUserId, action: approve ? 'deadline.approve' : 'deadline.decline',
      entityType: 'task', entityId: request.task_id,
      before: { deadline_utc: request.previous_deadline },
      after: approve ? { deadline_utc: request.requested_deadline } : { deadline_utc: request.previous_deadline },
      detail: note,
    });

    return db.prepare('SELECT * FROM deadline_requests WHERE id = ?').get(requestId);
  })();
}

function listDeadlineRequests(db, guildId, { status = 'pending', departmentId = null, limit = 25 } = {}) {
  const clauses = ['r.guild_id = ?'];
  const params = [guildId];

  if (status !== 'all') { clauses.push('r.status = ?'); params.push(status); }
  if (departmentId !== null) { clauses.push('t.department_id = ?'); params.push(departmentId); }

  return db.prepare(`
    SELECT r.*, t.code, t.title, t.department_id, t.leader_user_id
    FROM deadline_requests r JOIN tasks t ON t.id = r.task_id
    WHERE ${clauses.join(' AND ')}
    ORDER BY r.created_at DESC LIMIT ?
  `).all(...params, limit);
}

function deadlineHistory(db, taskId) {
  return db.prepare("SELECT * FROM deadline_requests WHERE task_id = ? AND status = 'approved' ORDER BY decided_at").all(taskId);
}

module.exports = {
  READY_STATES,
  upsertTemplate,
  getTemplate,
  listTemplates,
  templateDeliverables,
  deleteTemplate,
  addDependency,
  wouldCycle,
  removeDependency,
  dependenciesOf,
  dependentsOf,
  unmetDependencies,
  downstreamAtRisk,
  newlyReadyDependencies,
  markDependencyNotified,
  raiseBlocker,
  clearBlocker,
  openBlockersForTask,
  listOpenBlockers,
  requestDeadlineChange,
  decideDeadlineRequest,
  listDeadlineRequests,
  deadlineHistory,
};
