const { recordAudit } = require('./core');

/**
 * Clients are not staff, so their access is never derived from a Discord role.
 * Authority comes only from an explicit row in client_accounts, which is what
 * every dashboard view and approval button is checked against.
 */

function createClient(db, guildId, { displayName, notes = null, finderUserId = null, preferredContact = null }, actorUserId) {
  const now = Date.now();
  const client = db.prepare(`
    INSERT INTO clients (guild_id, display_name, notes, finder_user_id, preferred_contact, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *
  `).get(guildId, displayName, notes, finderUserId, preferredContact, actorUserId, now, now);

  recordAudit(db, {
    guildId, actorUserId, action: 'client.create', entityType: 'client', entityId: client.id, after: client,
  });
  return client;
}

function getClient(db, guildId, id) {
  return db.prepare('SELECT * FROM clients WHERE guild_id = ? AND id = ?').get(guildId, id) || null;
}

function listClients(db, guildId, { limit = 25 } = {}) {
  return db.prepare('SELECT * FROM clients WHERE guild_id = ? ORDER BY display_name COLLATE NOCASE LIMIT ?')
    .all(guildId, limit);
}

function searchClients(db, guildId, query, limit = 25) {
  const like = `%${String(query || '').toLowerCase()}%`;
  return db.prepare(`
    SELECT * FROM clients WHERE guild_id = ? AND LOWER(display_name) LIKE ?
    ORDER BY display_name COLLATE NOCASE LIMIT ?
  `).all(guildId, like, limit);
}

