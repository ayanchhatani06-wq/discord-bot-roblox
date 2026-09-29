const test = require('node:test');
const assert = require('node:assert/strict');

const { openDatabase } = require('../src/db');
const configRepo = require('../src/db/repos/config');
const staffRepo = require('../src/db/repos/staff');
const projectsRepo = require('../src/db/repos/projects');
const tasksRepo = require('../src/db/repos/tasks');
const offersRepo = require('../src/db/repos/offers');
const { listAudit } = require('../src/db/repos/core');
const { TASK_STATES } = require('../src/domain/taskState');
const { parseBulkSpec, taskTitlesFor } = require('../src/domain/bulkSpec');
const { parseAmount } = require('../src/domain/money');

const GUILD = 'guild-1';
const OWNER = 'owner-1';
const LEADER = 'leader-1';
const ARTIST = 'artist-1';

function setup() {
  const db = openDatabase({ file: ':memory:' });
  configRepo.ensureConfig(db, GUILD);
  configRepo.seedDefaultDepartments(db, GUILD, OWNER);
  configRepo.updateConfig(db, GUILD, { owner_user_id: OWNER }, OWNER);
  return db;
}

function department(db, key = 'modelling') {
  return configRepo.getDepartmentByKey(db, GUILD, key);
}

function makeProject(db, overrides = {}) {
  return projectsRepo.createProject(db, GUILD, {
    name: 'Client order',
    clientAmountMinor: 40000,
    clientCurrency: 'USD',
    managerUserId: OWNER,
    ...overrides,
  }, OWNER);
}

function makeTask(db, project, overrides = {}) {
  return tasksRepo.createTask(db, GUILD, {
    projectId: project.id,
    title: 'Model 1/1',
    departmentId: department(db).id,
    leaderUserId: LEADER,
    deliverables: ['Source file', 'Exported model'],
    ...overrides,
  }, OWNER);
}

function approvedTask(db, project, overrides = {}) {
  const task = makeTask(db, project, overrides);
  tasksRepo.approvePay(db, GUILD, task.id, { amountMinor: 2500, currency: 'USD', actorUserId: OWNER });
  return tasksRepo.getTask(db, GUILD, task.id);
}

function offerTask(db, task, artist = ARTIST) {
  return db.transaction(() => {
    tasksRepo.applyTransition(db, GUILD, task.id, 'offer', {
      actorUserId: LEADER,
      patch: { artist_user_id: artist },
    });
    return offersRepo.createOffer(db, GUILD, {
      taskId: task.id,
      artistUserId: artist,
      offeredBy: LEADER,
      terms: tasksRepo.termsSnapshot({ ...tasksRepo.getTask(db, GUILD, task.id), artist_user_id: artist }),
    });
  })();
}

test('a bulk order becomes one task per deliverable, routed by department', () => {
  const db = setup();
  const departments = configRepo.listDepartments(db, GUILD);
  const parsed = parseBulkSpec('12 models, 4 vfx, 2 animations', departments);

  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.total, 18);
  assert.deepEqual(parsed.items.map((item) => [item.department.key, item.count]), [
    ['modelling', 12], ['vfx', 4], ['animation', 2],
  ]);

  const project = makeProject(db);
  const created = [];
  for (const item of parsed.items) {
    for (const title of taskTitlesFor(item)) {
      created.push(tasksRepo.createTask(db, GUILD, {
        projectId: project.id,
        title,
        departmentId: item.department.id,
        deliverables: configRepo.departmentChecklist(item.department),
      }, OWNER));
    }
  }

  assert.equal(created.length, 18);
  assert.equal(tasksRepo.listTasksForProject(db, project.id).length, 18);
  assert.equal(created[0].title, 'Model 1/12');
  assert.equal(created[11].title, 'Model 12/12');
  // Each department's own checklist came along.
  assert.deepEqual(tasksRepo.deliverables(created[0]), ['Source file', 'Exported model', 'Textures', 'Previews']);
  assert.deepEqual(tasksRepo.deliverables(created[16]), ['Source file', 'Animation export', 'Preview video']);
  // Every task starts unassigned and unpaid.
  assert.ok(created.every((task) => task.state === TASK_STATES.UNASSIGNED && task.pay_state === 'unset'));
  db.close();
});

test('bulk parsing reports what it could not understand instead of guessing', () => {
  const db = setup();
  const departments = configRepo.listDepartments(db, GUILD);

  const parsed = parseBulkSpec('12 models, 3 interpretive dance, banana', departments);
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.errors.length, 2);
  assert.match(parsed.errors.join(' '), /interpretive dance/);

  assert.equal(parseBulkSpec('9999 models', departments).errors.length, 1, 'absurd counts are rejected');
  assert.equal(parseBulkSpec('', departments).items.length, 0);
  db.close();
});

