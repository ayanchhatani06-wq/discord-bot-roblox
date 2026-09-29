const test = require('node:test');
const assert = require('node:assert/strict');

const { openDatabase } = require('../src/db');
const configRepo = require('../src/db/repos/config');
const clientsRepo = require('../src/db/repos/clients');
const projectsRepo = require('../src/db/repos/projects');
const tasksRepo = require('../src/db/repos/tasks');
const clientRecordsRepo = require('../src/db/repos/clientRecords');
const repeatOrders = require('../src/services/repeatOrders');

const GUILD = 'guild-1';
const OWNER = 'owner-1';
const FINDER = 'finder-1';

function setup() {
  const db = openDatabase({ file: ':memory:' });
  configRepo.ensureConfig(db, GUILD);
  configRepo.seedDefaultDepartments(db, GUILD, OWNER);
  configRepo.updateConfig(db, GUILD, { owner_user_id: OWNER }, OWNER);
  return db;
}

const modelling = (db) => configRepo.getDepartmentByKey(db, GUILD, 'modelling');
const vfx = (db) => configRepo.getDepartmentByKey(db, GUILD, 'vfx');

function makeClient(db) {
  return clientsRepo.createClient(db, GUILD, { displayName: 'Acme Games' }, OWNER);
}

/** A finished order with two items, priced and dated — the thing to repeat. */
function makeSourceOrder(db, client) {
  const project = projectsRepo.createProject(db, GUILD, {
    name: 'Lobby pack',
    brief: 'A set of lobby props.',
    clientAmountMinor: 12000,
    clientCurrency: 'USD',
    deadlineUtc: Date.now() - 1000,
    finderUserId: FINDER,
  }, OWNER);
  clientsRepo.linkProject(db, GUILD, project.id, client.id, OWNER, { clientChannelId: 'channel-1' });

  tasksRepo.createTask(db, GUILD, {
    projectId: project.id, title: 'Crate', departmentId: modelling(db).id, brief: 'A wooden crate.',
  }, OWNER);
  tasksRepo.createTask(db, GUILD, {
    projectId: project.id, title: 'Sparks', departmentId: vfx(db).id,
  }, OWNER);

  return projectsRepo.getProject(db, GUILD, project.id);
}

function makeDraft(db, client) {
  const source = makeSourceOrder(db, client);
  return clientRecordsRepo.draftFromProject(
    db, GUILD, source, tasksRepo.listTasksForProject(db, source.id), {}, OWNER
  );
}

// ---------------------------------------------------------------------------
// Standing requirements
// ---------------------------------------------------------------------------

test('a requirement with no department applies to everybody', () => {
  const db = setup();
  const client = makeClient(db);

  clientRecordsRepo.addRequirement(db, GUILD, client.id, {
    label: 'Naming', detail: 'lowercase_with_underscores',
  }, OWNER);
  clientRecordsRepo.addRequirement(db, GUILD, client.id, {
    label: 'Texture size', detail: '4K only', departmentId: modelling(db).id,
  }, OWNER);

  const forModelling = clientRecordsRepo.listRequirements(db, GUILD, client.id, { departmentId: modelling(db).id });
  assert.deepEqual(forModelling.map((row) => row.label).sort(), ['Naming', 'Texture size']);

  const forVfx = clientRecordsRepo.listRequirements(db, GUILD, client.id, { departmentId: vfx(db).id });
  assert.deepEqual(forVfx.map((row) => row.label), ['Naming'],
    'a modelling-only requirement is noise for the VFX team');
});

test('a retired requirement stops being shown but stays on the record', () => {
  const db = setup();
  const client = makeClient(db);
  const requirement = clientRecordsRepo.addRequirement(db, GUILD, client.id, {
    label: 'Naming', detail: 'lowercase',
  }, OWNER);

  clientRecordsRepo.updateRequirement(db, GUILD, requirement.id, { active: 0 }, OWNER);

  assert.equal(clientRecordsRepo.listRequirements(db, GUILD, client.id).length, 0);
  assert.equal(clientRecordsRepo.listRequirements(db, GUILD, client.id, { includeInactive: true }).length, 1);
});

test('requirements are found through the project, not typed in again', () => {
  const db = setup();
  const client = makeClient(db);
  const project = makeSourceOrder(db, client);
  clientRecordsRepo.addRequirement(db, GUILD, client.id, { label: 'Naming', detail: 'lowercase' }, OWNER);

  assert.equal(clientRecordsRepo.requirementsForProject(db, GUILD, project).length, 1);

  const noClient = projectsRepo.createProject(db, GUILD, { name: 'Internal' }, OWNER);
  assert.deepEqual(clientRecordsRepo.requirementsForProject(db, GUILD, noClient), []);
});

// ---------------------------------------------------------------------------
// Repeat orders
// ---------------------------------------------------------------------------

test("a draft copies the shape of an order but not last time's terms", () => {
  const db = setup();
  const client = makeClient(db);
  const draft = makeDraft(db, client);

  assert.equal(clientRecordsRepo.draftItems(draft).length, 2, 'the items came across');
  assert.equal(draft.brief, 'A set of lobby props.');

  assert.equal(draft.client_amount_minor, null, "last time's price is not carried over");
  assert.equal(draft.deadline_utc, null, "last time's deadline is not carried over");
  assert.deepEqual(clientRecordsRepo.outstandingConfirmations(draft), ['scope', 'price', 'deadline']);
});

