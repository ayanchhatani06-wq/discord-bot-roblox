const tasksRepo = require('../db/repos/tasks');
const projectsRepo = require('../db/repos/projects');
const configRepo = require('../db/repos/config');
const submissionsRepo = require('../db/repos/submissions');
const assetsRepo = require('../db/repos/assets');
const { recordAudit } = require('../db/repos/core');
const { TASK_STATES } = require('../domain/taskState');

const DEFAULT_CONDITIONS = Object.freeze({
  require_client_approval: true,
  require_client_paid: false,
  require_checklist_complete: true,
});

function deliveryConditions(config) {
  try {
    const parsed = JSON.parse(config?.delivery_conditions_json || '{}');
    return { ...DEFAULT_CONDITIONS, ...parsed };
  } catch {
    return { ...DEFAULT_CONDITIONS };
  }
}

function setDeliveryConditions(db, guildId, conditions, actorUserId) {
  const merged = { ...DEFAULT_CONDITIONS, ...conditions };
  db.prepare('UPDATE guild_config SET delivery_conditions_json = ?, updated_at = ? WHERE guild_id = ?')
    .run(JSON.stringify(merged), Date.now(), guildId);

  recordAudit(db, {
    guildId, actorUserId, action: 'config.delivery_conditions', entityType: 'guild', entityId: guildId, after: merged,
  });
  return merged;
}

/**
 * Whether this task may be released, against the studio's configured
 * conditions.
 *
 * Checks that the required files exist and that the checklist was completed.
 * It does not and cannot judge whether the work is any good: that is what the
 * leader's internal review and the client's approval are for, and claiming
 * otherwise would be dishonest.
 */
function checkDeliveryReadiness(db, guildId, task) {
  const config = configRepo.getConfig(db, guildId);
  const conditions = deliveryConditions(config);
  const project = projectsRepo.getProject(db, guildId, task.project_id);
  const submission = submissionsRepo.latestSubmission(db, task.id, { kind: 'final' });

  const blockers = [];
  const warnings = [];

  if (task.delivered_at) {
    return { ok: false, alreadyDelivered: true, blockers: ['This item has already been delivered.'], warnings, submission, conditions };
  }

  if (!submission) {
    blockers.push('No final submission exists for this item.');
  }

  if (conditions.require_client_approval && task.state !== TASK_STATES.CLIENT_APPROVED) {
    blockers.push('The client has not approved this item yet.');
  }

  if (conditions.require_client_paid && project) {
    if (!projectsRepo.isClientPaidInFull(db, project)) {
      blockers.push(`The client payment for ${project.code} is not recorded as received in full.`);
    }
  }

  if (conditions.require_checklist_complete && submission) {
    const checklist = submissionsRepo.checklist(submission);
    const missing = checklist.filter((entry) => entry && entry.included === false);
    if (missing.length > 0) {
      blockers.push(`Deliverables not marked complete: ${missing.map((entry) => entry.item).join(', ')}.`);
    }
    if (checklist.length === 0) {
      warnings.push('This submission carries no deliverables checklist, so nothing could be verified against one.');
    }
  }

  const deliverables = submission
    ? assetsRepo.listForTask(db, task.id, { kind: assetsRepo.KINDS.DELIVERABLE }).filter((asset) => asset.version === submission.version)
    : [];

  if (submission && deliverables.length === 0) {
    blockers.push('No deliverable files are recorded against the latest submission.');
  }

  return {
    ok: blockers.length === 0,
    alreadyDelivered: false,
    blockers,
    warnings,
    submission,
    deliverables,
    conditions,
    project,
  };
}

/**
 * Records that a named person released a specific version at a specific time.
 * Delivery is an authorisation, not an automatic consequence of approval.
 */
function authorizeDelivery(db, guildId, task, { actorUserId, note = null, override = false }) {
  const readiness = checkDeliveryReadiness(db, guildId, task);

  if (readiness.alreadyDelivered) {
    return { ok: false, reason: 'already_delivered', readiness };
  }
  if (!readiness.ok && !override) {
    return { ok: false, reason: 'conditions_not_met', readiness };
  }
  if (!readiness.submission) {
    return { ok: false, reason: 'nothing_to_deliver', readiness };
  }

  const delivered = db.transaction(() => {
    db.prepare(`
      UPDATE tasks SET delivered_at = ?, delivered_by = ?, delivered_version = ?, delivery_note = ?, updated_at = ?
      WHERE id = ?
    `).run(Date.now(), actorUserId, readiness.submission.version, note, Date.now(), task.id);

    assetsRepo.markDelivered(db, task.id, readiness.submission.version);

    recordAudit(db, {
      guildId,
      actorUserId,
      action: 'task.deliver',
      entityType: 'task',
      entityId: task.id,
      after: {
        version: readiness.submission.version,
        files: readiness.deliverables.length,
        overridden: override && !readiness.ok,
      },
      detail: override && !readiness.ok
        ? `Released despite: ${readiness.blockers.join(' ')}${note ? ` · ${note}` : ''}`
        : note,
    });

    return tasksRepo.getTask(db, guildId, task.id);
  })();

  return { ok: true, task: delivered, readiness, overridden: override && !readiness.ok };
}

/**
 * The version a client last approved, which is what "latest approved version"
 * means for delivery and for the archive.
 */
function latestApprovedVersion(db, taskId) {
  const decision = db.prepare(`
    SELECT cd.*, s.version FROM client_decisions cd
    LEFT JOIN submissions s ON s.id = cd.submission_id
    WHERE cd.task_id = ? AND cd.decision = 'approved'
    ORDER BY cd.recorded_at DESC LIMIT 1
  `).get(taskId);

  return decision ? { version: decision.version ?? null, approvedAt: decision.recorded_at, recordedBy: decision.recorded_by } : null;
}

function undeliveredApproved(db, guildId) {
  return db.prepare(`
    SELECT * FROM tasks
    WHERE guild_id = ? AND state = 'client_approved' AND delivered_at IS NULL
    ORDER BY completed_at
  `).all(guildId);
}

module.exports = {
  DEFAULT_CONDITIONS,
  deliveryConditions,
  setDeliveryConditions,
  checkDeliveryReadiness,
  authorizeDelivery,
  latestApprovedVersion,
  undeliveredApproved,
};
