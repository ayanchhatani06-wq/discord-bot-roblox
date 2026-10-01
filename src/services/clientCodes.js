const crypto = require('node:crypto');

/**
 * Week-long access codes for clients signing in to the website.
 *
 * The studio's choice, and the reasoning behind each part of it:
 *
 * A one-time link is safer, but a client checking progress daily ends up asking
 * for a new one every morning, and a studio that is asked often enough starts
 * posting links where links should not be posted. A code bounded to a week is
 * the compromise: convenient enough to be used as intended, short-lived enough
 * that a leaked one stops working on its own.
 *
 * The code is never enough on its own by default. `client_code_require_email`
 * is on, so somebody signing in needs the code *and* an email already on that
 * client's record. A code read over a shoulder is then not a way in, and the
 * record shows which address was used rather than "somebody who had the code".
 *
 * Codes are stored hashed, so this table cannot be read for live access and a
 * code cannot be shown again after it is issued — only replaced. That is a real
 * cost (an owner who loses the message has to reissue) and it is the right
 * trade: the alternative is a database that hands over every client's access.
 */

/**
 * No characters that get misread aloud or retyped wrong: 0/O, 1/I/L, 5/S, U/V.
 * Thirty symbols over eight positions is about 6.5e11 codes, which against a
 * rate-limited form and a seven-day life is far more than enough.
 */
const ALPHABET = '23456789ABCDEFGHJKMNPQRTWXYZ';
const GROUP = 4;
const GROUPS = 2;
const DEFAULT_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Three letters taken from the studio's name, so a client can see it is yours. */
function prefixFor(studioName) {
  const letters = String(studioName || '').toUpperCase().replace(/[^A-Z]/g, '');
  return letters.length >= 3 ? letters.slice(0, 3) : 'CLI';
}

/**
 * Typed codes arrive with whatever spacing and case the person used, and the
 * hyphens are ours rather than theirs. Everything is stripped back to the bare
 * symbols before hashing so `cyl 7k4p-r2m9` and `CYL7K4PR2M9` are one code.
 */
