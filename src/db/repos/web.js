const { recordAudit } = require('./core');

/**
 * The website's own storage: sessions, one-time login links, client email
 * identities, and the text of the public pages.
 *
 * Two rules carried over from the bot. Client access is never derived — a
 * person reaches a client's orders only because somebody recorded their
 * Discord account or their email address against that client. And secrets are
 * stored hashed, so a copy of this database is not a set of live logins.
 */

const SUBJECTS = Object.freeze({ CLIENT: 'client', STAFF: 'staff' });

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LOGIN_TOKEN_TTL_MS = 30 * 60 * 1000;

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

function createSession(db, guildId, { tokenHash, subjectKind, clientId = null, userId = null, email = null, displayName = null, ttlMs = SESSION_TTL_MS, now = Date.now() }) {
  return db.prepare(`
    INSERT INTO web_sessions (token_hash, guild_id, subject_kind, client_id, user_id, email, display_name, created_at, expires_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *
  `).get(tokenHash, guildId, subjectKind, clientId, userId, email, displayName, now, now + ttlMs, now);
}

/** A session is only valid while it is unexpired and unrevoked. */
function sessionByHash(db, tokenHash, { now = Date.now() } = {}) {
  const row = db.prepare('SELECT * FROM web_sessions WHERE token_hash = ?').get(tokenHash);
  if (!row) return null;
  if (row.revoked_at || row.expires_at <= now) return null;
  return row;
}

function touchSession(db, id, now = Date.now()) {
  db.prepare('UPDATE web_sessions SET last_seen_at = ? WHERE id = ?').run(now, id);
}

