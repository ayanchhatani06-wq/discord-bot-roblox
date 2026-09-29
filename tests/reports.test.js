const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { openDatabase } = require('../src/db');
const configRepo = require('../src/db/repos/config');
const projectsRepo = require('../src/db/repos/projects');
const tasksRepo = require('../src/db/repos/tasks');
const paymentsRepo = require('../src/db/repos/payments');
const reports = require('../src/services/reports');
const automation = require('../src/services/automation');
const exporter = require('../src/services/exporter');
const { TASK_STATES } = require('../src/domain/taskState');

const GUILD = 'guild-1';
const OWNER = 'owner-1';
const LEADER = 'leader-1';
const ARTIST = 'artist-1';
const DAY = reports.DAY_MS;

function setup() {
  const db = openDatabase({ file: ':memory:' });
  configRepo.ensureConfig(db, GUILD);
  configRepo.seedDefaultDepartments(db, GUILD, OWNER);
  configRepo.updateConfig(db, GUILD, { owner_user_id: OWNER }, OWNER);
  return db;
}

const modelling = (db) => configRepo.getDepartmentByKey(db, GUILD, 'modelling');

function makeProject(db, overrides = {}) {
  return projectsRepo.createProject(db, GUILD, { name: 'Order', ...overrides }, OWNER);
}

function makeTask(db, project, overrides = {}) {
  return tasksRepo.createTask(db, GUILD, {
    projectId: project.id, title: 'Crate', departmentId: modelling(db).id, leaderUserId: LEADER, ...overrides,
  }, OWNER);
}

/** Rewrites a task's audit trail so a timeline can be tested deterministically. */
function fakeTransition(db, task, state, at) {
  db.prepare(`
    INSERT INTO audit_log (guild_id, actor_user_id, action, entity_type, entity_id, after_json, created_at)
    VALUES (?, ?, ?, 'task', ?, ?, ?)
  `).run(GUILD, OWNER, 'task.test', String(task.id), JSON.stringify({ state }), at);
  db.prepare('UPDATE tasks SET state = ?, updated_at = ? WHERE id = ?').run(state, at, task.id);
}

// ---------------------------------------------------------------------------
// Waiting time
// ---------------------------------------------------------------------------

test('time with the client is not counted as the studio being slow', () => {
  const db = setup();
  const project = makeProject(db);
  const task = makeTask(db, project);

  const now = Date.now();
  db.prepare('UPDATE tasks SET created_at = ? WHERE id = ?').run(now - 10 * DAY, task.id);

  fakeTransition(db, task, TASK_STATES.IN_PROGRESS, now - 8 * DAY);
  fakeTransition(db, task, TASK_STATES.AWAITING_CLIENT, now - 6 * DAY);
  fakeTransition(db, task, TASK_STATES.CLIENT_APPROVED, now - 1 * DAY);

  const fresh = tasksRepo.getTask(db, GUILD, task.id);
  const breakdown = reports.waitingBreakdown(db, GUILD, fresh, { now });

  // 2 days unassigned + 2 days in progress with us; 5 days with the client.
  assert.equal(Math.round(breakdown.studio / DAY), 4);
  assert.equal(Math.round(breakdown.client / DAY), 5);
  assert.equal(breakdown.hold, 0);
});

test('time on hold is counted separately from both', () => {
  const db = setup();
  const project = makeProject(db);
  const task = makeTask(db, project);

  const now = Date.now();
  db.prepare('UPDATE tasks SET created_at = ? WHERE id = ?').run(now - 6 * DAY, task.id);
  fakeTransition(db, task, TASK_STATES.ON_HOLD, now - 4 * DAY);

  const breakdown = reports.waitingBreakdown(db, GUILD, tasksRepo.getTask(db, GUILD, task.id), { now });
  assert.equal(Math.round(breakdown.hold / DAY), 4);
  assert.equal(Math.round(breakdown.studio / DAY), 2);
});

