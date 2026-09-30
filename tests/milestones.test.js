const test = require('node:test');
const assert = require('node:assert/strict');

const { openDatabase } = require('../src/db');
const configRepo = require('../src/db/repos/config');
const projectsRepo = require('../src/db/repos/projects');
const tasksRepo = require('../src/db/repos/tasks');
const paymentsRepo = require('../src/db/repos/payments');
const contributorsRepo = require('../src/db/repos/contributors');
const paymentSchedule = require('../src/services/paymentSchedule');
const paymentState = require('../src/services/paymentState');
const budget = require('../src/services/budget');

const GUILD = 'guild-1';
const OWNER = 'owner-1';
const LEADER = 'leader-1';
const ARTIST = 'artist-1';
const SECOND_ARTIST = 'artist-2';

const { PAYMENT_STATES } = tasksRepo;

function setup() {
  const db = openDatabase({ file: ':memory:' });
  configRepo.ensureConfig(db, GUILD);
  configRepo.seedDefaultDepartments(db, GUILD, OWNER);
  configRepo.updateConfig(db, GUILD, { owner_user_id: OWNER }, OWNER);
  return db;
}

function makeProject(db, overrides = {}) {
  return projectsRepo.createProject(db, GUILD, {
    name: 'Order',
    clientAmountMinor: 10000,
    clientCurrency: 'USD',
    ...overrides,
  }, OWNER);
}

function makeApprovedTask(db, project, { payMinor = 2500, payCurrency = 'USD', artist = ARTIST, title = 'Model' } = {}) {
  const task = tasksRepo.createTask(db, GUILD, {
    projectId: project.id,
    title,
    departmentId: configRepo.getDepartmentByKey(db, GUILD, 'modelling').id,
    leaderUserId: LEADER,
  }, OWNER);

  tasksRepo.approvePay(db, GUILD, task.id, { amountMinor: payMinor, currency: payCurrency, actorUserId: OWNER });
  tasksRepo.assignArtist(db, GUILD, task.id, artist, OWNER);
  db.prepare("UPDATE tasks SET state = 'client_approved' WHERE id = ?").run(task.id);
  return tasksRepo.getTask(db, GUILD, task.id);
}

function receive(db, project, amountMinor, { currency = 'USD', key = `r-${Math.random()}` } = {}) {
  return paymentsRepo.recordPayment(db, GUILD, {
    direction: 'client_receipt',
    projectId: project.id,
    amountMinor,
    currency,
    recordedBy: OWNER,
    idempotencyKey: key,
  });
}

function payOut(db, project, task, amountMinor, { payee = ARTIST, currency = 'USD', key = `p-${Math.random()}` } = {}) {
  return paymentsRepo.recordPayment(db, GUILD, {
    direction: 'payout',
    projectId: project.id,
    taskId: task.id,
    payeeUserId: payee,
    amountMinor,
    currency,
    recordedBy: OWNER,
    idempotencyKey: key,
  });
}

// ---------------------------------------------------------------------------
// The schedule itself
// ---------------------------------------------------------------------------

test('an order with no parts behaves exactly as it did before parts existed', () => {
  const db = setup();
  const project = makeProject(db);
  const schedule = paymentSchedule.scheduleFor(db, GUILD, project);

  assert.equal(schedule.hasSchedule, false);
  assert.equal(schedule.totalMinor, 10000);
  assert.equal(schedule.receivedMinor, 0);
  assert.equal(schedule.outstandingMinor, 10000);
  db.close();
});

test('receipts fill the parts in order, not the one that happens to match', () => {
  const db = setup();
  const project = makeProject(db);

  paymentSchedule.addMilestone(db, GUILD, project.id, {
    label: 'Deposit', amountMinor: 4000, currency: 'USD',
  }, OWNER);
  paymentSchedule.addMilestone(db, GUILD, project.id, {
    label: 'On delivery', amountMinor: 6000, currency: 'USD',
  }, OWNER);

  receive(db, project, 6000, { key: 'r1' });

  const schedule = paymentSchedule.scheduleFor(db, GUILD, project);
  assert.equal(schedule.hasSchedule, true);
  assert.equal(schedule.totalMinor, 10000);
  assert.equal(schedule.receivedMinor, 6000);

  const [deposit, delivery] = schedule.milestones;
  assert.equal(deposit.covered, true, 'the deposit is filled first');
  assert.equal(delivery.covered, false);
  assert.equal(delivery.coveredMinor, 2000, 'the remainder spills into the next part');
  assert.equal(delivery.outstandingMinor, 4000);
  assert.equal(schedule.nextDue.milestone.label, 'On delivery');
  db.close();
});

