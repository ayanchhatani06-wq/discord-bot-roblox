const test = require('node:test');
const assert = require('node:assert/strict');

const { openDatabase } = require('../src/db');
const configRepo = require('../src/db/repos/config');
const staffRepo = require('../src/db/repos/staff');
const projectsRepo = require('../src/db/repos/projects');
const tasksRepo = require('../src/db/repos/tasks');
const paymentsRepo = require('../src/db/repos/payments');
const paymentState = require('../src/services/paymentState');
const recruiterFee = require('../src/services/recruiterFee');

const GUILD = 'guild-1';
const OWNER = 'owner-1';
const LEADER = 'leader-1';
const ARTIST = 'artist-1';
const RECRUITER = 'recruiter-1';

function setup() {
  const db = openDatabase({ file: ':memory:' });
  configRepo.ensureConfig(db, GUILD);
  configRepo.seedDefaultDepartments(db, GUILD, OWNER);
  configRepo.updateConfig(db, GUILD, { owner_user_id: OWNER }, OWNER);
  staffRepo.ensureStaff(db, GUILD, ARTIST, 'New Artist');
  staffRepo.ensureStaff(db, GUILD, RECRUITER, 'The Recruiter');
  return db;
}

function makeTask(db, { payMinor = 3500, currency = 'USD', finder = null } = {}) {
  const project = projectsRepo.createProject(db, GUILD, {
    name: 'Order', clientAmountMinor: 5000, clientCurrency: 'USD', finderUserId: finder,
  }, OWNER);
  const task = tasksRepo.createTask(db, GUILD, {
    projectId: project.id,
    title: 'Model',
    departmentId: configRepo.getDepartmentByKey(db, GUILD, 'modelling').id,
    leaderUserId: LEADER,
  }, OWNER);
  tasksRepo.approvePay(db, GUILD, task.id, { amountMinor: payMinor, currency, actorUserId: OWNER });
  tasksRepo.assignArtist(db, GUILD, task.id, ARTIST, OWNER);
  db.prepare("UPDATE tasks SET state = 'client_approved' WHERE id = ?").run(task.id);
  return { project, task: tasksRepo.getTask(db, GUILD, task.id) };
}

/** What the payout command does, without Discord in the way. */
function payOut(db, { project, task }, amountMinor, { key = 'p1' } = {}) {
  const config = configRepo.getConfig(db, GUILD);
  const fee = recruiterFee.feeFor(db, GUILD, {
    artistUserId: ARTIST, task, amountMinor, currency: 'USD', config,
  });
  const toArtist = fee.applies ? fee.artistReceivesMinor : amountMinor;

  paymentsRepo.recordPayment(db, GUILD, {
    direction: 'payout', projectId: project.id, taskId: task.id, payeeUserId: ARTIST,
    amountMinor: toArtist, currency: 'USD', recordedBy: OWNER, idempotencyKey: `payout:${key}`,
  });

  if (fee.applies) {
    paymentsRepo.recordPayment(db, GUILD, {
      direction: 'payout', projectId: project.id, taskId: task.id,
      payeeUserId: fee.recruiterUserId, amountMinor: fee.feeMinor, currency: 'USD',
      allocationKind: 'recruiter', deductedFromUserId: ARTIST,
      recordedBy: OWNER, idempotencyKey: `recruiter:${key}`,
    });
    recruiterFee.markTaken(db, GUILD, ARTIST, OWNER);
  }
  return fee;
}

test('no recruiter recorded means no fee', () => {
  const db = setup();
  const { task } = makeTask(db);
  const fee = recruiterFee.feeFor(db, GUILD, {
    artistUserId: ARTIST, task, amountMinor: 3500, currency: 'USD',
  });
  assert.equal(fee.applies, false);
  assert.equal(fee.reason, 'no_recruiter');
  db.close();
});

