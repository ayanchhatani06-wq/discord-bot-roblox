const test = require('node:test');
const assert = require('node:assert/strict');

const { openDatabase } = require('../src/db');
const configRepo = require('../src/db/repos/config');
const projectsRepo = require('../src/db/repos/projects');
const tasksRepo = require('../src/db/repos/tasks');
const clientsRepo = require('../src/db/repos/clients');
const staffRepo = require('../src/db/repos/staff');
const assetsRepo = require('../src/db/repos/assets');
const contributorsRepo = require('../src/db/repos/contributors');
const search = require('../src/services/search');
const capacity = require('../src/services/capacity');
const bulkPay = require('../src/services/bulkPay');
const { resolveActor, CAPABILITIES } = require('../src/domain/permissions');

const GUILD = 'guild-1';
const OWNER = 'owner-1';
const LEADER = 'leader-1';
const OTHER_LEADER = 'leader-2';
const ARTIST = 'artist-1';
const OUTSIDER = 'nobody-1';

function setup() {
  const db = openDatabase({ file: ':memory:' });
  configRepo.ensureConfig(db, GUILD);
  configRepo.seedDefaultDepartments(db, GUILD, OWNER);
  configRepo.updateConfig(db, GUILD, { owner_user_id: OWNER }, OWNER);
  return db;
}

function actorFor(db, userId, { leads = [] } = {}) {
  const config = configRepo.ensureConfig(db, GUILD);

  // Leading a department comes from holding its leader role in Discord, so a
  // test actor gets a role per department they lead.
  const roleIds = leads.map((key) => `role-${key}`);
  const departments = configRepo.listDepartments(db, GUILD).map((dept) => (
    leads.includes(dept.key) ? { ...dept, leader_role_id: `role-${dept.key}` } : dept
  ));

  return resolveActor({
    userId,
    roleIds,
    config,
    departments,
    roleCapabilities: [],
    guildOwnerId: null,
  });
}

function departmentId(db, key) {
  return configRepo.getDepartmentByKey(db, GUILD, key).id;
}

function makeTask(db, project, { title, key = 'modelling', artist = null, leader = LEADER } = {}) {
  const task = tasksRepo.createTask(db, GUILD, {
    projectId: project.id,
    title,
    departmentId: departmentId(db, key),
    leaderUserId: leader,
  }, OWNER);
  if (artist) {
    tasksRepo.approvePay(db, GUILD, task.id, { amountMinor: 1000, currency: 'USD', actorUserId: OWNER });
    tasksRepo.assignArtist(db, GUILD, task.id, artist, OWNER);
    // Assigning alone is not load — work counts once it is out with them.
    db.prepare("UPDATE tasks SET state = 'in_progress' WHERE id = ?").run(task.id);
  }
  return tasksRepo.getTask(db, GUILD, task.id);
}

// ---------------------------------------------------------------------------
// One search, scoped to what the caller may see
// ---------------------------------------------------------------------------

test('a one-character query is refused rather than returning half the studio', () => {
  const db = setup();
  assert.equal(search.everything(db, GUILD, 'a', actorFor(db, OWNER)).ok, false);
  assert.equal(search.everything(db, GUILD, '', actorFor(db, OWNER)).reason, 'too_short');
  assert.equal(search.everything(db, GUILD, 'ab', actorFor(db, OWNER)).ok, true);
  db.close();
});

test('the owner finds work, orders, clients and people in one search', () => {
  const db = setup();
  const client = clientsRepo.createClient(db, GUILD, { displayName: 'Dragon Games' }, OWNER);
  const project = projectsRepo.createProject(db, GUILD, { name: 'Dragon lobby' }, OWNER);
  clientsRepo.linkProject(db, GUILD, project.id, client.id, OWNER);
  makeTask(db, project, { title: 'Dragon statue' });
  staffRepo.ensureStaff(db, GUILD, ARTIST, 'Dragon Artist');

  const found = search.everything(db, GUILD, 'dragon', actorFor(db, OWNER));
  assert.equal(found.ok, true);
  assert.ok(found.byKind.task >= 1);
  assert.ok(found.byKind.project >= 1);
  assert.ok(found.byKind.client >= 1);
  assert.ok(found.byKind.staff >= 1);
  db.close();
});

