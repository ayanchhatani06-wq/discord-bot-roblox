const test = require('node:test');
const assert = require('node:assert/strict');

const { openDatabase } = require('../src/db');
const configRepo = require('../src/db/repos/config');
const projectsRepo = require('../src/db/repos/projects');
const tasksRepo = require('../src/db/repos/tasks');
const paymentsRepo = require('../src/db/repos/payments');
const contributorsRepo = require('../src/db/repos/contributors');
const allocationFlow = require('../src/services/allocationFlow');
const paymentState = require('../src/services/paymentState');
const budget = require('../src/services/budget');
const bonusFlow = require('../src/services/bonusFlow');

const GUILD = 'guild-1';
const OWNER = 'owner-1';
const LEADER = 'leader-1';
const ARTIST = 'artist-1';
const HELPER = 'helper-1';
const FINDER = 'finder-1';
const MOD = 'mod-1';

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
    clientAmountMinor: 4000,
    clientCurrency: 'USD',
    finderUserId: FINDER,
    modUserId: MOD,
    ...overrides,
  }, OWNER);
}

function makeTask(db, project, { payMinor = 2500, payCurrency = 'USD', approve = true, ...overrides } = {}) {
  const task = tasksRepo.createTask(db, GUILD, {
    projectId: project.id,
    title: 'Model',
    departmentId: configRepo.getDepartmentByKey(db, GUILD, 'modelling').id,
    leaderUserId: LEADER,
    ...overrides,
  }, OWNER);

  if (payMinor !== null) {
    tasksRepo.approvePay(db, GUILD, task.id, { amountMinor: payMinor, currency: payCurrency, actorUserId: OWNER });
  }
  tasksRepo.assignArtist(db, GUILD, task.id, ARTIST, OWNER);
  if (approve) db.prepare("UPDATE tasks SET state = 'client_approved' WHERE id = ?").run(task.id);
  return tasksRepo.getTask(db, GUILD, task.id);
}

// ---------------------------------------------------------------------------
// Converting a single-artist task to shared work
// ---------------------------------------------------------------------------

test('adding a second person preserves the first one on their original terms', () => {
  const db = setup();
  const task = makeTask(db, makeProject(db));

  const result = contributorsRepo.addContributor(db, GUILD, task, {
    userId: HELPER, responsibility: 'Rigging', actorUserId: OWNER,
  });
  assert.equal(result.ok, true);

  const rows = contributorsRepo.listForTask(db, task.id);
  assert.equal(rows.length, 2, 'the original artist became a contributor row');

  const primary = rows.find((row) => row.user_id === ARTIST);
  assert.equal(primary.is_primary, 1);
  assert.equal(primary.pay_minor, 2500, 'their agreed figure was carried over unchanged');
  assert.equal(primary.pay_currency, 'USD');
  assert.equal(primary.pay_state, contributorsRepo.PAY_STATES.APPROVED);
});

test('converting a task does not double count the original artist in its cost', () => {
  const db = setup();
  const task = makeTask(db, makeProject(db));

  const before = contributorsRepo.costByCurrency(db, task);
  assert.equal(before.get('USD'), 2500);

  contributorsRepo.addContributor(db, GUILD, task, {
    userId: HELPER, responsibility: 'Rigging', actorUserId: OWNER,
  });

  // The helper has no agreed pay yet, so the cost must not have moved.
  const after = contributorsRepo.costByCurrency(db, tasksRepo.getTask(db, GUILD, task.id));
  assert.equal(after.get('USD'), 2500, 'adding somebody without pay changes nothing');

  contributorsRepo.approvePay(db, GUILD, task.id, HELPER, {
    amountMinor: 500, currency: 'USD', actorUserId: OWNER,
  });
  assert.equal(contributorsRepo.costByCurrency(db, task).get('USD'), 3000);
});

