const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_PERCENTAGES_BP,
  AllocationConfigError,
  validatePercentages,
  computeTaskClientSlices,
  computeTaskPool,
  allocatePool,
} = require('../src/domain/allocations');

const OWNER = 'owner-1';
const FINDER = 'finder-1';
const LEADER = 'leader-1';
const MOD = 'mod-1';

function lineFor(result, userId) {
  return result.lines.find((line) => line.userId === userId);
}

test('percentages must total 100%', () => {
  assert.doesNotThrow(() => validatePercentages(DEFAULT_PERCENTAGES_BP));
  assert.throws(() => validatePercentages({ finder: 2000, leader: 2000, mod: 1000, owner: 4000 }), AllocationConfigError);
  assert.throws(() => validatePercentages({ finder: -100, leader: 2100, mod: 1000, owner: 5000 }), AllocationConfigError);
  assert.throws(
    () => validatePercentages({ finder: 2000, leader: 2000, mod: 1000, owner: 5000, intern: 0 }),
    AllocationConfigError
  );
});

test("the studio's worked example: $40 client, $25 artist, $15 pool", () => {
  const pool = computeTaskPool({
    sliceMinor: 4000,
    sliceCurrency: 'USD',
    artistPayMinor: 2500,
    artistPayCurrency: 'USD',
  });
  assert.equal(pool.ok, true);
  assert.equal(pool.poolMinor, 1500);

  const result = allocatePool({
    poolMinor: pool.poolMinor,
    currency: 'USD',
    recipients: { finder: FINDER, leader: LEADER, mod: MOD, owner: OWNER },
  });

  assert.equal(lineFor(result, FINDER).amountMinor, 300);
  assert.equal(lineFor(result, LEADER).amountMinor, 300);
  assert.equal(lineFor(result, MOD).amountMinor, 150);
  assert.equal(lineFor(result, OWNER).amountMinor, 750);
  assert.equal(result.lines.reduce((s, l) => s + l.amountMinor, 0), 1500);
});

test('owner who found the client receives 70% as a single collapsed line', () => {
  const result = allocatePool({
    poolMinor: 1500,
    currency: 'USD',
    recipients: { finder: OWNER, leader: LEADER, mod: MOD, owner: OWNER },
  });

  const ownerLine = lineFor(result, OWNER);
  assert.equal(ownerLine.amountMinor, 1050);
  assert.equal(ownerLine.percentBp, 7000);
  assert.deepEqual(ownerLine.kinds.sort(), ['finder', 'owner']);
  assert.equal(result.lines.length, 3);
});

test('unnamed mod share falls to the owner', () => {
  const result = allocatePool({
    poolMinor: 1500,
    currency: 'USD',
    recipients: { finder: FINDER, leader: LEADER, mod: null, owner: OWNER },
  });

  assert.equal(lineFor(result, OWNER).amountMinor, 900);
  assert.equal(lineFor(result, OWNER).percentBp, 6000);
  assert.equal(lineFor(result, MOD), undefined);
  assert.deepEqual(result.unassignedKinds, ['mod']);
  assert.equal(result.lines.reduce((s, l) => s + l.amountMinor, 0), 1500);
});

test('every share falling to the owner still allocates the whole pool', () => {
  const result = allocatePool({
    poolMinor: 777,
    currency: 'USD',
    recipients: { finder: null, leader: null, mod: null, owner: OWNER },
  });
  assert.equal(result.lines.length, 1);
  assert.equal(lineFor(result, OWNER).amountMinor, 777);
  assert.equal(lineFor(result, OWNER).percentBp, 10000);
});

test('splits always sum to the pool exactly, at every size', () => {
  for (let poolMinor = 0; poolMinor <= 500; poolMinor += 1) {
    const result = allocatePool({
      poolMinor,
      currency: 'USD',
      recipients: { finder: FINDER, leader: LEADER, mod: MOD, owner: OWNER },
    });
    const total = result.byKind.reduce((sum, entry) => sum + entry.amountMinor, 0);
    assert.equal(total, poolMinor, `pool ${poolMinor} did not allocate exactly`);
    assert.ok(result.byKind.every((entry) => entry.amountMinor >= 0));
  }
});

