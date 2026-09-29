const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDatabase } = require('../src/db');
const { nextCode, recordAudit, listAudit, claimGuard, pruneGuards } = require('../src/db/repos/core');

const GUILD = 'guild-1';

function memoryDb() {
  return openDatabase({ file: ':memory:' });
}

function seedDepartment(db, key = 'modelling') {
  const now = Date.now();
  return db.prepare(`
    INSERT INTO departments (guild_id, key, name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?) RETURNING id
  `).get(GUILD, key, key, now, now).id;
}

function seedProject(db) {
  const now = Date.now();
  return db.prepare(`
    INSERT INTO projects (guild_id, code, name, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?) RETURNING id
  `).get(GUILD, nextCode(db, GUILD, 'project'), 'Test project', 'owner-1', now, now).id;
}

function seedTask(db, projectId, departmentId, overrides = {}) {
  const now = Date.now();
  const columns = {
    guild_id: GUILD,
    project_id: projectId,
    code: nextCode(db, GUILD, 'task'),
    title: 'Test task',
    department_id: departmentId,
    created_by: 'owner-1',
    created_at: now,
    updated_at: now,
    ...overrides,
  };
  const keys = Object.keys(columns);
  return db.prepare(`
    INSERT INTO tasks (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')}) RETURNING id
  `).get(...keys.map((k) => columns[k])).id;
}

test('migrations create the schema and are idempotent', () => {
  const db = memoryDb();
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);

  for (const expected of [
    'guild_config', 'departments', 'role_capabilities', 'staff', 'board_messages',
    'projects', 'tasks', 'task_offers', 'submissions', 'reviews', 'client_decisions',
    'payments', 'allocations', 'allocation_config', 'reminder_state', 'audit_log',
    'interaction_guards', 'schema_migrations',
  ]) {
    assert.ok(tables.includes(expected), `missing table ${expected}`);
  }

  const applied = db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n;
  assert.equal(applied, 1);
  db.close();
});

