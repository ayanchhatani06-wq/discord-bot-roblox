const test = require('node:test');
const assert = require('node:assert/strict');

const { openDatabase } = require('../src/db');
const configRepo = require('../src/db/repos/config');
const projectsRepo = require('../src/db/repos/projects');
const tasksRepo = require('../src/db/repos/tasks');
const paymentsRepo = require('../src/db/repos/payments');
const allocationFlow = require('../src/services/allocationFlow');
const paymentState = require('../src/services/paymentState');
const { TASK_STATES } = require('../src/domain/taskState');

const GUILD = 'guild-1';
const OWNER = 'owner-1';
const LEADER = 'leader-1';
const ARTIST = 'artist-1';
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

function makeApprovedTask(db, project, { payMinor = 2500, payCurrency = 'USD', ...overrides } = {}) {
  const task = tasksRepo.createTask(db, GUILD, {
    projectId: project.id,
    title: 'Model',
    departmentId: configRepo.getDepartmentByKey(db, GUILD, 'modelling').id,
    leaderUserId: LEADER,
    ...overrides,
  }, OWNER);

  tasksRepo.approvePay(db, GUILD, task.id, { amountMinor: payMinor, currency: payCurrency, actorUserId: OWNER });
  tasksRepo.assignArtist(db, GUILD, task.id, ARTIST, OWNER);
  db.prepare("UPDATE tasks SET state = 'client_approved' WHERE id = ?").run(task.id);
  return tasksRepo.getTask(db, GUILD, task.id);
}

function receiveFromClient(db, project, amountMinor, currency = 'USD', key = 'r1') {
  return paymentsRepo.recordPayment(db, GUILD, {
    direction: 'client_receipt',
    projectId: project.id,
    amountMinor,
    currency,
    recordedBy: OWNER,
    idempotencyKey: key,
  });
}

test("the studio's split lands on the right people for the worked example", () => {
  const db = setup();
  const project = makeProject(db);
  const task = makeApprovedTask(db, project);

  const computed = allocationFlow.computeForTask(db, GUILD, task);
  assert.equal(computed.ok, true);
  assert.equal(computed.poolMinor, 1500, '$40 client minus $25 artist');

  const byKind = new Map(computed.byKind.map((entry) => [entry.kind, entry]));
  assert.equal(byKind.get('finder').userId, FINDER);
  assert.equal(byKind.get('finder').amountMinor, 300);
  assert.equal(byKind.get('leader').userId, LEADER, 'the leader share follows the department that did the work');
  assert.equal(byKind.get('leader').amountMinor, 300);
  assert.equal(byKind.get('mod').userId, MOD);
  assert.equal(byKind.get('mod').amountMinor, 150);
  assert.equal(byKind.get('owner').userId, OWNER);
  assert.equal(byKind.get('owner').amountMinor, 750);
  db.close();
});

test('with no finder or mod recorded, both shares fall to the owner', () => {
  const db = setup();
  const project = makeProject(db, { finderUserId: null, modUserId: null });
  const task = makeApprovedTask(db, project);

  const computed = allocationFlow.computeForTask(db, GUILD, task);
  const ownerLine = computed.lines.find((line) => line.userId === OWNER);

  assert.equal(ownerLine.amountMinor, 1200, '50% + 20% finder + 10% mod of a $15 pool');
  assert.deepEqual(computed.unassignedKinds.sort(), ['finder', 'mod']);
  assert.equal(computed.byKind.reduce((sum, e) => sum + e.amountMinor, 0), 1500);
  db.close();
});

test('the owner finding their own client stacks to 70%', () => {
  const db = setup();
  const project = makeProject(db, { finderUserId: OWNER });
  const task = makeApprovedTask(db, project);

  const computed = allocationFlow.computeForTask(db, GUILD, task);
  const ownerLine = computed.lines.find((line) => line.userId === OWNER);

  assert.equal(ownerLine.amountMinor, 1050);
  assert.equal(ownerLine.percentBp, 7000);
  db.close();
});

test('splits are stored and add up to the pool exactly', () => {
  const db = setup();
  const task = makeApprovedTask(db, makeProject(db));

  const stored = allocationFlow.persistForTask(db, GUILD, task, OWNER);
  assert.equal(stored.ok, true);

  const rows = allocationFlow.listAllocations(db, task.id);
  assert.equal(rows.length, 4);
  assert.equal(rows.reduce((sum, row) => sum + row.amount_minor, 0), 1500);
  assert.ok(rows.every((row) => row.currency === 'USD' && row.pool_minor === 1500));
  db.close();
});