test('a project sums its live items and ignores cancelled ones', () => {
  const db = setup();
  const project = makeProject(db);
  const now = Date.now();

  const live = makeTask(db, project);
  db.prepare('UPDATE tasks SET created_at = ? WHERE id = ?').run(now - 3 * DAY, live.id);

  const dead = makeTask(db, project, { title: 'Scrapped' });
  db.prepare('UPDATE tasks SET created_at = ?, state = ? WHERE id = ?')
    .run(now - 30 * DAY, TASK_STATES.CANCELLED, dead.id);

  const waiting = reports.projectWaiting(db, GUILD, project.id, { now });
  assert.equal(waiting.tasks, 1);
  assert.equal(Math.round(waiting.studio / DAY), 3);
});

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

test('overdue means past its deadline and still live', () => {
  const db = setup();
  const project = makeProject(db);
  const now = Date.now();

  const late = makeTask(db, project, { deadlineUtc: now - DAY });
  fakeTransition(db, late, TASK_STATES.IN_PROGRESS, now - 2 * DAY);

  const done = makeTask(db, project, { title: 'Finished', deadlineUtc: now - DAY });
  fakeTransition(db, done, TASK_STATES.CLIENT_APPROVED, now - 2 * DAY);

  const overdue = reports.filterTasks(db, GUILD, reports.FILTERS.OVERDUE, { now });
  assert.deepEqual(overdue.map((task) => task.id), [late.id], 'finished work cannot be overdue');
});

test('a stale task is one somebody is holding, not an empty queue', () => {
  const db = setup();
  const project = makeProject(db);
  const now = Date.now();

  const held = makeTask(db, project);
  fakeTransition(db, held, TASK_STATES.IN_PROGRESS, now - 10 * DAY);
  db.prepare('UPDATE tasks SET last_progress_at = ? WHERE id = ?').run(now - 10 * DAY, held.id);

  // An unassigned task is old but has nobody to chase.
  const nobody = makeTask(db, project, { title: 'Unclaimed' });
  db.prepare('UPDATE tasks SET created_at = ?, updated_at = ? WHERE id = ?').run(now - 40 * DAY, now - 40 * DAY, nobody.id);

  const stale = reports.filterTasks(db, GUILD, reports.FILTERS.NO_PROGRESS, { now });
  assert.deepEqual(stale.map((task) => task.id), [held.id]);
});

test('unpaid means approved work where somebody is still owed', () => {
  const db = setup();
  const project = makeProject(db);
  const task = makeTask(db, project);

  tasksRepo.approvePay(db, GUILD, task.id, { amountMinor: 2500, currency: 'USD', actorUserId: OWNER });
  tasksRepo.assignArtist(db, GUILD, task.id, ARTIST, OWNER);
  db.prepare("UPDATE tasks SET state = 'client_approved' WHERE id = ?").run(task.id);

  assert.equal(reports.filterTasks(db, GUILD, reports.FILTERS.UNPAID).length, 1);

  paymentsRepo.recordPayment(db, GUILD, {
    direction: 'payout', taskId: task.id, payeeUserId: ARTIST, amountMinor: 2500, currency: 'USD',
    recordedBy: OWNER, idempotencyKey: 'paid',
  });
  assert.equal(reports.filterTasks(db, GUILD, reports.FILTERS.UNPAID).length, 0);
});

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

test("a person's picture carries no score and the team list is not ranked", () => {
  const db = setup();
  const project = makeProject(db);

  const task = makeTask(db, project);
  tasksRepo.assignArtist(db, GUILD, task.id, ARTIST, OWNER);
  db.prepare("UPDATE tasks SET state = 'client_approved', completed_at = ? WHERE id = ?").run(Date.now(), task.id);

  const picture = reports.personPicture(db, GUILD, ARTIST);
  assert.equal(picture.approved, 1);
  assert.equal(picture.score, undefined, 'there is deliberately no single number');
  assert.match(picture.note, /league table/);

  const team = reports.peoplePictures(db, GUILD, ['zeta-1', 'alpha-1']);
  assert.deepEqual(team.map((row) => row.userId), ['alpha-1', 'zeta-1'], 'name order, so the top is not "best"');
});

