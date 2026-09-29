const test = require('node:test');
const assert = require('node:assert/strict');

const { openDatabase } = require('../src/db');
const configRepo = require('../src/db/repos/config');
const staffRepo = require('../src/db/repos/staff');
const projectsRepo = require('../src/db/repos/projects');
const tasksRepo = require('../src/db/repos/tasks');
const paymentsRepo = require('../src/db/repos/payments');
const onboardingRepo = require('../src/db/repos/onboarding');
const offboarding = require('../src/services/offboarding');
const { resolveActor, can, CAPABILITIES } = require('../src/domain/permissions');

const GUILD = 'guild-1';
const OWNER = 'owner-1';
const LEADER = 'leader-1';
const ARTIST = 'artist-1';
const STAND_IN = 'standin-1';
const CANDIDATE = 'candidate-1';

const { TRIAL_STATES } = onboardingRepo;

function setup() {
  const db = openDatabase({ file: ':memory:' });
  configRepo.ensureConfig(db, GUILD);
  configRepo.seedDefaultDepartments(db, GUILD, OWNER);
  configRepo.updateConfig(db, GUILD, { owner_user_id: OWNER }, OWNER);
  return db;
}

function modelling(db) {
  return configRepo.getDepartmentByKey(db, GUILD, 'modelling');
}

// ---------------------------------------------------------------------------
// Procedures
// ---------------------------------------------------------------------------

test('acknowledging a procedure records the version that was read', () => {
  const db = setup();
  const { procedure } = onboardingRepo.upsertProcedure(db, GUILD, {
    key: 'file-naming', title: 'File naming', body: 'Use lowercase.',
  }, OWNER);

  onboardingRepo.acknowledge(db, GUILD, procedure.id, ARTIST);
  assert.equal(onboardingRepo.hasAcknowledged(db, procedure, ARTIST), true);

  const [ack] = onboardingRepo.acknowledgementsFor(db, GUILD, procedure.id);
  assert.equal(ack.version, 1);
});

test('editing the text makes every earlier acknowledgement stale', () => {
  const db = setup();
  const { procedure } = onboardingRepo.upsertProcedure(db, GUILD, {
    key: 'file-naming', title: 'File naming', body: 'Use lowercase.',
  }, OWNER);
  onboardingRepo.acknowledge(db, GUILD, procedure.id, ARTIST);

  const edited = onboardingRepo.upsertProcedure(db, GUILD, {
    key: 'file-naming', title: 'File naming', body: 'Use lowercase, and no spaces.',
  }, OWNER);

  assert.equal(edited.versionChanged, true);
  assert.equal(edited.procedure.version, 2);
  assert.equal(onboardingRepo.hasAcknowledged(db, edited.procedure, ARTIST), false,
    'agreeing to version 1 is not agreeing to version 2');

  // The old acknowledgement is kept — it is still true that they read v1.
  assert.equal(onboardingRepo.acknowledgementsFor(db, GUILD, procedure.id).length, 1);
});

test('changing only the audience does not ask everybody again', () => {
  const db = setup();
  const { procedure } = onboardingRepo.upsertProcedure(db, GUILD, {
    key: 'file-naming', title: 'File naming', body: 'Use lowercase.',
  }, OWNER);
  onboardingRepo.acknowledge(db, GUILD, procedure.id, ARTIST);

  const edited = onboardingRepo.upsertProcedure(db, GUILD, {
    key: 'file-naming', title: 'File naming', body: 'Use lowercase.', audience: 'leaders',
  }, OWNER);

  assert.equal(edited.versionChanged, false);
  assert.equal(onboardingRepo.hasAcknowledged(db, edited.procedure, ARTIST), true);
});

test('acknowledging twice is harmless', () => {
  const db = setup();
  const { procedure } = onboardingRepo.upsertProcedure(db, GUILD, {
    key: 'p', title: 'P', body: 'Body',
  }, OWNER);

  onboardingRepo.acknowledge(db, GUILD, procedure.id, ARTIST);
  const second = onboardingRepo.acknowledge(db, GUILD, procedure.id, ARTIST);

  assert.equal(second.alreadyAcknowledged, true);
  assert.equal(onboardingRepo.acknowledgementsFor(db, GUILD, procedure.id).length, 1);
});