test('mixed currencies refuse to produce a split until the owner enters the pool', () => {
  const db = setup();
  const project = makeProject(db, { clientAmountMinor: 4000, clientCurrency: 'USD' });
  // Client pays USD, artist is paid Robux: no rate exists to bridge them.
  const task = makeApprovedTask(db, project, { payMinor: 1500, payCurrency: 'ROBUX' });

  const refused = allocationFlow.computeForTask(db, GUILD, task);
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'currency_mismatch');
  assert.match(refused.detail, /no conversion rate/);

  // The owner states the distributable pool themselves.
  db.prepare('UPDATE tasks SET pool_override_minor = 1000, pool_override_currency = ? WHERE id = ?').run('USD', task.id);
  const computed = allocationFlow.computeForTask(db, GUILD, tasksRepo.getTask(db, GUILD, task.id));

  assert.equal(computed.ok, true);
  assert.equal(computed.poolMinor, 1000);
  assert.equal(computed.currency, 'USD');
  assert.equal(computed.poolSource, 'owner_override');
  assert.equal(computed.byKind.reduce((sum, e) => sum + e.amountMinor, 0), 1000);
  db.close();
});

test('a job sold below cost is reported rather than split', () => {
  const db = setup();
  const project = makeProject(db, { clientAmountMinor: 2000 });
  const task = makeApprovedTask(db, project, { payMinor: 2500 });

  const computed = allocationFlow.computeForTask(db, GUILD, task);
  assert.equal(computed.ok, false);
  assert.equal(computed.reason, 'negative_pool');
  assert.equal(computed.shortfallMinor, 500);
  db.close();
});

test('work is not payable until the client has actually paid', () => {
  const db = setup();
  const project = makeProject(db);
  const task = makeApprovedTask(db, project);

  // Client-approved, but no money in yet.
  let state = paymentState.recomputeTaskPaymentState(db, GUILD, task.id, OWNER);
  assert.equal(state.payment_state, 'pending_client_payment');

  receiveFromClient(db, project, 4000);
  const changed = paymentState.recomputeProjectPaymentStates(db, GUILD, project.id, OWNER);

  assert.equal(changed.length, 1);
  assert.equal(changed[0].payment_state, 'payable');
  db.close();
});

test('a part payment from the client does not make work payable', () => {
  const db = setup();
  const project = makeProject(db);
  const task = makeApprovedTask(db, project);

  receiveFromClient(db, project, 2000, 'USD', 'deposit');
  paymentState.recomputeProjectPaymentStates(db, GUILD, project.id, OWNER);

  assert.equal(tasksRepo.getTask(db, GUILD, task.id).payment_state, 'pending_client_payment');
  db.close();
});

test('the owner can override payability for a deposit situation, on the record', () => {
  const db = setup();
  const task = makeApprovedTask(db, makeProject(db));

  tasksRepo.overridePayable(db, GUILD, task.id, { actorUserId: OWNER, reason: 'Client pays on delivery' });
  const overridden = tasksRepo.getTask(db, GUILD, task.id);

  assert.equal(overridden.payment_state, 'payable');
  assert.equal(overridden.payable_override_reason, 'Client pays on delivery');
  // The override survives a recompute rather than being undone by it.
  assert.equal(paymentState.recomputeTaskPaymentState(db, GUILD, task.id, OWNER).payment_state, 'payable');
  db.close();
});

test('payments progress the task from payable to partly paid to paid', () => {
  const db = setup();
  const project = makeProject(db);
  const task = makeApprovedTask(db, project);
  receiveFromClient(db, project, 4000);
  paymentState.recomputeProjectPaymentStates(db, GUILD, project.id, OWNER);

  paymentsRepo.recordPayment(db, GUILD, {
    direction: 'payout', projectId: project.id, taskId: task.id, payeeUserId: ARTIST,
    amountMinor: 1000, currency: 'USD', recordedBy: OWNER, idempotencyKey: 'p1',
  });
  let updated = paymentState.recomputeTaskPaymentState(db, GUILD, task.id, OWNER);
  assert.equal(updated.payment_state, 'partially_paid');
  assert.equal(paymentState.owedToContributor(db, updated, ARTIST).remainingMinor, 1500);

  paymentsRepo.recordPayment(db, GUILD, {
    direction: 'payout', projectId: project.id, taskId: task.id, payeeUserId: ARTIST,
    amountMinor: 1500, currency: 'USD', recordedBy: OWNER, idempotencyKey: 'p2',
  });
  updated = paymentState.recomputeTaskPaymentState(db, GUILD, task.id, OWNER);
  assert.equal(updated.payment_state, 'paid');
  assert.equal(paymentState.owedToContributor(db, updated, ARTIST).remainingMinor, 0);
  db.close();
});

