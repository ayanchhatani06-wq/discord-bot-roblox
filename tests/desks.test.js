const test = require('node:test');
const assert = require('node:assert/strict');

const { openDatabase } = require('../src/db');
const configRepo = require('../src/db/repos/config');
const staffRepo = require('../src/db/repos/staff');
const projectsRepo = require('../src/db/repos/projects');
const tasksRepo = require('../src/db/repos/tasks');
const offersRepo = require('../src/db/repos/offers');
const paymentsRepo = require('../src/db/repos/payments');
const enquiriesRepo = require('../src/db/repos/enquiries');
const escalationsRepo = require('../src/db/repos/escalations');
const clientsRepo = require('../src/db/repos/clients');
const desks = require('../src/services/desks');
const { TASK_STATES } = require('../src/domain/taskState');
const { DAY_MS } = require('../src/utils/time');

const GUILD = 'guild-1';
const OWNER = 'owner-1';
const LEADER = 'leader-1';
const ARTIST = 'artist-1';

function setup() {
  const db = openDatabase({ file: ':memory:' });
  configRepo.ensureConfig(db, GUILD);
  configRepo.seedDefaultDepartments(db, GUILD, OWNER);
  configRepo.updateConfig(db, GUILD, { owner_user_id: OWNER }, OWNER);

  for (const id of [ARTIST, LEADER]) {
    staffRepo.ensureStaff(db, GUILD, id, id);
    staffRepo.updateStaff(db, GUILD, id, {
      timezone: 'Europe/London',
      department_id: configRepo.getDepartmentByKey(db, GUILD, 'modelling').id,
    });
  }
  return db;
}

function makeProject(db, overrides = {}) {
  return projectsRepo.createProject(db, GUILD, {
    name: 'Pack', clientAmountMinor: 40000, clientCurrency: 'USD', ...overrides,
  }, OWNER);
}

function makeTask(db, project, { state = TASK_STATES.UNASSIGNED, pay = null, artist = null, deadline = null, title = 'Model' } = {}) {
  const task = tasksRepo.createTask(db, GUILD, {
    projectId: project.id,
    title,
    departmentId: configRepo.getDepartmentByKey(db, GUILD, 'modelling').id,
    leaderUserId: LEADER,
    deadlineUtc: deadline,
  }, OWNER);

  if (pay !== null) {
    tasksRepo.approvePay(db, GUILD, task.id, { amountMinor: pay, currency: 'USD', actorUserId: OWNER });
  }
  db.prepare('UPDATE tasks SET state = ?, artist_user_id = ? WHERE id = ?').run(state, artist, task.id);
  return tasksRepo.getTask(db, GUILD, task.id);
}

function fieldMap(embed) {
  return new Map(embed.toJSON().fields.map((field) => [field.name.replace(/\s*\(\d+\)$/, ''), field.value]));
}

test('My Desk gathers offers, assignments, deadlines and pay in one place', () => {
  const db = setup();
  const project = makeProject(db);

  const offeredTask = makeTask(db, project, { state: TASK_STATES.OFFERED, pay: 2500, artist: ARTIST, title: 'Offered one' });
  offersRepo.createOffer(db, GUILD, { taskId: offeredTask.id, artistUserId: ARTIST, offeredBy: LEADER, terms: {} });

  makeTask(db, project, { state: TASK_STATES.IN_PROGRESS, pay: 2500, artist: ARTIST, title: 'Active one' });
  makeTask(db, project, {
    state: TASK_STATES.IN_PROGRESS, pay: 1000, artist: ARTIST, title: 'Late one', deadline: Date.now() - DAY_MS,
  });
  makeTask(db, project, { state: TASK_STATES.REVISION_NEEDED, pay: 500, artist: ARTIST, title: 'Revise one' });

  const desk = desks.buildMyDesk(db, GUILD, ARTIST);
  const fields = fieldMap(desk.embed);

  assert.equal(desk.counts.offers, 1);
  assert.match(fields.get('📨 Offers waiting for you'), /Offered one/);
  assert.match(fields.get('🛠️ Current assignments'), /Active one/);
  assert.match(fields.get('🔁 Changes requested'), /Revise one/);
  assert.match(fields.get('📅 Deadlines'), /overdue/);
  assert.equal(desk.counts.overdue, 1);
  db.close();
});

test('My Desk shows what is owed and what is actually payable', () => {
  const db = setup();
  const project = makeProject(db);

  const approved = makeTask(db, project, { state: TASK_STATES.CLIENT_APPROVED, pay: 2500, artist: ARTIST });
  db.prepare("UPDATE tasks SET payment_state = 'payable' WHERE id = ?").run(approved.id);
  makeTask(db, project, { state: TASK_STATES.IN_PROGRESS, pay: 1500, artist: ARTIST });

  paymentsRepo.recordPayment(db, GUILD, {
    direction: 'payout', projectId: project.id, taskId: approved.id, payeeUserId: ARTIST,
    amountMinor: 500, currency: 'USD', recordedBy: OWNER, idempotencyKey: 'p1',
  });

  const fields = fieldMap(desks.buildMyDesk(db, GUILD, ARTIST).embed);
  const pay = fields.get('💰 Your pay');

  // $2500 + $1500 agreed, $500 already paid, so $35.00 outstanding.
  assert.match(pay, /Owed to you: \*\*\$35\.00\*\*/);
  assert.match(pay, /Paid to date: \$5\.00/);
  assert.match(pay, /payable now/);
  db.close();
});