test('work with no deadline is not counted as late', () => {
  const db = setup();
  const project = makeProject(db);
  const task = makeTask(db, project);

  tasksRepo.assignArtist(db, GUILD, task.id, ARTIST, OWNER);
  db.prepare("UPDATE tasks SET state = 'client_approved', completed_at = ? WHERE id = ?").run(Date.now(), task.id);

  const picture = reports.personPicture(db, GUILD, ARTIST);
  assert.equal(picture.measuredForTimeliness, 0, 'nothing to measure against');
  assert.equal(picture.onTime, 0);
});

// ---------------------------------------------------------------------------
// Automation
// ---------------------------------------------------------------------------

function makeRule(db, overrides = {}) {
  return automation.upsertRule(db, GUILD, {
    key: 'chase', label: 'Chase overdue work',
    triggerKey: automation.TRIGGERS.OVERDUE,
    actionKey: automation.ACTIONS.TELL_OWNER,
    ...overrides,
  }, OWNER);
}

test('a rule starts switched off, and changing it switches it off again', () => {
  const db = setup();
  const created = makeRule(db);
  assert.equal(created.rule.enabled, 0);

  automation.setRuleEnabled(db, GUILD, 'chase', true, OWNER);
  assert.equal(automation.getRule(db, GUILD, 'chase').enabled, 1);

  const changed = makeRule(db, { label: 'Chase overdue work, politely' });
  assert.equal(changed.rule.enabled, 0, 'a changed rule is a different rule');
});

test('a rule with an action it cannot carry out is refused', () => {
  const db = setup();
  const result = makeRule(db, { key: 'tell', actionKey: automation.ACTIONS.TELL_PERSON });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no_target');
  assert.equal(automation.getRule(db, GUILD, 'tell'), null);
});

test('preview says what would happen and changes nothing', async () => {
  const db = setup();
  const project = makeProject(db);
  const now = Date.now();

  const late = makeTask(db, project, { deadlineUtc: now - DAY });
  fakeTransition(db, late, TASK_STATES.IN_PROGRESS, now - 2 * DAY);

  const { rule } = makeRule(db);
  const check = automation.preview(db, GUILD, rule, { now });

  assert.equal(check.wouldAct, 1);
  assert.equal(check.alreadyActed, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM automation_events').get().n, 0,
    'a preview leaves no trace, because it did nothing');
});

test('a rule acts on each task once, however often it runs', async () => {
  const db = setup();
  const project = makeProject(db);
  const now = Date.now();

  const late = makeTask(db, project, { deadlineUtc: now - DAY });
  fakeTransition(db, late, TASK_STATES.IN_PROGRESS, now - 2 * DAY);

  const { rule } = makeRule(db);
  const sent = [];
  const discord = { users: { fetch: async () => ({ send: async (payload) => { sent.push(payload); return { id: 'm1' }; } }) } };

  const first = await automation.runRule(discord, db, GUILD, rule, { now });
  assert.equal(first.acted, 1);

  const second = await automation.runRule(discord, db, GUILD, rule, { now });
  assert.equal(second.acted, 0);
  assert.equal(second.skipped, 1, 'the same task is never chased twice by one rule');
  assert.equal(sent.length, 1);
});

test('only rules that are switched on run', async () => {
  const db = setup();
  const project = makeProject(db);
  const now = Date.now();

  const late = makeTask(db, project, { deadlineUtc: now - DAY });
  fakeTransition(db, late, TASK_STATES.IN_PROGRESS, now - 2 * DAY);
  makeRule(db);

  const discord = { users: { fetch: async () => ({ send: async () => ({ id: 'm1' }) }) } };
  assert.deepEqual(await automation.runAll(discord, db, GUILD, { now }), [], 'a rule left off does nothing');

  automation.setRuleEnabled(db, GUILD, 'chase', true, OWNER);
  const results = await automation.runAll(discord, db, GUILD, { now });
  assert.equal(results[0].acted, 1);
});