test('odd pools distribute the remainder without losing or inventing units', () => {
  const result = allocatePool({
    poolMinor: 1,
    currency: 'USD',
    recipients: { finder: FINDER, leader: LEADER, mod: MOD, owner: OWNER },
  });
  assert.equal(result.byKind.reduce((s, e) => s + e.amountMinor, 0), 1);
  assert.equal(lineFor(result, OWNER).amountMinor, 1, 'largest share takes the odd unit');
});

test('a job sold below cost is reported, not silently negative', () => {
  const pool = computeTaskPool({
    sliceMinor: 2000,
    sliceCurrency: 'USD',
    artistPayMinor: 2500,
    artistPayCurrency: 'USD',
  });
  assert.equal(pool.ok, false);
  assert.equal(pool.reason, 'negative_pool');
  assert.equal(pool.shortfallMinor, 500);
});

test('mixed currencies refuse to produce a pool instead of guessing a rate', () => {
  const pool = computeTaskPool({
    sliceMinor: 4000,
    sliceCurrency: 'USD',
    artistPayMinor: 1500,
    artistPayCurrency: 'ROBUX',
  });
  assert.equal(pool.ok, false);
  assert.equal(pool.reason, 'currency_mismatch');
});

test('missing pay or client amount blocks allocation', () => {
  assert.equal(computeTaskPool({ sliceMinor: null, sliceCurrency: 'USD', artistPayMinor: 100, artistPayCurrency: 'USD' }).reason, 'no_client_amount');
  assert.equal(computeTaskPool({ sliceMinor: 100, sliceCurrency: 'USD', artistPayMinor: null, artistPayCurrency: 'USD' }).reason, 'no_artist_pay');
});

test('allocatePool rejects a bad pool or a missing owner', () => {
  assert.throws(() => allocatePool({ poolMinor: -1, currency: 'USD', recipients: { owner: OWNER } }), AllocationConfigError);
  assert.throws(() => allocatePool({ poolMinor: 100, currency: 'USD', recipients: { owner: null } }), AllocationConfigError);
});

test('bulk order: 12 models + 4 VFX + 2 animations, one client payment', () => {
  const tasks = [
    ...Array.from({ length: 12 }, (_, i) => ({ id: `m${i}`, dept: 'modelling', artistPayMinor: 2000, artistPayCurrency: 'USD' })),
    ...Array.from({ length: 4 }, (_, i) => ({ id: `v${i}`, dept: 'vfx', artistPayMinor: 1500, artistPayCurrency: 'USD' })),
    ...Array.from({ length: 2 }, (_, i) => ({ id: `a${i}`, dept: 'animation', artistPayMinor: 2500, artistPayCurrency: 'USD' })),
  ];

  const slices = computeTaskClientSlices({
    clientAmountMinor: 40000,
    clientCurrency: 'USD',
    tasks,
  });

  const sliceTotal = [...slices.values()].reduce((sum, s) => sum + s.sliceMinor, 0);
  assert.equal(sliceTotal, 40000, 'slices must add up to exactly the client payment');

  const leaders = { modelling: 'lead-model', vfx: 'lead-vfx', animation: 'lead-anim' };
  const perLeader = new Map();
  let poolTotal = 0;
  let allocatedTotal = 0;

  for (const task of tasks) {
    const slice = slices.get(task.id);
    const pool = computeTaskPool({
      sliceMinor: slice.sliceMinor,
      sliceCurrency: slice.currency,
      artistPayMinor: task.artistPayMinor,
      artistPayCurrency: task.artistPayCurrency,
    });
    assert.equal(pool.ok, true);
    poolTotal += pool.poolMinor;

    const result = allocatePool({
      poolMinor: pool.poolMinor,
      currency: 'USD',
      recipients: { finder: FINDER, leader: leaders[task.dept], mod: MOD, owner: OWNER },
    });

    // Each task's own pool is allocated to the last minor unit.
    const taskTotal = result.byKind.reduce((s, e) => s + e.amountMinor, 0);
    assert.equal(taskTotal, pool.poolMinor);
    allocatedTotal += taskTotal;

    const leaderEntry = result.byKind.find((e) => e.kind === 'leader');
    assert.equal(leaderEntry.userId, leaders[task.dept], 'leader share follows the department that did the work');
    perLeader.set(leaders[task.dept], (perLeader.get(leaders[task.dept]) || 0) + leaderEntry.amountMinor);
  }

  // Pool is the whole client payment less all artist pay: $400 - $350 = $50,
  // and every unit of it is assigned to somebody.
  assert.equal(poolTotal, 5000);
  assert.equal(allocatedTotal, 5000);

  // Only the three involved leaders are paid, each solely from their own tasks.
  assert.deepEqual([...perLeader.keys()].sort(), ['lead-anim', 'lead-model', 'lead-vfx']);
  assert.equal(perLeader.get('lead-model'), 684);
  assert.equal(perLeader.get('lead-vfx'), 172);
  assert.equal(perLeader.get('lead-anim'), 142);

  // Rounding happens per task, so the aggregate leader share lands within a
  // minor unit per task of the headline 20% rather than exactly on it. Nothing
  // is lost -- the difference sits with the other recipients.
  const leaderTotal = [...perLeader.values()].reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(leaderTotal - 1000) <= tasks.length, `leader total ${leaderTotal} drifted too far from 20%`);
});

