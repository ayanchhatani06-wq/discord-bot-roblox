/**
 * Capability-based permissions. Nothing in the bot checks Discord roles
 * directly: roles are mapped to capabilities in configuration, so the studio
 * can restructure its roles without a code change.
 */

const CAPABILITIES = Object.freeze({
  CONFIG_MANAGE: 'config.manage',
  STAFF_MANAGE: 'staff.manage',
  PROJECT_CREATE: 'project.create',
  PROJECT_EDIT: 'project.edit',
  TASK_CREATE: 'task.create',
  TASK_EDIT: 'task.edit',
  TASK_PAY_PROPOSE: 'task.pay.propose',
  TASK_PAY_APPROVE: 'task.pay.approve',
  TASK_OFFER: 'task.offer',
  TASK_REASSIGN: 'task.reassign',
  TASK_HOLD: 'task.hold',
  TASK_CANCEL: 'task.cancel',
  REVIEW_INTERNAL: 'review.internal',
  CLIENT_RECORD: 'client.record',
  PAYMENT_RECORD: 'payment.record',
  CLIENT_RECEIPT_RECORD: 'client_receipt.record',
  FINANCE_VIEW_ALL: 'finance.view_all',
  SUMMARY_VIEW: 'summary.view',
  AUDIT_VIEW: 'audit.view',
});

const ALL_CAPABILITIES = Object.freeze(Object.values(CAPABILITIES));

/**
 * Capabilities a group leader may only exercise inside a department they lead.
 * The owner is never department-scoped.
 */
const DEPARTMENT_SCOPED = Object.freeze([
  CAPABILITIES.TASK_OFFER,
  CAPABILITIES.TASK_REASSIGN,
  CAPABILITIES.TASK_HOLD,
  CAPABILITIES.TASK_PAY_PROPOSE,
  CAPABILITIES.REVIEW_INTERNAL,
  CAPABILITIES.TASK_EDIT,
]);

/**
 * Defaults chosen by the studio owner: pay, payments, the ledger and client
 * decisions are owner-only. Leaders run their own departments and may propose
 * pay, but cannot approve it.
 */
const DEFAULT_LEADER_CAPABILITIES = Object.freeze([
  CAPABILITIES.TASK_OFFER,
  CAPABILITIES.TASK_REASSIGN,
  CAPABILITIES.TASK_HOLD,
  CAPABILITIES.TASK_PAY_PROPOSE,
  CAPABILITIES.REVIEW_INTERNAL,
  CAPABILITIES.TASK_EDIT,
]);

const DEFAULT_MANAGER_CAPABILITIES = Object.freeze([
  CAPABILITIES.PROJECT_CREATE,
  CAPABILITIES.PROJECT_EDIT,
  CAPABILITIES.TASK_CREATE,
  CAPABILITIES.TASK_EDIT,
  CAPABILITIES.SUMMARY_VIEW,
]);

class PermissionError extends Error {
  constructor(capability, detail) {
    super(detail || `You do not have permission to do that (${capability}).`);
    this.name = 'PermissionError';
    this.capability = capability;
  }
}

function isOwner({ userId, roleIds = [], config = {}, guildOwnerId = null }) {
  if (config.owner_user_id && config.owner_user_id === userId) return true;
  if (guildOwnerId && guildOwnerId === userId) return true;
  if (config.owner_role_id && roleIds.includes(config.owner_role_id)) return true;
  return false;
}

/**
 * Departments (by id) where this member holds the configured leader role.
 */
function ledDepartmentIds({ roleIds = [], departments = [] }) {
  return departments
    .filter((dept) => dept.leader_role_id && roleIds.includes(dept.leader_role_id))
    .map((dept) => dept.id);
}

/**
 * Resolves everything a member is allowed to do, from three sources:
 * owner status, explicit role -> capability grants, and department leadership.
 */
