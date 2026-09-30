const fs = require('node:fs');
const path = require('node:path');

/**
 * Owner-controlled exports.
 *
 * Two different jobs, deliberately separated:
 *
 *  - a **backup** is a byte-exact copy of the database, taken with SQLite's own
 *    online backup so it is consistent even while the bot is writing. It is the
 *    thing you restore from.
 *  - an **export** is readable data for a person or a spreadsheet. It is not a
 *    backup and cannot be restored from, and this file says so everywhere,
 *    because somebody will otherwise keep CSVs and discover too late.
 *
 * Exports never include anything that would be dangerous to hand around:
 * payment references, gift card details and DM contents are not in them.
 */

const EXPORTABLE = Object.freeze({
  projects: {
    label: 'Orders',
    sql: `SELECT code, name, status, brief, deadline_utc, client_amount_minor, client_currency,
                 client_paid_in_full_at, created_at
          FROM projects WHERE guild_id = ? ORDER BY created_at`,
  },
  tasks: {
    label: 'Tasks',
    sql: `SELECT t.code, t.title, t.state, t.payment_state, d.name AS department, p.code AS project_code,
                 t.artist_user_id, t.leader_user_id, t.deadline_utc, t.completed_at, t.created_at
          FROM tasks t
          LEFT JOIN departments d ON d.id = t.department_id
          LEFT JOIN projects p ON p.id = t.project_id
          WHERE t.guild_id = ? ORDER BY t.created_at`,
  },
  payments: {
    // Deliberately no reference column: a payment reference can be a gift card
    // code, and a gift card code in a spreadsheet is money lying in the open.
    label: 'Payments (no references)',
    sql: `SELECT direction, amount_minor, currency, method_label, payee_user_id, allocation_kind,
                 recorded_by, recorded_at
          FROM payments WHERE guild_id = ? ORDER BY recorded_at`,
  },
  allocations: {
    label: 'Splits',
    sql: `SELECT t.code AS task_code, a.recipient_kind, a.recipient_user_id, a.percent_bp,
                 a.amount_minor, a.currency, a.pool_minor, a.computed_at, a.frozen_at
          FROM allocations a JOIN tasks t ON t.id = a.task_id
          WHERE t.guild_id = ? ORDER BY a.task_id`,
  },
  clients: {
    label: 'Clients',
    sql: `SELECT display_name, finder_user_id, preferred_contact, promo_opt_in, promo_stopped_at, created_at
          FROM clients WHERE guild_id = ? ORDER BY display_name`,
  },
  staff: {
    label: 'Staff',
    sql: `SELECT user_id, display_name, timezone, specialties, availability, onboarded_at, removed_at
          FROM staff WHERE guild_id = ? ORDER BY display_name`,
  },
  audit: {
    label: 'Audit trail',
    sql: `SELECT actor_user_id, action, entity_type, entity_id, detail, created_at
          FROM audit_log WHERE guild_id = ? ORDER BY created_at`,
  },
});

const EXPORT_KINDS = Object.freeze(Object.keys(EXPORTABLE));

/** RFC 4180 quoting, so a brief containing a comma or a quote survives. */
function csvCell(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function toCsv(rows) {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  return [
    headers.join(','),
    ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(',')),
  ].join('\n');
}

function exportRows(db, guildId, kind) {
  const spec = EXPORTABLE[kind];
  if (!spec) return null;
  return db.prepare(spec.sql).all(guildId);
}

function exportCsv(db, guildId, kind) {
  const rows = exportRows(db, guildId, kind);
  if (rows === null) return null;
  return { kind, label: EXPORTABLE[kind].label, rows: rows.length, csv: toCsv(rows) };
}

/**
 * A consistent copy of the whole database.
 *
 * Uses SQLite's own online backup rather than copying the file, because a
 * plain copy taken mid-write produces a file that looks fine and is not.
 */
async function backup(db, destination) {
  const directory = path.dirname(destination);
  fs.mkdirSync(directory, { recursive: true });

  // better-sqlite3 exposes the online backup API; it is awaited so a partial
  // file is never reported as a finished backup.
  await db.backup(destination);

  const { size } = fs.statSync(destination);
  return { path: destination, bytes: size, takenAt: Date.now() };
}