test('a task cannot be offered until the owner has approved the pay', () => {
  const db = setup();
  const task = makeTask(db, makeProject(db));

  assert.equal(tasksRepo.isPayApproved(task), false);

  // A leader's figure is a proposal only.
  const proposed = tasksRepo.proposePay(db, GUILD, task.id, {
    amountMinor: parseAmount('20', 'USD'), currency: 'USD', actorUserId: LEADER,
  });
  assert.equal(proposed.pay_state, 'proposed');
  assert.equal(proposed.artist_pay_minor, null, 'a proposal must not become the agreed pay');
  assert.equal(tasksRepo.isPayApproved(proposed), false);

  // The owner can approve a different number.
  const { task: approved } = tasksRepo.approvePay(db, GUILD, task.id, {
    amountMinor: parseAmount('25', 'USD'), currency: 'USD', actorUserId: OWNER,
  });
  assert.equal(approved.pay_state, 'approved');
  assert.equal(approved.artist_pay_minor, 2500);
  assert.equal(approved.pay_approved_by, OWNER);
  assert.equal(tasksRepo.isPayApproved(approved), true);
  db.close();
});

test('the full happy path records who did what', () => {
  const db = setup();
  const project = makeProject(db);
  const task = approvedTask(db, project);

  const offer = offerTask(db, task);
  assert.equal(tasksRepo.getTask(db, GUILD, task.id).state, TASK_STATES.OFFERED);
  assert.equal(offer.state, 'pending');

  offersRepo.resolveOffer(db, GUILD, offer.id, 'accepted', { actorUserId: ARTIST });
  const accepted = tasksRepo.applyTransition(db, GUILD, task.id, 'offer_accept', {
    actorUserId: ARTIST,
    patch: { accepted_at: Date.now(), accepted_terms_json: offer.terms_json },
  });
  assert.equal(accepted.state, TASK_STATES.IN_PROGRESS);

  // The terms the artist agreed to are frozen on the task.
  const agreed = JSON.parse(accepted.accepted_terms_json);
  assert.equal(agreed.artist_pay_minor, 2500);
  assert.equal(agreed.artist_pay_currency, 'USD');
  assert.deepEqual(agreed.deliverables, ['Source file', 'Exported model']);

  const trail = listAudit(db, { guildId: GUILD, entityType: 'task', entityId: task.id });
  const actions = trail.map((row) => row.action);
  assert.ok(actions.includes('task.pay.approve'));
  assert.ok(actions.includes('offer.create'));
  assert.ok(actions.includes('offer.accepted'));
  assert.ok(actions.includes('task.offer_accept'));
  db.close();
});

test('two artists cannot hold a pending offer for the same task', () => {
  const db = setup();
  const task = approvedTask(db, makeProject(db));
  offerTask(db, task);

  // The second offer fails on the state machine, before the database index.
  assert.throws(() => offerTask(db, tasksRepo.getTask(db, GUILD, task.id), 'artist-2'), /Cannot offer a task that is Offered/);

  // And the index itself refuses a second pending row even if state were bypassed.
  assert.throws(
    () => offersRepo.createOffer(db, GUILD, {
      taskId: task.id, artistUserId: 'artist-2', offeredBy: LEADER, terms: {},
    }),
    /UNIQUE constraint failed/
  );
  db.close();
});

test('a repeated Accept click cannot start the task twice', () => {
  const db = setup();
  const task = approvedTask(db, makeProject(db));
  const offer = offerTask(db, task);

  const first = offersRepo.resolveOffer(db, GUILD, offer.id, 'accepted', { actorUserId: ARTIST });
  assert.ok(first);
  // resolveOffer only touches pending rows, so the replayed click gets nothing.
  assert.equal(offersRepo.resolveOffer(db, GUILD, offer.id, 'accepted', { actorUserId: ARTIST }), null);

  tasksRepo.applyTransition(db, GUILD, task.id, 'offer_accept', {
    actorUserId: ARTIST,
    guardKey: `offer-accept:${offer.id}`,
  });

  // Both guards independently reject the replay.
  assert.throws(
    () => tasksRepo.applyTransition(db, GUILD, task.id, 'offer_accept', {
      actorUserId: ARTIST, guardKey: `offer-accept:${offer.id}`,
    }),
    /already been recorded|already/i
  );
  assert.equal(tasksRepo.getTask(db, GUILD, task.id).state, TASK_STATES.IN_PROGRESS);
  db.close();
});