test('a rule scoped to a department leaves other departments alone', () => {
  const db = setup();
  const project = makeProject(db);
  const now = Date.now();
  const vfx = configRepo.getDepartmentByKey(db, GUILD, 'vfx');

  const mine = makeTask(db, project, { deadlineUtc: now - DAY });
  fakeTransition(db, mine, TASK_STATES.IN_PROGRESS, now - 2 * DAY);

  const theirs = makeTask(db, project, { title: 'Sparks', departmentId: vfx.id, deadlineUtc: now - DAY });
  fakeTransition(db, theirs, TASK_STATES.IN_PROGRESS, now - 2 * DAY);

  const { rule } = makeRule(db, { departmentId: modelling(db).id });
  const matched = automation.matches(db, GUILD, rule, { now });

  assert.deepEqual(matched.map((task) => task.id), [mine.id]);
});

// ---------------------------------------------------------------------------
// Exports and backups
// ---------------------------------------------------------------------------

test('a CSV survives a comma, a quote and a newline in the data', () => {
  const csv = exporter.toCsv([{ name: 'A, B', note: 'He said "no"', body: 'line one\nline two' }]);
  const lines = csv.split('\n');

  assert.equal(lines[0], 'name,note,body');
  assert.match(csv, /"A, B"/);
  assert.match(csv, /"He said ""no"""/);
  assert.match(csv, /"line one\nline two"/);
});

test('the payments export leaves references out', () => {
  const db = setup();
  const project = makeProject(db);
  paymentsRepo.recordPayment(db, GUILD, {
    direction: 'client_receipt', projectId: project.id, amountMinor: 1000, currency: 'USD',
    reference: 'GIFTCARD-SECRET-1234', recordedBy: OWNER, idempotencyKey: 'r1',
  });

  const result = exporter.exportCsv(db, GUILD, 'payments');
  assert.equal(result.rows, 1);
  assert.doesNotMatch(result.csv, /SECRET/, 'a reference can be a gift card code');
  assert.match(result.csv, /client_receipt/);
});

test('a backup is a real database that opens and passes its own integrity check', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-backup-'));
  const live = path.join(directory, 'live.sqlite');

  const db = openDatabase({ file: live });
  configRepo.ensureConfig(db, GUILD);
  configRepo.seedDefaultDepartments(db, GUILD, OWNER);
  makeProject(db);

  const destination = exporter.defaultBackupPath(directory);
  const result = await exporter.backup(db, destination);
  assert.ok(result.bytes > 0);

  const check = exporter.verifyBackup(openDatabase, destination);
  assert.equal(check.ok, true);
  assert.equal(check.counts.projects, 1);

  assert.equal(exporter.newestBackup(directory), destination);

  db.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test('verifying something that is not a database fails rather than passing quietly', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-backup-'));
  const fake = path.join(directory, 'not-a-database.sqlite');
  fs.writeFileSync(fake, 'this is just some text');

  const check = exporter.verifyBackup(openDatabase, fake);
  assert.equal(check.ok, false);

  assert.equal(exporter.verifyBackup(openDatabase, path.join(directory, 'nope.sqlite')).reason, 'missing');
  fs.rmSync(directory, { recursive: true, force: true });
});

test('the restore instructions say to move the write-ahead log aside', () => {
  // The single most common way a restore silently corrupts: leaving an old
  // -wal file next to a restored database.
  assert.ok(exporter.RESTORE_STEPS.some((step) => /-wal/.test(step)));
  assert.ok(exporter.RESTORE_STEPS.some((step) => /Stop the bot/i.test(step)));
});
