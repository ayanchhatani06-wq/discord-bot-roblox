const { recordAudit } = require('./core');
const { unknownPlaceholders } = require('../../domain/templates');

/**
 * Message templates, the outbound queue, and client replies.
 *
 * The rule this file exists to enforce: nothing reaches a client that the
 * owner has not approved, and nothing reaches them twice.
 */

const KINDS = Object.freeze({ TRANSACTIONAL: 'transactional', PROMOTIONAL: 'promotional' });

const STATUSES = Object.freeze({
  QUEUED: 'queued',
  SENT: 'sent',
  FAILED: 'failed',
  BLOCKED: 'blocked',
  CANCELLED: 'cancelled',
});

/**
 * Events a template can be attached to. A closed list, because an event the
 * bot never raises would be a template that silently never sends.
 */
const TRIGGERS = Object.freeze({
  ORDER_CONFIRMED: 'order_confirmed',
  PRODUCTION_STARTED: 'production_started',
  PREVIEW_READY: 'preview_ready',
  DELIVERED: 'delivered',
  AWAITING_CLIENT_CHASE: 'awaiting_client_chase',
  POST_DELIVERY_CHECK_IN: 'post_delivery_check_in',
  REVIEW_REQUEST: 'review_request',
  REPEAT_ORDER: 'repeat_order',
  CROSS_SERVICE: 'cross_service',
});

const TRIGGER_LABELS = Object.freeze({
  order_confirmed: 'When an order is confirmed',
  production_started: 'When work starts on their order',
  preview_ready: 'When a preview is ready for them',
  delivered: 'When the finished work is released',
  awaiting_client_chase: 'When they have not answered a preview',
  post_delivery_check_in: 'A while after delivery',
  review_request: 'Asking for a review after delivery',
  repeat_order: 'Reminding a past client they can order again',
  cross_service: 'Offering a related service',
});

// Promotional by nature: these go to somebody who has not asked for anything,
// so they need opt-in. The rest are about work the client is already paying for.
const PROMOTIONAL_TRIGGERS = Object.freeze([
  TRIGGERS.REPEAT_ORDER,
  TRIGGERS.CROSS_SERVICE,
]);

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

/**
 * Writes a template. Any change to the wording drops it back to draft, so the
 * approval always belongs to the exact text that will be sent.
 */
function upsertTemplate(db, guildId, { key, label, kind, triggerEvent = null, subject = null, body }, actorUserId) {
  const unknown = unknownPlaceholders(body);
  if (unknown.length > 0) return { ok: false, reason: 'unknown_placeholder', unknown };

  const now = Date.now();
  const existing = getTemplate(db, guildId, key);

  if (!existing) {
    const created = db.prepare(`
      INSERT INTO message_templates (guild_id, key, label, kind, trigger_event, subject, body, created_by, created_at, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *
    `).get(guildId, key, label, kind, triggerEvent, subject, body, actorUserId, now, actorUserId, now);

    recordAudit(db, {
      guildId, actorUserId, action: 'template.create', entityType: 'template', entityId: created.id,
      after: { key, kind, trigger_event: triggerEvent },
      detail: 'Draft. Nothing sends until it is approved.',
    });
    return { ok: true, template: created, wordingChanged: false };
  }

  const wordingChanged = existing.body !== body || existing.subject !== subject;
  const version = wordingChanged ? existing.version + 1 : existing.version;

  db.prepare(`
    UPDATE message_templates
    SET label = ?, kind = ?, trigger_event = ?, subject = ?, body = ?, version = ?,
        status = ?, approved_by = ?, approved_at = ?, updated_by = ?, updated_at = ?
    WHERE id = ?
  `).run(
    label, kind, triggerEvent, subject, body, version,
    wordingChanged ? 'draft' : existing.status,
    wordingChanged ? null : existing.approved_by,
    wordingChanged ? null : existing.approved_at,
    actorUserId, now, existing.id
  );

  recordAudit(db, {
    guildId, actorUserId, action: 'template.update', entityType: 'template', entityId: existing.id,
    before: { version: existing.version, status: existing.status },
    after: { version, status: wordingChanged ? 'draft' : existing.status },
    detail: wordingChanged ? 'Wording changed, so it needs approving again before it can send.' : null,
  });

  return { ok: true, template: getTemplate(db, guildId, key), wordingChanged };
}