test('a procedure only applies to the people it is addressed to', () => {
  const db = setup();
  const department = modelling(db);

  onboardingRepo.upsertProcedure(db, GUILD, { key: 'all', title: 'All', body: 'x' }, OWNER);
  onboardingRepo.upsertProcedure(db, GUILD, { key: 'leaders', title: 'Leaders', body: 'x', audience: 'leaders' }, OWNER);
  onboardingRepo.upsertProcedure(db, GUILD, {
    key: 'dept', title: 'Modelling', body: 'x', audience: 'department', departmentId: department.id,
  }, OWNER);

  const artist = onboardingRepo.proceduresFor(db, GUILD, { departmentId: department.id, isLeader: false });
  assert.deepEqual(artist.map((p) => p.key).sort(), ['all', 'dept']);

  const outsider = onboardingRepo.proceduresFor(db, GUILD, { departmentId: null, isLeader: false });
  assert.deepEqual(outsider.map((p) => p.key), ['all']);

  const leader = onboardingRepo.proceduresFor(db, GUILD, { departmentId: department.id, isLeader: true });
  assert.deepEqual(leader.map((p) => p.key).sort(), ['all', 'dept', 'leaders']);
});

test('a retired procedure stops being asked for but keeps its record', () => {
  const db = setup();
  const { procedure } = onboardingRepo.upsertProcedure(db, GUILD, { key: 'p', title: 'P', body: 'x' }, OWNER);
  onboardingRepo.acknowledge(db, GUILD, procedure.id, ARTIST);

  onboardingRepo.setProcedureActive(db, GUILD, 'p', false, OWNER);

  assert.equal(onboardingRepo.proceduresFor(db, GUILD, {}).length, 0);
  assert.equal(onboardingRepo.acknowledgementsFor(db, GUILD, procedure.id).length, 1);
});

// ---------------------------------------------------------------------------
// Trials
// ---------------------------------------------------------------------------

function makeTrial(db, overrides = {}) {
  return onboardingRepo.createTrial(db, GUILD, {
    userId: CANDIDATE,
    departmentId: modelling(db).id,
    title: 'A crate',
    brief: 'Model a wooden crate.',
    terms: 'Paid $10 whatever the outcome. One round of feedback.',
    payMinor: 1000,
    payCurrency: 'USD',
    ...overrides,
  }, OWNER);
}

test('a trial cannot be submitted before it is accepted', () => {
  const db = setup();
  const trial = makeTrial(db);

  const early = onboardingRepo.setTrialStatus(db, GUILD, trial.id, TRIAL_STATES.SUBMITTED, {
    from: TRIAL_STATES.ACCEPTED, actorUserId: CANDIDATE,
  });
  assert.equal(early, null, 'an offered trial is not an accepted one');

  onboardingRepo.setTrialStatus(db, GUILD, trial.id, TRIAL_STATES.ACCEPTED, {
    from: TRIAL_STATES.OFFERED, actorUserId: CANDIDATE,
  });
  const submitted = onboardingRepo.setTrialStatus(db, GUILD, trial.id, TRIAL_STATES.SUBMITTED, {
    from: TRIAL_STATES.ACCEPTED, actorUserId: CANDIDATE,
    columns: { submission_links: 'https://example.invalid/crate' },
  });
  assert.equal(submitted.status, TRIAL_STATES.SUBMITTED);
});

test('a trial cannot be decided before anything is submitted', () => {
  const db = setup();
  const trial = makeTrial(db);
  onboardingRepo.setTrialStatus(db, GUILD, trial.id, TRIAL_STATES.ACCEPTED, {
    from: TRIAL_STATES.OFFERED, actorUserId: CANDIDATE,
  });

  const decided = onboardingRepo.setTrialStatus(db, GUILD, trial.id, TRIAL_STATES.PASSED, {
    from: TRIAL_STATES.SUBMITTED, actorUserId: OWNER,
  });
  assert.equal(decided, null, 'judging work never handed in is refused');
});

