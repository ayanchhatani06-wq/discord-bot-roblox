const test = require('node:test');
const assert = require('node:assert/strict');

const { openDatabase } = require('../src/db');
const configRepo = require('../src/db/repos/config');
const staffRepo = require('../src/db/repos/staff');
const projectsRepo = require('../src/db/repos/projects');
const tasksRepo = require('../src/db/repos/tasks');
const clientsRepo = require('../src/db/repos/clients');
const messagingRepo = require('../src/db/repos/messaging');
const nextActions = require('../src/services/nextActions');
const { resolveActor } = require('../src/domain/permissions');

const GUILD = 'guild-1';
const OWNER = 'owner-1';
const LEADER = 'leader-1';
const ARTIST = 'artist-1';
const DAY = nextActions.DAY_MS;

function setup() {
  const db = openDatabase({ file: ':memory:' });
  configRepo.ensureConfig(db, GUILD);
  configRepo.seedDefaultDepartments(db, GUILD, OWNER);
  configRepo.updateConfig(db, GUILD, { owner_user_id: OWNER }, OWNER);
  staffRepo.ensureStaff(db, GUILD, OWNER, 'Owner');
  staffRepo.setTimezone(db, GUILD, OWNER, 'UTC', OWNER);
  return db;
}

const modelling = (db) => configRepo.getDepartmentByKey(db, GUILD, 'modelling');

function actorFor(db, userId, { leadDepartmentIds = [] } = {}) {
  return resolveActor({
    userId,
    config: configRepo.getConfig(db, GUILD),
    departments: configRepo.listDepartments(db, GUILD),
    standInDepartmentIds: leadDepartmentIds,
  });
}

function makeTask(db, overrides = {}) {
  const project = projectsRepo.createProject(db, GUILD, { name: 'Order' }, OWNER);
  return tasksRepo.createTask(db, GUILD, {
    projectId: project.id, title: 'Crate', departmentId: modelling(db).id, ...overrides,
  }, OWNER);
}

test('an owner with nothing waiting gets an empty list, not invented work', () => {
  const db = setup();
  const result = nextActions.forUser(db, GUILD, OWNER, actorFor(db, OWNER));

  assert.equal(result.total, 0);
  assert.deepEqual(result.actions, []);
});

test('proposed pay is the most pressing thing an owner sees, because work waits on it', () => {
  const db = setup();
  const task = makeTask(db);
  tasksRepo.proposePay(db, GUILD, task.id, { amountMinor: 2500, currency: 'USD', actorUserId: LEADER });

  const result = nextActions.forUser(db, GUILD, OWNER, actorFor(db, OWNER));
  assert.equal(result.actions[0].urgency, nextActions.URGENCY.BLOCKING);
  assert.match(result.actions[0].text, /pay figure/);
  assert.match(result.actions[0].command, /approve-pay/);
});

test("an artist sees their own overdue work and nobody else's", () => {
  const db = setup();
  staffRepo.ensureStaff(db, GUILD, ARTIST, 'Artist');
  staffRepo.setTimezone(db, GUILD, ARTIST, 'UTC', ARTIST);

  const mine = makeTask(db, { title: 'Mine', deadlineUtc: Date.now() - DAY });
  tasksRepo.assignArtist(db, GUILD, mine.id, ARTIST, OWNER);
  db.prepare("UPDATE tasks SET state = 'in_progress' WHERE id = ?").run(mine.id);

  const theirs = makeTask(db, { title: 'Theirs', deadlineUtc: Date.now() - DAY });
  tasksRepo.assignArtist(db, GUILD, theirs.id, 'somebody-else', OWNER);
  db.prepare("UPDATE tasks SET state = 'in_progress' WHERE id = ?").run(theirs.id);

  const result = nextActions.forUser(db, GUILD, ARTIST, actorFor(db, ARTIST));
  const overdue = result.actions.find((action) => action.icon === '🔴');

  assert.ok(overdue, 'their own overdue task is reported');
  assert.equal(overdue.count, 1);
  assert.match(overdue.text, new RegExp(mine.code));
  assert.doesNotMatch(overdue.text, new RegExp(theirs.code));
});