function getTemplate(db, guildId, key) {
  return db.prepare('SELECT * FROM message_templates WHERE guild_id = ? AND key = ?').get(guildId, key) || null;
}

function listTemplates(db, guildId, { approvedOnly = false, triggerEvent = null } = {}) {
  const clauses = ['guild_id = ?'];
  const params = [guildId];
  if (approvedOnly) clauses.push("status = 'approved' AND active = 1");
  if (triggerEvent) { clauses.push('trigger_event = ?'); params.push(triggerEvent); }

  return db.prepare(`SELECT * FROM message_templates WHERE ${clauses.join(' AND ')} ORDER BY label`).all(...params);
}

function approveTemplate(db, guildId, key, actorUserId) {
  const result = db.prepare(`
    UPDATE message_templates SET status = 'approved', approved_by = ?, approved_at = ?, updated_at = ?
    WHERE guild_id = ? AND key = ? AND status = 'draft'
  `).run(actorUserId, Date.now(), Date.now(), guildId, key);

  if (result.changes === 0) return null;
  const template = getTemplate(db, guildId, key);
  recordAudit(db, {
    guildId, actorUserId, action: 'template.approve', entityType: 'template', entityId: template.id,
    after: { key, version: template.version },
  });
  return template;
}

function setTemplateActive(db, guildId, key, active, actorUserId) {
  db.prepare('UPDATE message_templates SET active = ?, updated_at = ? WHERE guild_id = ? AND key = ?')
    .run(active ? 1 : 0, Date.now(), guildId, key);
  recordAudit(db, { guildId, actorUserId, action: 'template.active', entityType: 'template', entityId: key, after: { active } });
  return getTemplate(db, guildId, key);
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

function getPrefs(db, clientId) {
  return db.prepare('SELECT * FROM client_message_prefs WHERE client_id = ?').get(clientId) || null;
}

function setPrefs(db, guildId, clientId, patch, actorUserId) {
  const existing = getPrefs(db, clientId);
  const merged = {
    max_per_week: patch.maxPerWeek !== undefined ? patch.maxPerWeek : existing?.max_per_week ?? null,
    paused_until: patch.pausedUntil !== undefined ? patch.pausedUntil : existing?.paused_until ?? null,
    paused_reason: patch.pausedReason !== undefined ? patch.pausedReason : existing?.paused_reason ?? null,
    follow_up_user_id: patch.followUpUserId !== undefined ? patch.followUpUserId : existing?.follow_up_user_id ?? null,
    digest_minutes: patch.digestMinutes !== undefined ? patch.digestMinutes : existing?.digest_minutes ?? null,
  };

  db.prepare(`
    INSERT INTO client_message_prefs (client_id, guild_id, max_per_week, paused_until, paused_reason, follow_up_user_id, digest_minutes, updated_by, updated_at)
    VALUES (@client_id, @guild_id, @max_per_week, @paused_until, @paused_reason, @follow_up_user_id, @digest_minutes, @updated_by, @updated_at)
    ON CONFLICT (client_id) DO UPDATE SET
      max_per_week = excluded.max_per_week,
      paused_until = excluded.paused_until,
      paused_reason = excluded.paused_reason,
      follow_up_user_id = excluded.follow_up_user_id,
      digest_minutes = excluded.digest_minutes,
      updated_by = excluded.updated_by,
      updated_at = excluded.updated_at
  `).run({
    client_id: clientId, guild_id: guildId, ...merged,
    updated_by: actorUserId, updated_at: Date.now(),
  });

  recordAudit(db, {
    guildId, actorUserId, action: 'client.message_prefs', entityType: 'client', entityId: clientId, after: merged,
  });
  return getPrefs(db, clientId);
}

// ---------------------------------------------------------------------------
// The outbound queue
// ---------------------------------------------------------------------------

/**
 * Queues a message.
 *
 * The unique dedupe key is what makes re-triggering harmless: the second
 * attempt is refused by the database, not by a check in code that somebody
 * might later forget to write.
 */
function queueMessage(db, guildId, {
  clientId, projectId = null, templateKey = null, templateVersion = null,
  kind, triggerEvent = null, body, dedupeKey, digestKey = null, sendAfter = Date.now(), queuedBy = null,
}) {
  try {
    const message = db.prepare(`
      INSERT INTO client_messages (
        guild_id, client_id, project_id, template_key, template_version, kind, trigger_event,
        body, dedupe_key, digest_key, send_after, queued_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *
    `).get(guildId, clientId, projectId, templateKey, templateVersion, kind, triggerEvent,
      body, dedupeKey, digestKey, sendAfter, queuedBy, Date.now());

    return { ok: true, created: true, message };
  } catch (error) {
    if (!String(error.message).includes('UNIQUE')) throw error;
    const existing = db.prepare('SELECT * FROM client_messages WHERE dedupe_key = ?').get(dedupeKey);
    return { ok: true, created: false, message: existing };
  }
}

function getMessage(db, guildId, id) {
  return db.prepare('SELECT * FROM client_messages WHERE guild_id = ? AND id = ?').get(guildId, id) || null;
}

function dueMessages(db, guildId, { now = Date.now(), limit = 25 } = {}) {
  return db.prepare(`
    SELECT * FROM client_messages
    WHERE guild_id = ? AND status = 'queued' AND send_after <= ?
    ORDER BY send_after, id LIMIT ?
  `).all(guildId, now, limit);
}

function markSent(db, id, { channelId, messageId }) {
  db.prepare(`
    UPDATE client_messages SET status = 'sent', sent_at = ?, channel_id = ?, message_id = ?, attempts = attempts + 1
    WHERE id = ? AND status = 'queued'
  `).run(Date.now(), channelId, messageId, id);
}

function markFailed(db, id, reason) {
  db.prepare(`
    UPDATE client_messages SET status = 'failed', failure_reason = ?, attempts = attempts + 1 WHERE id = ?
  `).run(String(reason).slice(0, 500), id);
}

/** Held back by a rule rather than broken. Recorded so the reason is visible. */
function markBlocked(db, id, reason) {
  db.prepare("UPDATE client_messages SET status = 'blocked', blocked_reason = ? WHERE id = ? AND status = 'queued'")
    .run(String(reason).slice(0, 200), id);
}

function cancelMessage(db, guildId, id, actorUserId) {
  const result = db.prepare("UPDATE client_messages SET status = 'cancelled' WHERE guild_id = ? AND id = ? AND status = 'queued'")
    .run(guildId, id);
  if (result.changes === 0) return null;
  recordAudit(db, { guildId, actorUserId, action: 'client_message.cancel', entityType: 'client_message', entityId: id });
  return getMessage(db, guildId, id);
}

function cancelQueuedForClient(db, guildId, clientId, { kind = null } = {}) {
  const sql = kind
    ? "UPDATE client_messages SET status = 'cancelled' WHERE guild_id = ? AND client_id = ? AND status = 'queued' AND kind = ?"
    : "UPDATE client_messages SET status = 'cancelled' WHERE guild_id = ? AND client_id = ? AND status = 'queued'";
  const params = kind ? [guildId, clientId, kind] : [guildId, clientId];
  return db.prepare(sql).run(...params).changes;
}

function history(db, guildId, { clientId = null, projectId = null, status = null, limit = 25 } = {}) {
  const clauses = ['guild_id = ?'];
  const params = [guildId];
  if (clientId) { clauses.push('client_id = ?'); params.push(clientId); }
  if (projectId) { clauses.push('project_id = ?'); params.push(projectId); }
  if (status) { clauses.push('status = ?'); params.push(status); }

  return db.prepare(`
    SELECT * FROM client_messages WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT ?
  `).all(...params, limit);
}

/** How many messages of a kind actually reached this client in a window. */
function sentCountSince(db, clientId, since, { kind = null } = {}) {
  const sql = kind
    ? "SELECT COUNT(*) AS n FROM client_messages WHERE client_id = ? AND status = 'sent' AND sent_at >= ? AND kind = ?"
    : "SELECT COUNT(*) AS n FROM client_messages WHERE client_id = ? AND status = 'sent' AND sent_at >= ?";
  const params = kind ? [clientId, since, kind] : [clientId, since];
  return db.prepare(sql).get(...params).n;
}

/** Queued messages sharing a digest key, so several items become one message. */
function digestGroup(db, guildId, digestKey) {
  return db.prepare(`
    SELECT * FROM client_messages
    WHERE guild_id = ? AND digest_key = ? AND status = 'queued' ORDER BY id
  `).all(guildId, digestKey);
}

// ---------------------------------------------------------------------------
// Client replies
// ---------------------------------------------------------------------------

function recordReply(db, guildId, { clientId, projectId = null, userId, channelId, messageId, excerpt }) {
  try {
    return db.prepare(`
      INSERT INTO client_replies (guild_id, client_id, project_id, user_id, channel_id, message_id, excerpt, received_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *
    `).get(guildId, clientId, projectId, userId, channelId, messageId, String(excerpt).slice(0, 500), Date.now());
  } catch (error) {
    if (!String(error.message).includes('UNIQUE')) throw error;
    return db.prepare('SELECT * FROM client_replies WHERE message_id = ?').get(messageId);
  }
}

function openReplies(db, guildId, { clientId = null, limit = 25 } = {}) {
  const sql = clientId
    ? 'SELECT * FROM client_replies WHERE guild_id = ? AND handled_at IS NULL AND client_id = ? ORDER BY received_at DESC LIMIT ?'
    : 'SELECT * FROM client_replies WHERE guild_id = ? AND handled_at IS NULL ORDER BY received_at DESC LIMIT ?';
  const params = clientId ? [guildId, clientId, limit] : [guildId, limit];
  return db.prepare(sql).all(...params);
}

function hasUnhandledReply(db, clientId) {
  return Boolean(db.prepare('SELECT 1 FROM client_replies WHERE client_id = ? AND handled_at IS NULL LIMIT 1').get(clientId));
}

function markReplyHandled(db, guildId, id, actorUserId) {
  const result = db.prepare(`
    UPDATE client_replies SET handled_by = ?, handled_at = ? WHERE guild_id = ? AND id = ? AND handled_at IS NULL
  `).run(actorUserId, Date.now(), guildId, id);
  if (result.changes === 0) return null;

  recordAudit(db, { guildId, actorUserId, action: 'client_reply.handled', entityType: 'client_reply', entityId: id });
  return db.prepare('SELECT * FROM client_replies WHERE id = ?').get(id);
}

module.exports = {
  KINDS,
  STATUSES,
  TRIGGERS,
  TRIGGER_LABELS,
  PROMOTIONAL_TRIGGERS,
  upsertTemplate,
  getTemplate,
  listTemplates,
  approveTemplate,
  setTemplateActive,
  getPrefs,
  setPrefs,
  queueMessage,
  getMessage,
  dueMessages,
  markSent,
  markFailed,
  markBlocked,
  cancelMessage,
  cancelQueuedForClient,
  history,
  sentCountSince,
  digestGroup,
  recordReply,
  openReplies,
  hasUnhandledReply,
  markReplyHandled,
};
