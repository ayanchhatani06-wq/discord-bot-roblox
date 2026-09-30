const test = require('node:test');
const assert = require('node:assert/strict');

const { openDatabase } = require('../src/db');
const configRepo = require('../src/db/repos/config');
const staffRepo = require('../src/db/repos/staff');
const clientsRepo = require('../src/db/repos/clients');
const projectsRepo = require('../src/db/repos/projects');
const tasksRepo = require('../src/db/repos/tasks');
const offersRepo = require('../src/db/repos/offers');
const submissionsRepo = require('../src/db/repos/submissions');
const paymentsRepo = require('../src/db/repos/payments');
const assetsRepo = require('../src/db/repos/assets');
const enquiriesRepo = require('../src/db/repos/enquiries');
const messagingRepo = require('../src/db/repos/messaging');
const contributorsRepo = require('../src/db/repos/contributors');
const webRepo = require('../src/db/repos/web');
const { listAudit } = require('../src/db/repos/core');

const allocationFlow = require('../src/services/allocationFlow');
const paymentState = require('../src/services/paymentState');
const clientReport = require('../src/services/clientReport');
const clientMessaging = require('../src/services/clientMessaging');
const messageTriggers = require('../src/services/messageTriggers');
const budget = require('../src/services/budget');
const doctor = require('../src/services/doctor');
const nextActions = require('../src/services/nextActions');
const content = require('../web/lib/content');

const { resolveActor } = require('../src/domain/permissions');
const { TASK_STATES } = require('../src/domain/taskState');
const { formatAmount } = require('../src/domain/money');

const GUILD = 'guild-1';
const OWNER = 'owner-1';
const LEADER = 'leader-1';
const ARTIST = 'artist-1';
const HELPER = 'helper-1';
const FINDER = 'finder-1';
const MOD = 'mod-1';
const CLIENT_USER = 'client-user-1';

/**
 * One whole job, from the enquiry arriving to the money being split.
 *
 * The per-area suites prove each stage works. This proves the seams between
 * them hold: that an enquiry really becomes a project, that approving work
 * really makes it payable, that the split really lands on the people the
 * studio's rules name, and that a client only ever sees their own side of it.
 *
 * It is written as one test on purpose. A job is a sequence, and a failure
 * halfway through is most informative when you can see everything that had
 * already happened.
 */