test('explicitly priced tasks are honoured and the rest share what is left', () => {
  const slices = computeTaskClientSlices({
    clientAmountMinor: 10000,
    clientCurrency: 'USD',
    tasks: [
      { id: 'special', artistPayMinor: 1000, artistPayCurrency: 'USD', clientPriceMinor: 6000, clientPriceCurrency: 'USD' },
      { id: 'a', artistPayMinor: 1000, artistPayCurrency: 'USD' },
      { id: 'b', artistPayMinor: 1000, artistPayCurrency: 'USD' },
    ],
  });

  assert.equal(slices.get('special').sliceMinor, 6000);
  assert.equal(slices.get('special').source, 'explicit');
  assert.equal(slices.get('a').sliceMinor, 2000);
  assert.equal(slices.get('b').sliceMinor, 2000);
  assert.equal([...slices.values()].reduce((s, x) => s + x.sliceMinor, 0), 10000);
});

test('slice derivation flags the cases it cannot compute', () => {
  const noAmount = computeTaskClientSlices({ clientAmountMinor: null, clientCurrency: null, tasks: [{ id: 't' }] });
  assert.equal(noAmount.get('t').reason, 'no_client_amount');

  const mixed = computeTaskClientSlices({
    clientAmountMinor: 4000,
    clientCurrency: 'USD',
    tasks: [{ id: 't', artistPayMinor: 500, artistPayCurrency: 'ROBUX' }],
  });
  assert.equal(mixed.get('t').reason, 'currency_mismatch');

  const overpriced = computeTaskClientSlices({
    clientAmountMinor: 1000,
    clientCurrency: 'USD',
    tasks: [
      { id: 'big', artistPayMinor: 100, artistPayCurrency: 'USD', clientPriceMinor: 5000 },
      { id: 'rest', artistPayMinor: 100, artistPayCurrency: 'USD' },
    ],
  });
  assert.equal(overpriced.get('rest').reason, 'explicit_prices_exceed_client_amount');
});

test('an even split is used when no artist pay is set to weight by', () => {
  const slices = computeTaskClientSlices({
    clientAmountMinor: 900,
    clientCurrency: 'USD',
    tasks: [
      { id: 'a', artistPayMinor: 0, artistPayCurrency: 'USD' },
      { id: 'b', artistPayMinor: 0, artistPayCurrency: 'USD' },
      { id: 'c', artistPayMinor: 0, artistPayCurrency: 'USD' },
    ],
  });
  assert.equal(slices.get('a').sliceMinor, 300);
  assert.equal(slices.get('b').sliceMinor, 300);
  assert.equal(slices.get('c').sliceMinor, 300);
});

test('configurable percentages replace the defaults', () => {
  const result = allocatePool({
    poolMinor: 1000,
    currency: 'USD',
    percentagesBp: { finder: 1000, leader: 3000, mod: 0, owner: 6000 },
    recipients: { finder: FINDER, leader: LEADER, mod: MOD, owner: OWNER },
  });

  assert.equal(lineFor(result, FINDER).amountMinor, 100);
  assert.equal(lineFor(result, LEADER).amountMinor, 300);
  assert.equal(lineFor(result, OWNER).amountMinor, 600);
  assert.equal(lineFor(result, MOD), undefined, 'a 0% share produces no payable line');
});