test('money beyond the parts is reported rather than quietly absorbed', () => {
  const db = setup();
  const project = makeProject(db);
  paymentSchedule.addMilestone(db, GUILD, project.id, {
    label: 'All of it', amountMinor: 4000, currency: 'USD',
  }, OWNER);

  receive(db, project, 5000, { key: 'r1' });

  const schedule = paymentSchedule.scheduleFor(db, GUILD, project);
  assert.equal(schedule.overpaidMinor, 1000, 'usually a missing part or a double payment');
  assert.equal(schedule.outstandingMinor, 0);
  assert.equal(schedule.fullyPaid, true);
  db.close();
});

test('a waived part stops counting as owed', () => {
  const db = setup();
  const project = makeProject(db);
  const first = paymentSchedule.addMilestone(db, GUILD, project.id, {
    label: 'Deposit', amountMinor: 4000, currency: 'USD',
  }, OWNER);
  paymentSchedule.addMilestone(db, GUILD, project.id, {
    label: 'Rush fee', amountMinor: 2000, currency: 'USD',
  }, OWNER);

  const before = paymentSchedule.scheduleFor(db, GUILD, project);
  assert.equal(before.totalMinor, 6000);

  paymentSchedule.waiveMilestone(db, GUILD, first.milestone.id, {
    reason: 'Goodwill after the delay', actorUserId: OWNER,
  });

  const after = paymentSchedule.scheduleFor(db, GUILD, project);
  assert.equal(after.totalMinor, 2000, 'the waived part is no longer owed');
  assert.equal(after.milestones[0].waived, true);
  assert.equal(after.milestones[0].outstandingMinor, 0);
  db.close();
});

test('a part in a second currency is refused, because it could never be paid off', () => {
  const db = setup();
  const project = makeProject(db);
  paymentSchedule.addMilestone(db, GUILD, project.id, {
    label: 'Deposit', amountMinor: 4000, currency: 'USD',
  }, OWNER);

  const refused = paymentSchedule.addMilestone(db, GUILD, project.id, {
    label: 'The rest in Robux', amountMinor: 5000, currency: 'RBX',
  }, OWNER);

  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'currency_mismatch');
  assert.equal(refused.expected, 'USD');
  assert.equal(paymentSchedule.listMilestones(db, project.id).length, 1);
  db.close();
});

test('a part with a zero or negative amount is refused', () => {
  const db = setup();
  const project = makeProject(db);
  assert.equal(paymentSchedule.addMilestone(db, GUILD, project.id, {
    label: 'Nothing', amountMinor: 0, currency: 'USD',
  }, OWNER).reason, 'bad_amount');
  db.close();
});

test('asking for a part twice keeps the first timestamp', () => {
  const db = setup();
  const project = makeProject(db);
  const added = paymentSchedule.addMilestone(db, GUILD, project.id, {
    label: 'Deposit', amountMinor: 4000, currency: 'USD',
  }, OWNER);

  const first = paymentSchedule.markInvoiced(db, GUILD, added.milestone.id, OWNER);
  const second = paymentSchedule.markInvoiced(db, GUILD, added.milestone.id, OWNER);

  assert.ok(first.invoiced_at);
  assert.equal(second, null, 'the second attempt changes nothing');
  db.close();
});

// ---------------------------------------------------------------------------
// The payable rule the owner chose: payable once the deposit covers their pay
// ---------------------------------------------------------------------------

test('a deposit that covers the artist makes the work payable', () => {
  const db = setup();
  const project = makeProject(db);
  const task = makeApprovedTask(db, project, { payMinor: 2500 });

  paymentSchedule.addMilestone(db, GUILD, project.id, {
    label: 'Deposit', amountMinor: 4000, currency: 'USD',
  }, OWNER);
  paymentSchedule.addMilestone(db, GUILD, project.id, {
    label: 'On delivery', amountMinor: 6000, currency: 'USD',
  }, OWNER);

  assert.equal(
    paymentState.computePaymentState(db, GUILD, task), PAYMENT_STATES.PENDING_CLIENT_PAYMENT,
    'nothing has arrived yet'
  );

  receive(db, project, 4000, { key: 'deposit' });
  paymentState.recomputeProjectPaymentStates(db, GUILD, project.id, OWNER);

  assert.equal(
    tasksRepo.getTask(db, GUILD, task.id).payment_state, PAYMENT_STATES.PAYABLE,
    '$40 in covers the $25 owed, so the artist can be paid without the order being settled'
  );
  db.close();
});