test('the fee is 20% of the payout, taken from it', () => {
  const db = setup();
  recruiterFee.setRecruiter(db, GUILD, { userId: ARTIST, recruiterUserId: RECRUITER, actorUserId: OWNER });
  const { task } = makeTask(db);

  const fee = recruiterFee.feeFor(db, GUILD, {
    artistUserId: ARTIST, task, amountMinor: 3500, currency: 'USD',
  });

  assert.equal(fee.applies, true);
  assert.equal(fee.feeMinor, 700, '20% of $35');
  assert.equal(fee.artistReceivesMinor, 2800, 'the artist receives the rest');
  assert.equal(fee.feeMinor + fee.artistReceivesMinor, 3500, 'nothing is created or lost');
  assert.equal(fee.recruiterUserId, RECRUITER);
  db.close();
});

test("the artist's pay is settled even though they received less", () => {
  const db = setup();
  recruiterFee.setRecruiter(db, GUILD, { userId: ARTIST, recruiterUserId: RECRUITER, actorUserId: OWNER });
  const made = makeTask(db, { payMinor: 3500 });

  payOut(db, made, 3500);

  // The whole point of deducted_from_user_id: without it the ledger sees $28
  // against $35 agreed and thinks the artist is still owed $7.
  const owed = paymentState.owedToContributor(db, tasksRepo.getTask(db, GUILD, made.task.id), ARTIST);
  assert.equal(owed.paidMinor, 3500, 'their pay is accounted for in full');
  assert.equal(owed.remainingMinor, 0, 'they are not owed the fee back');
  db.close();
});

test('the studio pays out exactly what was owed, not a penny more', () => {
  const db = setup();
  recruiterFee.setRecruiter(db, GUILD, { userId: ARTIST, recruiterUserId: RECRUITER, actorUserId: OWNER });
  const made = makeTask(db, { payMinor: 3500 });

  payOut(db, made, 3500);

  const out = paymentsRepo.listPaymentsForTask(db, made.task.id)
    .filter((row) => row.direction === 'payout')
    .reduce((sum, row) => sum + row.amount_minor, 0);
  assert.equal(out, 3500, 'the pool is untouched — the fee came out of the artist, not the studio');
  db.close();
});

test('it is taken once, not on every task', () => {
  const db = setup();
  recruiterFee.setRecruiter(db, GUILD, { userId: ARTIST, recruiterUserId: RECRUITER, actorUserId: OWNER });

  const first = makeTask(db, { payMinor: 3500 });
  const firstFee = payOut(db, first, 3500, { key: 'first' });
  assert.equal(firstFee.applies, true);

  const second = makeTask(db, { payMinor: 3500 });
  const secondFee = payOut(db, second, 3500, { key: 'second' });
  assert.equal(secondFee.applies, false);
  assert.equal(secondFee.reason, 'already_taken', 'their second task pays in full');
  db.close();
});

test("it does not stack on the finder's cut", () => {
  const db = setup();
  recruiterFee.setRecruiter(db, GUILD, { userId: ARTIST, recruiterUserId: RECRUITER, actorUserId: OWNER });

  // The recruiter also brought in this client, so they already take 20% of the
  // pool on this task. The studio's choice was that the finder's cut wins.
  const { task } = makeTask(db, { finder: RECRUITER });

  const fee = recruiterFee.feeFor(db, GUILD, {
    artistUserId: ARTIST, task, amountMinor: 3500, currency: 'USD',
  });
  assert.equal(fee.applies, false);
  assert.equal(fee.reason, 'is_finder');
  db.close();
});

test('a part payment takes the fee from what is actually paid', () => {
  const db = setup();
  recruiterFee.setRecruiter(db, GUILD, { userId: ARTIST, recruiterUserId: RECRUITER, actorUserId: OWNER });
  const { task } = makeTask(db, { payMinor: 3500 });

  const fee = recruiterFee.feeFor(db, GUILD, {
    artistUserId: ARTIST, task, amountMinor: 1000, currency: 'USD',
  });
  assert.equal(fee.feeMinor, 200, '20% of what is being paid now, not of the agreed total');
  assert.equal(fee.artistReceivesMinor, 800);
  db.close();
});

test('rounding never lets the fee exceed the payout', () => {
  const db = setup();
  recruiterFee.setRecruiter(db, GUILD, { userId: ARTIST, recruiterUserId: RECRUITER, actorUserId: OWNER });
  const { task } = makeTask(db);

  for (const amount of [1, 3, 7, 9, 11, 99, 101]) {
    const fee = recruiterFee.feeFor(db, GUILD, {
      artistUserId: ARTIST, task, amountMinor: amount, currency: 'USD',
    });
    if (!fee.applies) continue;
    assert.ok(fee.feeMinor < amount, `${amount}: fee ${fee.feeMinor} must be less than the payout`);
    assert.equal(fee.feeMinor + fee.artistReceivesMinor, amount);
  }
  db.close();
});