test('a draft cannot become an order until all three are confirmed', () => {
  const db = setup();
  const client = makeClient(db);
  const draft = makeDraft(db, client);

  const tooEarly = repeatOrders.materialise(db, GUILD, draft.id, { actorUserId: OWNER });
  assert.equal(tooEarly.ok, false);
  assert.deepEqual(tooEarly.missing, ['scope', 'price', 'deadline']);

  clientRecordsRepo.confirmScope(db, GUILD, draft.id, {
    items: clientRecordsRepo.draftItems(draft), actorUserId: OWNER,
  });
  clientRecordsRepo.confirmPrice(db, GUILD, draft.id, { amountMinor: 15000, currency: 'USD', actorUserId: OWNER });

  const stillMissing = repeatOrders.materialise(db, GUILD, draft.id, { actorUserId: OWNER });
  assert.equal(stillMissing.ok, false);
  assert.deepEqual(stillMissing.missing, ['deadline']);

  clientRecordsRepo.confirmDeadline(db, GUILD, draft.id, { deadlineUtc: Date.now() + 86_400_000, actorUserId: OWNER });
  assert.equal(repeatOrders.materialise(db, GUILD, draft.id, { actorUserId: OWNER }).ok, true);
});

test('each confirmation records who made it', () => {
  const db = setup();
  const client = makeClient(db);
  const draft = makeDraft(db, client);

  const priced = clientRecordsRepo.confirmPrice(db, GUILD, draft.id, {
    amountMinor: 15000, currency: 'USD', actorUserId: 'manager-1',
  });

  assert.equal(priced.price_confirmed_by, 'manager-1');
  assert.ok(priced.price_confirmed_at > 0);
});

function fullyConfirmed(db, client, { deadlineUtc = Date.now() + 86_400_000 } = {}) {
  const draft = makeDraft(db, client);
  clientRecordsRepo.confirmScope(db, GUILD, draft.id, {
    items: clientRecordsRepo.draftItems(draft), actorUserId: OWNER,
  });
  clientRecordsRepo.confirmPrice(db, GUILD, draft.id, { amountMinor: 15000, currency: 'USD', actorUserId: OWNER });
  clientRecordsRepo.confirmDeadline(db, GUILD, draft.id, { deadlineUtc, actorUserId: OWNER });
  return clientRecordsRepo.getDraft(db, GUILD, draft.id);
}

test('creating the order carries the relationship across but no money or dates from before', () => {
  const db = setup();
  const client = makeClient(db);
  const draft = fullyConfirmed(db, client);

  const result = repeatOrders.materialise(db, GUILD, draft.id, { actorUserId: OWNER, clientChannelId: 'channel-2' });
  assert.equal(result.ok, true);

  assert.equal(result.project.client_id, client.id);
  assert.equal(result.project.client_channel_id, 'channel-2');
  assert.equal(result.project.finder_user_id, FINDER, 'who found the client is still true');
  assert.equal(result.project.client_amount_minor, 15000, 'this order\'s price, not last order\'s');

  assert.equal(result.tasks.length, 2);
  for (const task of result.tasks) {
    assert.equal(task.artist_pay_minor, null, 'pay is agreed per order, never inherited');
    assert.equal(task.artist_user_id, null, 'nobody is assigned by a repeat');
    assert.equal(task.state, 'unassigned');
  }
});

test('a draft can only become an order once', () => {
  const db = setup();
  const client = makeClient(db);
  const draft = fullyConfirmed(db, client);

  const first = repeatOrders.materialise(db, GUILD, draft.id, { actorUserId: OWNER });
  assert.equal(first.ok, true);

  const second = repeatOrders.materialise(db, GUILD, draft.id, { actorUserId: OWNER });
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'already_decided');

  assert.equal(projectsRepo.listProjects(db, GUILD, { status: 'all', limit: 50 }).length, 2,
    'the source order and one repeat, not two repeats');
});

test('a discarded draft creates nothing and cannot be revived by confirming it', () => {
  const db = setup();
  const client = makeClient(db);
  const draft = fullyConfirmed(db, client);

  clientRecordsRepo.discardDraft(db, GUILD, draft.id, OWNER);
  const result = repeatOrders.materialise(db, GUILD, draft.id, { actorUserId: OWNER });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'already_decided');
  assert.equal(projectsRepo.listProjects(db, GUILD, { status: 'all', limit: 50 }).length, 1);
});

test('a rewritten scope replaces the copied items', () => {
  const db = setup();
  const client = makeClient(db);
  const draft = makeDraft(db, client);

  const updated = clientRecordsRepo.confirmScope(db, GUILD, draft.id, {
    items: [{ title: 'Just one crate', department_id: modelling(db).id }],
    actorUserId: OWNER,
  });

  assert.equal(clientRecordsRepo.draftItems(updated).length, 1);
  assert.equal(clientRecordsRepo.draftItems(updated)[0].title, 'Just one crate');
});

test('an empty draft cannot become an order', () => {
  const db = setup();
  const client = makeClient(db);
  const draft = makeDraft(db, client);

  clientRecordsRepo.confirmScope(db, GUILD, draft.id, { items: [], actorUserId: OWNER });
  clientRecordsRepo.confirmPrice(db, GUILD, draft.id, { amountMinor: 100, currency: 'USD', actorUserId: OWNER });
  clientRecordsRepo.confirmDeadline(db, GUILD, draft.id, { deadlineUtc: Date.now() + 1000, actorUserId: OWNER });

  const result = repeatOrders.materialise(db, GUILD, draft.id, { actorUserId: OWNER });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no_items');
});

test('drafts are invisible to everything that looks at real orders', () => {
  const db = setup();
  const client = makeClient(db);
  makeDraft(db, client);

  // One project exists: the source order. The draft is not one.
  assert.equal(projectsRepo.listProjects(db, GUILD, { status: 'all', limit: 50 }).length, 1);
  assert.equal(clientsRepo.clientOrderHistory(db, GUILD, client.id).length, 1);
});
