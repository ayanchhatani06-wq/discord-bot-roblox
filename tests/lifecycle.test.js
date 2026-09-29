const test = require('node:test');
const assert = require('node:assert/strict');

const { openDatabase } = require('../src/db');
const configRepo = require('../src/db/repos/config');
const staffRepo = require('../src/db/repos/staff');
const projectsRepo = require('../src/db/repos/projects');
const tasksRepo = require('../src/db/repos/tasks');
const offersRepo = require('../src/db/repos/offers');
const submissionsRepo = require('../src/db/repos/submissions');
const paymentsRepo = require('../src/db/repos/payments');
const { listAudit } = require('../src/db/repos/core');
const { contributionSummary } = require('../src/services/absence');
const paymentState = require('../src/services/paymentState');
const { TASK_STATES } = require('../src/domain/taskState');

const GUILD = 'guild-1';
const OWNER = 'owner-1';
const LEADER = 'leader-1';
const ARTIST = 'artist-1';
const REPLACEMENT = 'artist-2';

function setup() {
  const db = openDatabase({ file: ':memory:' });
  configRepo.ensureConfig(db, GUILD);
  configRepo.seedDefaultDepartments(db, GUILD, OWNER);
  configRepo.updateConfig(db, GUILD, { owner_user_id: OWNER }, OWNER);
  for (const id of [ARTIST, REPLACEMENT, LEADER]) {
    staffRepo.ensureStaff(db, GUILD, id, id);
    staffRepo.updateStaff(db, GUILD, id, {
      timezone: 'Europe/London',
      department_id: configRepo.getDepartmentByKey(db, GUILD, 'modelling').id,
    });
  }
  return db;
}

function inProgressTask(db) {
  const project = projectsRepo.createProject(db, GUILD, {
    name: 'P', clientAmountMinor: 4000, clientCurrency: 'USD',
  }, OWNER);

  const task = tasksRepo.createTask(db, GUILD, {
    projectId: project.id,
    title: 'Model',
    departmentId: configRepo.getDepartmentByKey(db, GUILD, 'modelling').id,
    leaderUserId: LEADER,
  }, OWNER);

  tasksRepo.approvePay(db, GUILD, task.id, { amountMinor: 2500, currency: 'USD', actorUserId: OWNER });
  tasksRepo.applyTransition(db, GUILD, task.id, 'offer', { actorUserId: LEADER, patch: { artist_user_id: ARTIST } });
  const offer = offersRepo.createOffer(db, GUILD, { taskId: task.id, artistUserId: ARTIST, offeredBy: LEADER, terms: {} });
  offersRepo.resolveOffer(db, GUILD, offer.id, 'accepted', { actorUserId: ARTIST });
  tasksRepo.applyTransition(db, GUILD, task.id, 'offer_accept', {
    actorUserId: ARTIST, patch: { accepted_at: Date.now() },
  });

  return { project, task: tasksRepo.getTask(db, GUILD, task.id) };
}

test('reassignment keeps the original artist\'s work and flags it for the owner', () => {
  const db = setup();
  const { task } = inProgressTask(db);

  submissionsRepo.addSubmission(db, GUILD, task.id, {
    kind: 'progress', notes: 'Blockout done', links: ['https://example.com/a'], submittedBy: ARTIST,
  });

  const contribution = contributionSummary(db, task.id);
  assert.equal(contribution.hasWork, true);
  assert.equal(contribution.submissionCount, 1);

  const moved = tasksRepo.applyTransition(db, GUILD, task.id, 'reassign', {
    actorUserId: LEADER,
    patch: { artist_user_id: REPLACEMENT, accepted_at: null, accepted_terms_json: null },
    detail: 'Original artist went away',
  });
  tasksRepo.setFlag(db, GUILD, task.id, 'compensation', true, LEADER, 'work done before the move');

  assert.equal(moved.state, TASK_STATES.OFFERED, 'the new artist still has to accept');
  assert.equal(moved.artist_user_id, REPLACEMENT);
  assert.equal(tasksRepo.getTask(db, GUILD, task.id).compensation_review_flag, 1);

  // The original submission is untouched and still attributed to them.
  const submissions = submissionsRepo.listSubmissions(db, task.id);
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].submitted_by, ARTIST);
  db.close();
});

test('cancelling preserves the task, its history and its payments', () => {
  const db = setup();
  const { project, task } = inProgressTask(db);

  submissionsRepo.addSubmission(db, GUILD, task.id, {
    kind: 'final', notes: 'Done', links: ['https://example.com/final'], checklist: [], submittedBy: ARTIST,
  });
  paymentsRepo.recordPayment(db, GUILD, {
    direction: 'payout', projectId: project.id, taskId: task.id, payeeUserId: ARTIST,
    amountMinor: 1000, currency: 'USD', recordedBy: OWNER, idempotencyKey: 'part-payment',
  });

  const cancelled = tasksRepo.applyTransition(db, GUILD, task.id, 'cancel', {
    actorUserId: OWNER, patch: { cancel_reason: 'Client pulled out' }, detail: 'Client pulled out',
  });

  assert.equal(cancelled.state, TASK_STATES.CANCELLED);
  assert.equal(cancelled.cancel_reason, 'Client pulled out');
  assert.ok(cancelled.cancelled_at > 0);
  assert.equal(submissionsRepo.listSubmissions(db, task.id).length, 1, 'submissions survive');
  assert.equal(paymentsRepo.listPaymentsForTask(db, task.id).length, 1, 'payments survive');

  const trail = listAudit(db, { guildId: GUILD, entityType: 'task', entityId: task.id });
  assert.ok(trail.some((row) => row.action === 'task.cancel'));
  db.close();
});