test('the same payment cannot be recorded twice', () => {
  const db = setup();
  const project = makeProject(db);
  const task = makeApprovedTask(db, project);

  const first = paymentsRepo.recordPayment(db, GUILD, {
    direction: 'payout', projectId: project.id, taskId: task.id, payeeUserId: ARTIST,
    amountMinor: 2500, currency: 'USD', recordedBy: OWNER, idempotencyKey: 'same-click',
  });
  const second = paymentsRepo.recordPayment(db, GUILD, {
    direction: 'payout', projectId: project.id, taskId: task.id, payeeUserId: ARTIST,
    amountMinor: 2500, currency: 'USD', recordedBy: OWNER, idempotencyKey: 'same-click',
  });

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.payment.id, first.payment.id);
  assert.equal(paymentState.owedToContributor(db, tasksRepo.getTask(db, GUILD, task.id), ARTIST).paidMinor, 2500, 'paid once, not twice');
  db.close();
});

test('a genuinely separate instalment is still allowed', () => {
  const db = setup();
  const project = makeProject(db);
  const task = makeApprovedTask(db, project);

  paymentsRepo.recordPayment(db, GUILD, {
    direction: 'payout', projectId: project.id, taskId: task.id, payeeUserId: ARTIST,
    amountMinor: 1000, currency: 'USD', recordedBy: OWNER, idempotencyKey: 'instalment-1',
  });
  paymentsRepo.recordPayment(db, GUILD, {
    direction: 'payout', projectId: project.id, taskId: task.id, payeeUserId: ARTIST,
    amountMinor: 1000, currency: 'USD', recordedBy: OWNER, idempotencyKey: 'instalment-2',
  });

  assert.equal(paymentState.owedToContributor(db, tasksRepo.getTask(db, GUILD, task.id), ARTIST).paidMinor, 2000);
  db.close();
});

test('share payouts do not count towards the artist balance', () => {
  const db = setup();
  const project = makeProject(db);
  const task = makeApprovedTask(db, project);
  allocationFlow.persistForTask(db, GUILD, task, OWNER);

  // Paying the leader's share must not look like paying the artist.
  paymentsRepo.recordPayment(db, GUILD, {
    direction: 'payout', projectId: project.id, taskId: task.id, payeeUserId: LEADER,
    allocationKind: 'leader', amountMinor: 300, currency: 'USD', recordedBy: OWNER, idempotencyKey: 's1',
  });

  const fresh = tasksRepo.getTask(db, GUILD, task.id);
  assert.equal(paymentState.owedToContributor(db, fresh, ARTIST).paidMinor, 0);
  assert.equal(paymentState.owedToContributor(db, fresh, ARTIST).remainingMinor, 2500);
  db.close();
});

test('a settled share is frozen so recalculation cannot move it', () => {
  const db = setup();
  const project = makeProject(db);
  const task = makeApprovedTask(db, project);
  allocationFlow.persistForTask(db, GUILD, task, OWNER);

  const leaderShare = allocationFlow.listAllocations(db, task.id).find((row) => row.recipient_kind === 'leader');
  paymentsRepo.recordPayment(db, GUILD, {
    direction: 'payout', projectId: project.id, taskId: task.id, payeeUserId: LEADER,
    allocationKind: 'leader', amountMinor: leaderShare.amount_minor, currency: 'USD',
    recordedBy: OWNER, idempotencyKey: 'leader-paid',
  });
  allocationFlow.freezeAllocation(db, task.id, 'leader');

  // The client later pays more, which would otherwise change every share.
  projectsRepo.updateProject(db, GUILD, project.id, { client_amount_minor: 8000 }, OWNER);
  const recomputed = allocationFlow.persistForTask(db, GUILD, tasksRepo.getTask(db, GUILD, task.id), OWNER);

  assert.deepEqual(recomputed.frozenKinds, ['leader']);
  const after = allocationFlow.listAllocations(db, task.id);
  assert.equal(after.find((row) => row.recipient_kind === 'leader').amount_minor, 300, 'the paid share is untouched');
  assert.equal(after.find((row) => row.recipient_kind === 'owner').amount_minor, 2750, 'unpaid shares follow the new pool');
  db.close();
});

