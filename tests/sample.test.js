const test = require('node:test');
const assert = require('node:assert/strict');

const { openDatabase } = require('../src/db');
const configRepo = require('../src/db/repos/config');
const tasksRepo = require('../src/db/repos/tasks');
const projectsRepo = require('../src/db/repos/projects');
const offersRepo = require('../src/db/repos/offers');
const submissionsRepo = require('../src/db/repos/submissions');
const paymentsRepo = require('../src/db/repos/payments');
const allocationFlow = require('../src/services/allocationFlow');
const { buildPanel } = require('../src/interactions/setup');
const {
  SAMPLE_MARKER,
  createSampleProject,
  listSampleProjects,
  removeSampleData,
} = require('../src/services/sampleData');
const { TASK_STATES } = require('../src/domain/taskState');

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

function build(db) {
  return createSampleProject(db, GUILD, { ownerId: OWNER, leaderId: LEADER, artistId: ARTIST });
}

test('the sample project demonstrates every stage of the workflow at once', () => {
  const db = setup();
  const result = build(db);

  assert.equal(result.ok, true);
  assert.equal(result.taskCount, 6);
  assert.match(result.project.name, /^\[SAMPLE\]/);

  const tasks = tasksRepo.listTasksForProject(db, result.project.id);
  const states = tasks.map((task) => task.state).sort();

  // One task sitting in each of the interesting states.
  assert.deepEqual(states, [
    TASK_STATES.CLIENT_APPROVED,
    TASK_STATES.IN_PROGRESS,
    TASK_STATES.INTERNAL_REVIEW,
    TASK_STATES.OFFERED,
    TASK_STATES.UNASSIGNED,
    TASK_STATES.UNASSIGNED,
  ].sort());
  db.close();
});

test('the sample covers both pay states a leader and owner will meet', () => {
  const db = setup();
  const result = build(db);

  const proposed = tasksRepo.getTaskByCode(db, GUILD, result.showcase.payProposed);
  assert.equal(proposed.pay_state, 'proposed');
  assert.equal(proposed.artist_pay_minor, null, 'a proposal is not agreed pay');
  assert.equal(proposed.pay_proposed_by, LEADER);

  const queued = tasksRepo.getTaskByCode(db, GUILD, result.showcase.queued);
  assert.equal(queued.pay_state, 'unset');
  assert.equal(tasksRepo.isPayApproved(queued), false, 'so it cannot be offered yet');
  db.close();
});

test('the sample offer is left unanswered so the queue view has something in it', () => {
  const db = setup();
  const result = build(db);

  const offered = tasksRepo.getTaskByCode(db, GUILD, result.showcase.offered);
  assert.equal(offered.state, TASK_STATES.OFFERED);
  assert.equal(offered.artist_user_id, ARTIST);

  const pending = offersRepo.getPendingOffer(db, offered.id);
  assert.ok(pending, 'there is a live offer');
  assert.equal(pending.state, 'pending');
  db.close();
});

test('the finished sample task is approved, paid and split', () => {
  const db = setup();
  const result = build(db);
  const done = tasksRepo.getTaskByCode(db, GUILD, result.showcase.finished);

  assert.equal(done.state, TASK_STATES.CLIENT_APPROVED);
  assert.equal(done.payment_state, 'paid');
  assert.ok(done.completed_at > 0);

  const decision = submissionsRepo.latestClientDecision(db, done.id);
  assert.equal(decision.decision, 'approved');
  assert.equal(decision.recorded_by, OWNER, 'recorded by a person, not by the bot');

  const allocations = allocationFlow.listAllocations(db, done.id);
  assert.equal(allocations.length > 0, true);
  const poolMinor = allocations[0].pool_minor;
  assert.equal(allocations.reduce((sum, row) => sum + row.amount_minor, 0), poolMinor);

  // With no finder or mod on the sample project, those shares fall to the owner.
  const ownerShare = allocations.find((row) => row.recipient_kind === 'owner');
  assert.equal(ownerShare.recipient_user_id, OWNER);
  assert.equal(ownerShare.percent_bp, 8000);
  db.close();
});