test('a deposit too small for the artist does not make the work payable', () => {
  const db = setup();
  const project = makeProject(db);
  const task = makeApprovedTask(db, project, { payMinor: 2500 });

  receive(db, project, 1000, { key: 'small' });
  paymentState.recomputeProjectPaymentStates(db, GUILD, project.id, OWNER);

  assert.equal(
    tasksRepo.getTask(db, GUILD, task.id).payment_state, PAYMENT_STATES.PENDING_CLIENT_PAYMENT,
    '$10 in does not cover $25 owed'
  );
  db.close();
});

test('a deposit funds work in order and stops when it runs out', () => {
  const db = setup();
  const project = makeProject(db);
  const first = makeApprovedTask(db, project, { payMinor: 2500, title: 'Model' });
  const second = makeApprovedTask(db, project, { payMinor: 2500, artist: SECOND_ARTIST, title: 'Texture' });

  receive(db, project, 3000, { key: 'deposit' });
  paymentState.recomputeProjectPaymentStates(db, GUILD, project.id, OWNER);

  // $30 in covers one $25 task, not two.
  assert.equal(tasksRepo.getTask(db, GUILD, first.id).payment_state, PAYMENT_STATES.PAYABLE);
  assert.equal(tasksRepo.getTask(db, GUILD, second.id).payment_state, PAYMENT_STATES.PAYABLE,
    'both look payable until one is actually paid — the money only stretches to one');

  payOut(db, project, first, 2500, { key: 'pay-1' });
  paymentState.recomputeProjectPaymentStates(db, GUILD, project.id, OWNER);

  assert.equal(
    tasksRepo.getTask(db, GUILD, second.id).payment_state, PAYMENT_STATES.PENDING_CLIENT_PAYMENT,
    'once the first is paid there is only $5 of headroom left, so the second is not payable'
  );
  db.close();
});

test('Robux received does not fund a dollar payout', () => {
  const db = setup();
  const project = makeProject(db, { clientAmountMinor: null, clientCurrency: null });
  const task = makeApprovedTask(db, project, { payMinor: 2500, payCurrency: 'USD' });

  paymentSchedule.addMilestone(db, GUILD, project.id, {
    label: 'All of it', amountMinor: 50000, currency: 'RBX',
  }, OWNER);
  receive(db, project, 50000, { currency: 'RBX', key: 'robux' });
  paymentState.recomputeProjectPaymentStates(db, GUILD, project.id, OWNER);

  assert.equal(
    tasksRepo.getTask(db, GUILD, task.id).payment_state, PAYMENT_STATES.PENDING_CLIENT_PAYMENT,
    'there is no rate, so Robux in cannot cover dollars out'
  );
  db.close();
});

test('the owner can still force a task payable, and that override wins', () => {
  const db = setup();
  const project = makeProject(db);
  const task = makeApprovedTask(db, project, { payMinor: 2500 });

  tasksRepo.overridePayable(db, GUILD, task.id, { reason: 'Paying from studio funds', actorUserId: OWNER });
  assert.equal(
    paymentState.computePaymentState(db, GUILD, tasksRepo.getTask(db, GUILD, task.id)),
    PAYMENT_STATES.PAYABLE
  );
  db.close();
});