test('client receipts and staff payouts are reported separately, per currency', () => {
  const db = setup();
  const project = makeProject(db);
  const task = makeApprovedTask(db, project);

  receiveFromClient(db, project, 4000, 'USD', 'in-usd');
  paymentsRepo.recordPayment(db, GUILD, {
    direction: 'payout', projectId: project.id, taskId: task.id, payeeUserId: ARTIST,
    amountMinor: 1500, currency: 'ROBUX', recordedBy: OWNER, idempotencyKey: 'out-robux',
  });

  const totals = paymentsRepo.totalsByDirection(db, GUILD);
  assert.equal(totals.received.get('USD'), 4000);
  assert.equal(totals.received.get('ROBUX'), undefined);
  assert.equal(totals.paidOut.get('ROBUX'), 1500);
  assert.equal(totals.paidOut.get('USD'), undefined);
  db.close();
});

test('a payment must be a positive whole number of minor units', () => {
  const db = setup();
  const project = makeProject(db);

  for (const bad of [0, -100, 12.5]) {
    assert.throws(() => paymentsRepo.recordPayment(db, GUILD, {
      direction: 'payout', projectId: project.id, amountMinor: bad, currency: 'USD',
      recordedBy: OWNER, idempotencyKey: `bad-${bad}`,
    }), /positive whole number/);
  }

  assert.throws(() => paymentsRepo.recordPayment(db, GUILD, {
    direction: 'refund', projectId: project.id, amountMinor: 100, currency: 'USD',
    recordedBy: OWNER, idempotencyKey: 'bad-direction',
  }), /Unknown payment direction/);
  db.close();
});

test('outstanding payouts list only client-approved work', () => {
  const db = setup();
  const project = makeProject(db);
  const approved = makeApprovedTask(db, project);
  receiveFromClient(db, project, 4000);
  paymentState.recomputeProjectPaymentStates(db, GUILD, project.id, OWNER);

  // Work still in progress is not a payout waiting to happen.
  const inProgress = tasksRepo.createTask(db, GUILD, {
    projectId: project.id, title: 'Other', departmentId: configRepo.getDepartmentByKey(db, GUILD, 'vfx').id,
  }, OWNER);
  tasksRepo.approvePay(db, GUILD, inProgress.id, { amountMinor: 1000, currency: 'USD', actorUserId: OWNER });

  const pending = paymentState.pendingPayouts(db, GUILD);
  assert.deepEqual(pending.payable.map((task) => task.id), [approved.id]);
  assert.equal(pending.awaitingClientMoney.length, 0);

  const computed = allocationFlow.persistForTask(db, GUILD, tasksRepo.getTask(db, GUILD, approved.id), OWNER);
  const shares = allocationFlow.outstandingAllocations(db, GUILD);

  // Only the approved task has shares to pay, and they add up to its own pool.
  // That pool is smaller than the whole project's margin because the second
  // task now claims part of the same client payment.
  assert.equal(shares.length, 4);
  assert.equal(shares.reduce((sum, row) => sum + row.outstanding_minor, 0), computed.poolMinor);
  assert.ok(computed.poolMinor < 1500, 'a sibling task takes a share of the client payment');
  db.close();
});

test('cancelled tasks do not dilute the pro-rata slices of live work', () => {
  const db = setup();
  const project = makeProject(db, { clientAmountMinor: 10000 });

  const live = makeApprovedTask(db, project, { payMinor: 2000 });
  const cancelled = makeApprovedTask(db, project, { payMinor: 2000 });
  db.prepare("UPDATE tasks SET state = 'cancelled' WHERE id = ?").run(cancelled.id);

  const computed = allocationFlow.computeForTask(db, GUILD, tasksRepo.getTask(db, GUILD, live.id));
  // The live task takes the whole client payment, not half of it.
  assert.equal(computed.poolMinor, 8000);
  db.close();
});

test('percentage changes apply to unpaid work without touching settled lines', () => {
  const db = setup();
  const project = makeProject(db);
  const task = makeApprovedTask(db, project);
  allocationFlow.persistForTask(db, GUILD, task, OWNER);

  configRepo.setAllocationPercentages(db, GUILD, { finder: 1000, leader: 4000, mod: 0, owner: 5000 }, OWNER);
  allocationFlow.persistForTask(db, GUILD, tasksRepo.getTask(db, GUILD, task.id), OWNER);

  const rows = new Map(allocationFlow.listAllocations(db, task.id).map((row) => [row.recipient_kind, row]));
  assert.equal(rows.get('leader').amount_minor, 600, '40% of $15');
  assert.equal(rows.get('finder').amount_minor, 150);
  assert.equal(rows.get('owner').amount_minor, 750);
  db.close();
});
