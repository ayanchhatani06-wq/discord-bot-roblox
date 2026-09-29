const { PermissionError } = require('../domain/permissions');
const { TransitionError } = require('../domain/taskState');
const { InvalidAmountError, CurrencyMismatchError } = require('../domain/money');
const { AllocationConfigError } = require('../domain/allocations');
const { replyPrivate } = require('../utils/reply');

/**
 * Component custom ids are `namespace:action:arg1:arg2...`.
 * Handlers register per namespace and receive the split parts, so adding a
 * button never means touching the dispatch code.
 */
const handlers = new Map();

function register(namespace, handler) {
  if (handlers.has(namespace)) throw new Error(`Duplicate interaction namespace: ${namespace}`);
  handlers.set(namespace, handler);
}

function customId(namespace, action, ...args) {
  return [namespace, action, ...args].join(':');
}

function parse(id) {
  const [namespace, action, ...args] = String(id).split(':');
  return { namespace, action, args };
}

/**
 * Turns a thrown domain error into something the user can act on. Expected
 * failures (no permission, illegal transition, bad amount) explain themselves;
 * anything else is logged and reported as a generic failure.
 */
async function reportError(interaction, error, label) {
  const expected =
    error instanceof PermissionError ||
    error instanceof TransitionError ||
    error instanceof InvalidAmountError ||
    error instanceof CurrencyMismatchError ||
    error instanceof AllocationConfigError;

  if (expected) {
    await replyPrivate(interaction, `❌ ${error.message}`);
    return;
  }

  console.error(`Unhandled error in ${label}:`, error);
  await replyPrivate(interaction, '❌ Something went wrong. The error has been logged.');
}

async function route(interaction) {
  const { namespace, action, args } = parse(interaction.customId);
  const handler = handlers.get(namespace);

  if (!handler) {
    await replyPrivate(interaction, '❌ This control is no longer available. Run the command again.');
    return;
  }

  try {
    await handler(interaction, { namespace, action, args });
  } catch (error) {
    await reportError(interaction, error, `${namespace}:${action}`);
  }
}

function registeredNamespaces() {
  return [...handlers.keys()];
}

module.exports = { register, route, customId, parse, reportError, registeredNamespaces };