test('each contributor sees only their own terms', () => {
  const db = setup();
  const task = makeTask(db, makeProject(db));
  contributorsRepo.addContributor(db, GUILD, task, { userId: HELPER, responsibility: 'Rigging', actorUserId: OWNER });
  contributorsRepo.approvePay(db, GUILD, task.id, HELPER, { amountMinor: 500, currency: 'USD', actorUserId: OWNER });

  const artist = paymentState.owedToContributor(db, task, ARTIST);
  const helper = paymentState.owedToContributor(db, task, HELPER);

  assert.equal(artist.agreedMinor, 2500);
  assert.equal(helper.agreedMinor, 500);
  assert.equal(paymentState.owedToContributor(db, task, 'stranger-1'), null);
});

// ---------------------------------------------------------------------------
// Payment state across several people
// ---------------------------------------------------------------------------

test('a task is only paid once every contributor is settled', () => {
  const db = setup();
  const project = makeProject(db);
  const task = makeTask(db, project);
  contributorsRepo.addContributor(db, GUILD, task, { userId: HELPER, responsibility: 'Rigging', actorUserId: OWNER });
  contributorsRepo.approvePay(db, GUILD, task.id, HELPER, { amountMinor: 500, currency: 'USD', actorUserId: OWNER });

  paymentsRepo.recordPayment(db, GUILD, {
    direction: 'client_receipt', projectId: project.id, amountMinor: 4000, currency: 'USD',
    recordedBy: OWNER, idempotencyKey: 'receipt-1',
  });
  paymentState.recomputeProjectPaymentStates(db, GUILD, project.id, OWNER);

  paymentsRepo.recordPayment(db, GUILD, {
    direction: 'payout', projectId: project.id, taskId: task.id, payeeUserId: ARTIST,
    amountMinor: 2500, currency: 'USD', recordedBy: OWNER, idempotencyKey: 'pay-artist',
  });
  let updated = paymentState.recomputeTaskPaymentState(db, GUILD, task.id, OWNER);
  assert.equal(updated.payment_state, tasksRepo.PAYMENT_STATES.PARTIALLY_PAID,
    'the main artist is settled but the helper is not');

  paymentsRepo.recordPayment(db, GUILD, {
    direction: 'payout', projectId: project.id, taskId: task.id, payeeUserId: HELPER,
    amountMinor: 500, currency: 'USD', recordedBy: OWNER, idempotencyKey: 'pay-helper',
  });
  updated = paymentState.recomputeTaskPaymentState(db, GUILD, task.id, OWNER);
  assert.equal(updated.payment_state, tasksRepo.PAYMENT_STATES.PAID);
});

test('a payout to one person does not count towards another', () => {
  const db = setup();
  const task = makeTask(db, makeProject(db));
  contributorsRepo.addContributor(db, GUILD, task, { userId: HELPER, responsibility: 'Rigging', actorUserId: OWNER });
  contributorsRepo.approvePay(db, GUILD, task.id, HELPER, { amountMinor: 500, currency: 'USD', actorUserId: OWNER });

  paymentsRepo.recordPayment(db, GUILD, {
    direction: 'payout', taskId: task.id, payeeUserId: HELPER, amountMinor: 500, currency: 'USD',
    recordedBy: OWNER, idempotencyKey: 'pay-helper',
  });

  assert.equal(paymentState.owedToContributor(db, task, HELPER).remainingMinor, 0);
  assert.equal(paymentState.owedToContributor(db, task, ARTIST).remainingMinor, 2500);
});

test('a removed contributor keeps the payments already made to them', () => {
  const db = setup();
  const task = makeTask(db, makeProject(db));
  contributorsRepo.addContributor(db, GUILD, task, { userId: HELPER, responsibility: 'Rigging', actorUserId: OWNER });
  contributorsRepo.approvePay(db, GUILD, task.id, HELPER, { amountMinor: 500, currency: 'USD', actorUserId: OWNER });
  paymentsRepo.recordPayment(db, GUILD, {
    direction: 'payout', taskId: task.id, payeeUserId: HELPER, amountMinor: 500, currency: 'USD',
    recordedBy: OWNER, idempotencyKey: 'pay-helper',
  });

  const removal = contributorsRepo.removeContributor(db, GUILD, task.id, HELPER, OWNER);
  assert.equal(removal.ok, true);

  const paid = paymentsRepo.payoutTotalsForPayee(db, GUILD, HELPER);
  assert.equal(paid.get('USD'), 500, 'the payment record survives the removal');
  assert.equal(contributorsRepo.costByCurrency(db, task).get('USD'), 2500,
    'they no longer count towards the task cost');
});

