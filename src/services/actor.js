const { getDatabase } = require('../db');
const configRepo = require('../db/repos/config');
const onboardingRepo = require('../db/repos/onboarding');
const { resolveActor } = require('../domain/permissions');

/**
 * Member role ids, tolerating both the cached GuildMemberRoleManager and the
 * plain array Discord sends for an uncached interaction member.
 */
function roleIdsOf(member) {
  if (!member) return [];
  const roles = member.roles;
  if (!roles) return [];
  if (Array.isArray(roles)) return roles;
  if (roles.cache) return [...roles.cache.keys()];
  return [];
}

/**
 * Resolves the caller's permissions plus the guild configuration they apply to.
 * Every command and button handler starts here, so no code path can skip the
 * permission check by forgetting to look it up.
 */
function contextFor(interaction, db = getDatabase()) {
  const guildId = interaction.guildId;
  const config = configRepo.ensureConfig(db, guildId);
  const departments = configRepo.listDepartments(db, guildId);
  const roleCapabilities = configRepo.listRoleCapabilities(db, guildId);
  const roleIds = roleIdsOf(interaction.member);

  const actor = resolveActor({
    userId: interaction.user.id,
    roleIds,
    config,
    departments,
    roleCapabilities,
    guildOwnerId: interaction.guild?.ownerId ?? null,
    // Re-read every time, so a stand-in's powers lapse on the stated date
    // without anything having to run to take them away.
    standInDepartmentIds: onboardingRepo.activeBackupDepartmentIds(db, guildId, interaction.user.id),
  });

  return { db, guildId, config, departments, roleIds, actor };
}

/**
 * The department a member belongs to according to their Discord roles. Leader
 * roles win over member roles so a leader is filed under the team they run.
 */
function departmentFromRoles(roleIds, departments) {
  const asLeader = departments.find((dept) => dept.leader_role_id && roleIds.includes(dept.leader_role_id));
  if (asLeader) return asLeader;
  return departments.find((dept) => dept.member_role_id && roleIds.includes(dept.member_role_id)) || null;
}

function isSetupComplete(config) {
  return Boolean(config?.setup_completed_at);
}

module.exports = { roleIdsOf, contextFor, departmentFromRoles, isSetupComplete };