test('accepting twice does nothing the second time', () => {
  const db = setup();
  const trial = makeTrial(db);

  const first = onboardingRepo.setTrialStatus(db, GUILD, trial.id, TRIAL_STATES.ACCEPTED, {
    from: TRIAL_STATES.OFFERED, actorUserId: CANDIDATE, columns: { accepted_at: 1 },
  });
  const second = onboardingRepo.setTrialStatus(db, GUILD, trial.id, TRIAL_STATES.ACCEPTED, {
    from: TRIAL_STATES.OFFERED, actorUserId: CANDIDATE, columns: { accepted_at: 2 },
  });

  assert.equal(first.accepted_at, 1);
  assert.equal(second, null);
  assert.equal(onboardingRepo.getTrial(db, GUILD, trial.id).accepted_at, 1, 'the first acceptance stands');
});

test('a declined trial cannot later be passed', () => {
  const db = setup();
  const trial = makeTrial(db);
  onboardingRepo.setTrialStatus(db, GUILD, trial.id, TRIAL_STATES.DECLINED, {
    from: TRIAL_STATES.OFFERED, actorUserId: CANDIDATE,
  });

  const passed = onboardingRepo.setTrialStatus(db, GUILD, trial.id, TRIAL_STATES.PASSED, {
    from: TRIAL_STATES.SUBMITTED, actorUserId: OWNER,
  });
  assert.equal(passed, null);
});

test('trials get their own sequential codes', () => {
  const db = setup();
  assert.equal(makeTrial(db).code, 'TRL-0001');
  assert.equal(makeTrial(db).code, 'TRL-0002');
});

// ---------------------------------------------------------------------------
// Recommendations
// ---------------------------------------------------------------------------

test('a recommendation is decided once and only once', () => {
  const db = setup();
  const recommendation = onboardingRepo.createRecommendation(db, GUILD, {
    subjectUserId: CANDIDATE, kind: 'promotion', note: 'Good work on three jobs.',
  }, LEADER);

  const accepted = onboardingRepo.decideRecommendation(db, GUILD, recommendation.id, { accept: true, actorUserId: OWNER });
  assert.equal(accepted.status, 'accepted');

  const again = onboardingRepo.decideRecommendation(db, GUILD, recommendation.id, { accept: false, actorUserId: OWNER });
  assert.equal(again, null);
});

// ---------------------------------------------------------------------------
// Stand-in leaders
// ---------------------------------------------------------------------------

function grantStandIn(db, { startsAt, expiresAt }) {
  return onboardingRepo.grantBackupLeader(db, GUILD, {
    departmentId: modelling(db).id,
    userId: STAND_IN,
    responsibilities: 'Assigning and reviewing while the leader is away.',
    startsAt,
    expiresAt,
  }, OWNER);
}

test('a stand-in gets leader powers in that department and nowhere else', () => {
  const db = setup();
  const department = modelling(db);
  const other = configRepo.getDepartmentByKey(db, GUILD, 'vfx');
  grantStandIn(db, { startsAt: Date.now() - 1000, expiresAt: Date.now() + 60_000 });

  const actor = resolveActor({
    userId: STAND_IN,
    departments: configRepo.listDepartments(db, GUILD),
    config: { owner_user_id: OWNER },
    standInDepartmentIds: onboardingRepo.activeBackupDepartmentIds(db, GUILD, STAND_IN),
  });

  assert.equal(can(actor, CAPABILITIES.TASK_OFFER, { departmentId: department.id }), true);
  assert.equal(can(actor, CAPABILITIES.TASK_OFFER, { departmentId: other.id }), false);
  assert.equal(can(actor, CAPABILITIES.TASK_PAY_APPROVE), false, 'standing in is not being the owner');
});

test('stand-in powers lapse on time without anything having to run', () => {
  const db = setup();
  grantStandIn(db, { startsAt: Date.now() - 10_000, expiresAt: Date.now() - 1000 });

  assert.deepEqual(onboardingRepo.activeBackupDepartmentIds(db, GUILD, STAND_IN), [],
    'an expired grant confers nothing, even though nothing cleaned it up');
});