test('the main artist cannot be removed as a contributor', () => {
  const db = setup();
  const task = makeTask(db, makeProject(db));
  contributorsRepo.addContributor(db, GUILD, task, { userId: HELPER, responsibility: 'Rigging', actorUserId: OWNER });

  const result = contributorsRepo.removeContributor(db, GUILD, task.id, ARTIST, OWNER);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'primary_contributor');
});

// ---------------------------------------------------------------------------
// The split pool
// ---------------------------------------------------------------------------

test('the split pool is the client slice minus what everyone on the task costs', () => {
  const db = setup();
  const project = makeProject(db);
  const task = makeTask(db, project);

  assert.equal(allocationFlow.computePool(db, GUILD, task).poolMinor, 1500);

  contributorsRepo.addContributor(db, GUILD, task, { userId: HELPER, responsibility: 'Rigging', actorUserId: OWNER });
  contributorsRepo.approvePay(db, GUILD, task.id, HELPER, { amountMinor: 500, currency: 'USD', actorUserId: OWNER });

  const pool = allocationFlow.computePool(db, GUILD, tasksRepo.getTask(db, GUILD, task.id));
  assert.equal(pool.ok, true);
  assert.equal(pool.poolMinor, 1000, '$40 client minus $25 artist minus $5 helper');
});

test('contributors paid in different currencies leave the pool uncomputed rather than guessed', () => {
  const db = setup();
  const project = makeProject(db);
  const task = makeTask(db, project);
  contributorsRepo.addContributor(db, GUILD, task, { userId: HELPER, responsibility: 'Rigging', actorUserId: OWNER });
  contributorsRepo.approvePay(db, GUILD, task.id, HELPER, { amountMinor: 400, currency: 'ROBUX', actorUserId: OWNER });

  const pool = allocationFlow.computePool(db, GUILD, tasksRepo.getTask(db, GUILD, task.id));
  assert.equal(pool.ok, false);
  assert.equal(pool.reason, 'currency_mismatch');
});

// ---------------------------------------------------------------------------
// Budget guard
// ---------------------------------------------------------------------------

test('pay that would exceed the client payment is refused, not merely flagged', () => {
  const db = setup();
  const project = makeProject(db, { clientAmountMinor: 3000, clientCurrency: 'USD' });
  const task = makeTask(db, project, { payMinor: 2500 });

  contributorsRepo.addContributor(db, GUILD, task, { userId: HELPER, responsibility: 'Rigging', actorUserId: OWNER });

  const check = budget.checkBudget(db, GUILD, tasksRepo.getTask(db, GUILD, task.id), {
    amountMinor: 1000, currency: 'USD', userId: HELPER,
  });
  assert.equal(check.ok, false);
  assert.equal(check.reason, 'over_budget');
  assert.equal(check.committed, 2500);
  assert.equal(check.excessMinor, 500);
});

test('the owner can allow over-budget pay deliberately, and take the allowance back', () => {
  const db = setup();
  const project = makeProject(db, { clientAmountMinor: 3000, clientCurrency: 'USD' });
  const task = makeTask(db, project, { payMinor: 2500 });

  budget.setBudgetOverride(db, GUILD, project.id, { actorUserId: OWNER, reason: 'Rush job, taking the loss' });
  const allowed = budget.checkBudget(db, GUILD, task, { amountMinor: 1000, currency: 'USD', userId: HELPER });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.reason, 'override_in_place');

  budget.clearBudgetOverride(db, GUILD, project.id, OWNER);
  const refused = budget.checkBudget(db, GUILD, task, { amountMinor: 1000, currency: 'USD', userId: HELPER });
  assert.equal(refused.ok, false);
});

test('pay in a currency the client did not use is not measured against the budget', () => {
  const db = setup();
  const project = makeProject(db, { clientAmountMinor: 3000, clientCurrency: 'USD' });
  const task = makeTask(db, project, { payMinor: 2500 });

  const check = budget.checkBudget(db, GUILD, task, { amountMinor: 900000, currency: 'ROBUX', userId: HELPER });
  assert.equal(check.ok, true);
  assert.equal(check.reason, 'different_currency', 'no conversion rate exists, so it is said plainly');
  assert.equal(check.budgetCurrency, 'USD');
});

