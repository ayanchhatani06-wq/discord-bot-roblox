const { recordAudit } = require('./core');
const { DEFAULT_PERCENTAGES_BP, RECIPIENT_KINDS, validatePercentages } = require('../../domain/allocations');

/**
 * Seeded on first setup and fully editable afterwards. Checklists follow the
 * studio's stated deliverables; the remaining departments get a sensible
 * starting list that the owner is expected to adjust.
 */
const DEFAULT_DEPARTMENTS = [
  { key: 'modelling', name: 'Modelling', checklist: ['Source file', 'Exported model', 'Textures', 'Previews'] },
  { key: 'building', name: 'Building', checklist: ['Source place file', 'Exported build', 'Previews'] },
  { key: 'animation', name: 'Animation', checklist: ['Source file', 'Animation export', 'Preview video'] },
  { key: 'vfx', name: 'VFX', checklist: ['Effect files', 'Textures / flipbooks', 'Demonstration video'] },
  { key: 'ui', name: 'UI', checklist: ['Editable source', 'Exported assets', 'Required resolutions', 'Preview'] },
  { key: 'gfx', name: 'GFX', checklist: ['Editable source', 'Exported image', 'Required sizes', 'Preview'] },
  { key: 'scripting', name: 'Scripting', checklist: ['Source scripts', 'Test place or demo', 'Usage notes'] },
  { key: 'sfx', name: 'SFX', checklist: ['Source project', 'Exported audio', 'Format and loudness notes'] },
];

const CONFIG_COLUMNS = [
  'studio_name', 'studio_tagline',
  'owner_user_id', 'owner_role_id', 'manager_role_id', 'staff_board_channel_id',
  'audit_log_channel_id', 'fallback_channel_id', 'summary_channel_id',
  'board_refresh_minutes', 'offer_reminder_hours', 'stale_progress_days',
  'deadline_warning_hours', 'quiet_start_minute', 'quiet_end_minute',
  'default_currency', 'payment_methods_json', 'summary_cron', 'setup_completed_at',
  'recruiter_fee_bp', 'enquiry_channel_id',
];

