const { assertSameCurrency, currencyInfo } = require('./money');

/**
 * Allocation percentages are stored in basis points (10000 = 100%) so the
 * owner can configure them without introducing floating point drift.
 * Defaults come from the studio's agreed split of the leftover pool:
 * client finder 20%, the department leader who did the work 20%,
 * mod 10%, owner 50%.
 */
const DEFAULT_PERCENTAGES_BP = Object.freeze({
  finder: 2000,
  leader: 2000,
  mod: 1000,
  owner: 5000,
});

const RECIPIENT_KINDS = Object.freeze(['finder', 'leader', 'mod', 'owner']);

class AllocationConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AllocationConfigError';
  }
}

function validatePercentages(percentages) {
  let total = 0;
  for (const kind of RECIPIENT_KINDS) {
    const bp = percentages[kind];
    if (!Number.isInteger(bp) || bp < 0) {
      throw new AllocationConfigError(`Percentage for "${kind}" must be a non-negative whole number of basis points.`);
    }
    total += bp;
  }
  const extra = Object.keys(percentages).filter((k) => !RECIPIENT_KINDS.includes(k));
  if (extra.length > 0) {
    throw new AllocationConfigError(`Unknown allocation recipient(s): ${extra.join(', ')}`);
  }
  if (total !== 10000) {
    throw new AllocationConfigError(`Allocation percentages must total 100% (got ${total / 100}%).`);
  }
  return percentages;
}

/**
 * Distributes `totalMinor` across weighted buckets so the parts always sum to
 * exactly `totalMinor` (largest remainder method). Ties break on the caller's
 * bucket order, which keeps results deterministic and therefore testable.
 */
function distributeByWeight(totalMinor, buckets) {
  const totalWeight = buckets.reduce((sum, b) => sum + b.weight, 0);
  if (totalWeight <= 0) return buckets.map((b) => ({ ...b, amountMinor: 0 }));

  const provisional = buckets.map((bucket, index) => {
    const exact = (totalMinor * bucket.weight) / totalWeight;
    const floor = Math.floor(exact);
    return { ...bucket, index, amountMinor: floor, remainder: exact - floor };
  });

  let assigned = provisional.reduce((sum, b) => sum + b.amountMinor, 0);
  let leftover = totalMinor - assigned;

  const order = [...provisional].sort((a, b) => {
    if (b.remainder !== a.remainder) return b.remainder - a.remainder;
    return a.index - b.index;
  });

  let cursor = 0;
  while (leftover > 0 && order.length > 0) {
    order[cursor % order.length].amountMinor += 1;
    leftover -= 1;
    cursor += 1;
  }

  return provisional
    .sort((a, b) => a.index - b.index)
    .map(({ remainder, index, ...rest }) => rest);
}

/**
 * Works out each task's slice of the project's client payment.
 *
 * Tasks may carry an explicit client price; whatever client money is left over
 * is shared between the remaining tasks in proportion to their artist pay, so
 * the owner does not have to price all 18 tasks of a bulk order by hand.
 *
 * A task whose artist pay is in a different currency from the client payment
 * gets no derived slice at all: the studio does not use conversion rates, so
 * the owner must enter that pool explicitly instead.
 */
function computeTaskClientSlices({ clientAmountMinor, clientCurrency, tasks }) {
  const results = new Map();
  if (clientAmountMinor === null || clientAmountMinor === undefined || !clientCurrency) {
    for (const task of tasks) {
      results.set(task.id, { ok: false, reason: 'no_client_amount' });
    }
    return results;
  }

  const currency = currencyInfo(clientCurrency).code;
  const explicit = [];
  const derived = [];

  for (const task of tasks) {
    if (task.clientPriceMinor !== null && task.clientPriceMinor !== undefined) {
      if (currencyInfo(task.clientPriceCurrency || currency).code !== currency) {
        results.set(task.id, { ok: false, reason: 'currency_mismatch' });
        continue;
      }
      explicit.push(task);
      results.set(task.id, { ok: true, sliceMinor: task.clientPriceMinor, currency, source: 'explicit' });
      continue;
    }

    if (task.artistPayMinor === null || task.artistPayMinor === undefined) {
      results.set(task.id, { ok: false, reason: 'no_artist_pay' });
      continue;
    }
    if (currencyInfo(task.artistPayCurrency || currency).code !== currency) {
      results.set(task.id, { ok: false, reason: 'currency_mismatch' });
      continue;
    }
    derived.push(task);
  }

  const explicitTotal = explicit.reduce((sum, t) => sum + t.clientPriceMinor, 0);
  const remaining = clientAmountMinor - explicitTotal;

  if (derived.length > 0) {
    if (remaining < 0) {
      for (const task of derived) {
        results.set(task.id, { ok: false, reason: 'explicit_prices_exceed_client_amount' });
      }
    } else {
      const totalArtistPay = derived.reduce((sum, t) => sum + t.artistPayMinor, 0);
      const buckets = derived.map((task) => ({
        id: task.id,
        // With no artist pay anywhere to weight by, fall back to an even split.
        weight: totalArtistPay > 0 ? task.artistPayMinor : 1,
      }));
      for (const bucket of distributeByWeight(remaining, buckets)) {
        results.set(bucket.id, { ok: true, sliceMinor: bucket.amountMinor, currency, source: 'prorata' });
      }
    }
  }

  return results;
}