test('declining returns the task to the queue and clears the artist', () => {
  const db = setup();
  const task = approvedTask(db, makeProject(db));
  const offer = offerTask(db, task);

  offersRepo.resolveOffer(db, GUILD, offer.id, 'declined', { actorUserId: ARTIST, declineReason: 'Deadline too tight' });
  const declined = tasksRepo.applyTransition(db, GUILD, task.id, 'offer_decline', {
    actorUserId: ARTIST,
    patch: { artist_user_id: null },
  });

  assert.equal(declined.state, TASK_STATES.UNASSIGNED);
  assert.equal(declined.artist_user_id, null);
  assert.equal(offersRepo.getPendingOffer(db, task.id), null);
  assert.equal(offersRepo.getOffer(db, offer.id).decline_reason, 'Deadline too tight');

  // It shows up in the leader's queue again and can be re-offered.
  const queue = tasksRepo.listQueue(db, GUILD, department(db).id);
  assert.deepEqual(queue.map((row) => row.id), [task.id]);
  assert.doesNotThrow(() => offerTask(db, declined, 'artist-2'));
  db.close();
});

test('offer history is preserved across declines and re-offers', () => {
  const db = setup();
  const task = approvedTask(db, makeProject(db));

  const first = offerTask(db, task, 'artist-1');
  offersRepo.resolveOffer(db, GUILD, first.id, 'declined', { actorUserId: 'artist-1', declineReason: 'Busy' });
  tasksRepo.applyTransition(db, GUILD, task.id, 'offer_decline', { actorUserId: 'artist-1', patch: { artist_user_id: null } });

  const second = offerTask(db, tasksRepo.getTask(db, GUILD, task.id), 'artist-2');
  offersRepo.resolveOffer(db, GUILD, second.id, 'accepted', { actorUserId: 'artist-2' });

  const history = offersRepo.offerHistory(db, task.id);
  assert.equal(history.length, 2);
  assert.deepEqual(history.map((row) => [row.artist_user_id, row.state]), [
    ['artist-1', 'declined'], ['artist-2', 'accepted'],
  ]);
  db.close();
});

test('changing agreed pay after acceptance is recorded for the artist to acknowledge', () => {
  const db = setup();
  const task = approvedTask(db, makeProject(db));
  const offer = offerTask(db, task);
  offersRepo.resolveOffer(db, GUILD, offer.id, 'accepted', { actorUserId: ARTIST });
  tasksRepo.applyTransition(db, GUILD, task.id, 'offer_accept', {
    actorUserId: ARTIST, patch: { accepted_at: Date.now(), accepted_terms_json: offer.terms_json },
  });

  const { requiresAcknowledgement } = tasksRepo.approvePay(db, GUILD, task.id, {
    amountMinor: 3000, currency: 'USD', actorUserId: OWNER,
  });
  assert.equal(requiresAcknowledgement, true);

  const pending = tasksRepo.unacknowledgedTermChanges(db, task.id);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].field, 'artist_pay');
  assert.equal(pending[0].old_value, '2500 USD');
  assert.equal(pending[0].new_value, '3000 USD');

  assert.equal(tasksRepo.acknowledgeTermChanges(db, task.id, ARTIST), 1);
  assert.equal(tasksRepo.unacknowledgedTermChanges(db, task.id).length, 0);
  db.close();
});

test('an unchanged re-approval does not nag the artist', () => {
  const db = setup();
  const task = approvedTask(db, makeProject(db));
  const offer = offerTask(db, task);
  offersRepo.resolveOffer(db, GUILD, offer.id, 'accepted', { actorUserId: ARTIST });
  tasksRepo.applyTransition(db, GUILD, task.id, 'offer_accept', { actorUserId: ARTIST, patch: { accepted_at: Date.now() } });

  const { requiresAcknowledgement } = tasksRepo.approvePay(db, GUILD, task.id, {
    amountMinor: 2500, currency: 'USD', actorUserId: OWNER,
  });
  assert.equal(requiresAcknowledgement, false);
  assert.equal(tasksRepo.unacknowledgedTermChanges(db, task.id).length, 0);
  db.close();
});

test('the queue is ordered by deadline with undated work last', () => {
  const db = setup();
  const project = makeProject(db);
  const later = makeTask(db, project, { title: 'later', deadlineUtc: Date.UTC(2026, 9, 20) });
  const undated = makeTask(db, project, { title: 'undated' });
  const soon = makeTask(db, project, { title: 'soon', deadlineUtc: Date.UTC(2026, 9, 1) });

  const queue = tasksRepo.listQueue(db, GUILD, department(db).id);
  assert.deepEqual(queue.map((row) => row.id), [soon.id, later.id, undated.id]);
  db.close();
});