function normalise(code) {
  return String(code || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
}

function hash(code) {
  return crypto.createHash('sha256').update(normalise(code)).digest('hex');
}

/** Rejection sampling, so every symbol is equally likely. */
function randomSymbols(count) {
  const out = [];
  const limit = 256 - (256 % ALPHABET.length);
  while (out.length < count) {
    for (const byte of crypto.randomBytes(count)) {
      if (byte >= limit) continue;
      out.push(ALPHABET[byte % ALPHABET.length]);
      if (out.length === count) break;
    }
  }
  return out.join('');
}

/** `CYL-7K4P-R2M9` — readable down a phone, pasteable into a DM. */
function generate(studioName) {
  const symbols = randomSymbols(GROUP * GROUPS);
  const groups = [];
  for (let i = 0; i < GROUPS; i += 1) groups.push(symbols.slice(i * GROUP, (i + 1) * GROUP));
  return `${prefixFor(studioName)}-${groups.join('-')}`;
}

function settingsFor(config = {}) {
  return {
    requireEmail: config.client_code_require_email !== 0,
    rotateWeekly: config.client_code_rotate_weekly !== 0,
    days: Number(config.client_code_days) > 0 ? Number(config.client_code_days) : DEFAULT_DAYS,
  };
}

/** The live code for a client, if there is one. At most one ever is. */
function activeFor(db, clientId, now = Date.now()) {
  return db.prepare(`
    SELECT * FROM client_access_codes
    WHERE client_id = ? AND revoked_at IS NULL AND expires_at > ?
    ORDER BY issued_at DESC LIMIT 1
  `).get(clientId, now) || null;
}

/** Retiring the old code is the point of issuing a new one, so it is not optional. */
function revokeFor(db, clientId, { by = null, now = Date.now() } = {}) {
  return db.prepare(`
    UPDATE client_access_codes SET revoked_at = ?, revoked_by = ?
    WHERE client_id = ? AND revoked_at IS NULL AND expires_at > ?
  `).run(now, by, clientId, now).changes;
}

/**
 * Mint a code for one client, retiring whatever they had.
 *
 * Returns the plaintext code exactly once. Nothing stores it, so a caller that
 * drops it has to issue another.
 */
function issue(db, guildId, { clientId, studioName = null, issuedBy = null, days = DEFAULT_DAYS, now = Date.now() }) {
  const ttlDays = Number(days) > 0 ? Number(days) : DEFAULT_DAYS;
  const expiresAt = now + ttlDays * DAY_MS;

  const run = db.transaction(() => {
    revokeFor(db, clientId, { by: issuedBy, now });

    // A collision would throw on the unique index rather than overwrite
    // somebody's access, but retrying is cheaper than explaining that.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = generate(studioName);
      const codeHash = hash(code);
      const clash = db.prepare('SELECT 1 FROM client_access_codes WHERE code_hash = ?').get(codeHash);
      if (clash) continue;

      const result = db.prepare(`
        INSERT INTO client_access_codes
          (guild_id, client_id, code_hash, display_hint, issued_by, issued_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(guildId, clientId, codeHash, normalise(code).slice(-4), issuedBy, now, expiresAt);

      return { code, id: result.lastInsertRowid, expiresAt, days: ttlDays };
    }
    throw new Error('Could not generate a unique access code.');
  });

  return run();
}

/**
 * Check a code, and an email where the studio requires one.
 *
 * Every failure returns the same shape and a reason the caller is expected to
 * keep to itself: telling somebody they had the right code but the wrong email
 * turns a guessed code into a confirmed one.
 */
function verify(db, guildId, { code, email = null, config = {}, now = Date.now() }) {
  const { requireEmail } = settingsFor(config);
  const normalised = normalise(code);
  if (!normalised) return { ok: false, reason: 'empty' };

  const row = db.prepare('SELECT * FROM client_access_codes WHERE code_hash = ? AND guild_id = ?')
    .get(hash(normalised), guildId);

  if (!row) return { ok: false, reason: 'unknown' };
  if (row.revoked_at) return { ok: false, reason: 'revoked' };
  if (row.expires_at <= now) return { ok: false, reason: 'expired' };

  if (requireEmail) {
    const address = String(email || '').trim().toLowerCase();
    if (!address) return { ok: false, reason: 'email_required' };

    const known = db.prepare(`
      SELECT 1 FROM client_emails
      WHERE client_id = ? AND email = ? AND revoked_at IS NULL
    `).get(row.client_id, address);

    if (!known) return { ok: false, reason: 'email_mismatch' };
  }

  db.prepare('UPDATE client_access_codes SET last_used_at = ?, use_count = use_count + 1 WHERE id = ?')
    .run(now, row.id);

  return { ok: true, clientId: row.client_id, codeId: row.id, expiresAt: row.expires_at };
}

/** Clients with work in flight — the ones for whom a code is worth minting. */
function clientsNeedingCodes(db, guildId) {
  return db.prepare(`
    SELECT DISTINCT c.id, c.display_name
    FROM clients c
    JOIN projects p ON p.client_id = c.id
    WHERE c.guild_id = ? AND p.status = 'active'
    ORDER BY c.display_name
  `).all(guildId);
}

/**
 * The weekly mint.
 *
 * Only clients with active work, so the studio is not handing out access to
 * people whose job finished in March. A client whose code still has time on it
 * is left alone unless `force` is set, so running this twice in a day does not
 * invalidate codes the owner only just sent out.
 */
function rotateWeekly(db, guildId, { studioName = null, days = DEFAULT_DAYS, force = false, now = Date.now() } = {}) {
  const issued = [];
  const kept = [];

  for (const client of clientsNeedingCodes(db, guildId)) {
    const live = activeFor(db, client.id, now);

    // Half a week left is still a usable code; replacing it only creates
    // confusion about which of two messages is current.
    if (!force && live && live.expires_at - now > (days * DAY_MS) / 2) {
      kept.push({ clientId: client.id, name: client.display_name, expiresAt: live.expires_at });
      continue;
    }

    const result = issue(db, guildId, { clientId: client.id, studioName, issuedBy: null, days, now });
    issued.push({ clientId: client.id, name: client.display_name, code: result.code, expiresAt: result.expiresAt });
  }

  return { issued, kept };
}

/** Housekeeping: expired rows are already ignored, this stops the table growing forever. */
function pruneExpired(db, { now = Date.now(), keepMs = 30 * DAY_MS } = {}) {
  return db.prepare('DELETE FROM client_access_codes WHERE expires_at < ?').run(now - keepMs).changes;
}

module.exports = {
  ALPHABET,
  DEFAULT_DAYS,
  DAY_MS,
  prefixFor,
  normalise,
  hash,
  generate,
  settingsFor,
  activeFor,
  revokeFor,
  issue,
  verify,
  clientsNeedingCodes,
  rotateWeekly,
  pruneExpired,
};