test('My Desk shows one person only their own work', () => {
  const db = setup();
  const project = makeProject(db);
  makeTask(db, project, { state: TASK_STATES.IN_PROGRESS, pay: 2500, artist: ARTIST, title: 'Mine' });
  makeTask(db, project, { state: TASK_STATES.IN_PROGRESS, pay: 9900, artist: 'artist-2', title: 'Theirs' });

  const rendered = JSON.stringify(desks.buildMyDesk(db, GUILD, ARTIST).embed.toJSON());
  assert.ok(rendered.includes('Mine'));
  assert.ok(!rendered.includes('Theirs'));
  assert.ok(!rendered.includes('99.00'), "another artist's pay must not appear");
  db.close();
});

test('an empty desk reads as empty rather than erroring', () => {
  const db = setup();
  const desk = desks.buildMyDesk(db, GUILD, 'nobody-1');

  assert.equal(desk.counts.offers, 0);
  assert.equal(desk.counts.active, 0);
  assert.match(desk.embed.toJSON().description, /no studio profile|accepting/i);
  db.close();
});

test('Group Desk shows the queue, reviews, risk and capacity for one department', () => {
  const db = setup();
  const project = makeProject(db);
  const department = configRepo.getDepartmentByKey(db, GUILD, 'modelling');

  makeTask(db, project, { title: 'Waiting', pay: 2500 });
  makeTask(db, project, { title: 'Unpaid one' });
  makeTask(db, project, { state: TASK_STATES.OFFERED, pay: 2500, artist: ARTIST, title: 'Out with artist' });
  makeTask(db, project, { state: TASK_STATES.INTERNAL_REVIEW, pay: 2500, artist: ARTIST, title: 'For review' });
  makeTask(db, project, { state: TASK_STATES.AWAITING_CLIENT, pay: 2500, artist: ARTIST, title: 'With client' });
  makeTask(db, project, {
    state: TASK_STATES.IN_PROGRESS, pay: 2500, artist: ARTIST, title: 'Late', deadline: Date.now() - DAY_MS,
  });

  const desk = desks.buildGroupDesk(db, GUILD, department);
  const fields = fieldMap(desk.embed);

  assert.match(fields.get('📥 Unassigned'), /Waiting/);
  assert.match(fields.get('📥 Unassigned'), /pay not approved/);
  assert.match(fields.get('⏳ Offered, not answered'), /Out with artist/);
  assert.match(fields.get('🔍 Waiting for your review'), /For review/);
  assert.match(fields.get('📤 With the client'), /With client/);
  assert.match(fields.get('🔴 Deadline risk'), /Late/);
  assert.match(fields.get('👥 Capacity'), /artist-1/);
  assert.equal(desk.counts.queue, 2);
  db.close();
});

test('Group Desk covers only its own department', () => {
  const db = setup();
  const project = makeProject(db);
  const modelling = configRepo.getDepartmentByKey(db, GUILD, 'modelling');
  const vfx = configRepo.getDepartmentByKey(db, GUILD, 'vfx');

  makeTask(db, project, { title: 'Model task' });
  tasksRepo.createTask(db, GUILD, { projectId: project.id, title: 'VFX task', departmentId: vfx.id }, OWNER);

  const rendered = JSON.stringify(desks.buildGroupDesk(db, GUILD, modelling).embed.toJSON());
  assert.ok(rendered.includes('Model task'));
  assert.ok(!rendered.includes('VFX task'));
  db.close();
});

test('Owner Desk lists everything waiting on a decision', () => {
  const db = setup();
  const project = makeProject(db);

  // A pay proposal from a leader.
  const proposed = makeTask(db, project, { title: 'Needs pay' });
  tasksRepo.proposePay(db, GUILD, proposed.id, { amountMinor: 2000, currency: 'USD', actorUserId: LEADER });

  // A flagged scope decision.
  const flagged = makeTask(db, project, { state: TASK_STATES.CLIENT_APPROVED, pay: 2500, artist: ARTIST, title: 'Scope' });
  tasksRepo.setFlag(db, GUILD, flagged.id, 'scope', true, OWNER, 'client asked for more');

  // A draft quote.
  const enquiry = enquiriesRepo.createEnquiry(db, GUILD, { serviceRequest: '3 models', parsed: [] }, OWNER);
  enquiriesRepo.createQuote(db, GUILD, enquiry.id, { lines: [], totalMinor: 12000, currency: 'USD' }, LEADER);

  // A staff concern.
  escalationsRepo.raise(db, GUILD, { raisedBy: ARTIST, category: 'payment', subject: 'Unpaid', body: 'x' });

  const desk = desks.buildOwnerDesk(db, GUILD);
  const description = desk.embed.toJSON().description;

  assert.match(description, /1 pay proposal/);
  assert.match(description, /1 draft quote/);
  assert.match(description, /flagged for scope or compensation/);
  assert.match(description, /1 staff concern/);
  assert.ok(desk.counts.decisions >= 4);
  db.close();
});