test('stand-in powers do not start early', () => {
  const db = setup();
  grantStandIn(db, { startsAt: Date.now() + 60_000, expiresAt: Date.now() + 120_000 });

  assert.deepEqual(onboardingRepo.activeBackupDepartmentIds(db, GUILD, STAND_IN), []);
});

test('revoking a stand-in ends it immediately', () => {
  const db = setup();
  const grant = grantStandIn(db, { startsAt: Date.now() - 1000, expiresAt: Date.now() + 600_000 });

  assert.equal(onboardingRepo.activeBackupDepartmentIds(db, GUILD, STAND_IN).length, 1);
  onboardingRepo.revokeBackupLeader(db, GUILD, grant.id, OWNER);
  assert.deepEqual(onboardingRepo.activeBackupDepartmentIds(db, GUILD, STAND_IN), []);

  assert.equal(onboardingRepo.revokeBackupLeader(db, GUILD, grant.id, OWNER), null, 'revoking twice does nothing');
});

test('a stand-in grant for a department that no longer exists confers nothing', () => {
  const db = setup();
  const department = modelling(db);
  grantStandIn(db, { startsAt: Date.now() - 1000, expiresAt: Date.now() + 60_000 });

  const actor = resolveActor({
    userId: STAND_IN,
    // The department list no longer carries it, so the claim is dropped.
    departments: configRepo.listDepartments(db, GUILD).filter((dept) => dept.id !== department.id),
    standInDepartmentIds: [department.id],
  });

  assert.deepEqual(actor.leadDepartmentIds, []);
});

// ---------------------------------------------------------------------------
// Offboarding
// ---------------------------------------------------------------------------

test('offboarding reports unfinished work and money still owed, and deletes nothing', () => {
  const db = setup();
  staffRepo.ensureStaff(db, GUILD, ARTIST, 'Artist One');

  const project = projectsRepo.createProject(db, GUILD, {
    name: 'Order', clientAmountMinor: 10000, clientCurrency: 'USD',
  }, OWNER);

  const live = tasksRepo.createTask(db, GUILD, {
    projectId: project.id, title: 'Crate', departmentId: modelling(db).id, leaderUserId: LEADER,
  }, OWNER);
  tasksRepo.approvePay(db, GUILD, live.id, { amountMinor: 2500, currency: 'USD', actorUserId: OWNER });
  tasksRepo.assignArtist(db, GUILD, live.id, ARTIST, OWNER);
  db.prepare("UPDATE tasks SET state = 'in_progress' WHERE id = ?").run(live.id);

  const done = tasksRepo.createTask(db, GUILD, {
    projectId: project.id, title: 'Barrel', departmentId: modelling(db).id, leaderUserId: LEADER,
  }, OWNER);
  tasksRepo.approvePay(db, GUILD, done.id, { amountMinor: 1500, currency: 'USD', actorUserId: OWNER });
  tasksRepo.assignArtist(db, GUILD, done.id, ARTIST, OWNER);
  db.prepare("UPDATE tasks SET state = 'client_approved' WHERE id = ?").run(done.id);

  const departments = configRepo.listDepartments(db, GUILD);
  const report = offboarding.buildReport(db, GUILD, ARTIST, departments);

  assert.equal(report.unfinished.length, 1);
  assert.equal(report.unfinished[0].code, live.code);
  assert.equal(report.pay.totals.get('USD'), 4000, 'both tasks are still unpaid');
  assert.equal(report.files.length, 1, 'the approved task has no files recorded');
  assert.ok(report.blockers.length >= 3);

  onboardingRepo.recordDeparture(db, GUILD, {
    userId: ARTIST, reason: 'Moving on', snapshot: offboarding.snapshotOf(report),
  }, OWNER);
  staffRepo.markRemoved(db, GUILD, ARTIST, OWNER);

  // Everything that made them accountable is still there.
  assert.equal(tasksRepo.getTask(db, GUILD, live.id).artist_user_id, ARTIST);
  assert.ok(staffRepo.getStaff(db, GUILD, ARTIST).removed_at, 'flagged, not deleted');
  assert.equal(offboarding.buildReport(db, GUILD, ARTIST, departments).pay.totals.get('USD'), 4000,
    'leaving does not cancel what they are owed');
});