function revokeSession(db, tokenHash) {
  db.prepare('UPDATE web_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
    .run(Date.now(), tokenHash);
}

function revokeSessionsForClient(db, clientId) {
  return db.prepare('UPDATE web_sessions SET revoked_at = ? WHERE client_id = ? AND revoked_at IS NULL')
    .run(Date.now(), clientId).changes;
}

function pruneSessions(db, { now = Date.now() } = {}) {
  return db.prepare('DELETE FROM web_sessions WHERE expires_at < ?').run(now).changes;
}

// ---------------------------------------------------------------------------
// One-time login links
// ---------------------------------------------------------------------------

/**
 * A one-time link, for exactly one of a client or a staff member.
 *
 * The database enforces that it is one or the other, so a link can never be
 * ambiguous about which door it opens.
 */
function issueLoginToken(db, guildId, {
  clientId = null, staffUserId = null, tokenHash, email = null,
  issuedBy = null, ttlMs = LOGIN_TOKEN_TTL_MS, now = Date.now(),
}) {
  const token = db.prepare(`
    INSERT INTO web_login_tokens (guild_id, token_hash, client_id, staff_user_id, email, issued_by, issued_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *
  `).get(guildId, tokenHash, clientId, staffUserId, email, issuedBy, now, now + ttlMs);

  recordAudit(db, {
    guildId,
    actorUserId: issuedBy,
    action: 'web.login_link.issue',
    entityType: staffUserId ? 'staff' : 'client',
    entityId: staffUserId || clientId,
    after: { email, expires_at: token.expires_at },
    detail: 'One-time link. It is spent the first time it is used.',
  });
  return token;
}

/**
 * Spends a login link.
 *
 * The check and the write are one statement, so two people clicking the same
 * forwarded link cannot both be let in: the second finds nothing to consume.
 */
function consumeLoginToken(db, tokenHash, { now = Date.now(), ip = null } = {}) {
  const result = db.prepare(`
    UPDATE web_login_tokens SET consumed_at = ?, consumed_ip = ?
    WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?
  `).run(now, ip, tokenHash, now);

  if (result.changes === 0) return null;
  return db.prepare('SELECT * FROM web_login_tokens WHERE token_hash = ?').get(tokenHash);
}

function pruneLoginTokens(db, { now = Date.now() } = {}) {
  return db.prepare('DELETE FROM web_login_tokens WHERE expires_at < ?').run(now - 24 * 60 * 60 * 1000).changes;
}

// ---------------------------------------------------------------------------
// Client email identities
// ---------------------------------------------------------------------------

function normaliseEmail(email) {
  return String(email ?? '').trim().toLowerCase();
}

function addClientEmail(db, guildId, clientId, { email, label = null, canApprove = false }, actorUserId) {
  const address = normaliseEmail(email);
  db.prepare(`
    INSERT INTO client_emails (guild_id, client_id, email, label, can_approve, added_by, added_at, revoked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT (client_id, email) DO UPDATE SET
      label = excluded.label, can_approve = excluded.can_approve, revoked_at = NULL
  `).run(guildId, clientId, address, label, canApprove ? 1 : 0, actorUserId, Date.now());

  recordAudit(db, {
    guildId, actorUserId, action: 'client.email.add', entityType: 'client', entityId: clientId,
    after: { email: address, can_approve: canApprove ? 1 : 0 },
  });
  return findClientEmail(db, guildId, address);
}

function revokeClientEmail(db, guildId, clientId, email, actorUserId) {
  const result = db.prepare(`
    UPDATE client_emails SET revoked_at = ? WHERE guild_id = ? AND client_id = ? AND email = ? AND revoked_at IS NULL
  `).run(Date.now(), guildId, clientId, normaliseEmail(email));

  if (result.changes === 0) return null;
  recordAudit(db, {
    guildId, actorUserId, action: 'client.email.revoke', entityType: 'client', entityId: clientId,
    before: { email: normaliseEmail(email) },
  });
  return true;
}

/** The single lookup from an email address to a client. Nothing else grants it. */
function findClientEmail(db, guildId, email) {
  return db.prepare(`
    SELECT * FROM client_emails WHERE guild_id = ? AND email = ? AND revoked_at IS NULL
  `).get(guildId, normaliseEmail(email)) || null;
}

function listClientEmails(db, clientId) {
  return db.prepare('SELECT * FROM client_emails WHERE client_id = ? AND revoked_at IS NULL ORDER BY email').all(clientId);
}

// ---------------------------------------------------------------------------
// Public page content
// ---------------------------------------------------------------------------

function upsertService(db, guildId, { key, name, summary, detail = null, sortOrder = 0 }, actorUserId) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO web_services (guild_id, key, name, summary, detail, sort_order, created_by, created_at, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (guild_id, key) DO UPDATE SET
      name = excluded.name, summary = excluded.summary, detail = excluded.detail,
      sort_order = excluded.sort_order, updated_by = excluded.updated_by, updated_at = excluded.updated_at
  `).run(guildId, key, name, summary, detail, sortOrder, actorUserId, now, actorUserId, now);

  recordAudit(db, { guildId, actorUserId, action: 'web.service.upsert', entityType: 'web_service', entityId: key, after: { name } });
  return getService(db, guildId, key);
}

function getService(db, guildId, key) {
  return db.prepare('SELECT * FROM web_services WHERE guild_id = ? AND key = ?').get(guildId, key) || null;
}

function listServices(db, guildId, { publishedOnly = true } = {}) {
  const sql = publishedOnly
    ? 'SELECT * FROM web_services WHERE guild_id = ? AND published = 1 ORDER BY sort_order, name'
    : 'SELECT * FROM web_services WHERE guild_id = ? ORDER BY sort_order, name';
  return db.prepare(sql).all(guildId);
}

function setServicePublished(db, guildId, key, published, actorUserId) {
  const result = db.prepare('UPDATE web_services SET published = ?, updated_by = ?, updated_at = ? WHERE guild_id = ? AND key = ?')
    .run(published ? 1 : 0, actorUserId, Date.now(), guildId, key);
  if (result.changes === 0) return null;

  recordAudit(db, { guildId, actorUserId, action: 'web.service.publish', entityType: 'web_service', entityId: key, after: { published } });
  return getService(db, guildId, key);
}

function upsertPage(db, guildId, { key, title, body }, actorUserId) {
  db.prepare(`
    INSERT INTO web_pages (guild_id, key, title, body, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (guild_id, key) DO UPDATE SET
      title = excluded.title, body = excluded.body, updated_by = excluded.updated_by, updated_at = excluded.updated_at
  `).run(guildId, key, title, body, actorUserId, Date.now());

  recordAudit(db, { guildId, actorUserId, action: 'web.page.upsert', entityType: 'web_page', entityId: key });
  return getPage(db, guildId, key, { publishedOnly: false });
}

function getPage(db, guildId, key, { publishedOnly = true } = {}) {
  const sql = publishedOnly
    ? 'SELECT * FROM web_pages WHERE guild_id = ? AND key = ? AND published = 1'
    : 'SELECT * FROM web_pages WHERE guild_id = ? AND key = ?';
  return db.prepare(sql).get(guildId, key) || null;
}

function setPagePublished(db, guildId, key, published, actorUserId) {
  const result = db.prepare('UPDATE web_pages SET published = ?, updated_by = ?, updated_at = ? WHERE guild_id = ? AND key = ?')
    .run(published ? 1 : 0, actorUserId, Date.now(), guildId, key);
  if (result.changes === 0) return null;

  recordAudit(db, { guildId, actorUserId, action: 'web.page.publish', entityType: 'web_page', entityId: key, after: { published } });
  return getPage(db, guildId, key, { publishedOnly: false });
}

module.exports = {
  SUBJECTS,
  SESSION_TTL_MS,
  LOGIN_TOKEN_TTL_MS,
  normaliseEmail,
  createSession,
  sessionByHash,
  touchSession,
  revokeSession,
  revokeSessionsForClient,
  pruneSessions,
  issueLoginToken,
  consumeLoginToken,
  pruneLoginTokens,
  addClientEmail,
  revokeClientEmail,
  findClientEmail,
  listClientEmails,
  upsertService,
  getService,
  listServices,
  setServicePublished,
  upsertPage,
  getPage,
  setPagePublished,
};