test('a whole job: enquiry, quote, work, approval, payment, split and portfolio', () => {
  const db = openDatabase({ file: ':memory:' });

  // ---- the studio, configured ----

  configRepo.ensureConfig(db, GUILD);
  configRepo.seedDefaultDepartments(db, GUILD, OWNER);
  configRepo.updateConfig(db, GUILD, {
    owner_user_id: OWNER,
    fallback_channel_id: 'fallback',
    studio_name: 'Cylops Studio',
  }, OWNER);

  const modelling = configRepo.getDepartmentByKey(db, GUILD, 'modelling');
  db.prepare('UPDATE departments SET leader_role_id = ?, member_role_id = ? WHERE id = ?')
    .run('lead-modelling', 'member-modelling', modelling.id);

  for (const [id, name] of [[OWNER, 'Owner'], [LEADER, 'Leader'], [ARTIST, 'Artist'], [HELPER, 'Helper']]) {
    staffRepo.ensureStaff(db, GUILD, id, name);
    staffRepo.setTimezone(db, GUILD, id, 'UTC', id);
    staffRepo.updateStaff(db, GUILD, id, { department_id: modelling.id, leader_user_id: LEADER }, OWNER);
  }

  // ---- an enquiry arrives from the website ----

  const enquiry = enquiriesRepo.createEnquiry(db, GUILD, {
    source: 'web',
    contactRef: 'Acme Games — acme#1234',
    serviceRequest: 'Modelling',
    notes: 'Two crates for a lobby.',
  }, null);

  assert.match(enquiry.code, /^ENQ-/);
  assert.equal(enquiry.source, 'web');

  // ---- it becomes a client and an order ----

  const client = clientsRepo.createClient(db, GUILD, {
    displayName: 'Acme Games', finderUserId: FINDER,
  }, OWNER);
  clientsRepo.addAccount(db, GUILD, client.id, { userId: CLIENT_USER }, OWNER);

  const project = projectsRepo.createProject(db, GUILD, {
    name: 'Lobby crates',
    clientAmountMinor: 4000,
    clientCurrency: 'USD',
    finderUserId: FINDER,
    modUserId: MOD,
  }, OWNER);
  clientsRepo.linkProject(db, GUILD, project.id, client.id, OWNER, { clientChannelId: 'client-channel' });

  // ---- a task, priced by the owner ----

  const task = tasksRepo.createTask(db, GUILD, {
    projectId: project.id,
    title: 'Wooden crate',
    departmentId: modelling.id,
    leaderUserId: LEADER,
    brief: 'A wooden crate.',
    deliverables: ['Source file', 'Exported model'],
  }, OWNER);

  // A leader proposes; only the owner agrees it. Until then it cannot be offered.
  tasksRepo.proposePay(db, GUILD, task.id, { amountMinor: 2500, currency: 'USD', actorUserId: LEADER });
  assert.equal(tasksRepo.isPayApproved(tasksRepo.getTask(db, GUILD, task.id)), false);

  // The owner sees it as the most pressing thing waiting on them.
  const ownerActor = resolveActor({
    userId: OWNER,
    config: configRepo.getConfig(db, GUILD),
    departments: configRepo.listDepartments(db, GUILD),
  });
  const waiting = nextActions.forUser(db, GUILD, OWNER, ownerActor);
  assert.match(waiting.actions[0].text, /pay figure/);

  // And the budget allows it: $25 of a $40 job.
  const check = budget.checkBudget(db, GUILD, task, { amountMinor: 2500, currency: 'USD' });
  assert.equal(check.ok, true);

  tasksRepo.approvePay(db, GUILD, task.id, { amountMinor: 2500, currency: 'USD', actorUserId: OWNER });
  assert.equal(tasksRepo.isPayApproved(tasksRepo.getTask(db, GUILD, task.id)), true);

  // ---- offered, accepted ----

  const offer = offersRepo.createOffer(db, GUILD, {
    taskId: task.id,
    artistUserId: ARTIST,
    offeredBy: LEADER,
    terms: tasksRepo.termsSnapshot({ ...tasksRepo.getTask(db, GUILD, task.id), artist_user_id: ARTIST }),
  });
  tasksRepo.assignArtist(db, GUILD, task.id, ARTIST, LEADER);
  tasksRepo.applyTransition(db, GUILD, task.id, 'offer', { actorUserId: LEADER });

  offersRepo.resolveOffer(db, GUILD, offer.id, offersRepo.OFFER_STATES.ACCEPTED, { actorUserId: ARTIST });
  tasksRepo.applyTransition(db, GUILD, task.id, 'offer_accept', { actorUserId: ARTIST });

  assert.equal(tasksRepo.getTask(db, GUILD, task.id).state, TASK_STATES.IN_PROGRESS);

  // ---- somebody helps, on their own separately agreed terms ----

  contributorsRepo.addContributor(db, GUILD, tasksRepo.getTask(db, GUILD, task.id), {
    userId: HELPER, responsibility: 'Texturing', actorUserId: LEADER,
  });
  contributorsRepo.approvePay(db, GUILD, task.id, HELPER, {
    amountMinor: 500, currency: 'USD', actorUserId: OWNER,
  });

  // The original artist's terms carried across untouched, and nobody is doubled.
  const cost = contributorsRepo.costByCurrency(db, tasksRepo.getTask(db, GUILD, task.id));
  assert.equal(cost.get('USD'), 3000, '$25 artist plus $5 helper, counted once each');

  // ---- submitted, reviewed, released to the client ----

  const submission = submissionsRepo.addSubmission(db, GUILD, task.id, {
    kind: 'final',
    links: ['https://example.invalid/crate.fbx'],
    checklist: ['Source file', 'Exported model'],
    submittedBy: ARTIST,
  });
  tasksRepo.applyTransition(db, GUILD, task.id, 'submit_final', { actorUserId: ARTIST });

  submissionsRepo.markClientVisible(db, GUILD, submission.id, LEADER);
  tasksRepo.applyTransition(db, GUILD, task.id, 'review_ready_for_client', { actorUserId: LEADER });

  assert.equal(tasksRepo.getTask(db, GUILD, task.id).state, TASK_STATES.AWAITING_CLIENT);

  // What the client sees: their own progress, and nothing about who did it.
  const report = clientReport.buildProjectReport(db, GUILD, projectsRepo.getProject(db, GUILD, project.id));
  assert.equal(report.counts[clientReport.BUCKETS.AWAITING_YOUR_APPROVAL], 1);
  assert.equal(JSON.stringify(report).includes(ARTIST), false, 'the client never learns who made it');
  assert.equal(JSON.stringify(report).includes('2500'), false, 'nor what anybody was paid');

  // ---- the client approves ----

  submissionsRepo.addClientDecision(db, GUILD, task.id, {
    submissionId: submission.id, decision: 'approved', recordedBy: OWNER,
  });
  tasksRepo.applyTransition(db, GUILD, task.id, 'client_approve', { actorUserId: OWNER });

  // Approved is not payable: the client's money has to have arrived.
  let state = paymentState.recomputeTaskPaymentState(db, GUILD, task.id, OWNER);
  assert.equal(state.payment_state, tasksRepo.PAYMENT_STATES.PENDING_CLIENT_PAYMENT);

  paymentsRepo.recordPayment(db, GUILD, {
    direction: 'client_receipt', projectId: project.id, amountMinor: 4000, currency: 'USD',
    recordedBy: OWNER, idempotencyKey: 'receipt-1',
  });
  paymentState.recomputeProjectPaymentStates(db, GUILD, project.id, OWNER);

  state = tasksRepo.getTask(db, GUILD, task.id);
  assert.equal(state.payment_state, tasksRepo.PAYMENT_STATES.PAYABLE);

  // ---- everybody is paid, and the task settles only when the last one is ----

  const owed = paymentState.owedOnTask(db, state);
  assert.equal(owed.length, 2);

  paymentsRepo.recordPayment(db, GUILD, {
    direction: 'payout', projectId: project.id, taskId: task.id, payeeUserId: ARTIST,
    amountMinor: 2500, currency: 'USD', recordedBy: OWNER, idempotencyKey: 'pay-artist',
  });
  assert.equal(
    paymentState.recomputeTaskPaymentState(db, GUILD, task.id, OWNER).payment_state,
    tasksRepo.PAYMENT_STATES.PARTIALLY_PAID,
    'the helper is still owed'
  );

  paymentsRepo.recordPayment(db, GUILD, {
    direction: 'payout', projectId: project.id, taskId: task.id, payeeUserId: HELPER,
    amountMinor: 500, currency: 'USD', recordedBy: OWNER, idempotencyKey: 'pay-helper',
  });
  assert.equal(
    paymentState.recomputeTaskPaymentState(db, GUILD, task.id, OWNER).payment_state,
    tasksRepo.PAYMENT_STATES.PAID
  );

  // ---- the leftover splits by the studio's rules ----

  // persistForTask, not computeForTask: storing the split is what puts it on
  // the record, and the record is what the studio is paid against.
  const split = allocationFlow.persistForTask(db, GUILD, tasksRepo.getTask(db, GUILD, task.id), OWNER);
  assert.equal(split.ok, true);
  assert.equal(split.poolMinor, 1000, '$40 client, minus $25 artist and $5 helper');

  const byKind = new Map(split.byKind.map((line) => [line.kind, line]));
  assert.equal(byKind.get('finder').userId, FINDER);
  assert.equal(byKind.get('leader').userId, LEADER, 'the leader share follows the department that did the work');
  assert.equal(byKind.get('mod').userId, MOD);
  assert.equal(byKind.get('owner').userId, OWNER);

  const allocated = split.byKind.reduce((sum, line) => sum + line.amountMinor, 0);
  assert.equal(allocated, split.poolMinor, 'the split lands on the pool exactly, to the cent');

  // ---- delivered, and the client permits it in the portfolio ----

  assetsRepo.addAsset(db, GUILD, {
    projectId: project.id, taskId: task.id, submissionId: submission.id,
    url: 'https://example.invalid/crate.fbx', label: 'Wooden crate',
    kind: 'deliverable', createdBy: ARTIST,
  });

  // Until permission is recorded, the public site shows nothing.
  assert.equal(content.publicSnapshot(db, GUILD).portfolio.length, 0);

  assetsRepo.setProjectRights(db, GUILD, project.id, {
    staffAllowed: true, studioAllowed: true, actorUserId: OWNER,
  });

  const snapshot = content.publicSnapshot(db, GUILD);
  assert.equal(snapshot.portfolio.length, 1);
  assert.equal(snapshot.studio.name, 'Cylops Studio');

  const publicPage = require('../web/lib/pages').work(snapshot);
  assert.match(publicPage, /Wooden crate/);
  assert.doesNotMatch(publicPage, /Acme Games/, 'permission to show the work is not permission to name the client');
  assert.doesNotMatch(publicPage, new RegExp(project.code));

  // ---- the studio is healthy, and everything that happened has a name on it ----

  const health = doctor.diagnose(db, GUILD);
  assert.equal(health.breaks, 0, `unexpected: ${health.findings.map((f) => f.title).join(' | ')}`);

  const audit = listAudit(db, { guildId: GUILD, limit: 500 });
  const actions = audit.map((row) => row.action);

  for (const expected of [
    'task.pay.approve', 'task.offer_accept', 'task.client_approve',
    'payment.client_receipt', 'payment.payout', 'allocation.compute',
  ]) {
    assert.ok(actions.includes(expected), `${expected} is not in the audit trail`);
  }

  assert.ok(
    audit.filter((row) => row.action === 'payment.payout').every((row) => row.actor_user_id === OWNER),
    'every payout records who entered it'
  );
});