test('somebody with no role sees only their own work, and no client records', () => {
  const db = setup();
  const client = clientsRepo.createClient(db, GUILD, { displayName: 'Secret Client' }, OWNER);
  const project = projectsRepo.createProject(db, GUILD, { name: 'Secret order' }, OWNER);
  clientsRepo.linkProject(db, GUILD, project.id, client.id, OWNER);

  makeTask(db, project, { title: 'Secret thing for them', artist: ARTIST });
  makeTask(db, project, { title: 'Secret thing for somebody else' });

  const found = search.everything(db, GUILD, 'secret', actorFor(db, ARTIST));
  assert.equal(found.byKind.client, 0, 'client records carry contact details and finder arrangements');
  assert.equal(found.byKind.project, 0);
  assert.equal(found.byKind.task, 1, 'their own task only');
  assert.ok(found.results.some((row) => row.title.includes('for them')));
  assert.equal(
    found.results.some((row) => row.title.includes('somebody else')), false,
    'a result they would then be refused has already leaked that it exists'
  );
  db.close();
});

test('a leader sees their own department, not another leader\'s', () => {
  const db = setup();
  const project = projectsRepo.createProject(db, GUILD, { name: 'Order' }, OWNER);
  makeTask(db, project, { title: 'Widget model', key: 'modelling' });
  makeTask(db, project, { title: 'Widget script', key: 'scripting', leader: OTHER_LEADER });

  const found = search.everything(db, GUILD, 'widget', actorFor(db, LEADER, { leads: ['modelling'] }));
  const titles = found.results.filter((row) => row.kind === 'task').map((row) => row.title);

  assert.ok(titles.some((title) => title.includes('model')));
  assert.equal(titles.some((title) => title.includes('script')), false);
  db.close();
});

test('proof on file is not searchable by somebody with no finance or client role', () => {
  const db = setup();
  db.prepare(`
    INSERT INTO evidence (guild_id, kind, filename, stored_path, sha256, bytes, added_by, added_at)
    VALUES (?, 'payment', 'receipt-widget.png', 'ab/hash.png', 'hash', 10, ?, ?)
  `).run(GUILD, OWNER, Date.now());

  assert.equal(search.searchEvidence(db, GUILD, 'widget', actorFor(db, OUTSIDER)).length, 0);
  assert.equal(search.searchEvidence(db, GUILD, 'widget', actorFor(db, OWNER)).length, 1);
  db.close();
});

test('a Roblox asset ID is findable, which is the point of recording it', () => {
  const db = setup();
  const project = projectsRepo.createProject(db, GUILD, { name: 'Order' }, OWNER);
  const task = makeTask(db, project, { title: 'Sword model' });

  const asset = assetsRepo.addAsset(db, GUILD, {
    projectId: project.id,
    taskId: task.id,
    submissionId: null,
    label: 'Sword',
    url: 'https://example.invalid/sword.fbx',
    kind: 'deliverable',
    createdBy: OWNER,
  });

  const set = assetsRepo.setRobloxAssetId(db, GUILD, asset.id, {
    robloxAssetId: 'https://create.roblox.com/store/asset/1234567890/Sword',
    actorUserId: OWNER,
  });
  assert.equal(set.ok, true);
  assert.equal(set.asset.roblox_asset_id, '1234567890', 'the digits are kept, not the whole URL');

  const found = search.searchAssets(db, GUILD, '1234567890', actorFor(db, OWNER));
  assert.equal(found.length, 1);
  assert.ok(found[0].subtitle.includes('1234567890'));
  db.close();
});