test('an artist is never shown the owner\'s decisions', () => {
  const db = setup();
  staffRepo.ensureStaff(db, GUILD, ARTIST, 'Artist');
  staffRepo.setTimezone(db, GUILD, ARTIST, 'UTC', ARTIST);

  const task = makeTask(db);
  tasksRepo.proposePay(db, GUILD, task.id, { amountMinor: 2500, currency: 'USD', actorUserId: LEADER });

  const result = nextActions.forUser(db, GUILD, ARTIST, actorFor(db, ARTIST));
  assert.equal(result.actions.some((action) => /pay figure/.test(action.text)), false);
});

test('a leader sees their own department\'s queue and not another\'s', () => {
  const db = setup();
  staffRepo.ensureStaff(db, GUILD, LEADER, 'Leader');
  staffRepo.setTimezone(db, GUILD, LEADER, 'UTC', LEADER);

  makeTask(db, { title: 'Mine to staff' });
  makeTask(db, { title: 'Not mine', departmentId: configRepo.getDepartmentByKey(db, GUILD, 'vfx').id });

  const actor = actorFor(db, LEADER, { leadDepartmentIds: [modelling(db).id] });
  const result = nextActions.forUser(db, GUILD, LEADER, actor);
  const unassigned = result.actions.find((action) => action.icon === '👥');

  assert.ok(unassigned);
  assert.equal(unassigned.count, 1, 'only the department they run');
});

test('an unanswered client reply is treated as blocking, because their messages are paused', () => {
  const db = setup();
  const client = clientsRepo.createClient(db, GUILD, { displayName: 'Acme' }, OWNER);
  messagingRepo.recordReply(db, GUILD, {
    clientId: client.id, userId: 'client-user', channelId: 'c1', messageId: 'm1', excerpt: 'Hello?',
  });

  const result = nextActions.forUser(db, GUILD, OWNER, actorFor(db, OWNER));
  const reply = result.actions.find((action) => /written in/.test(action.text));

  assert.ok(reply);
  assert.equal(reply.urgency, nextActions.URGENCY.BLOCKING);
});

test('the list is ordered by how pressing things are', () => {
  const db = setup();
  staffRepo.ensureStaff(db, GUILD, ARTIST, 'Artist');

  // Something merely upcoming, and something already overdue.
  const soon = makeTask(db, { title: 'Soon', deadlineUtc: Date.now() + DAY });
  tasksRepo.assignArtist(db, GUILD, soon.id, ARTIST, OWNER);
  db.prepare("UPDATE tasks SET state = 'in_progress' WHERE id = ?").run(soon.id);

  const late = makeTask(db, { title: 'Late', deadlineUtc: Date.now() - DAY });
  tasksRepo.assignArtist(db, GUILD, late.id, ARTIST, OWNER);
  db.prepare("UPDATE tasks SET state = 'in_progress' WHERE id = ?").run(late.id);

  const result = nextActions.forUser(db, GUILD, ARTIST, actorFor(db, ARTIST));
  const urgencies = result.actions.map((action) => action.urgency);

  assert.deepEqual(urgencies, [...urgencies].sort((a, b) => a - b));
  assert.equal(result.actions[0].urgency, nextActions.URGENCY.OVERDUE);
});

test('a missing timezone is mentioned, because it makes every deadline suspect', () => {
  const db = setup();
  staffRepo.ensureStaff(db, GUILD, ARTIST, 'Artist');

  const result = nextActions.forUser(db, GUILD, ARTIST, actorFor(db, ARTIST));
  assert.ok(result.actions.some((action) => /timezone/.test(action.text)));

  staffRepo.setTimezone(db, GUILD, ARTIST, 'Europe/London', ARTIST);
  const after = nextActions.forUser(db, GUILD, ARTIST, actorFor(db, ARTIST));
  assert.equal(after.actions.some((action) => /timezone/.test(action.text)), false);
});

test('the list is capped but says how many there are in total', () => {
  const db = setup();
  staffRepo.ensureStaff(db, GUILD, ARTIST, 'Artist');

  const result = nextActions.forUser(db, GUILD, ARTIST, actorFor(db, ARTIST), { limit: 1 });
  assert.ok(result.actions.length <= 1);
  assert.ok(result.total >= result.actions.length);
});

test('every action names a command, so nothing has to be remembered', () => {
  const db = setup();
  const task = makeTask(db);
  tasksRepo.proposePay(db, GUILD, task.id, { amountMinor: 2500, currency: 'USD', actorUserId: LEADER });

  const result = nextActions.forUser(db, GUILD, OWNER, actorFor(db, OWNER));
  assert.ok(result.actions.length > 0);
  assert.ok(result.actions.every((action) => typeof action.command === 'string' && action.command.length > 0));
});