function ensureConfig(db, guildId) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO guild_config (guild_id, created_at, updated_at) VALUES (?, ?, ?)
    ON CONFLICT (guild_id) DO NOTHING
  `).run(guildId, now, now);
  return db.prepare('SELECT * FROM guild_config WHERE guild_id = ?').get(guildId);
}

function getConfig(db, guildId) {
  return db.prepare('SELECT * FROM guild_config WHERE guild_id = ?').get(guildId) || null;
}

function updateConfig(db, guildId, patch, actorUserId = null) {
  const before = ensureConfig(db, guildId);
  const entries = Object.entries(patch).filter(([key]) => CONFIG_COLUMNS.includes(key));
  if (entries.length === 0) return before;

  const assignments = entries.map(([key]) => `${key} = ?`).join(', ');
  db.prepare(`UPDATE guild_config SET ${assignments}, updated_at = ? WHERE guild_id = ?`)
    .run(...entries.map(([, value]) => value), Date.now(), guildId);

  const after = getConfig(db, guildId);
  recordAudit(db, {
    guildId,
    actorUserId,
    action: 'config.update',
    entityType: 'guild',
    entityId: guildId,
    before: Object.fromEntries(entries.map(([key]) => [key, before[key]])),
    after: Object.fromEntries(entries.map(([key]) => [key, after[key]])),
  });
  return after;
}

function markSetupComplete(db, guildId, actorUserId) {
  return updateConfig(db, guildId, { setup_completed_at: Date.now() }, actorUserId);
}

function paymentMethods(config) {
  try {
    const parsed = JSON.parse(config?.payment_methods_json || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function listDepartments(db, guildId, { includeArchived = false } = {}) {
  const sql = includeArchived
    ? 'SELECT * FROM departments WHERE guild_id = ? ORDER BY sort_order, name'
    : 'SELECT * FROM departments WHERE guild_id = ? AND archived_at IS NULL ORDER BY sort_order, name';
  return db.prepare(sql).all(guildId);
}

function getDepartment(db, guildId, id) {
  return db.prepare('SELECT * FROM departments WHERE guild_id = ? AND id = ?').get(guildId, id) || null;
}

function getDepartmentByKey(db, guildId, key) {
  return db.prepare('SELECT * FROM departments WHERE guild_id = ? AND key = ?').get(guildId, key) || null;
}

function seedDefaultDepartments(db, guildId, actorUserId = null) {
  const now = Date.now();
  const insert = db.prepare(`
    INSERT INTO departments (guild_id, key, name, checklist_json, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (guild_id, key) DO NOTHING
  `);

  const created = [];
  db.transaction(() => {
    DEFAULT_DEPARTMENTS.forEach((dept, index) => {
      const result = insert.run(guildId, dept.key, dept.name, JSON.stringify(dept.checklist), index, now, now);
      if (result.changes === 1) created.push(dept.key);
    });
    if (created.length > 0) {
      recordAudit(db, {
        guildId,
        actorUserId,
        action: 'departments.seed',
        entityType: 'guild',
        entityId: guildId,
        after: { created },
      });
    }
  })();

  return created;
}

function upsertDepartment(db, guildId, { key, name, leaderRoleId, memberRoleId, checklist, taskCap, sortOrder }, actorUserId = null) {
  const now = Date.now();
  const existing = getDepartmentByKey(db, guildId, key);

  if (!existing) {
    const row = db.prepare(`
      INSERT INTO departments (guild_id, key, name, leader_role_id, member_role_id, checklist_json, task_cap, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *
    `).get(
      guildId, key, name || key, leaderRoleId || null, memberRoleId || null,
      JSON.stringify(checklist || []), taskCap ?? null, sortOrder ?? 0, now, now
    );
    recordAudit(db, { guildId, actorUserId, action: 'department.create', entityType: 'department', entityId: row.id, after: row });
    return row;
  }

  const patch = {
    name: name ?? existing.name,
    leader_role_id: leaderRoleId === undefined ? existing.leader_role_id : leaderRoleId,
    member_role_id: memberRoleId === undefined ? existing.member_role_id : memberRoleId,
    checklist_json: checklist === undefined ? existing.checklist_json : JSON.stringify(checklist),
    task_cap: taskCap === undefined ? existing.task_cap : taskCap,
    sort_order: sortOrder === undefined ? existing.sort_order : sortOrder,
  };

  db.prepare(`
    UPDATE departments SET name = ?, leader_role_id = ?, member_role_id = ?, checklist_json = ?, task_cap = ?, sort_order = ?, updated_at = ?
    WHERE guild_id = ? AND key = ?
  `).run(
    patch.name, patch.leader_role_id, patch.member_role_id, patch.checklist_json,
    patch.task_cap, patch.sort_order, now, guildId, key
  );

  const after = getDepartmentByKey(db, guildId, key);
  recordAudit(db, { guildId, actorUserId, action: 'department.update', entityType: 'department', entityId: after.id, before: existing, after });
  return after;
}

function archiveDepartment(db, guildId, key, actorUserId = null) {
  const existing = getDepartmentByKey(db, guildId, key);
  if (!existing) return null;
  db.prepare('UPDATE departments SET archived_at = ?, updated_at = ? WHERE id = ?').run(Date.now(), Date.now(), existing.id);
  recordAudit(db, { guildId, actorUserId, action: 'department.archive', entityType: 'department', entityId: existing.id, before: existing });
  return getDepartment(db, guildId, existing.id);
}

function departmentChecklist(department) {
  try {
    const parsed = JSON.parse(department?.checklist_json || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function listRoleCapabilities(db, guildId) {
  return db.prepare('SELECT * FROM role_capabilities WHERE guild_id = ?').all(guildId);
}

function grantCapability(db, guildId, roleId, capability, actorUserId = null) {
  db.prepare(`
    INSERT INTO role_capabilities (guild_id, role_id, capability, granted_by, granted_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (guild_id, role_id, capability) DO NOTHING
  `).run(guildId, roleId, capability, actorUserId, Date.now());
  recordAudit(db, { guildId, actorUserId, action: 'capability.grant', entityType: 'role', entityId: roleId, after: { capability } });
}

function revokeCapability(db, guildId, roleId, capability, actorUserId = null) {
  const result = db.prepare('DELETE FROM role_capabilities WHERE guild_id = ? AND role_id = ? AND capability = ?')
    .run(guildId, roleId, capability);
  if (result.changes > 0) {
    recordAudit(db, { guildId, actorUserId, action: 'capability.revoke', entityType: 'role', entityId: roleId, before: { capability } });
  }
  return result.changes > 0;
}

function getAllocationPercentages(db, guildId) {
  const rows = db.prepare('SELECT recipient_kind, percent_bp FROM allocation_config WHERE guild_id = ?').all(guildId);
  if (rows.length === 0) return { ...DEFAULT_PERCENTAGES_BP };

  const percentages = { ...DEFAULT_PERCENTAGES_BP };
  for (const row of rows) percentages[row.recipient_kind] = row.percent_bp;
  return percentages;
}

function setAllocationPercentages(db, guildId, percentages, actorUserId = null) {
  validatePercentages(percentages);
  const before = getAllocationPercentages(db, guildId);
  const now = Date.now();

  const upsert = db.prepare(`
    INSERT INTO allocation_config (guild_id, recipient_kind, percent_bp, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (guild_id, recipient_kind) DO UPDATE SET
      percent_bp = excluded.percent_bp, updated_by = excluded.updated_by, updated_at = excluded.updated_at
  `);

  db.transaction(() => {
    for (const kind of RECIPIENT_KINDS) upsert.run(guildId, kind, percentages[kind], actorUserId, now);
    recordAudit(db, {
      guildId, actorUserId, action: 'allocation.percentages.update',
      entityType: 'guild', entityId: guildId, before, after: percentages,
    });
  })();

  return getAllocationPercentages(db, guildId);
}

function getBoardMessage(db, guildId, boardKey) {
  return db.prepare('SELECT * FROM board_messages WHERE guild_id = ? AND board_key = ?').get(guildId, boardKey) || null;
}

function setBoardMessage(db, guildId, boardKey, channelId, messageId) {
  db.prepare(`
    INSERT INTO board_messages (guild_id, board_key, channel_id, message_id, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (guild_id, board_key) DO UPDATE SET
      channel_id = excluded.channel_id, message_id = excluded.message_id, updated_at = excluded.updated_at
  `).run(guildId, boardKey, channelId, messageId, Date.now());
}

function deleteBoardMessage(db, guildId, boardKey) {
  db.prepare('DELETE FROM board_messages WHERE guild_id = ? AND board_key = ?').run(guildId, boardKey);
}

function listBoardMessages(db, guildId) {
  return db.prepare('SELECT * FROM board_messages WHERE guild_id = ?').all(guildId);
}

function listConfiguredGuilds(db) {
  return db.prepare('SELECT * FROM guild_config').all();
}

module.exports = {
  DEFAULT_DEPARTMENTS,
  ensureConfig,
  getConfig,
  updateConfig,
  markSetupComplete,
  paymentMethods,
  listDepartments,
  getDepartment,
  getDepartmentByKey,
  seedDefaultDepartments,
  upsertDepartment,
  archiveDepartment,
  departmentChecklist,
  listRoleCapabilities,
  grantCapability,
  revokeCapability,
  getAllocationPercentages,
  setAllocationPercentages,
  getBoardMessage,
  setBoardMessage,
  deleteBoardMessage,
  listBoardMessages,
  listConfiguredGuilds,
};