test('a tiny payout that rounds the fee to nothing takes nothing', () => {
  const db = setup();
  recruiterFee.setRecruiter(db, GUILD, { userId: ARTIST, recruiterUserId: RECRUITER, actorUserId: OWNER });
  const { task } = makeTask(db);

  const fee = recruiterFee.feeFor(db, GUILD, {
    artistUserId: ARTIST, task, amountMinor: 4, currency: 'USD',
  });
  assert.equal(fee.applies, false);
  assert.equal(fee.reason, 'rounds_to_nothing', 'and it is not marked taken, so it still applies later');
  db.close();
});

test('the percentage is configurable', () => {
  const db = setup();
  recruiterFee.setRecruiter(db, GUILD, { userId: ARTIST, recruiterUserId: RECRUITER, actorUserId: OWNER });
  const { task } = makeTask(db);

  const fee = recruiterFee.feeFor(db, GUILD, {
    artistUserId: ARTIST, task, amountMinor: 3500, currency: 'USD',
    config: { recruiter_fee_bp: 1000 },
  });
  assert.equal(fee.feeMinor, 350, '10%');
  db.close();
});

test('setting it to zero turns it off', () => {
  const db = setup();
  recruiterFee.setRecruiter(db, GUILD, { userId: ARTIST, recruiterUserId: RECRUITER, actorUserId: OWNER });
  const { task } = makeTask(db);

  const fee = recruiterFee.feeFor(db, GUILD, {
    artistUserId: ARTIST, task, amountMinor: 3500, currency: 'USD',
    config: { recruiter_fee_bp: 0 },
  });
  assert.equal(fee.applies, false);
  db.close();
});

test('nobody recruits themselves', () => {
  const db = setup();
  const result = recruiterFee.setRecruiter(db, GUILD, {
    userId: ARTIST, recruiterUserId: ARTIST, actorUserId: OWNER,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'self');
  db.close();
});

test('the recruiter cannot be changed once the fee has been taken', () => {
  const db = setup();
  staffRepo.ensureStaff(db, GUILD, 'someone-else', 'Someone Else');
  recruiterFee.setRecruiter(db, GUILD, { userId: ARTIST, recruiterUserId: RECRUITER, actorUserId: OWNER });
  const made = makeTask(db, { payMinor: 3500 });
  payOut(db, made, 3500);

  const moved = recruiterFee.setRecruiter(db, GUILD, {
    userId: ARTIST, recruiterUserId: 'someone-else', actorUserId: OWNER,
  });
  assert.equal(moved.ok, false);
  assert.equal(moved.reason, 'already_paid', 'otherwise it is paid to the wrong person, or twice');

  assert.equal(recruiterFee.clearRecruiter(db, GUILD, ARTIST, OWNER).ok, false);
  db.close();
});

test('the artist is told before they accept, in money rather than a percentage', () => {
  const db = setup();
  recruiterFee.setRecruiter(db, GUILD, { userId: ARTIST, recruiterUserId: RECRUITER, actorUserId: OWNER });
  const { task } = makeTask(db, { payMinor: 3500 });

  const text = recruiterFee.disclosureFor(db, GUILD, {
    artistUserId: ARTIST, amountMinor: 3500, currency: 'USD', task,
  });

  assert.ok(text.includes('$28.00'), 'says what they will actually receive');
  assert.ok(text.includes('$7.00'), 'and what is being taken');
  assert.ok(text.includes('20%'));
  assert.ok(/only time|after this one/i.test(text), 'and that it happens once');
  db.close();
});

test('somebody with no fee due is told nothing', () => {
  const db = setup();
  const { task } = makeTask(db);
  assert.equal(
    recruiterFee.disclosureFor(db, GUILD, { artistUserId: ARTIST, amountMinor: 3500, currency: 'USD', task }),
    null
  );
  db.close();
});