test('a leader sees candidate warnings for away and overloaded artists', () => {
  const db = setup();
  const { candidateWarnings } = require('../src/services/offerFlow');
  const dept = department(db);
  configRepo.upsertDepartment(db, GUILD, { key: 'modelling', taskCap: 2 }, OWNER);
  const capped = department(db);

  staffRepo.ensureStaff(db, GUILD, ARTIST, 'Artist One');
  staffRepo.updateStaff(db, GUILD, ARTIST, { department_id: dept.id, timezone: 'Asia/Karachi' });

  assert.deepEqual(candidateWarnings(db, GUILD, { staff: staffRepo.getStaff(db, GUILD, ARTIST), department: capped }), []);

  staffRepo.setAvailability(db, GUILD, ARTIST, 'away', { awayUntil: Date.UTC(2026, 9, 20) });
  const awayWarnings = candidateWarnings(db, GUILD, { staff: staffRepo.getStaff(db, GUILD, ARTIST), department: capped });
  assert.equal(awayWarnings.length, 1);
  assert.match(awayWarnings[0], /away/);

  staffRepo.setAvailability(db, GUILD, ARTIST, 'accepting');
  const project = makeProject(db);
  for (let i = 0; i < 2; i += 1) {
    const task = approvedTask(db, project, { title: `t${i}` });
    offerTask(db, task, ARTIST);
    const offer = offersRepo.getPendingOffer(db, task.id);
    offersRepo.resolveOffer(db, GUILD, offer.id, 'accepted', { actorUserId: ARTIST });
    tasksRepo.applyTransition(db, GUILD, task.id, 'offer_accept', { actorUserId: ARTIST, patch: { accepted_at: Date.now() } });
  }

  const loadWarnings = candidateWarnings(db, GUILD, { staff: staffRepo.getStaff(db, GUILD, ARTIST), department: capped });
  assert.equal(loadWarnings.length, 1);
  assert.match(loadWarnings[0], /2.*active tasks.*cap 2/);

  // Someone with no profile at all is flagged too, rather than silently offered work.
  assert.match(candidateWarnings(db, GUILD, { staff: null, department: capped })[0], /no studio profile/);
  db.close();
});

test('projects report their own progress and client receipts', () => {
  const db = setup();
  const project = makeProject(db);
  const a = approvedTask(db, project, { title: 'a' });
  makeTask(db, project, { title: 'b' });

  offerTask(db, a);
  assert.deepEqual(projectsRepo.projectProgress(db, project.id), {
    total: 2,
    counts: { offered: 1, unassigned: 1 },
  });

  assert.equal(projectsRepo.isClientPaidInFull(db, project), false);
  db.prepare(`
    INSERT INTO payments (guild_id, direction, project_id, amount_minor, currency, recorded_by, recorded_at, idempotency_key)
    VALUES (?, 'client_receipt', ?, 40000, 'USD', ?, ?, 'r1')
  `).run(GUILD, project.id, OWNER, Date.now());

  assert.equal(projectsRepo.clientReceipts(db, project.id).get('USD'), 40000);
  assert.equal(projectsRepo.isClientPaidInFull(db, projectsRepo.getProject(db, GUILD, project.id)), true);
  db.close();
});

test('a part payment does not make the project paid in full', () => {
  const db = setup();
  const project = makeProject(db);
  db.prepare(`
    INSERT INTO payments (guild_id, direction, project_id, amount_minor, currency, recorded_by, recorded_at, idempotency_key)
    VALUES (?, 'client_receipt', ?, 20000, 'USD', ?, ?, 'deposit')
  `).run(GUILD, project.id, OWNER, Date.now());

  assert.equal(projectsRepo.isClientPaidInFull(db, projectsRepo.getProject(db, GUILD, project.id)), false);
  assert.equal(projectsRepo.clientReceipts(db, project.id).get('USD'), 20000);
  db.close();
});

test('a client paying in a different currency does not count towards the expected amount', () => {
  const db = setup();
  const project = makeProject(db, { clientAmountMinor: 40000, clientCurrency: 'USD' });
  db.prepare(`
    INSERT INTO payments (guild_id, direction, project_id, amount_minor, currency, recorded_by, recorded_at, idempotency_key)
    VALUES (?, 'client_receipt', ?, 50000, 'ROBUX', ?, ?, 'robux')
  `).run(GUILD, project.id, OWNER, Date.now());

  // No conversion rate exists, so Robux cannot satisfy a USD expectation.
  assert.equal(projectsRepo.isClientPaidInFull(db, projectsRepo.getProject(db, GUILD, project.id)), false);
  const receipts = projectsRepo.clientReceipts(db, project.id);
  assert.equal(receipts.get('ROBUX'), 50000);
  assert.equal(receipts.get('USD'), undefined);
  db.close();
});