test('Owner Desk says so plainly when nothing needs deciding', () => {
  const db = setup();
  const desk = desks.buildOwnerDesk(db, GUILD);

  assert.match(desk.embed.toJSON().description, /Nothing is waiting on a decision/);
  assert.equal(desk.counts.decisions, 0);
  db.close();
});

test('Owner Desk flags a project that commits more to artists than the client pays', () => {
  const db = setup();
  const healthy = makeProject(db, { name: 'Healthy', clientAmountMinor: 40000 });
  makeTask(db, healthy, { pay: 2500, title: 'Fine' });

  const overcommitted = makeProject(db, { name: 'Overcommitted', clientAmountMinor: 5000 });
  makeTask(db, overcommitted, { pay: 3000, title: 'A' });
  makeTask(db, overcommitted, { pay: 3000, title: 'B' });

  const fields = fieldMap(desks.buildOwnerDesk(db, GUILD).embed);
  const exceptions = fields.get('⚠️ Budget exceptions');

  assert.ok(exceptions, 'the exception section appears');
  assert.match(exceptions, new RegExp(overcommitted.code));
  assert.ok(!exceptions.includes(healthy.code), 'a healthy project is not flagged');
  db.close();
});

test('a budget exception in a different currency is not falsely reported', () => {
  const db = setup();
  const project = makeProject(db, { clientAmountMinor: 5000, clientCurrency: 'USD' });
  const task = makeTask(db, project, { title: 'Robux paid' });
  tasksRepo.approvePay(db, GUILD, task.id, { amountMinor: 900000, currency: 'ROBUX', actorUserId: OWNER });

  const fields = fieldMap(desks.buildOwnerDesk(db, GUILD).embed);
  // Robux pay cannot be compared with a USD budget, so it is left out rather
  // than converted at an invented rate.
  assert.equal(fields.get('⚠️ Budget exceptions'), undefined);
  db.close();
});

test('Owner Desk reports money per currency and never combines them', () => {
  const db = setup();
  const project = makeProject(db);

  paymentsRepo.recordPayment(db, GUILD, {
    direction: 'client_receipt', projectId: project.id, amountMinor: 40000, currency: 'USD',
    recordedBy: OWNER, idempotencyKey: 'r1',
  });
  paymentsRepo.recordPayment(db, GUILD, {
    direction: 'payout', projectId: project.id, payeeUserId: ARTIST, amountMinor: 1500, currency: 'ROBUX',
    recordedBy: OWNER, idempotencyKey: 'p1',
  });

  const money = fieldMap(desks.buildOwnerDesk(db, GUILD).embed).get('💵 Money');
  assert.match(money, /Received from clients: \$400\.00/);
  assert.match(money, /Paid out: R\$1,500/);
  db.close();
});

test('Owner Desk surfaces undecided client problems', () => {
  const db = setup();
  const project = makeProject(db);
  const client = clientsRepo.createClient(db, GUILD, { displayName: 'Demo' }, OWNER);
  clientsRepo.linkProject(db, GUILD, project.id, client.id, OWNER);

  clientsRepo.createRequest(db, GUILD, {
    projectId: project.id, clientId: client.id, raisedBy: 'client-user-1',
    kind: 'delivery_issue', body: 'Missing textures',
  });

  assert.match(desks.buildOwnerDesk(db, GUILD).embed.toJSON().description, /1 client problem/);
  db.close();
});

test('every desk field stays inside Discord embed limits', () => {
  const db = setup();
  const project = makeProject(db);
  const department = configRepo.getDepartmentByKey(db, GUILD, 'modelling');

  // Enough work to overflow a naive renderer.
  for (let i = 0; i < 40; i += 1) {
    makeTask(db, project, {
      title: `A task with quite a long descriptive title number ${i}`,
      pay: 2500,
      artist: ARTIST,
      state: TASK_STATES.IN_PROGRESS,
      deadline: Date.now() - DAY_MS,
    });
  }

  for (const embed of [
    desks.buildMyDesk(db, GUILD, ARTIST).embed,
    desks.buildGroupDesk(db, GUILD, department).embed,
    desks.buildOwnerDesk(db, GUILD).embed,
  ]) {
    const json = embed.toJSON();
    assert.ok((json.description || '').length <= 4096);
    for (const field of json.fields || []) {
      assert.ok(field.value.length <= 1024, `field "${field.name}" is ${field.value.length} characters`);
      assert.ok(field.name.length <= 256);
    }
    assert.ok((json.fields || []).length <= 25);
  }
  db.close();
});