test('a cancelled task cannot be cancelled or worked on again', () => {
  const db = setup();
  const { task } = inProgressTask(db);
  tasksRepo.applyTransition(db, GUILD, task.id, 'cancel', { actorUserId: OWNER, patch: { cancel_reason: 'x' } });

  for (const action of ['cancel', 'submit_final', 'reassign', 'hold']) {
    assert.throws(() => tasksRepo.applyTransition(db, GUILD, task.id, action, { actorUserId: OWNER }), /Cannot/);
  }
  db.close();
});

test('compensation is recorded separately from the agreed artist pay', () => {
  const db = setup();
  const { project, task } = inProgressTask(db);

  paymentsRepo.recordPayment(db, GUILD, {
    direction: 'payout', projectId: project.id, taskId: task.id, payeeUserId: ARTIST,
    allocationKind: 'compensation', amountMinor: 800, currency: 'USD',
    note: 'Blockout done before reassignment', recordedBy: OWNER, idempotencyKey: 'comp-1',
  });

  const fresh = tasksRepo.getTask(db, GUILD, task.id);
  // Compensation must not look like progress towards the agreed fee.
  assert.equal(paymentState.paidToArtist(db, fresh), 0);
  assert.equal(paymentState.remainingForArtist(db, fresh), 2500);

  const paid = paymentsRepo.payoutTotalsForPayee(db, GUILD, ARTIST);
  assert.equal(paid.get('USD'), 800, 'but it still counts as money they received');
  db.close();
});

test('holding a task pauses it and resuming returns it to the same artist', () => {
  const db = setup();
  const { task } = inProgressTask(db);

  const held = tasksRepo.applyTransition(db, GUILD, task.id, 'hold', { actorUserId: LEADER, detail: 'Waiting on references' });
  assert.equal(held.state, TASK_STATES.ON_HOLD);
  assert.equal(held.artist_user_id, ARTIST);

  const resumed = tasksRepo.applyTransition(db, GUILD, task.id, 'resume', { actorUserId: LEADER });
  assert.equal(resumed.state, TASK_STATES.IN_PROGRESS);
  assert.equal(resumed.artist_user_id, ARTIST);
  db.close();
});

test('an unassigned task resumes into the queue rather than to nobody', () => {
  const db = setup();
  const project = projectsRepo.createProject(db, GUILD, { name: 'P' }, OWNER);
  const task = tasksRepo.createTask(db, GUILD, {
    projectId: project.id, title: 'T',
    departmentId: configRepo.getDepartmentByKey(db, GUILD, 'vfx').id,
  }, OWNER);

  tasksRepo.applyTransition(db, GUILD, task.id, 'hold', { actorUserId: OWNER, detail: 'paused' });
  const resumed = tasksRepo.applyTransition(db, GUILD, task.id, 'resume_unassigned', { actorUserId: OWNER });

  assert.equal(resumed.state, TASK_STATES.UNASSIGNED);
  assert.equal(resumed.artist_user_id, null);
  db.close();
});

test('going away does not touch the artist\'s tasks', () => {
  const db = setup();
  const { task } = inProgressTask(db);

  staffRepo.setAvailability(db, GUILD, ARTIST, 'away', { awayUntil: Date.now() + 86400000, note: 'Exams' });

  const after = tasksRepo.getTask(db, GUILD, task.id);
  assert.equal(after.state, TASK_STATES.IN_PROGRESS, 'the task is untouched');
  assert.equal(after.artist_user_id, ARTIST, 'and still theirs');
  assert.equal(staffRepo.getStaff(db, GUILD, ARTIST).availability, 'away');
  db.close();
});

test('contribution detection distinguishes work done from nothing started', () => {
  const db = setup();
  const { task } = inProgressTask(db);

  assert.equal(contributionSummary(db, task.id).hasWork, false);

  submissionsRepo.addSubmission(db, GUILD, task.id, { kind: 'progress', notes: 'wip', submittedBy: ARTIST });
  const after = contributionSummary(db, task.id);
  assert.equal(after.hasWork, true);
  assert.equal(after.finalCount, 0);

  submissionsRepo.addSubmission(db, GUILD, task.id, { kind: 'final', notes: 'done', links: ['https://x.example'], submittedBy: ARTIST });
  assert.equal(contributionSummary(db, task.id).finalCount, 1);
  db.close();
});

test('reassigning clears the previous acceptance so the new artist agrees for themselves', () => {
  const db = setup();
  const { task } = inProgressTask(db);
  assert.ok(tasksRepo.getTask(db, GUILD, task.id).accepted_at);

  const moved = tasksRepo.applyTransition(db, GUILD, task.id, 'reassign', {
    actorUserId: LEADER,
    patch: { artist_user_id: REPLACEMENT, accepted_at: null, accepted_terms_json: null },
  });

  assert.equal(moved.accepted_at, null);
  assert.equal(moved.accepted_terms_json, null);
  assert.equal(moved.state, TASK_STATES.OFFERED);
  db.close();
});
