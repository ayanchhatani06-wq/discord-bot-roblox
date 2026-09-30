const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { recordAudit } = require('./core');

/**
 * Files kept as proof.
 *
 * The studio holds the bytes. Discord's attachment URLs are signed, expire,
 * and stop working permanently once the message is deleted — so a stored link
 * is not evidence, it is a bet that Discord will still be holding something on
 * the day the argument happens.
 *
 * Every file is hashed when it arrives. That is what makes it provable later:
 * the hash was recorded before anybody knew there would be a dispute, so a
 * copy that still matches it is demonstrably the one that was filed.
 */

const KINDS = Object.freeze({
  PAYMENT: 'payment',
  APPROVAL: 'approval',
  DISPUTE: 'dispute',
  ISSUE: 'issue',
  DELIVERY: 'delivery',
  GENERAL: 'general',
});

const KIND_LABELS = Object.freeze({
  payment: 'Proof of payment',
  approval: 'Proof a client approved something',
  dispute: 'Evidence for a dispute',
  issue: 'Something a client reported',
  delivery: 'Proof of delivery',
  general: 'Kept for the record',
});

// Images and PDFs only. An evidence store that accepts executables is a way to
// pass malware around with the studio's name on it.
const ALLOWED_TYPES = Object.freeze([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'text/plain',
]);

const MAX_BYTES = 8 * 1024 * 1024;

function evidenceDir() {
  return process.env.EVIDENCE_DIR
    || path.join(__dirname, '..', '..', '..', 'data', 'evidence');
}

/**
 * Where a file is written.
 *
 * Sharded by the first two characters of its hash, because one directory with
 * ten thousand files in it is slow on every filesystem worth naming.
 */
function storagePathFor(sha256, filename) {
  const extension = path.extname(filename).toLowerCase().slice(0, 10).replace(/[^a-z0-9.]/g, '');
  return path.join(sha256.slice(0, 2), `${sha256}${extension}`);
}

/**
 * Writes the bytes and records them.
 *
 * The same file filed twice is one record. That is not just tidiness: it means
 * somebody re-uploading the same screenshot cannot make it look like two
 * separate pieces of proof.
 */
function store(db, guildId, {
  buffer, filename, contentType = null, kind = KINDS.GENERAL,
  projectId = null, taskId = null, paymentId = null, clientId = null,
  note = null, sourceUrl = null,
}, actorUserId) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { ok: false, reason: 'empty' };
  }
  if (buffer.length > MAX_BYTES) {
    return { ok: false, reason: 'too_large', bytes: buffer.length, limit: MAX_BYTES };
  }
  if (contentType && !ALLOWED_TYPES.includes(String(contentType).split(';')[0].trim())) {
    return { ok: false, reason: 'unsupported_type', contentType };
  }

  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const existing = db.prepare('SELECT * FROM evidence WHERE guild_id = ? AND sha256 = ?').get(guildId, sha256);
  if (existing) return { ok: true, created: false, evidence: existing };

  const relative = storagePathFor(sha256, filename);
  const absolute = path.join(evidenceDir(), relative);

  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, buffer);

  const row = db.prepare(`
    INSERT INTO evidence (
      guild_id, kind, project_id, task_id, payment_id, client_id,
      filename, stored_path, content_type, bytes, sha256, note, source_url, added_by, added_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *
  `).get(
    guildId, kind, projectId, taskId, paymentId, clientId,
    filename, relative, contentType, buffer.length, sha256, note, sourceUrl, actorUserId, Date.now()
  );

  recordAudit(db, {
    guildId, actorUserId, action: 'evidence.store',
    entityType: taskId ? 'task' : projectId ? 'project' : 'guild',
    entityId: taskId || projectId || guildId,
    after: { kind, filename, bytes: buffer.length, sha256 },
    detail: 'The file itself is kept, not a link to it.',
  });

  return { ok: true, created: true, evidence: row };
}

function get(db, guildId, id) {
  return db.prepare('SELECT * FROM evidence WHERE guild_id = ? AND id = ?').get(guildId, id) || null;
}

/**
 * Reads a stored file back and checks it is still the one that was filed.
 *
 * A file whose hash no longer matches is reported rather than returned: a
 * changed file is worse than a missing one, because somebody might rely on it.
 */
function read(db, guildId, id) {
  const row = get(db, guildId, id);
  if (!row) return { ok: false, reason: 'not_found' };

  const absolute = path.join(evidenceDir(), row.stored_path);
  if (!fs.existsSync(absolute)) return { ok: false, reason: 'missing_file', evidence: row };

  const buffer = fs.readFileSync(absolute);
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

  if (sha256 !== row.sha256) {
    return { ok: false, reason: 'hash_mismatch', evidence: row, found: sha256 };
  }

  return { ok: true, buffer, evidence: row };
}

function listFor(db, guildId, { projectId = null, taskId = null, paymentId = null, clientId = null, kind = null, limit = 50 } = {}) {
  const clauses = ['guild_id = ?'];
  const params = [guildId];

  if (projectId !== null) { clauses.push('project_id = ?'); params.push(projectId); }
  if (taskId !== null) { clauses.push('task_id = ?'); params.push(taskId); }
  if (paymentId !== null) { clauses.push('payment_id = ?'); params.push(paymentId); }
  if (clientId !== null) { clauses.push('client_id = ?'); params.push(clientId); }
  if (kind !== null) { clauses.push('kind = ?'); params.push(kind); }

  return db.prepare(`
    SELECT * FROM evidence WHERE ${clauses.join(' AND ')} ORDER BY added_at DESC LIMIT ?
  `).all(...params, limit);
}

/** Everything filed about one order, whatever it was attached to. */
function forProject(db, guildId, projectId) {
  return db.prepare(`
    SELECT e.* FROM evidence e
    LEFT JOIN tasks t ON t.id = e.task_id
    WHERE e.guild_id = ? AND (e.project_id = ? OR t.project_id = ?)
    ORDER BY e.added_at
  `).all(guildId, projectId, projectId);
}

/**
 * Checks every stored file still matches its recorded hash.
 *
 * Worth running before relying on any of it, which is why the dispute pack
 * calls it rather than assuming.
 */
function verifyAll(db, guildId) {
  const results = { checked: 0, ok: 0, missing: [], changed: [] };

  for (const row of db.prepare('SELECT * FROM evidence WHERE guild_id = ?').all(guildId)) {
    results.checked += 1;
    const check = read(db, guildId, row.id);

    if (check.ok) results.ok += 1;
    else if (check.reason === 'missing_file') results.missing.push(row);
    else if (check.reason === 'hash_mismatch') results.changed.push(row);
  }

  return results;
}

function totalBytes(db, guildId) {
  return db.prepare('SELECT COALESCE(SUM(bytes), 0) AS total FROM evidence WHERE guild_id = ?').get(guildId).total;
}

module.exports = {
  KINDS,
  KIND_LABELS,
  ALLOWED_TYPES,
  MAX_BYTES,
  evidenceDir,
  storagePathFor,
  store,
  get,
  read,
  listFor,
  forProject,
  verifyAll,
  totalBytes,
};