test('re-pricing the same person does not count their old figure twice', () => {
  const db = setup();
  const project = makeProject(db, { clientAmountMinor: 3000, clientCurrency: 'USD' });
  const task = makeTask(db, project, { payMinor: 2500 });

  // Raising the sole artist from $25 to $29 is inside a $30 budget, even
  // though $25 + $29 would not be.
  const check = budget.checkBudget(db, GUILD, task, { amountMinor: 2900, currency: 'USD', userId: ARTIST });
  assert.equal(check.ok, true, 'the figure being replaced is excluded from the committed total');
  assert.equal(check.committed, 0);
});

test('cancelled work does not hold budget', () => {
  const db = setup();
  const project = makeProject(db, { clientAmountMinor: 3000, clientCurrency: 'USD' });
  const task = makeTask(db, project, { payMinor: 2500 });

  assert.equal(budget.committedByCurrency(db, GUILD, project.id).get('USD'), 2500);
  db.prepare("UPDATE tasks SET state = 'cancelled' WHERE id = ?").run(task.id);
  assert.equal(budget.committedByCurrency(db, GUILD, project.id).get('USD'), undefined);
});

// ---------------------------------------------------------------------------
// Bonus milestones
// ---------------------------------------------------------------------------

function makeBonusRule(db, overrides = {}) {
  return bonusFlow.upsertRule(db, GUILD, {
    key: 'models-2',
    label: 'Every 2 approved models',
    threshold: 2,
    amountMinor: 500,
    currency: 'USD',
    ...overrides,
  }, OWNER);
}

test('a milestone is earned once and cannot be earned twice by re-evaluating', () => {
  const db = setup();
  const project = makeProject(db);
  makeBonusRule(db);

  makeTask(db, project, { payMinor: 100 });
  assert.equal(bonusFlow.evaluateForUser(db, GUILD, ARTIST).length, 0, 'one approved task is not two');

  makeTask(db, project, { payMinor: 100 });
  const first = bonusFlow.evaluateForUser(db, GUILD, ARTIST);
  assert.equal(first.length, 1);
  assert.equal(first[0].award.milestone_index, 1);

  // Re-running the same evaluation must not create a second award.
  assert.equal(bonusFlow.evaluateForUser(db, GUILD, ARTIST).length, 0);
  assert.equal(bonusFlow.listAwards(db, GUILD, { status: 'all', userId: ARTIST }).length, 1);
});

test('a bonus is never owed until the owner approves it', () => {
  const db = setup();
  const project = makeProject(db);
  makeBonusRule(db);
  makeTask(db, project, { payMinor: 100 });
  makeTask(db, project, { payMinor: 100 });

  const [earned] = bonusFlow.evaluateForUser(db, GUILD, ARTIST);
  assert.equal(earned.award.status, 'pending');

  const approved = bonusFlow.decideAward(db, GUILD, earned.award.id, { approve: true, actorUserId: OWNER });
  assert.equal(approved.status, 'approved');

  // A second decision on the same award does nothing.
  assert.equal(bonusFlow.decideAward(db, GUILD, earned.award.id, { approve: false, actorUserId: OWNER, reason: 'no' }), null);
});

test('only client-approved work counts towards a bonus', () => {
  const db = setup();
  const project = makeProject(db);
  const rule = makeBonusRule(db);

  makeTask(db, project, { payMinor: 100 });
  makeTask(db, project, { payMinor: 100, approve: false });

  assert.equal(bonusFlow.qualifyingCount(db, GUILD, rule, ARTIST), 1);
});

test('a contributor earns towards a bonus, and a shared task counts once', () => {
  const db = setup();
  const project = makeProject(db);
  const rule = makeBonusRule(db);
  const task = makeTask(db, project, { payMinor: 100 });

  contributorsRepo.addContributor(db, GUILD, task, { userId: HELPER, responsibility: 'Rigging', actorUserId: OWNER });

  assert.equal(bonusFlow.qualifyingCount(db, GUILD, rule, HELPER), 1, 'helping counts');
  assert.equal(bonusFlow.qualifyingCount(db, GUILD, rule, ARTIST), 1,
    'the artist is both the task artist and a contributor row, but that is one task');
});

