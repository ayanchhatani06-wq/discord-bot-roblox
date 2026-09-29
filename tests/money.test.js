const test = require('node:test');
const assert = require('node:assert/strict');
const money = require('../src/domain/money');

test('parses USD amounts into cents', () => {
  assert.equal(money.parseAmount('25', 'USD'), 2500);
  assert.equal(money.parseAmount('25.5', 'USD'), 2550);
  assert.equal(money.parseAmount('25.50', 'USD'), 2550);
  assert.equal(money.parseAmount('$1,500.25', 'USD'), 150025);
  assert.equal(money.parseAmount('0', 'USD'), 0);
});

test('parses Robux as whole numbers only', () => {
  assert.equal(money.parseAmount('1500', 'ROBUX'), 1500);
  assert.equal(money.parseAmount('R$1,500', 'ROBUX'), 1500);
  assert.throws(() => money.parseAmount('1.5', 'ROBUX'), money.InvalidAmountError);
});

test('rejects malformed, negative and over-precise amounts', () => {
  assert.throws(() => money.parseAmount('25.555', 'USD'), money.InvalidAmountError);
  assert.throws(() => money.parseAmount('-25', 'USD'), money.InvalidAmountError);
  assert.throws(() => money.parseAmount('abc', 'USD'), money.InvalidAmountError);
  assert.throws(() => money.parseAmount('', 'USD'), money.InvalidAmountError);
  assert.throws(() => money.parseAmount(null, 'USD'), money.InvalidAmountError);
  assert.throws(() => money.parseAmount('25', 'EUR'), money.InvalidAmountError);
});

test('formats amounts with the right precision per currency', () => {
  assert.equal(money.formatAmount(2550, 'USD'), '$25.50');
  assert.equal(money.formatAmount(2500, 'USD'), '$25.00');
  assert.equal(money.formatAmount(150025, 'USD'), '$1,500.25');
  assert.equal(money.formatAmount(1500, 'ROBUX'), 'R$1,500');
  assert.equal(money.formatAmount(-2550, 'USD'), '-$25.50');
});

test('round-trips parse and format', () => {
  for (const input of ['0', '1', '25.50', '999.99', '1,000']) {
    const minor = money.parseAmount(input, 'USD');
    assert.equal(money.parseAmount(money.formatAmount(minor, 'USD'), 'USD'), minor);
  }
});

test('refuses to combine different currencies', () => {
  assert.equal(money.assertSameCurrency('USD', 'usd'), 'USD');
  assert.throws(() => money.assertSameCurrency('USD', 'ROBUX'), money.CurrencyMismatchError);
});

test('totals are kept per currency, never merged', () => {
  const totals = money.totalsByCurrency([
    { minor: 2500, currency: 'USD' },
    { minor: 1000, currency: 'USD' },
    { minor: 800, currency: 'ROBUX' },
  ]);

  assert.equal(totals.size, 2);
  assert.equal(totals.get('USD'), 3500);
  assert.equal(totals.get('ROBUX'), 800);
  assert.equal(money.formatTotals(totals), 'R$800 + $35.00');
  assert.equal(money.formatTotals(new Map()), 'none');
});

test('no conversion helper is exposed', () => {
  // A studio rule, enforced by absence: nothing in the codebase may turn Robux
  // into USD, because no agreed rate exists.
  const exported = Object.keys(money).join(' ').toLowerCase();
  assert.ok(!exported.includes('convert'));
  assert.ok(!exported.includes('exchange'));
  assert.ok(!exported.includes('devex'));
});