test('a departure snapshot keeps what was outstanding at the time', () => {
  const db = setup();
  const project = projectsRepo.createProject(db, GUILD, { name: 'Order' }, OWNER);
  const task = tasksRepo.createTask(db, GUILD, {
    projectId: project.id, title: 'Crate', departmentId: modelling(db).id, leaderUserId: LEADER,
  }, OWNER);
  tasksRepo.assignArtist(db, GUILD, task.id, ARTIST, OWNER);
  db.prepare("UPDATE tasks SET state = 'in_progress' WHERE id = ?").run(task.id);

  const report = offboarding.buildReport(db, GUILD, ARTIST, configRepo.listDepartments(db, GUILD));
  const departure = onboardingRepo.recordDeparture(db, GUILD, {
    userId: ARTIST, snapshot: offboarding.snapshotOf(report),
  }, OWNER);

  // Finishing the task afterwards must not rewrite what the record says was
  // outstanding on the day they left.
  db.prepare("UPDATE tasks SET state = 'client_approved' WHERE id = ?").run(task.id);

  const stored = JSON.parse(onboardingRepo.listDepartures(db, GUILD)[0].snapshot_json);
  assert.deepEqual(stored.unfinished_task_codes, [task.code]);
  assert.equal(departure.completed_at, null);

  assert.ok(onboardingRepo.completeDeparture(db, GUILD, departure.id, OWNER));
  assert.equal(onboardingRepo.completeDeparture(db, GUILD, departure.id, OWNER), null, 'completed once');
});

test('offboarding counts work somebody only contributed to', () => {
  const db = setup();
  const contributorsRepo = require('../src/db/repos/contributors');

  const project = projectsRepo.createProject(db, GUILD, { name: 'Order' }, OWNER);
  const task = tasksRepo.createTask(db, GUILD, {
    projectId: project.id, title: 'Crate', departmentId: modelling(db).id, leaderUserId: LEADER,
  }, OWNER);
  tasksRepo.approvePay(db, GUILD, task.id, { amountMinor: 2500, currency: 'USD', actorUserId: OWNER });
  tasksRepo.assignArtist(db, GUILD, task.id, ARTIST, OWNER);
  db.prepare("UPDATE tasks SET state = 'in_progress' WHERE id = ?").run(task.id);

  contributorsRepo.addContributor(db, GUILD, tasksRepo.getTask(db, GUILD, task.id), {
    userId: STAND_IN, responsibility: 'Texturing', actorUserId: OWNER,
  });
  contributorsRepo.approvePay(db, GUILD, task.id, STAND_IN, {
    amountMinor: 500, currency: 'USD', actorUserId: OWNER,
  });

  const report = offboarding.buildReport(db, GUILD, STAND_IN, configRepo.listDepartments(db, GUILD));
  assert.equal(report.unfinished.length, 1, 'helping on somebody else\'s task still leaves work behind');
  assert.equal(report.pay.totals.get('USD'), 500, 'their own figure, not the task total');
});

test('money already paid is not reported as still owed', () => {
  const db = setup();
  const project = projectsRepo.createProject(db, GUILD, { name: 'Order' }, OWNER);
  const task = tasksRepo.createTask(db, GUILD, {
    projectId: project.id, title: 'Crate', departmentId: modelling(db).id, leaderUserId: LEADER,
  }, OWNER);
  tasksRepo.approvePay(db, GUILD, task.id, { amountMinor: 2500, currency: 'USD', actorUserId: OWNER });
  tasksRepo.assignArtist(db, GUILD, task.id, ARTIST, OWNER);
  db.prepare("UPDATE tasks SET state = 'client_approved' WHERE id = ?").run(task.id);

  paymentsRepo.recordPayment(db, GUILD, {
    direction: 'payout', taskId: task.id, payeeUserId: ARTIST, amountMinor: 2500, currency: 'USD',
    recordedBy: OWNER, idempotencyKey: 'paid-in-full',
  });

  const report = offboarding.buildReport(db, GUILD, ARTIST, configRepo.listDepartments(db, GUILD));
  assert.equal(report.pay.totals.size, 0);
});