/**
 * Copies the evidence files alongside the database backup.
 *
 * Necessary because the database holds only each file's path and hash, not the
 * bytes. A restored database without these files has a full set of evidence
 * records that all read as missing — worse than useless in the argument they
 * were kept for, because it looks like the proof was deleted.
 *
 * Files are copied by hash-derived path and never overwritten, since a file that
 * is already there with the same name has the same contents by definition.
 */
function backupEvidence(sourceDirectory, destinationDirectory) {
  if (!fs.existsSync(sourceDirectory)) {
    return { copied: 0, bytes: 0, skipped: 0, directory: destinationDirectory };
  }

  const source = path.resolve(sourceDirectory);
  const destination = path.resolve(destinationDirectory);

  if (destination === source) {
    return { copied: 0, skipped: 0, bytes: 0, directory: destinationDirectory, reason: 'same_directory' };
  }

  fs.mkdirSync(destination, { recursive: true });
  let copied = 0;
  let skipped = 0;
  let bytes = 0;

  const walk = (relative) => {
    const absolute = path.join(source, relative);
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      const next = path.join(relative, entry.name);

      // Never walk into our own output. With the backup directory configured
      // inside the evidence directory this would otherwise copy the copies,
      // forever, until the path is too long to write.
      if (path.resolve(source, next) === destination) continue;

      if (entry.isDirectory()) {
        fs.mkdirSync(path.join(destination, next), { recursive: true });
        walk(next);
        continue;
      }

      const target = path.join(destination, next);
      if (fs.existsSync(target)) {
        skipped += 1;
        continue;
      }
      fs.copyFileSync(path.join(source, next), target);
      copied += 1;
      bytes += fs.statSync(target).size;
    }
  };

  walk('.');
  return { copied, skipped, bytes, directory: destinationDirectory };
}

/** The most recent backup in a directory, or null if there are none. */
function newestBackup(directory) {
  if (!fs.existsSync(directory)) return null;

  const files = fs.readdirSync(directory)
    .filter((name) => name.endsWith('.sqlite'))
    .map((name) => {
      const full = path.join(directory, name);
      return { full, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);

  return files[0]?.full ?? null;
}

function defaultBackupPath(directory, now = new Date()) {
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return path.join(directory, `studio-${stamp}.sqlite`);
}

/**
 * Checks a backup file is a database the bot could actually open.
 *
 * A backup nobody has ever opened is a hope, not a backup, so this exists to
 * be run on a real file rather than trusted.
 */
function verifyBackup(openDatabase, filePath) {
  if (!fs.existsSync(filePath)) return { ok: false, reason: 'missing' };

  let handle = null;
  try {
    // Read-only, which also means migrations are not applied to it: a backup
    // is checked as it is, not quietly upgraded by looking at it.
    handle = openDatabase({ file: filePath, readonly: true });
    const integrity = handle.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') return { ok: false, reason: 'integrity', detail: integrity };

    const counts = {
      projects: handle.prepare('SELECT COUNT(*) AS n FROM projects').get().n,
      tasks: handle.prepare('SELECT COUNT(*) AS n FROM tasks').get().n,
      payments: handle.prepare('SELECT COUNT(*) AS n FROM payments').get().n,
    };
    return { ok: true, counts, bytes: fs.statSync(filePath).size };
  } catch (error) {
    return { ok: false, reason: 'unreadable', detail: error.message };
  } finally {
    handle?.close?.();
  }
}

const RESTORE_STEPS = Object.freeze([
  'Stop the bot. Restoring underneath a running process gives you a database that disagrees with itself.',
  'Move the current file aside rather than deleting it — `mv studio.sqlite studio.sqlite.broken`. It may still hold something the backup does not.',
  'Also move aside `studio.sqlite-wal` and `studio.sqlite-shm` if they exist. Leaving an old write-ahead log next to a restored database corrupts it.',
  'Copy the backup into place as `studio.sqlite`.',
  'Start the bot. Migrations run automatically and are safe to re-run.',
  'Check `/studio setup` and `/summary now` before telling anybody it worked.',
]);

module.exports = {
  backupEvidence,
  EXPORTABLE,
  EXPORT_KINDS,
  RESTORE_STEPS,
  csvCell,
  toCsv,
  exportRows,
  exportCsv,
  backup,
  defaultBackupPath,
  newestBackup,
  verifyBackup,
};