test('a department rule only counts work in that department', () => {
  const db = setup();
  const project = makeProject(db);
  const modelling = configRepo.getDepartmentByKey(db, GUILD, 'modelling');
  const rule = makeBonusRule(db, { key: 'vfx-2', departmentId: configRepo.getDepartmentByKey(db, GUILD, 'vfx').id });

  makeTask(db, project, { payMinor: 100, departmentId: modelling.id });
  makeTask(db, project, { payMinor: 100, departmentId: modelling.id });

  assert.equal(bonusFlow.qualifyingCount(db, GUILD, rule, ARTIST), 0);
  assert.equal(bonusFlow.evaluateForUser(db, GUILD, ARTIST).length, 0);
});

test('turning a rule off stops it earning but keeps what was already awarded', () => {
  const db = setup();
  const project = makeProject(db);
  makeBonusRule(db);
  makeTask(db, project, { payMinor: 100 });
  makeTask(db, project, { payMinor: 100 });
  bonusFlow.evaluateForUser(db, GUILD, ARTIST);

  bonusFlow.setRuleActive(db, GUILD, 'models-2', false, OWNER);
  makeTask(db, project, { payMinor: 100 });
  makeTask(db, project, { payMinor: 100 });

  assert.equal(bonusFlow.evaluateForUser(db, GUILD, ARTIST).length, 0);
  assert.equal(bonusFlow.listAwards(db, GUILD, { status: 'all', userId: ARTIST }).length, 1);
});

test('a task that owes nobody anything is not reported as paid', () => {
  const db = setup();
  const project = makeProject(db);
  const task = makeTask(db, project, { payMinor: 0 });

  // Nothing was ever due, so it follows the ordinary payable/pending rules
  // rather than claiming money changed hands.
  assert.notEqual(
    paymentState.computePaymentState(db, GUILD, task),
    tasksRepo.PAYMENT_STATES.PAID
  );
});

test('a removed contributor is no longer owed anything on the task', () => {
  const db = setup();
  const task = makeTask(db, makeProject(db));
  contributorsRepo.addContributor(db, GUILD, task, { userId: HELPER, responsibility: 'Rigging', actorUserId: OWNER });
  contributorsRepo.approvePay(db, GUILD, task.id, HELPER, { amountMinor: 500, currency: 'USD', actorUserId: OWNER });

  assert.equal(paymentState.owedOnTask(db, task).length, 2);
  contributorsRepo.removeContributor(db, GUILD, task.id, HELPER, OWNER);

  const owed = paymentState.owedOnTask(db, task);
  assert.equal(owed.length, 1);
  assert.equal(owed[0].userId, ARTIST);
});

test('a task with several people is settled only when the last of them is, whatever the order', () => {
  const db = setup();
  const task = makeTask(db, makeProject(db));
  contributorsRepo.addContributor(db, GUILD, task, { userId: HELPER, responsibility: 'Rigging', actorUserId: OWNER });
  contributorsRepo.approvePay(db, GUILD, task.id, HELPER, { amountMinor: 500, currency: 'USD', actorUserId: OWNER });

  // The helper is paid first this time.
  paymentsRepo.recordPayment(db, GUILD, {
    direction: 'payout', taskId: task.id, payeeUserId: HELPER, amountMinor: 500, currency: 'USD',
    recordedBy: OWNER, idempotencyKey: 'p1',
  });
  assert.equal(paymentState.settlementOf(db, task).allSettled, false);
  assert.equal(paymentState.settlementOf(db, task).outstanding, 2500);

  paymentsRepo.recordPayment(db, GUILD, {
    direction: 'payout', taskId: task.id, payeeUserId: ARTIST, amountMinor: 2500, currency: 'USD',
    recordedBy: OWNER, idempotencyKey: 'p2',
  });
  assert.equal(paymentState.settlementOf(db, task).allSettled, true);
});