test('the sample records a client receipt and an artist payout', () => {
  const db = setup();
  const result = build(db);

  const receipts = projectsRepo.clientReceipts(db, result.project.id);
  assert.equal(receipts.get('USD'), 40000);
  assert.equal(projectsRepo.isClientPaidInFull(db, projectsRepo.getProject(db, GUILD, result.project.id)), true);

  const payouts = paymentsRepo.payoutTotalsForPayee(db, GUILD, ARTIST);
  assert.equal(payouts.get('USD'), 2500);
  db.close();
});

test('the in-progress sample task has a progress note, so stale reminders stay quiet', () => {
  const db = setup();
  const result = build(db);
  const task = tasksRepo.getTaskByCode(db, GUILD, result.showcase.inProgress);

  assert.equal(task.state, TASK_STATES.IN_PROGRESS);
  assert.ok(task.accepted_at > 0);
  assert.ok(task.last_progress_at > 0);

  const submissions = submissionsRepo.listSubmissions(db, task.id, { kind: 'progress' });
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].submitted_by, ARTIST);
  db.close();
});

test('the reviewable sample task has a complete checklist attached', () => {
  const db = setup();
  const result = build(db);
  const task = tasksRepo.getTaskByCode(db, GUILD, result.showcase.inReview);

  const submission = submissionsRepo.latestSubmission(db, task.id, { kind: 'final' });
  const checklist = submissionsRepo.checklist(submission);

  assert.equal(task.state, TASK_STATES.INTERNAL_REVIEW);
  assert.ok(checklist.length > 0);
  assert.ok(checklist.every((entry) => entry.included === true));
  db.close();
});

test('sample data is clearly marked and removable in one go', () => {
  const db = setup();
  const result = build(db);

  assert.equal(listSampleProjects(db, GUILD).length, 1);
  assert.match(result.project.client_ref, /safe to delete/i);
  assert.ok(tasksRepo.listTasksForProject(db, result.project.id).every((task) => task.title.startsWith(SAMPLE_MARKER)));

  const removed = removeSampleData(db, GUILD);
  assert.equal(removed.removedProjects, 1);
  assert.equal(removed.removedTasks, 6);
  assert.equal(listSampleProjects(db, GUILD).length, 0);

  // Nothing is left dangling behind it.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM payments').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM submissions').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM allocations').get().n, 0);
  db.close();
});

test('removing sample data leaves real projects alone', () => {
  const db = setup();
  build(db);
  const real = projectsRepo.createProject(db, GUILD, { name: 'Actual client job' }, OWNER);

  removeSampleData(db, GUILD);
  assert.ok(projectsRepo.getProject(db, GUILD, real.id), 'the real project survives');
  db.close();
});

test('the sample refuses to build before departments exist', () => {
  const db = openDatabase({ file: ':memory:' });
  configRepo.ensureConfig(db, GUILD);

  const result = createSampleProject(db, GUILD, { ownerId: OWNER, leaderId: LEADER, artistId: ARTIST });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no_departments');
  db.close();
});

test('the setup checklist tracks what is still missing', () => {
  const db = setup();

  const before = buildPanel(db, GUILD).embed.toJSON();
  assert.match(before.description, /⬜ Staff board channel/);
  assert.match(before.description, /✅ Owner recorded/);
  assert.match(before.description, /⬜ Leader roles mapped — 0 of 8/);

  configRepo.updateConfig(db, GUILD, { staff_board_channel_id: 'chan-1' }, OWNER);
  configRepo.upsertDepartment(db, GUILD, { key: 'modelling', leaderRoleId: 'role-1' }, OWNER);

  const after = buildPanel(db, GUILD).embed.toJSON();
  assert.match(after.description, /✅ Staff board channel/);
  assert.match(after.description, /⬜ Leader roles mapped — 1 of 8/);
  db.close();
});

test('the setup panel fits inside Discord component limits', () => {
  const db = setup();
  const panel = buildPanel(db, GUILD);

  assert.ok(panel.components.length <= 5, 'at most five action rows');
  for (const row of panel.components) {
    const json = row.toJSON();
    assert.ok(json.components.length <= 5);
    for (const component of json.components) {
      if (component.custom_id) assert.ok(component.custom_id.length <= 100);
    }
  }
  db.close();
});
