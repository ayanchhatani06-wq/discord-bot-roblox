const { nextCode, recordAudit } = require('./core');
const { totalsByCurrency } = require('../../domain/money');

const EDITABLE_FIELDS = [
  'name', 'client_ref', 'brief', 'reference_links', 'deadline_utc',
  'client_amount_minor', 'client_currency', 'manager_user_id',
  'finder_user_id', 'mod_user_id', 'ticket_url', 'status',
];

function createProject(db, guildId, {
  name,
  clientRef = null,
  brief = null,
  referenceLinks = null,
  deadlineUtc = null,
  clientAmountMinor = null,
  clientCurrency = null,
  managerUserId = null,
  finderUserId = null,
  modUserId = null,
  ticketUrl = null,
}, actorUserId) {
  return db.transaction(() => {
    const now = Date.now();
    const code = nextCode(db, guildId, 'project');

    const project = db.prepare(`
      INSERT INTO projects (
        guild_id, code, name, client_ref, brief, reference_links, deadline_utc,
        client_amount_minor, client_currency, manager_user_id, finder_user_id,
        mod_user_id, ticket_url, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING *
    `).get(
      guildId, code, name, clientRef, brief, referenceLinks, deadlineUtc,
      clientAmountMinor, clientCurrency, managerUserId, finderUserId,
      modUserId, ticketUrl, actorUserId, now, now
    );

    recordAudit(db, {
      guildId, actorUserId, action: 'project.create',
      entityType: 'project', entityId: project.id, after: project,
    });
    return project;
  })();
}

function getProject(db, guildId, id) {
  return db.prepare('SELECT * FROM projects WHERE guild_id = ? AND id = ?').get(guildId, id) || null;
}

function getProjectByCode(db, guildId, code) {
  return db.prepare('SELECT * FROM projects WHERE guild_id = ? AND code = ?').get(guildId, String(code).toUpperCase()) || null;
}

function listProjects(db, guildId, { status = 'active', limit = 25 } = {}) {
  if (status === 'all') {
    return db.prepare('SELECT * FROM projects WHERE guild_id = ? ORDER BY created_at DESC LIMIT ?').all(guildId, limit);
  }
  return db.prepare('SELECT * FROM projects WHERE guild_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?')
    .all(guildId, status, limit);
}

function searchProjects(db, guildId, query, limit = 25) {
  const like = `%${String(query || '').toLowerCase()}%`;
  return db.prepare(`
    SELECT * FROM projects
    WHERE guild_id = ? AND (LOWER(code) LIKE ? OR LOWER(name) LIKE ?)
    ORDER BY created_at DESC LIMIT ?
  `).all(guildId, like, like, limit);
}

function updateProject(db, guildId, id, patch, actorUserId) {
  const before = getProject(db, guildId, id);
  if (!before) return null;

  const entries = Object.entries(patch).filter(([key]) => EDITABLE_FIELDS.includes(key));
  if (entries.length === 0) return before;

  db.prepare(`UPDATE projects SET ${entries.map(([key]) => `${key} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
    .run(...entries.map(([, value]) => value), Date.now(), id);

  const after = getProject(db, guildId, id);
  recordAudit(db, {
    guildId, actorUserId, action: 'project.update', entityType: 'project', entityId: id,
    before: Object.fromEntries(entries.map(([key]) => [key, before[key]])),
    after: Object.fromEntries(entries.map(([key]) => [key, after[key]])),
  });
  return after;
}

/**
 * What the client has actually paid, per currency. Payouts are only payable
 * once this covers the project, so it is read rather than assumed.
 */
function clientReceipts(db, projectId) {
  const rows = db.prepare(`
    SELECT amount_minor AS minor, currency FROM payments
    WHERE project_id = ? AND direction = 'client_receipt'
  `).all(projectId);
  return totalsByCurrency(rows);
}

function isClientPaidInFull(db, project) {
  if (project.client_paid_in_full_at) return true;
  if (project.client_amount_minor === null || !project.client_currency) return false;

  const received = clientReceipts(db, project.id).get(project.client_currency) || 0;
  return received >= project.client_amount_minor;
}

function markClientPaidInFull(db, guildId, projectId, actorUserId) {
  db.prepare('UPDATE projects SET client_paid_in_full_at = ?, updated_at = ? WHERE id = ?')
    .run(Date.now(), Date.now(), projectId);
  recordAudit(db, {
    guildId, actorUserId, action: 'project.client_paid', entityType: 'project', entityId: projectId,
  });
  return getProject(db, guildId, projectId);
}

function projectProgress(db, projectId) {
  const rows = db.prepare('SELECT state, COUNT(*) AS n FROM tasks WHERE project_id = ? GROUP BY state').all(projectId);
  const counts = {};
  let total = 0;
  for (const row of rows) {
    counts[row.state] = row.n;
    total += row.n;
  }
  return { total, counts };
}

module.exports = {
  EDITABLE_FIELDS,
  createProject,
  getProject,
  getProjectByCode,
  listProjects,
  searchProjects,
  updateProject,
  clientReceipts,
  isClientPaidInFull,
  markClientPaidInFull,
  projectProgress,
};
