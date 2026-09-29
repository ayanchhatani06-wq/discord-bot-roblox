const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function applyMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);

  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((row) => row.version)
  );

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  const record = db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)');

  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    if (applied.has(version)) continue;

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    // Each migration and its bookkeeping row commit together, so a crash
    // mid-migration cannot leave a half-applied schema marked as done.
    db.transaction(() => {
      db.exec(sql);
      record.run(version, Date.now());
    })();
    console.log(`Applied migration ${version}`);
  }
}

function openDatabase({ file, readonly = false } = {}) {
  const dbPath = file || process.env.DATABASE_FILE || path.join(__dirname, '..', '..', 'data', 'studio.db');

  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  const db = new Database(dbPath, { readonly });
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  if (!readonly) applyMigrations(db);
  return db;
}

let singleton = null;

function getDatabase() {
  if (!singleton) singleton = openDatabase();
  return singleton;
}

function closeDatabase() {
  if (singleton) {
    singleton.close();
    singleton = null;
  }
}

module.exports = { openDatabase, getDatabase, closeDatabase, applyMigrations };
