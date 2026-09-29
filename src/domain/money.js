/**
 * Money is stored as integer minor units plus an explicit currency code.
 * There is deliberately no conversion function anywhere in this module:
 * the studio does not use DevEx or any other rate, so cross-currency
 * arithmetic is a programming error rather than something to approximate.
 */

const CURRENCIES = {
  USD: { code: 'USD', exponent: 2, symbol: '$', symbolFirst: true },
  ROBUX: { code: 'ROBUX', exponent: 0, symbol: 'R$', symbolFirst: true },
};

class CurrencyMismatchError extends Error {
  constructor(a, b) {
    super(`Refusing to combine ${a} with ${b}: no conversion rate is configured.`);
    this.name = 'CurrencyMismatchError';
    this.currencies = [a, b];
  }
}

class InvalidAmountError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidAmountError';
  }
}

function currencyInfo(code) {
  const info = CURRENCIES[String(code).toUpperCase()];
  if (!info) throw new InvalidAmountError(`Unknown currency: ${code}`);
  return info;
}

function isSupportedCurrency(code) {
  return Object.prototype.hasOwnProperty.call(CURRENCIES, String(code).toUpperCase());
}

/**
 * Parses user input ("25", "25.50", "$25.50", "1,500") into integer minor units.
 * Rejects negatives and more decimal places than the currency supports, so
 * "25.555" USD fails loudly instead of being silently rounded.
 */
function parseAmount(input, currencyCode) {
  const info = currencyInfo(currencyCode);
  if (input === null || input === undefined) throw new InvalidAmountError('Amount is required.');

  // Strip the Robux prefix before the generic symbol strip, otherwise "R$1,500"
  // loses its "$" first and leaves a stray "R".
  const cleaned = String(input).trim().replace(/^r\$/i, '').replace(/[$,\s]/g, '');
  if (cleaned === '') throw new InvalidAmountError('Amount is required.');
  if (!/^\d+(\.\d+)?$/.test(cleaned)) {
    throw new InvalidAmountError(`"${input}" is not a valid amount. Use digits only, e.g. 25 or 25.50.`);
  }

  const [whole, fraction = ''] = cleaned.split('.');
  if (fraction.length > info.exponent) {
    throw new InvalidAmountError(
      info.exponent === 0
        ? `${info.code} amounts must be whole numbers (no decimals).`
        : `${info.code} amounts support at most ${info.exponent} decimal place(s).`
    );
  }

  const padded = fraction.padEnd(info.exponent, '0');
  const minor = Number(whole) * 10 ** info.exponent + (padded === '' ? 0 : Number(padded));
  if (!Number.isSafeInteger(minor)) throw new InvalidAmountError('Amount is too large.');
  return minor;
}

function formatAmount(minor, currencyCode) {
  const info = currencyInfo(currencyCode);
  if (!Number.isInteger(minor)) throw new InvalidAmountError('Minor units must be an integer.');

  const negative = minor < 0;
  const abs = Math.abs(minor);
  const divisor = 10 ** info.exponent;
  const whole = Math.floor(abs / divisor);
  const fraction = abs % divisor;
  const wholeText = whole.toLocaleString('en-US');
  const body = info.exponent === 0
    ? wholeText
    : `${wholeText}.${String(fraction).padStart(info.exponent, '0')}`;

  return `${negative ? '-' : ''}${info.symbol}${body}`;
}

function assertSameCurrency(a, b) {
  const left = String(a).toUpperCase();
  const right = String(b).toUpperCase();
  if (left !== right) throw new CurrencyMismatchError(left, right);
  return left;
}

/**
 * Groups amounts by currency and returns a Map of currency -> minor units.
 * Returning a map rather than a single number is intentional: a studio ledger
 * holding both USD and Robux has no meaningful single total.
 */
function totalsByCurrency(amounts) {
  const totals = new Map();
  for (const { minor, currency } of amounts) {
    const code = currencyInfo(currency).code;
    if (!Number.isInteger(minor)) throw new InvalidAmountError('Minor units must be an integer.');
    totals.set(code, (totals.get(code) || 0) + minor);
  }
  return totals;
}

function formatTotals(totals) {
  if (totals.size === 0) return 'none';
  return [...totals.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, minor]) => formatAmount(minor, currency))
    .join(' + ');
}

module.exports = {
  CURRENCIES,
  CurrencyMismatchError,
  InvalidAmountError,
  currencyInfo,
  isSupportedCurrency,
  parseAmount,
  formatAmount,
  assertSameCurrency,
  totalsByCurrency,
  formatTotals,
};