test('with several contributors the money must cover all of them', () => {
  const db = setup();
  const project = makeProject(db);
  const task = makeApprovedTask(db, project, { payMinor: 2500 });

  contributorsRepo.addContributor(db, GUILD, task, { userId: SECOND_ARTIST, responsibility: 'texturing', actorUserId: OWNER });
  contributorsRepo.approvePay(db, GUILD, task.id, ARTIST, { amountMinor: 1500, currency: 'USD', actorUserId: OWNER });
  contributorsRepo.approvePay(db, GUILD, task.id, SECOND_ARTIST, { amountMinor: 1500, currency: 'USD', actorUserId: OWNER });
  // The task now carries two people at $15 each, so $30 is owed on it.

  receive(db, project, 2000, { key: 'partial' });
  paymentState.recomputeProjectPaymentStates(db, GUILD, project.id, OWNER);
  assert.equal(
    tasksRepo.getTask(db, GUILD, task.id).payment_state, PAYMENT_STATES.PENDING_CLIENT_PAYMENT,
    '$20 in does not cover $30 owed across two people'
  );

  receive(db, project, 1500, { key: 'rest' });
  paymentState.recomputeProjectPaymentStates(db, GUILD, project.id, OWNER);
  assert.equal(tasksRepo.getTask(db, GUILD, task.id).payment_state, PAYMENT_STATES.PAYABLE);
  db.close();
});

// ---------------------------------------------------------------------------
// The budget guard has to see the parts, or it stops guarding
// ---------------------------------------------------------------------------

test('the budget guard measures against the parts when an order has no single price', () => {
  const db = setup();
  const project = makeProject(db, { clientAmountMinor: null, clientCurrency: null });

  paymentSchedule.addMilestone(db, GUILD, project.id, {
    label: 'Deposit', amountMinor: 2000, currency: 'USD',
  }, OWNER);
  paymentSchedule.addMilestone(db, GUILD, project.id, {
    label: 'On delivery', amountMinor: 2000, currency: 'USD',
  }, OWNER);

  const task = tasksRepo.createTask(db, GUILD, {
    projectId: project.id,
    title: 'Model',
    departmentId: configRepo.getDepartmentByKey(db, GUILD, 'modelling').id,
    leaderUserId: LEADER,
  }, OWNER);

  const within = budget.checkBudget(db, GUILD, task, { amountMinor: 3000, currency: 'USD' });
  assert.equal(within.ok, true);
  assert.equal(within.budget, 4000, 'the parts add up to the budget');

  const over = budget.checkBudget(db, GUILD, task, { amountMinor: 5000, currency: 'USD' });
  assert.equal(over.ok, false, 'without this the guard would see no budget at all and pass anything');
  assert.equal(over.excessMinor, 1000);
  assert.equal(over.fromSchedule, true);
  db.close();
});

test('waiving a part lowers the budget the guard enforces', () => {
  const db = setup();
  const project = makeProject(db, { clientAmountMinor: null, clientCurrency: null });
  const deposit = paymentSchedule.addMilestone(db, GUILD, project.id, {
    label: 'Deposit', amountMinor: 2000, currency: 'USD',
  }, OWNER);
  paymentSchedule.addMilestone(db, GUILD, project.id, {
    label: 'On delivery', amountMinor: 2000, currency: 'USD',
  }, OWNER);

  const task = tasksRepo.createTask(db, GUILD, {
    projectId: project.id,
    title: 'Model',
    departmentId: configRepo.getDepartmentByKey(db, GUILD, 'modelling').id,
    leaderUserId: LEADER,
  }, OWNER);

  paymentSchedule.waiveMilestone(db, GUILD, deposit.milestone.id, { reason: 'Goodwill', actorUserId: OWNER });

  const check = budget.checkBudget(db, GUILD, task, { amountMinor: 3000, currency: 'USD' });
  assert.equal(check.ok, false, 'the studio is only charging $20 now, so $30 of pay is over');
  db.close();
});

// ---------------------------------------------------------------------------
// Sent is not landed
// ---------------------------------------------------------------------------

test('a payout can be confirmed as actually received', () => {
  const db = setup();
  const project = makeProject(db);
  const task = makeApprovedTask(db, project);
  const { payment } = payOut(db, project, task, 2500, { key: 'pay-1' });

  assert.equal(payment.confirmed_at, null, 'sent is not the same as landed');

  const result = paymentsRepo.confirmReceived(db, GUILD, payment.id, { confirmedBy: ARTIST });
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.ok(result.payment.confirmed_at);
  assert.equal(result.payment.confirmed_by, ARTIST);
  db.close();
});

test('confirming twice keeps the first timestamp, because that is when it happened', () => {
  const db = setup();
  const project = makeProject(db);
  const task = makeApprovedTask(db, project);
  const { payment } = payOut(db, project, task, 2500, { key: 'pay-1' });

  const first = paymentsRepo.confirmReceived(db, GUILD, payment.id, { confirmedBy: ARTIST });
  const second = paymentsRepo.confirmReceived(db, GUILD, payment.id, { confirmedBy: OWNER });

  assert.equal(second.changed, false);
  assert.equal(second.payment.confirmed_at, first.payment.confirmed_at);
  assert.equal(second.payment.confirmed_by, ARTIST, 'the first confirmation stands');
  db.close();
});

