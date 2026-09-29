const tasksRepo = require('../db/repos/tasks');
const projectsRepo = require('../db/repos/projects');
const planningRepo = require('../db/repos/planning');
const { formatAmount } = require('../domain/money');

/**
 * What must be true before work is offered to somebody.
 *
 * Blockers stop the offer; warnings are shown and the leader decides. The split
 * matters: an artist cannot accept terms that do not exist yet, but plenty of
 * jobs legitimately start before every reference link has arrived.
 */
function checkTaskReadiness(db, guildId, task) {
  const blockers = [];
  const warnings = [];

  if (!tasksRepo.isPayApproved(task)) {
    blockers.push(
      task.pay_state === tasksRepo.PAY_STATES.PROPOSED
        ? `Pay of ${formatAmount(task.pay_proposed_minor, task.pay_proposed_currency)} is proposed but not approved by the owner.`
        : 'No pay has been set, so there are no terms to accept.'
    );
  }

  const deliverables = tasksRepo.deliverables(task);
  if (deliverables.length === 0) {
    blockers.push('No deliverables are listed, so nobody can tell what finished looks like.');
  }

  const project = projectsRepo.getProject(db, guildId, task.project_id);
  if (!task.brief && !project?.brief) {
    blockers.push('There is no brief on the task or its project.');
  }

  if (!task.deadline_utc) {
    warnings.push('No deadline is set on this task.');
  }
  if (!task.reference_links && !project?.reference_links) {
    warnings.push('No reference links are attached.');
  }
  if (!task.formats) {
    warnings.push('No required file formats are recorded.');
  }

  const unmet = planningRepo.unmetDependencies(db, task.id);
  for (const dependency of unmet) {
    warnings.push(`Depends on **${dependency.code} ${dependency.title}**, which has not passed review yet.`);
  }

  const openBlockers = planningRepo.openBlockersForTask(db, task.id);
  for (const blocker of openBlockers) {
    warnings.push(`An unresolved blocker is open on this task: ${blocker.reason.slice(0, 120)}`);
  }

  return {
    ok: blockers.length === 0,
    blockers,
    warnings,
    unmetDependencies: unmet,
    openBlockers,
  };
}

function describeReadiness(readiness) {
  const parts = [];
  if (readiness.blockers.length > 0) {
    parts.push(`**Cannot be offered yet:**\n${readiness.blockers.map((line) => `• ${line}`).join('\n')}`);
  }
  if (readiness.warnings.length > 0) {
    parts.push(`**Worth checking first:**\n${readiness.warnings.map((line) => `• ${line}`).join('\n')}`);
  }
  return parts.join('\n\n');
}

module.exports = { checkTaskReadiness, describeReadiness };