function updateClient(db, guildId, id, patch, actorUserId) {
  const allowed = ['display_name', 'notes', 'finder_user_id', 'preferred_contact', 'promo_opt_in', 'promo_stopped_at'];
  const before = getClient(db, guildId, id);
  if (!before) return null;

  const entries = Object.entries(patch).filter(([key]) => allowed.includes(key));
  if (entries.length === 0) return before;

  db.prepare(`UPDATE clients SET ${entries.map(([key]) => `${key} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
    .run(...entries.map(([, value]) => value), Date.now(), id);

  const after = getClient(db, guildId, id);
  recordAudit(db, {
    guildId, actorUserId, action: 'client.update', entityType: 'client', entityId: id,
    before: Object.fromEntries(entries.map(([key]) => [key, before[key]])),
    after: Object.fromEntries(entries.map(([key]) => [key, after[key]])),
  });
  return after;
}

function addAccount(db, guildId, clientId, { userId, label = null, canApprove = true }, actorUserId) {
  db.prepare(`
    INSERT INTO client_accounts (client_id, user_id, label, can_approve, added_by, added_at, revoked_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT (client_id, user_id) DO UPDATE SET
      label = excluded.label,
      can_approve = excluded.can_approve,
      revoked_at = NULL
  `).run(clientId, userId, label, canApprove ? 1 : 0, actorUserId, Date.now());

  recordAudit(db, {
    guildId, actorUserId, action: 'client.account.add', entityType: 'client', entityId: clientId,
    after: { user_id: userId, can_approve: canApprove ? 1 : 0 },
  });
}

function revokeAccount(db, guildId, clientId, userId, actorUserId) {
  const result = db.prepare(`
    UPDATE client_accounts SET revoked_at = ? WHERE client_id = ? AND user_id = ? AND revoked_at IS NULL
  `).run(Date.now(), clientId, userId);

  if (result.changes > 0) {
    recordAudit(db, {
      guildId, actorUserId, action: 'client.account.revoke', entityType: 'client', entityId: clientId,
      before: { user_id: userId },
    });
  }
  return result.changes > 0;
}

function listAccounts(db, clientId, { includeRevoked = false } = {}) {
  const sql = includeRevoked
    ? 'SELECT * FROM client_accounts WHERE client_id = ? ORDER BY added_at'
    : 'SELECT * FROM client_accounts WHERE client_id = ? AND revoked_at IS NULL ORDER BY added_at';
  return db.prepare(sql).all(clientId);
}

function getAccount(db, clientId, userId) {
  return db.prepare(`
    SELECT * FROM client_accounts WHERE client_id = ? AND user_id = ? AND revoked_at IS NULL
  `).get(clientId, userId) || null;
}

/**
 * The single access check for anything client-facing.
 *
 * Returns the project only when this user is a live authorized account for the
 * client that project belongs to. A revoked account, a different client's
 * project, or a project with no client attached all fail closed.
 */
function authorizeProjectAccess(db, guildId, projectId, userId) {
  const row = db.prepare(`
    SELECT p.*, ca.can_approve, c.display_name AS client_name
    FROM projects p
    JOIN clients c ON c.id = p.client_id
    JOIN client_accounts ca ON ca.client_id = c.id AND ca.user_id = ? AND ca.revoked_at IS NULL
    WHERE p.guild_id = ? AND p.id = ?
  `).get(userId, guildId, projectId);

  if (!row) return { ok: false, reason: 'not_authorized' };
  return { ok: true, project: row, canApprove: row.can_approve === 1, clientName: row.client_name };
}

/** Every project this client account may see, for a dashboard with no project named. */
function listProjectsForAccount(db, guildId, userId) {
  return db.prepare(`
    SELECT p.* FROM projects p
    JOIN client_accounts ca ON ca.client_id = p.client_id AND ca.user_id = ? AND ca.revoked_at IS NULL
    WHERE p.guild_id = ? AND p.status != 'cancelled'
    ORDER BY p.created_at DESC
  `).all(userId, guildId);
}

function linkProject(db, guildId, projectId, clientId, actorUserId, { clientChannelId = undefined } = {}) {
  const columns = ['client_id = ?'];
  const values = [clientId];
  if (clientChannelId !== undefined) {
    columns.push('client_channel_id = ?');
    values.push(clientChannelId);
  }

  db.prepare(`UPDATE projects SET ${columns.join(', ')}, updated_at = ? WHERE guild_id = ? AND id = ?`)
    .run(...values, Date.now(), guildId, projectId);

  recordAudit(db, {
    guildId, actorUserId, action: 'project.client.link', entityType: 'project', entityId: projectId,
    after: { client_id: clientId, client_channel_id: clientChannelId },
  });
}

function setDashboardMessage(db, guildId, projectId, messageId) {
  db.prepare('UPDATE projects SET dashboard_message_id = ?, updated_at = ? WHERE guild_id = ? AND id = ?')
    .run(messageId, Date.now(), guildId, projectId);
}

function clientOrderHistory(db, guildId, clientId) {
  return db.prepare(`
    SELECT p.*, (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) AS task_count
    FROM projects p WHERE p.guild_id = ? AND p.client_id = ?
    ORDER BY p.created_at DESC
  `).all(guildId, clientId);
}

/** Clients whose name is suspiciously similar, for a human to review. */
function findPossibleDuplicates(db, guildId) {
  const clients = listClients(db, guildId, { limit: 500 });
  const normalise = (name) => String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
  const groups = new Map();

  for (const client of clients) {
    const key = normalise(client.display_name);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(client);
  }

  return [...groups.values()].filter((group) => group.length > 1);
}

function logQuestion(db, guildId, { projectId, clientId, askedBy, kind, question = null, answerSummary = null, escalatedTo = null }) {
  return db.prepare(`
    INSERT INTO client_questions (guild_id, project_id, client_id, asked_by, kind, question, answer_summary, answered_at, escalated_to, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *
  `).get(
    guildId, projectId, clientId, askedBy, kind, question, answerSummary,
    answerSummary ? Date.now() : null, escalatedTo, Date.now()
  );
}

function createRequest(db, guildId, { projectId = null, taskId = null, clientId = null, raisedBy, kind, body, attachments = null }) {
  const request = db.prepare(`
    INSERT INTO client_requests (guild_id, project_id, task_id, client_id, raised_by, kind, body, attachments, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *
  `).get(guildId, projectId, taskId, clientId, raisedBy, kind, body, attachments, Date.now());

  recordAudit(db, {
    guildId, actorUserId: raisedBy, action: `client.request.${kind}`,
    entityType: 'project', entityId: projectId, after: { request_id: request.id, kind },
  });
  return request;
}

function listRequests(db, guildId, { status = 'open', projectId = null, limit = 25 } = {}) {
  const clauses = ['guild_id = ?'];
  const params = [guildId];

  if (status !== 'all') { clauses.push('status = ?'); params.push(status); }
  if (projectId !== null) { clauses.push('project_id = ?'); params.push(projectId); }

  return db.prepare(`SELECT * FROM client_requests WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT ?`)
    .all(...params, limit);
}

function getRequest(db, guildId, id) {
  return db.prepare('SELECT * FROM client_requests WHERE guild_id = ? AND id = ?').get(guildId, id) || null;
}

function resolveRequest(db, guildId, id, { status, resolution, actorUserId }) {
  db.prepare(`
    UPDATE client_requests SET status = ?, resolution = ?, resolved_by = ?, resolved_at = ? WHERE guild_id = ? AND id = ?
  `).run(status, resolution, actorUserId, Date.now(), guildId, id);

  recordAudit(db, {
    guildId, actorUserId, action: 'client.request.resolve', entityType: 'client_request', entityId: id,
    after: { status, resolution },
  });
  return getRequest(db, guildId, id);
}

const ISSUE_DECISIONS = Object.freeze({
  IN_SCOPE: 'in_scope',
  ADDITIONAL_WORK: 'additional_work',
  NO_FAULT: 'no_fault',
});

/**
 * Records what a reported issue was judged to be.
 *
 * Kept separate from closing the request: "resolved" says the matter is
 * finished, while the decision says whether it was a correction the studio owed
 * or extra work that needs paying for. An additional-work decision carries who
 * approved the charge, because only the owner may.
 */
function decideIssue(db, guildId, id, { decision, actorUserId, chargeApprovedBy = null, followUpTaskId = null, note = null }) {
  if (!Object.values(ISSUE_DECISIONS).includes(decision)) {
    throw new Error(`Unknown issue decision: ${decision}`);
  }

  db.prepare(`
    UPDATE client_requests
    SET decision = ?, decided_by = ?, decided_at = ?, charge_approved_by = ?, follow_up_task_id = ?,
        status = CASE WHEN ? = 'no_fault' THEN 'resolved' ELSE 'in_progress' END,
        resolution = COALESCE(?, resolution)
    WHERE guild_id = ? AND id = ?
  `).run(decision, actorUserId, Date.now(), chargeApprovedBy, followUpTaskId, decision, note, guildId, id);

  recordAudit(db, {
    guildId, actorUserId, action: 'client.issue.decide', entityType: 'client_request', entityId: id,
    after: { decision, charge_approved_by: chargeApprovedBy, follow_up_task_id: followUpTaskId },
    detail: note,
  });
  return getRequest(db, guildId, id);
}

/** Any open issue pauses promotional messaging for that client. */
function hasOpenIssue(db, guildId, clientId) {
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM client_requests
    WHERE guild_id = ? AND client_id = ? AND status IN ('open', 'in_progress')
      AND kind IN ('delivery_issue', 'change_request')
  `).get(guildId, clientId);
  return row.n > 0;
}

module.exports = {
  ISSUE_DECISIONS,
  decideIssue,
  createClient,
  getClient,
  listClients,
  searchClients,
  updateClient,
  addAccount,
  revokeAccount,
  listAccounts,
  getAccount,
  authorizeProjectAccess,
  listProjectsForAccount,
  linkProject,
  setDashboardMessage,
  clientOrderHistory,
  findPossibleDuplicates,
  logQuestion,
  createRequest,
  listRequests,
  getRequest,
  resolveRequest,
  hasOpenIssue,
};