/**
 * pool = the task's slice of the client payment minus the artist's agreed pay.
 * The artist's pay is never reduced by allocations, so a pool below zero means
 * the job was sold for less than it costs to produce and needs owner attention.
 */
function computeTaskPool({ sliceMinor, sliceCurrency, artistPayMinor, artistPayCurrency }) {
  if (sliceMinor === null || sliceMinor === undefined) {
    return { ok: false, reason: 'no_client_amount' };
  }
  if (artistPayMinor === null || artistPayMinor === undefined) {
    return { ok: false, reason: 'no_artist_pay' };
  }
  if (currencyInfo(sliceCurrency).code !== currencyInfo(artistPayCurrency).code) {
    return { ok: false, reason: 'currency_mismatch', currencies: [sliceCurrency, artistPayCurrency] };
  }

  const currency = assertSameCurrency(sliceCurrency, artistPayCurrency);
  const poolMinor = sliceMinor - artistPayMinor;
  if (poolMinor < 0) {
    return { ok: false, reason: 'negative_pool', shortfallMinor: Math.abs(poolMinor), currency };
  }
  return { ok: true, poolMinor, currency };
}

/**
 * Splits a pool between finder, department leader, mod and owner.
 *
 * A share with nobody to pay it to falls to the owner as the residual claimant
 * (their choice: no mod recorded means that 10% stays with them), so every pool
 * is fully allocated and nothing silently vanishes.
 */
function allocatePool({ poolMinor, currency, percentagesBp = DEFAULT_PERCENTAGES_BP, recipients }) {
  validatePercentages(percentagesBp);
  if (!Number.isInteger(poolMinor) || poolMinor < 0) {
    throw new AllocationConfigError('Pool must be a non-negative whole number of minor units.');
  }
  if (!recipients || !recipients.owner) {
    throw new AllocationConfigError('An owner recipient is required to absorb unassigned shares.');
  }

  const code = currencyInfo(currency).code;
  const effective = new Map(RECIPIENT_KINDS.map((kind) => [kind, percentagesBp[kind]]));
  const unassigned = [];

  for (const kind of ['finder', 'leader', 'mod']) {
    if (!recipients[kind]) {
      unassigned.push(kind);
      effective.set('owner', effective.get('owner') + effective.get(kind));
      effective.set(kind, 0);
    }
  }

  const active = RECIPIENT_KINDS
    .filter((kind) => effective.get(kind) > 0)
    .map((kind) => ({ kind, userId: recipients[kind], weight: effective.get(kind) }));

  const byKind = distributeByWeight(poolMinor, active).map((bucket) => ({
    kind: bucket.kind,
    userId: bucket.userId,
    percentBp: effective.get(bucket.kind),
    amountMinor: bucket.amountMinor,
    currency: code,
  }));

  // One person can hold several shares at once (owner who also found the
  // client, or a leader who did). Collapse them so the ledger shows one
  // payable line per person while still recording what it is made of.
  const perUser = new Map();
  for (const entry of byKind) {
    const existing = perUser.get(entry.userId);
    if (existing) {
      existing.amountMinor += entry.amountMinor;
      existing.percentBp += entry.percentBp;
      existing.kinds.push(entry.kind);
    } else {
      perUser.set(entry.userId, {
        userId: entry.userId,
        amountMinor: entry.amountMinor,
        percentBp: entry.percentBp,
        currency: code,
        kinds: [entry.kind],
      });
    }
  }

  const lines = [...perUser.values()];
  const allocated = lines.reduce((sum, line) => sum + line.amountMinor, 0);
  if (allocated !== poolMinor) {
    throw new AllocationConfigError(`Allocation rounding error: ${allocated} allocated from a pool of ${poolMinor}.`);
  }

  return { ok: true, poolMinor, currency: code, byKind, lines, unassignedKinds: unassigned };
}

module.exports = {
  DEFAULT_PERCENTAGES_BP,
  RECIPIENT_KINDS,
  AllocationConfigError,
  validatePercentages,
  distributeByWeight,
  computeTaskClientSlices,
  computeTaskPool,
  allocatePool,
};