test('something with no Roblox ID in it is refused rather than stored as one', () => {
  const db = setup();
  const project = projectsRepo.createProject(db, GUILD, { name: 'Order' }, OWNER);
  const task = makeTask(db, project, { title: 'Sword model' });
  const asset = assetsRepo.addAsset(db, GUILD, {
    projectId: project.id, taskId: task.id, submissionId: null,
    url: 'https://example.invalid/sword.fbx', kind: 'deliverable', createdBy: OWNER,
  });

  const refused = assetsRepo.setRobloxAssetId(db, GUILD, asset.id, {
    robloxAssetId: 'the sword one', actorUserId: OWNER,
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'not_an_id');
  assert.equal(assetsRepo.getAsset(db, GUILD, asset.id).roblox_asset_id, null);
  db.close();
});

// ---------------------------------------------------------------------------
// Approving several pay figures at once
// ---------------------------------------------------------------------------

test('bulk approval says yes only to what a leader actually proposed', () => {
  const db = setup();
  const project = projectsRepo.createProject(db, GUILD, {
    name: 'Order', clientAmountMinor: 10000, clientCurrency: 'USD',
  }, OWNER);

  const proposed = makeTask(db, project, { title: 'Proposed one' });
  tasksRepo.proposePay(db, GUILD, proposed.id, { amountMinor: 2000, currency: 'USD', actorUserId: LEADER });
  const untouched = makeTask(db, project, { title: 'Nobody proposed anything' });

  const result = bulkPay.approveAll(db, GUILD, { actorUserId: OWNER });
  assert.equal(result.considered, 1);
  assert.equal(result.approved.length, 1);
  assert.equal(tasksRepo.getTask(db, GUILD, proposed.id).artist_pay_minor, 2000);
  assert.equal(
    tasksRepo.getTask(db, GUILD, untouched.id).artist_pay_minor, null,
    'the owner is still the one deciding — this only speeds up saying yes'
  );
  db.close();
});

test('bulk approval refuses the one that goes over budget and keeps the rest', () => {
  const db = setup();
  const project = projectsRepo.createProject(db, GUILD, {
    name: 'Order', clientAmountMinor: 5000, clientCurrency: 'USD',
  }, OWNER);

  const first = makeTask(db, project, { title: 'First' });
  const second = makeTask(db, project, { title: 'Second' });
  const third = makeTask(db, project, { title: 'Third' });

  tasksRepo.proposePay(db, GUILD, first.id, { amountMinor: 3000, currency: 'USD', actorUserId: LEADER });
  tasksRepo.proposePay(db, GUILD, second.id, { amountMinor: 1500, currency: 'USD', actorUserId: LEADER });
  tasksRepo.proposePay(db, GUILD, third.id, { amountMinor: 3000, currency: 'USD', actorUserId: LEADER });

  const result = bulkPay.approveAll(db, GUILD, { actorUserId: OWNER });

  assert.equal(result.approved.length, 2, '$30 + $15 fits inside $50');
  assert.equal(result.refused.length, 1);
  assert.equal(result.refused[0].task.id, third.id, 'the third would take it to $75');
  assert.equal(result.refused[0].reason, 'over_budget');

  // The refusal is cumulative: the first two were counted against the budget.
  assert.equal(result.refused[0].check.committed, 4500);
  assert.equal(tasksRepo.getTask(db, GUILD, third.id).artist_pay_minor, null);
  assert.equal(tasksRepo.getTask(db, GUILD, second.id).artist_pay_minor, 1500);
  db.close();
});

test('a preview changes nothing', () => {
  const db = setup();
  const project = projectsRepo.createProject(db, GUILD, {
    name: 'Order', clientAmountMinor: 10000, clientCurrency: 'USD',
  }, OWNER);
  const task = makeTask(db, project, { title: 'Proposed' });
  tasksRepo.proposePay(db, GUILD, task.id, { amountMinor: 2000, currency: 'USD', actorUserId: LEADER });

  const preview = bulkPay.approveAll(db, GUILD, { actorUserId: OWNER, dryRun: true });
  assert.equal(preview.approved.length, 1);
  assert.equal(tasksRepo.getTask(db, GUILD, task.id).artist_pay_minor, null);
  assert.equal(tasksRepo.getTask(db, GUILD, task.id).pay_state, 'proposed');
  db.close();
});

test('bulk approval can be limited to one order', () => {
  const db = setup();
  const wanted = projectsRepo.createProject(db, GUILD, {
    name: 'Wanted', clientAmountMinor: 10000, clientCurrency: 'USD',
  }, OWNER);
  const other = projectsRepo.createProject(db, GUILD, {
    name: 'Other', clientAmountMinor: 10000, clientCurrency: 'USD',
  }, OWNER);

  const inScope = makeTask(db, wanted, { title: 'In scope' });
  const outOfScope = makeTask(db, other, { title: 'Out of scope' });
  tasksRepo.proposePay(db, GUILD, inScope.id, { amountMinor: 1000, currency: 'USD', actorUserId: LEADER });
  tasksRepo.proposePay(db, GUILD, outOfScope.id, { amountMinor: 1000, currency: 'USD', actorUserId: LEADER });

  const result = bulkPay.approveAll(db, GUILD, { actorUserId: OWNER, projectId: wanted.id });
  assert.equal(result.considered, 1);
  assert.equal(tasksRepo.getTask(db, GUILD, outOfScope.id).pay_state, 'proposed');
  db.close();
});

test('a cancelled task is not waiting on a pay decision', () => {
  const db = setup();
  const project = projectsRepo.createProject(db, GUILD, {
    name: 'Order', clientAmountMinor: 10000, clientCurrency: 'USD',
  }, OWNER);
  const task = makeTask(db, project, { title: 'Dropped' });
  tasksRepo.proposePay(db, GUILD, task.id, { amountMinor: 1000, currency: 'USD', actorUserId: LEADER });
  db.prepare("UPDATE tasks SET state = 'cancelled' WHERE id = ?").run(task.id);

  assert.equal(bulkPay.pending(db, GUILD).length, 0);
  db.close();
});

test('a contributor\'s proposed share is in the queue too', () => {
  const db = setup();
  const project = projectsRepo.createProject(db, GUILD, {
    name: 'Order', clientAmountMinor: 10000, clientCurrency: 'USD',
  }, OWNER);
  const task = makeTask(db, project, { title: 'Shared', artist: ARTIST });

  contributorsRepo.addContributor(db, GUILD, task, {
    userId: 'artist-2', responsibility: 'texturing', actorUserId: OWNER,
  });
  contributorsRepo.proposePay(db, GUILD, task.id, 'artist-2', {
    amountMinor: 800, currency: 'USD', actorUserId: LEADER,
  });

  const queue = bulkPay.pending(db, GUILD);
  assert.equal(queue.length, 1);
  assert.equal(queue[0].scope, 'contributor');

  bulkPay.approveAll(db, GUILD, { actorUserId: OWNER });
  assert.equal(contributorsRepo.getContributor(db, task.id, 'artist-2').pay_minor, 800);
  db.close();
});

// ---------------------------------------------------------------------------
// Who is free
// ---------------------------------------------------------------------------

test('somebody with nothing on is reported free', () => {
  const db = setup();
  staffRepo.ensureStaff(db, GUILD, ARTIST, 'Free Artist');

  const result = capacity.forecast(db, GUILD, { days: 7 });
  assert.equal(result.people.length, 1);
  assert.equal(result.people[0].outlook, capacity.OUTLOOK.FREE);
  assert.equal(result.counts.free, 1);
  db.close();
});

test('work running past the window means they are not free during it', () => {
  const db = setup();
  staffRepo.ensureStaff(db, GUILD, ARTIST, 'Busy Artist');
  const project = projectsRepo.createProject(db, GUILD, { name: 'Order' }, OWNER);

  const task = makeTask(db, project, { title: 'Long job', artist: ARTIST });
  const farOff = Date.now() + 30 * capacity.DAY;
  db.prepare('UPDATE tasks SET deadline_utc = ? WHERE id = ?').run(farOff, task.id);

  const result = capacity.forecast(db, GUILD, { days: 7 });
  assert.equal(result.people[0].outlook, capacity.OUTLOOK.LOADED);
  assert.equal(result.people[0].load.dueAfter.length, 1);
  db.close();
});

test('work due inside the window and nothing after it means they are finishing up', () => {
  const db = setup();
  staffRepo.ensureStaff(db, GUILD, ARTIST, 'Finishing Artist');
  const project = projectsRepo.createProject(db, GUILD, { name: 'Order' }, OWNER);

  const task = makeTask(db, project, { title: 'Ends soon', artist: ARTIST });
  db.prepare('UPDATE tasks SET deadline_utc = ? WHERE id = ?').run(Date.now() + 3 * capacity.DAY, task.id);

  const result = capacity.forecast(db, GUILD, { days: 7 });
  assert.equal(result.people[0].outlook, capacity.OUTLOOK.FINISHING);
  db.close();
});

test('somebody whose only work is overdue is behind, not free', () => {
  const db = setup();
  staffRepo.ensureStaff(db, GUILD, ARTIST, 'Late Artist');
  const project = projectsRepo.createProject(db, GUILD, { name: 'Order' }, OWNER);

  const task = makeTask(db, project, { title: 'Missed it', artist: ARTIST });
  db.prepare('UPDATE tasks SET deadline_utc = ? WHERE id = ?').run(Date.now() - 5 * capacity.DAY, task.id);

  const result = capacity.forecast(db, GUILD, { days: 7 });
  assert.equal(result.people[0].outlook, capacity.OUTLOOK.FINISHING);
  assert.equal(result.people[0].load.dueBefore.length, 1);
  db.close();
});

test('work with no deadline is counted, not assumed finished', () => {
  const db = setup();
  staffRepo.ensureStaff(db, GUILD, ARTIST, 'Open-ended Artist');
  const project = projectsRepo.createProject(db, GUILD, { name: 'Order' }, OWNER);
  makeTask(db, project, { title: 'No deadline', artist: ARTIST });

  const result = capacity.forecast(db, GUILD, { days: 7 });
  assert.equal(result.people[0].outlook, capacity.OUTLOOK.LOADED,
    'assuming it finishes is exactly the mistake that overbooks people');
  assert.equal(result.unknownDeadlines, 1, 'and the forecast says so rather than hiding it');
  db.close();
});

test('somebody away during the window is reported away, with their return date', () => {
  const db = setup();
  staffRepo.ensureStaff(db, GUILD, ARTIST, 'Away Artist');
  const back = Date.now() + 3 * capacity.DAY;
  staffRepo.setAvailability(db, GUILD, ARTIST, 'away', { awayUntil: back, note: 'Exams' }, ARTIST);

  const result = capacity.forecast(db, GUILD, { days: 7 });
  assert.equal(result.people[0].outlook, capacity.OUTLOOK.AWAY);
  assert.equal(result.people[0].returnsAt, back);
  db.close();
});

test('somebody back before the window starts is not counted away in it', () => {
  const db = setup();
  staffRepo.ensureStaff(db, GUILD, ARTIST, 'Returning Artist');
  const member = staffRepo.getStaff(db, GUILD, ARTIST);
  assert.ok(member);

  const past = Date.now() - capacity.DAY;
  db.prepare("UPDATE staff SET availability = 'away', away_until = ? WHERE guild_id = ? AND user_id = ?")
    .run(past, GUILD, ARTIST);

  const result = capacity.forecast(db, GUILD, { from: Date.now(), days: 7 });
  assert.equal(result.people[0].outlook, capacity.OUTLOOK.FREE, 'their absence ended before the window');
  db.close();
});

test('somebody who says they are at capacity is taken at their word', () => {
  const db = setup();
  staffRepo.ensureStaff(db, GUILD, ARTIST, 'Full Artist');
  staffRepo.setAvailability(db, GUILD, ARTIST, 'at_capacity', {}, ARTIST);

  const result = capacity.forecast(db, GUILD, { days: 7 });
  assert.equal(result.people[0].outlook, capacity.OUTLOOK.FULL);
  db.close();
});

test('the most obviously free person is listed first', () => {
  const db = setup();
  staffRepo.ensureStaff(db, GUILD, 'busy-1', 'Busy');
  staffRepo.ensureStaff(db, GUILD, 'free-1', 'Free');
  staffRepo.setAvailability(db, GUILD, 'busy-1', 'at_capacity', {}, 'busy-1');

  const result = capacity.forecast(db, GUILD, { days: 7 });
  assert.equal(result.people[0].member.user_id, 'free-1');
  db.close();
});

test('somebody who has left the studio is not in the forecast', () => {
  const db = setup();
  staffRepo.ensureStaff(db, GUILD, ARTIST, 'Gone Artist');
  staffRepo.markRemoved(db, GUILD, ARTIST, OWNER);

  assert.equal(capacity.forecast(db, GUILD, { days: 7 }).people.length, 0);
  db.close();
});

test('a share of somebody else\'s task still counts as their work', () => {
  const db = setup();
  staffRepo.ensureStaff(db, GUILD, 'artist-2', 'Helper');
  const project = projectsRepo.createProject(db, GUILD, { name: 'Order' }, OWNER);
  const task = makeTask(db, project, { title: 'Shared', artist: ARTIST });

  contributorsRepo.addContributor(db, GUILD, task, {
    userId: 'artist-2', responsibility: 'texturing', actorUserId: OWNER,
  });

  const result = capacity.forecast(db, GUILD, { days: 7 });
  const helper = result.people.find((person) => person.member.user_id === 'artist-2');
  assert.equal(helper.load.tasks.length, 1, 'contributing to a task is doing work');
  db.close();
});

test('a department task cap is the limit the forecast uses', () => {
  const db = setup();
  staffRepo.ensureStaff(db, GUILD, ARTIST, 'Capped Artist');
  configRepo.upsertDepartment(db, GUILD, {
    key: 'modelling', name: 'Modelling', taskCap: 2,
  }, OWNER);
  db.prepare('UPDATE staff SET department_id = ? WHERE guild_id = ? AND user_id = ?')
    .run(departmentId(db, 'modelling'), GUILD, ARTIST);

  const project = projectsRepo.createProject(db, GUILD, { name: 'Order' }, OWNER);
  makeTask(db, project, { title: 'One', artist: ARTIST });

  let result = capacity.forecast(db, GUILD, { days: 7 });
  assert.equal(result.people[0].cap, 2);
  assert.notEqual(result.people[0].outlook, capacity.OUTLOOK.FULL, 'one of two is not full');

  makeTask(db, project, { title: 'Two', artist: ARTIST });
  result = capacity.forecast(db, GUILD, { days: 7 });
  assert.equal(
    result.people[0].outlook, capacity.OUTLOOK.FULL,
    'at the cap the studio already warns when assigning, so the forecast must agree'
  );
  assert.equal(result.withoutCap.includes('Modelling'), false);
  db.close();
});

test('a department with no cap is named rather than claiming no limits exist', () => {
  const db = setup();
  staffRepo.ensureStaff(db, GUILD, ARTIST, 'Uncapped Artist');
  db.prepare('UPDATE staff SET department_id = ? WHERE guild_id = ? AND user_id = ?')
    .run(departmentId(db, 'modelling'), GUILD, ARTIST);

  const result = capacity.forecast(db, GUILD, { days: 7 });
  assert.equal(result.people[0].cap, null);
  assert.ok(result.withoutCap.includes('Modelling'), 'says which departments have no cap set');
  db.close();
});
