/**
 * Cross-cutting persistence helpers: human-readable IDs, the audit trail, and
 * the guard that makes repeated button clicks harmless.
 */

const CODE_PREFIXES = { project: 'PRJ', task: 'TSK', enquiry: 'ENQ' };

/**
 * Allocates the next sequential code for a guild ("PRJ-0007").
 * Must be called inside a transaction alongside the row it identifies so a
 * failed insert cannot burn a number or, worse, reuse one.
 */
function nextCode(db, guildId, kind) {
  const prefix = CODE_PREFIXES[kind];
  if (!prefix) throw new Error(`Unknown code kind: ${kind}`);

  db.prepare(`
    INSERT INTO id_counters (guild_id, kind, next_value) VALUES (?, ?, 1)
    ON CONFLICT (guild_id, kind) DO NOTHING
  `).run(guildId, kind);

  const row = db.prepare(`
    UPDATE id_counters SET next_value = next_value + 1
    WHERE guild_id = ? AND kind = ?
    RETURNING next_value - 1 AS value
  `).get(guildId, kind);

  return `${prefix}-${String(row.value).padStart(4, '0')}`;
}

function recordAudit(db, {
  guildId,
  actorUserId = null,
  action,
  entityType,
  entityId = null,
  before = null,
  after = null,
  detail = null,
}) {
  db.prepare(`
    INSERT INTO audit_log
      (guild_id, actor_user_id, action, entity_type, entity_id, before_json, after_json, detail, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    guildId,
    actorUserId,
    action,
    entityType,
    entityId === null ? null : String(entityId),
    before === null ? null : JSON.stringify(before),
    after === null ? null : JSON.stringify(after),
    detail,
    Date.now()
  );
}

function listAudit(db, { guildId, entityType = null, entityId = null, limit = 25 }) {
  if (entityType && entityId !== null) {
    return db.prepare(`
      SELECT * FROM audit_log
      WHERE guild_id = ? AND entity_type = ? AND entity_id = ?
      ORDER BY created_at DESC, id DESC LIMIT ?
    `).all(guildId, entityType, String(entityId), limit);
  }
  return db.prepare(`
    SELECT * FROM audit_log WHERE guild_id = ?
    ORDER BY created_at DESC, id DESC LIMIT ?
  `).all(guildId, limit);
}

/**
 * Claims a one-time key. Returns false if the key was already used, which is
 * how a double-submitted payment or a twice-clicked Accept button is rejected
 * at the storage layer instead of being trusted not to happen.
 */
function claimGuard(db, guardKey) {
  const result = db.prepare(`
    INSERT INTO interaction_guards (guard_key, created_at) VALUES (?, ?)
    ON CONFLICT (guard_key) DO NOTHING
  `).run(guardKey, Date.now());
  return result.changes === 1;
}

function pruneGuards(db, olderThanMs = 7 * 24 * 60 * 60 * 1000) {
  return db.prepare('DELETE FROM interaction_guards WHERE created_at < ?').run(Date.now() - olderThanMs).changes;
}

module.exports = { CODE_PREFIXES, nextCode, recordAudit, listAudit, claimGuard, pruneGuards };