function resolveActor({
  userId,
  roleIds = [],
  config = {},
  departments = [],
  roleCapabilities = [],
  guildOwnerId = null,
  standInDepartmentIds = [],
}) {
  const owner = isOwner({ userId, roleIds, config, guildOwnerId });
  const capabilities = new Set();

  if (owner) {
    for (const capability of ALL_CAPABILITIES) capabilities.add(capability);
  }

  for (const grant of roleCapabilities) {
    if (roleIds.includes(grant.role_id)) capabilities.add(grant.capability);
  }

  // Somebody standing in for a leader gets the same department-scoped powers,
  // in that department only and only while the stand-in window is open. The
  // caller decides which windows are open; this stays a pure function.
  const known = new Set(departments.map((dept) => dept.id));
  const standIn = [...new Set(standInDepartmentIds)].filter((id) => known.has(id));
  const leadDepartments = [...new Set([...ledDepartmentIds({ roleIds, departments }), ...standIn])];

  if (leadDepartments.length > 0) {
    for (const capability of DEFAULT_LEADER_CAPABILITIES) capabilities.add(capability);
  }

  return {
    userId,
    isOwner: owner,
    capabilities,
    leadDepartmentIds: leadDepartments,
    standInDepartmentIds: standIn,
  };
}

/**
 * @param {object} actor result of resolveActor
 * @param {string} capability one of CAPABILITIES
 * @param {object} [context] `{ departmentId }` for department-scoped checks
 */
function can(actor, capability, context = {}) {
  if (!actor) return false;
  if (actor.isOwner) return true;
  if (!actor.capabilities.has(capability)) return false;

  if (DEPARTMENT_SCOPED.includes(capability)) {
    // A leader acting on a department they do not lead is refused even though
    // they hold the capability in general.
    if (context.departmentId === null || context.departmentId === undefined) return false;
    return actor.leadDepartmentIds.includes(context.departmentId);
  }

  return true;
}

function assertCan(actor, capability, context = {}) {
  if (!can(actor, capability, context)) {
    if (
      DEPARTMENT_SCOPED.includes(capability) &&
      actor?.capabilities?.has(capability) &&
      !actor.isOwner
    ) {
      throw new PermissionError(capability, 'You can only do that for a department you lead.');
    }
    throw new PermissionError(capability);
  }
  return true;
}

/**
 * Artists act on their own work without holding any capability. Kept separate
 * from `can` so that "is this my task" can never be satisfied by a role grant.
 */
function isAssignedArtist(actor, task) {
  return Boolean(actor && task && task.artist_user_id && task.artist_user_id === actor.userId);
}

function canViewTaskFinance(actor, task) {
  if (!actor) return false;
  if (actor.isOwner) return true;
  if (actor.capabilities.has(CAPABILITIES.FINANCE_VIEW_ALL)) return true;
  // Otherwise only the artist's own agreed pay on their own task.
  return isAssignedArtist(actor, task);
}

/**
 * Who may run first-run setup and become the studio owner.
 *
 * Before setup nobody holds config.manage, so somebody has to be able to claim
 * the bot or it could never be configured at all. Three ways in:
 *
 *  - the Discord server owner, always;
 *  - anybody Discord already trusts to manage the server, but *only while the
 *    bot is unclaimed* — a studio whose Discord server was created by somebody
 *    else would otherwise be locked out of its own bot permanently;
 *  - whoever already holds owner status, so setup can be re-run.
 *
 * The middle door shuts the moment an owner is recorded. It is a way to start,
 * not a standing permission.
 */
function canClaimStudio({ userId, guildOwnerId = null, managesServer = false, config = {}, roleIds = [] }) {
  if (guildOwnerId && guildOwnerId === userId) return true;
  if (isOwner({ userId, roleIds, config })) return true;
  return !config.owner_user_id && managesServer === true;
}

module.exports = {
  CAPABILITIES,
  ALL_CAPABILITIES,
  canClaimStudio,
  DEPARTMENT_SCOPED,
  DEFAULT_LEADER_CAPABILITIES,
  DEFAULT_MANAGER_CAPABILITIES,
  PermissionError,
  isOwner,
  ledDepartmentIds,
  resolveActor,
  can,
  assertCan,
  isAssignedArtist,
  canViewTaskFinance,
};