test('a failed payout is kept on the record and the artist is owed again', () => {
  const db = setup();
  const project = makeProject(db);
  const task = makeApprovedTask(db, project, { payMinor: 2500 });
  receive(db, project, 4000, { key: 'deposit' });

  const { payment } = payOut(db, project, task, 2500, { key: 'pay-1' });
  paymentState.recomputeTaskPaymentState(db, GUILD, task.id, OWNER);
  assert.equal(tasksRepo.getTask(db, GUILD, task.id).payment_state, PAYMENT_STATES.PAID);

  const failed = paymentsRepo.markFailed(db, GUILD, payment.id, {
    failedBy: OWNER, reason: 'The gift card code had already been used',
  });
  assert.equal(failed.ok, true);
  assert.ok(failed.payment.failed_at);

  // The row is still there — the attempt happened.
  assert.equal(paymentsRepo.getPayment(db, GUILD, payment.id) !== null, true);

  const owed = paymentState.owedToContributor(db, tasksRepo.getTask(db, GUILD, task.id), ARTIST);
  assert.equal(owed.paidMinor, 0, 'a failed transfer is not money the artist received');
  assert.equal(owed.remainingMinor, 2500);

  paymentState.recomputeTaskPaymentState(db, GUILD, task.id, OWNER);
  assert.equal(
    tasksRepo.getTask(db, GUILD, task.id).payment_state, PAYMENT_STATES.PAYABLE,
    'the deposit still covers them, so they are payable again rather than stuck'
  );
  db.close();
});

test('a failed payout does not count in the studio totals or in what somebody has earned', () => {
  const db = setup();
  const project = makeProject(db);
  const task = makeApprovedTask(db, project);
  const { payment } = payOut(db, project, task, 2500, { key: 'pay-1' });
  payOut(db, project, task, 500, { key: 'pay-2' });

  paymentsRepo.markFailed(db, GUILD, payment.id, { failedBy: OWNER, reason: 'Wrong account' });

  const totals = paymentsRepo.totalsByDirection(db, GUILD, { projectId: project.id });
  assert.equal(totals.paidOut.get('USD'), 500, 'only the payment that arrived counts');
  assert.equal(paymentsRepo.payoutTotalsForPayee(db, GUILD, ARTIST).get('USD'), 500);
  db.close();
});

test('a confirmed payout cannot then be marked failed', () => {
  const db = setup();
  const project = makeProject(db);
  const task = makeApprovedTask(db, project);
  const { payment } = payOut(db, project, task, 2500, { key: 'pay-1' });

  paymentsRepo.confirmReceived(db, GUILD, payment.id, { confirmedBy: ARTIST });
  const refused = paymentsRepo.markFailed(db, GUILD, payment.id, { failedBy: OWNER, reason: 'Changed my mind' });

  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'already_confirmed');
  db.close();
});

test('money the client sent in is not confirmed through the payout route', () => {
  const db = setup();
  const project = makeProject(db);
  const { payment } = receive(db, project, 4000, { key: 'r1' });

  const refused = paymentsRepo.confirmReceived(db, GUILD, payment.id, { confirmedBy: OWNER });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'not_a_payout');
  db.close();
});

test('payouts waiting on confirmation are listed, and drop off once settled', () => {
  const db = setup();
  const project = makeProject(db);
  const task = makeApprovedTask(db, project);
  const first = payOut(db, project, task, 1000, { key: 'pay-1' }).payment;
  const second = payOut(db, project, task, 1500, { key: 'pay-2' }).payment;

  assert.equal(paymentsRepo.unconfirmedPayouts(db, GUILD).length, 2);

  paymentsRepo.confirmReceived(db, GUILD, first.id, { confirmedBy: ARTIST });
  paymentsRepo.markFailed(db, GUILD, second.id, { failedBy: OWNER, reason: 'Never arrived' });

  assert.equal(
    paymentsRepo.unconfirmedPayouts(db, GUILD).length, 0,
    'a payment is settled either way once somebody has said what happened to it'
  );
  db.close();
});