test('a second client cannot see the first one\'s job anywhere', () => {
  const db = openDatabase({ file: ':memory:' });
  configRepo.ensureConfig(db, GUILD);
  configRepo.seedDefaultDepartments(db, GUILD, OWNER);
  configRepo.updateConfig(db, GUILD, { owner_user_id: OWNER }, OWNER);

  const mine = clientsRepo.createClient(db, GUILD, { displayName: 'Mine' }, OWNER);
  const theirs = clientsRepo.createClient(db, GUILD, { displayName: 'Theirs' }, OWNER);

  const project = projectsRepo.createProject(db, GUILD, { name: 'Confidential' }, OWNER);
  clientsRepo.linkProject(db, GUILD, project.id, mine.id, OWNER, {});

  clientsRepo.addAccount(db, GUILD, mine.id, { userId: 'mine-user' }, OWNER);
  clientsRepo.addAccount(db, GUILD, theirs.id, { userId: 'theirs-user' }, OWNER);

  // The single checkpoint every client route goes through.
  assert.equal(clientsRepo.authorizeProjectAccess(db, GUILD, project.id, 'mine-user').ok, true);
  assert.equal(clientsRepo.authorizeProjectAccess(db, GUILD, project.id, 'theirs-user').ok, false);

  // And staff, including the owner, are not clients at all.
  assert.equal(clientsRepo.authorizeProjectAccess(db, GUILD, project.id, OWNER).ok, false,
    'client access is never derived from being staff');

  assert.deepEqual(clientsRepo.listProjectsForAccount(db, GUILD, 'theirs-user'), []);
});
