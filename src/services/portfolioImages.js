const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/**
 * Pictures of a staff member's work, kept as files on the server.
 *
 * Why not just store the Discord link: an attachment URL dies with the message
 * it was posted in, and a portfolio that empties itself over a year is worse
 * than no portfolio, because nobody notices until a client is looking at it.
 * This copies the bytes, exactly as the evidence store does, so what somebody
 * showed the studio in March is still there in December.
 *
 * Capped per person rather than per studio. Six is enough to show range and
 * few enough that a profile stays readable on a phone — and on a small host it
 * keeps a team of thirty inside a few hundred megabytes rather than filling the
 * disk the database also lives on.
 */

const MAX_PER_PERSON = 6;
const MAX_BYTES = 8 * 1024 * 1024;

// Images only. The evidence store takes PDFs and text because proof comes in
// those forms; a portfolio does not, and every extra accepted type is another
// thing that can be uploaded here and opened by somebody else.
const ALLOWED_TYPES = Object.freeze([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
]);

function portfolioDir() {
  return process.env.PORTFOLIO_DIR
    || path.join(__dirname, '..', '..', 'data', 'portfolio');
}

/** Sharded by the first two characters of the hash, as the evidence store is. */
function storagePathFor(sha256, filename) {
  const extension = path.extname(filename).toLowerCase().slice(0, 10).replace(/[^a-z0-9.]/g, '');
  return path.join(sha256.slice(0, 2), `${sha256}${extension}`);
}

function listFor(db, guildId, userId) {
  return db.prepare(`
    SELECT * FROM staff_portfolio_images
    WHERE guild_id = ? AND user_id = ?
    ORDER BY sort_order, id
  `).all(guildId, userId);
}

function countFor(db, guildId, userId) {
  return db.prepare('SELECT COUNT(*) AS c FROM staff_portfolio_images WHERE guild_id = ? AND user_id = ?')
    .get(guildId, userId).c;
}

function totalBytes(db, guildId) {
  return db.prepare('SELECT COALESCE(SUM(bytes), 0) AS b FROM staff_portfolio_images WHERE guild_id = ?')
    .get(guildId).b;
}

/**
 * Files the bytes against a person.
 *
 * Returns a reason rather than throwing, because every failure here is
 * something the person who uploaded can fix themselves once told which.
 */
function add(db, guildId, userId, { buffer, filename, contentType = null, caption = null }, actorUserId) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { ok: false, reason: 'empty' };
  }
  if (buffer.length > MAX_BYTES) {
    return { ok: false, reason: 'too_large', bytes: buffer.length, limit: MAX_BYTES };
  }

  const type = contentType ? String(contentType).split(';')[0].trim().toLowerCase() : null;
  if (!type || !ALLOWED_TYPES.includes(type)) {
    return { ok: false, reason: 'unsupported_type', contentType: type };
  }

  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const existing = db.prepare(
    'SELECT * FROM staff_portfolio_images WHERE guild_id = ? AND user_id = ? AND sha256 = ?'
  ).get(guildId, userId, sha256);
  if (existing) return { ok: true, created: false, image: existing };

  // Checked after the duplicate test, so re-adding a picture somebody already
  // has is never refused for being over the limit.
  if (countFor(db, guildId, userId) >= MAX_PER_PERSON) {
    return { ok: false, reason: 'too_many', limit: MAX_PER_PERSON };
  }

  const relative = storagePathFor(sha256, filename);
  const absolute = path.join(portfolioDir(), relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, buffer);

  const nextOrder = db.prepare(
    'SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM staff_portfolio_images WHERE guild_id = ? AND user_id = ?'
  ).get(guildId, userId).n;

  const image = db.prepare(`
    INSERT INTO staff_portfolio_images
      (guild_id, user_id, filename, stored_path, content_type, bytes, sha256, caption, sort_order, added_by, added_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *
  `).get(guildId, userId, filename, relative, type, buffer.length, sha256, caption, nextOrder, actorUserId, Date.now());

  return { ok: true, created: true, image };
}

/** The bytes back, for sending as an attachment. */
function read(db, guildId, id) {
  const row = db.prepare('SELECT * FROM staff_portfolio_images WHERE guild_id = ? AND id = ?').get(guildId, id);
  if (!row) return null;

  const absolute = path.join(portfolioDir(), row.stored_path);
  if (!fs.existsSync(absolute)) return { row, buffer: null, missing: true };
  return { row, buffer: fs.readFileSync(absolute), missing: false };
}

/**
 * Removes one picture.
 *
 * The file goes only when the last row pointing at it does. Two people who
 * worked on the same piece can both show it, and one of them removing it must
 * not blank the other's profile.
 */
function remove(db, guildId, id, userId = null) {
  const row = userId
    ? db.prepare('SELECT * FROM staff_portfolio_images WHERE guild_id = ? AND id = ? AND user_id = ?').get(guildId, id, userId)
    : db.prepare('SELECT * FROM staff_portfolio_images WHERE guild_id = ? AND id = ?').get(guildId, id);
  if (!row) return { ok: false, reason: 'not_found' };

  db.prepare('DELETE FROM staff_portfolio_images WHERE id = ?').run(row.id);

  const others = db.prepare('SELECT COUNT(*) AS c FROM staff_portfolio_images WHERE sha256 = ?').get(row.sha256).c;
  if (others === 0) {
    const absolute = path.join(portfolioDir(), row.stored_path);
    if (fs.existsSync(absolute)) fs.unlinkSync(absolute);
  }

  return { ok: true, image: row, fileRemoved: others === 0 };
}

module.exports = {
  MAX_PER_PERSON,
  MAX_BYTES,
  ALLOWED_TYPES,
  portfolioDir,
  storagePathFor,
  listFor,
  countFor,
  totalBytes,
  add,
  read,
  remove,
};
