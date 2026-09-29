/**
 * Remembers what has already been chased.
 *
 * Reminder state lives in the database rather than in memory so a restart does
 * not re-send everything, and so a reminder held back by quiet hours is
 * deferred rather than dropped.
 */

const KINDS = Object.freeze({
  OFFER_UNANSWERED: 'offer_unanswered',
  OFFER_ESCALATED: 'offer_escalated',
  DEADLINE_UPCOMING: 'deadline_upcoming',
  DEADLINE_OVERDUE: 'deadline_overdue',
  STALE_PROGRESS: 'stale_progress',
  AWAITING_REVIEW: 'awaiting_review',
  AWAITING_CLIENT: 'awaiting_client',
  APPROVED_UNPAID: 'approved_unpaid',
  DEPENDENCY_READY: 'dependency_ready',
  BLOCKER_OPEN: 'blocker_open',
  AWAY_RETURNED: 'away_returned',
});

function getState(db, guildId, kind, entityType, entityId) {
  return db.prepare(`
    SELECT * FROM reminder_state
    WHERE guild_id = ? AND kind = ? AND entity_type = ? AND entity_id = ?
  `).get(guildId, kind, entityType, String(entityId)) || null;
}

/**
 * True when this reminder is due: never sent, or last sent longer ago than
 * `minIntervalMs`. A deferral set by quiet hours holds it back until then.
 */
function isDue(db, guildId, kind, entityType, entityId, { minIntervalMs = 0, now = Date.now() } = {}) {
  const state = getState(db, guildId, kind, entityType, entityId);
  if (!state) return true;
  if (state.deferred_to && state.deferred_to > now) return false;
  if (!state.last_sent_at) return true;
  return now - state.last_sent_at >= minIntervalMs;
}

function markSent(db, guildId, kind, entityType, entityId, now = Date.now()) {
  db.prepare(`
    INSERT INTO reminder_state (guild_id, kind, entity_type, entity_id, last_sent_at, deferred_to, send_count)
    VALUES (?, ?, ?, ?, ?, NULL, 1)
    ON CONFLICT (guild_id, kind, entity_type, entity_id) DO UPDATE SET
      last_sent_at = excluded.last_sent_at,
      deferred_to = NULL,
      send_count = reminder_state.send_count + 1
  `).run(guildId, kind, entityType, String(entityId), now);
}

/** Holds a reminder until quiet hours end, instead of dropping it. */
function defer(db, guildId, kind, entityType, entityId, until) {
  db.prepare(`
    INSERT INTO reminder_state (guild_id, kind, entity_type, entity_id, deferred_to, send_count)
    VALUES (?, ?, ?, ?, ?, 0)
    ON CONFLICT (guild_id, kind, entity_type, entity_id) DO UPDATE SET
      deferred_to = excluded.deferred_to
  `).run(guildId, kind, entityType, String(entityId), until);
}

function clear(db, guildId, kind, entityType, entityId) {
  db.prepare(`
    DELETE FROM reminder_state WHERE guild_id = ? AND kind = ? AND entity_type = ? AND entity_id = ?
  `).run(guildId, kind, entityType, String(entityId));
}

function clearForEntity(db, guildId, entityType, entityId) {
  db.prepare('DELETE FROM reminder_state WHERE guild_id = ? AND entity_type = ? AND entity_id = ?')
    .run(guildId, entityType, String(entityId));
}

function listDeferred(db, guildId, now = Date.now()) {
  return db.prepare(`
    SELECT * FROM reminder_state WHERE guild_id = ? AND deferred_to IS NOT NULL AND deferred_to <= ?
  `).all(guildId, now);
}

module.exports = { KINDS, getState, isDue, markSent, defer, clear, clearForEntity, listDeferred };