test('data survives closing and reopening the database file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-db-'));
  const file = path.join(dir, 'studio.db');

  let db = openDatabase({ file });
  const now = Date.now();
  db.prepare(`
    INSERT INTO staff (guild_id, user_id, display_name, timezone, availability, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(GUILD, 'artist-1', 'Artist One', 'Asia/Karachi', 'accepting', now, now);
  const code = nextCode(db, GUILD, 'project');
  db.close();

  db = openDatabase({ file });
  const staff = db.prepare('SELECT * FROM staff WHERE guild_id = ? AND user_id = ?').get(GUILD, 'artist-1');
  assert.equal(staff.timezone, 'Asia/Karachi');
  assert.equal(staff.display_name, 'Artist One');
  assert.equal(code, 'PRJ-0001');
  // The counter continues rather than restarting after a reboot.
  assert.equal(nextCode(db, GUILD, 'project'), 'PRJ-0002');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n, 1);

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('codes are sequential per guild and per kind', () => {
  const db = memoryDb();
  assert.equal(nextCode(db, GUILD, 'project'), 'PRJ-0001');
  assert.equal(nextCode(db, GUILD, 'project'), 'PRJ-0002');
  assert.equal(nextCode(db, GUILD, 'task'), 'TSK-0001');
  assert.equal(nextCode(db, 'guild-2', 'project'), 'PRJ-0001');
  assert.throws(() => nextCode(db, GUILD, 'invoice'), /Unknown code kind/);
  db.close();
});

test('a guard key can only be claimed once', () => {
  const db = memoryDb();
  assert.equal(claimGuard(db, 'accept:task-1:artist-1'), true);
  assert.equal(claimGuard(db, 'accept:task-1:artist-1'), false, 'a repeated click is refused');
  assert.equal(claimGuard(db, 'accept:task-1:artist-2'), true);

  // Two rows exist, not three: the rejected duplicate never inserted one.
  db.prepare('UPDATE interaction_guards SET created_at = ?').run(Date.now() - 30 * 24 * 60 * 60 * 1000);
  assert.equal(pruneGuards(db), 2);
  db.close();
});

test('duplicate payments are impossible for the same idempotency key', () => {
  const db = memoryDb();
  const departmentId = seedDepartment(db);
  const projectId = seedProject(db);
  const taskId = seedTask(db, projectId, departmentId);

  const insert = db.prepare(`
    INSERT INTO payments
      (guild_id, direction, project_id, task_id, payee_user_id, amount_minor, currency, method_label, recorded_by, recorded_at, idempotency_key)
    VALUES (?, 'payout', ?, ?, ?, ?, 'USD', 'PayPal', 'owner-1', ?, ?)
  `);

  insert.run(GUILD, projectId, taskId, 'artist-1', 2500, Date.now(), `payout:${taskId}:artist-1:1`);
  assert.throws(
    () => insert.run(GUILD, projectId, taskId, 'artist-1', 2500, Date.now(), `payout:${taskId}:artist-1:1`),
    /UNIQUE constraint failed/
  );

  // A genuinely different payment is still allowed.
  insert.run(GUILD, projectId, taskId, 'artist-1', 500, Date.now(), `payout:${taskId}:artist-1:2`);
  const total = db.prepare("SELECT SUM(amount_minor) AS total FROM payments WHERE task_id = ? AND direction = 'payout'").get(taskId).total;
  assert.equal(total, 3000);
  db.close();
});

test('client receipts and staff payouts stay separable', () => {
  const db = memoryDb();
  const departmentId = seedDepartment(db);
  const projectId = seedProject(db);
  const taskId = seedTask(db, projectId, departmentId);
  const now = Date.now();

  db.prepare(`
    INSERT INTO payments (guild_id, direction, project_id, amount_minor, currency, recorded_by, recorded_at, idempotency_key)
    VALUES (?, 'client_receipt', ?, 4000, 'USD', 'owner-1', ?, 'receipt:1')
  `).run(GUILD, projectId, now);
  db.prepare(`
    INSERT INTO payments (guild_id, direction, project_id, task_id, payee_user_id, amount_minor, currency, recorded_by, recorded_at, idempotency_key)
    VALUES (?, 'payout', ?, ?, 'artist-1', 2500, 'ROBUX', 'owner-1', ?, 'payout:1')
  `).run(GUILD, projectId, taskId, now);

  const byDirection = db.prepare(`
    SELECT direction, currency, SUM(amount_minor) AS total FROM payments
    WHERE guild_id = ? GROUP BY direction, currency ORDER BY direction
  `).all(GUILD);

  assert.deepEqual(byDirection, [
    { direction: 'client_receipt', currency: 'USD', total: 4000 },
    { direction: 'payout', currency: 'ROBUX', total: 2500 },
  ]);
  db.close();
});

test('only one offer can be pending per task', () => {
  const db = memoryDb();
  const departmentId = seedDepartment(db);
  const projectId = seedProject(db);
  const taskId = seedTask(db, projectId, departmentId);

  const insert = db.prepare(`
    INSERT INTO task_offers (task_id, artist_user_id, offered_by, offered_at, terms_json, state)
    VALUES (?, ?, 'lead-1', ?, '{}', ?)
  `);

  insert.run(taskId, 'artist-1', Date.now(), 'pending');
  assert.throws(() => insert.run(taskId, 'artist-2', Date.now(), 'pending'), /UNIQUE constraint failed/);

  // Once the first offer is resolved, the task can be offered again.
  db.prepare("UPDATE task_offers SET state = 'declined', responded_at = ? WHERE task_id = ?").run(Date.now(), taskId);
  assert.doesNotThrow(() => insert.run(taskId, 'artist-2', Date.now(), 'pending'));
  db.close();
});

test('invalid enum values are rejected by the schema', () => {
  const db = memoryDb();
  const departmentId = seedDepartment(db);
  const projectId = seedProject(db);

  assert.throws(() => seedTask(db, projectId, departmentId, { state: 'finished' }), /CHECK constraint failed/);
  assert.throws(() => seedTask(db, projectId, departmentId, { payment_state: 'invoiced' }), /CHECK constraint failed/);
  assert.throws(() => seedTask(db, projectId, departmentId, { pay_state: 'haggling' }), /CHECK constraint failed/);
  assert.throws(
    () => db.prepare(`
      INSERT INTO staff (guild_id, user_id, availability, created_at, updated_at) VALUES (?, ?, 'busy', ?, ?)
    `).run(GUILD, 'x', Date.now(), Date.now()),
    /CHECK constraint failed/
  );
  db.close();
});

test('allocations are unique per recipient kind on a task', () => {
  const db = memoryDb();
  const departmentId = seedDepartment(db);
  const projectId = seedProject(db);
  const taskId = seedTask(db, projectId, departmentId);

  const insert = db.prepare(`
    INSERT INTO allocations (task_id, recipient_kind, recipient_user_id, percent_bp, amount_minor, currency, pool_minor, pool_source, computed_at)
    VALUES (?, ?, ?, ?, ?, 'USD', 1500, 'derived', ?)
  `);

  insert.run(taskId, 'leader', 'lead-1', 2000, 300, Date.now());
  assert.throws(() => insert.run(taskId, 'leader', 'lead-2', 2000, 300, Date.now()), /UNIQUE constraint failed/);
  assert.doesNotThrow(() => insert.run(taskId, 'owner', 'owner-1', 5000, 750, Date.now()));
  assert.throws(() => insert.run(taskId, 'intern', 'x', 100, 10, Date.now()), /CHECK constraint failed/);
  db.close();
});

test('the audit trail records before and after state', () => {
  const db = memoryDb();

  recordAudit(db, {
    guildId: GUILD,
    actorUserId: 'owner-1',
    action: 'task.pay.approve',
    entityType: 'task',
    entityId: 42,
    before: { artist_pay_minor: null },
    after: { artist_pay_minor: 2500, artist_pay_currency: 'USD' },
    detail: 'Approved proposed pay',
  });
  recordAudit(db, { guildId: GUILD, action: 'config.update', entityType: 'guild', entityId: GUILD });

  const forTask = listAudit(db, { guildId: GUILD, entityType: 'task', entityId: 42 });
  assert.equal(forTask.length, 1);
  assert.equal(forTask[0].actor_user_id, 'owner-1');
  assert.deepEqual(JSON.parse(forTask[0].after_json), { artist_pay_minor: 2500, artist_pay_currency: 'USD' });
  assert.equal(listAudit(db, { guildId: GUILD }).length, 2);
  db.close();
});

test('deleting a project keeps nothing dangling, but payments retain history', () => {
  const db = memoryDb();
  const departmentId = seedDepartment(db);
  const projectId = seedProject(db);
  const taskId = seedTask(db, projectId, departmentId);

  db.prepare(`
    INSERT INTO payments (guild_id, direction, project_id, task_id, payee_user_id, amount_minor, currency, recorded_by, recorded_at, idempotency_key)
    VALUES (?, 'payout', ?, ?, 'artist-1', 2500, 'USD', 'owner-1', ?, 'p:1')
  `).run(GUILD, projectId, taskId, Date.now());

  db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE id = ?').get(taskId).n, 0, 'tasks cascade');
  const payment = db.prepare("SELECT * FROM payments WHERE idempotency_key = 'p:1'").get();
  assert.ok(payment, 'the payment record itself is kept');
  assert.equal(payment.task_id, null);
  assert.equal(payment.amount_minor, 2500);
  db.close();
});
