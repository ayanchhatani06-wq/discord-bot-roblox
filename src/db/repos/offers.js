const { recordAudit } = require('./core');

const OFFER_STATES = Object.freeze({
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  DECLINED: 'declined',
  WITHDRAWN: 'withdrawn',
  EXPIRED: 'expired',
});

/**
 * Creates the live offer. A partial unique index means the database itself
 * refuses a second pending offer for the same task, so two leaders acting at
 * once cannot both hand out the same work.
 */
function createOffer(db, guildId, {
  taskId,
  artistUserId,
  offeredBy,
  expiresAt = null,
  terms,
  messageRef = null,
}) {
  const offer = db.prepare(`
    INSERT INTO task_offers (task_id, artist_user_id, offered_by, offered_at, expires_at, terms_json, state, message_ref)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *
  `).get(taskId, artistUserId, offeredBy, Date.now(), expiresAt, JSON.stringify(terms), OFFER_STATES.PENDING, messageRef);

  recordAudit(db, {
    guildId, actorUserId: offeredBy, action: 'offer.create', entityType: 'task', entityId: taskId,
    after: { offer_id: offer.id, artist_user_id: artistUserId, expires_at: expiresAt },
  });
  return offer;
}

function getOffer(db, offerId) {
  return db.prepare('SELECT * FROM task_offers WHERE id = ?').get(offerId) || null;
}

/**
 * Offers are answered from DMs, where Discord gives no guild context, so the
 * guild is recovered from the offer's own task instead of being trusted from
 * the button that was clicked.
 */
function guildIdForOffer(db, offerId) {
  const row = db.prepare(`
    SELECT t.guild_id AS guildId FROM task_offers o
    JOIN tasks t ON t.id = o.task_id
    WHERE o.id = ?
  `).get(offerId);
  return row ? row.guildId : null;
}

function getPendingOffer(db, taskId) {
  return db.prepare("SELECT * FROM task_offers WHERE task_id = ? AND state = 'pending'").get(taskId) || null;
}

function listPendingForArtist(db, guildId, artistUserId) {
  return db.prepare(`
    SELECT o.* FROM task_offers o
    JOIN tasks t ON t.id = o.task_id
    WHERE t.guild_id = ? AND o.artist_user_id = ? AND o.state = 'pending'
    ORDER BY o.offered_at
  `).all(guildId, artistUserId);
}

function resolveOffer(db, guildId, offerId, state, { actorUserId, declineReason = null }) {
  const before = getOffer(db, offerId);
  if (!before) return null;

  const result = db.prepare(`
    UPDATE task_offers SET state = ?, responded_at = ?, decline_reason = ?
    WHERE id = ? AND state = 'pending'
  `).run(state, Date.now(), declineReason, offerId);

  // Nothing updated means somebody already answered this offer.
  if (result.changes === 0) return null;

  const after = getOffer(db, offerId);
  recordAudit(db, {
    guildId, actorUserId, action: `offer.${state}`, entityType: 'task', entityId: before.task_id,
    before: { state: before.state }, after: { state: after.state }, detail: declineReason,
  });
  return after;
}

function markReminded(db, offerId) {
  db.prepare('UPDATE task_offers SET reminder_sent_at = ? WHERE id = ?').run(Date.now(), offerId);
}

function markEscalated(db, offerId) {
  db.prepare('UPDATE task_offers SET escalated_at = ? WHERE id = ?').run(Date.now(), offerId);
}

/**
 * Pending offers older than the guild's reminder window that have not been
 * chased yet, or that were chased and are now past their expiry.
 */
function listPendingNeedingReminder(db, guildId, olderThanMs) {
  return db.prepare(`
    SELECT o.*, t.code AS task_code, t.leader_user_id, t.department_id
    FROM task_offers o
    JOIN tasks t ON t.id = o.task_id
    WHERE t.guild_id = ? AND o.state = 'pending'
      AND o.offered_at <= ?
      AND o.reminder_sent_at IS NULL
    ORDER BY o.offered_at
  `).all(guildId, olderThanMs);
}

function listPendingNeedingEscalation(db, guildId, olderThanMs) {
  return db.prepare(`
    SELECT o.*, t.code AS task_code, t.leader_user_id, t.department_id
    FROM task_offers o
    JOIN tasks t ON t.id = o.task_id
    WHERE t.guild_id = ? AND o.state = 'pending'
      AND o.reminder_sent_at IS NOT NULL
      AND o.reminder_sent_at <= ?
      AND o.escalated_at IS NULL
    ORDER BY o.offered_at
  `).all(guildId, olderThanMs);
}

function listExpired(db, guildId, now = Date.now()) {
  return db.prepare(`
    SELECT o.*, t.code AS task_code, t.leader_user_id
    FROM task_offers o
    JOIN tasks t ON t.id = o.task_id
    WHERE t.guild_id = ? AND o.state = 'pending' AND o.expires_at IS NOT NULL AND o.expires_at <= ?
  `).all(guildId, now);
}

function offerHistory(db, taskId) {
  return db.prepare('SELECT * FROM task_offers WHERE task_id = ? ORDER BY offered_at').all(taskId);
}

function terms(offer) {
  try {
    return JSON.parse(offer?.terms_json || '{}');
  } catch {
    return {};
  }
}

module.exports = {
  OFFER_STATES,
  createOffer,
  getOffer,
  guildIdForOffer,
  getPendingOffer,
  listPendingForArtist,
  resolveOffer,
  markReminded,
  markEscalated,
  listPendingNeedingReminder,
  listPendingNeedingEscalation,
  listExpired,
  offerHistory,
  terms,
};
