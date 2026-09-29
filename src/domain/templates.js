/**
 * Message templates: a closed set of placeholders, filled from records.
 *
 * There is no free text generation anywhere in this file and no model behind
 * it. A template can only say things the studio wrote, with values the studio
 * recorded, which is the only way a message to a client cannot invent
 * something. A placeholder with no value refuses to render rather than sending
 * a sentence with a hole in it.
 */

const PLACEHOLDERS = Object.freeze({
  client_name: 'The client\'s name as recorded',
  project_name: 'The project name',
  project_code: 'The project code, e.g. PRJ-0007',
  studio_name: 'Your studio name from configuration',
  item_count: 'How many items are on the order',
  items_done: 'How many items the client has approved',
  items_awaiting_you: 'How many items are waiting on the client',
  deadline: 'The project deadline as a Discord timestamp, or "not set"',
  delivered_on: 'When the order was delivered, as a Discord timestamp',
  channel_link: 'A link back to the client\'s own channel',
  contact_name: 'Who at the studio is looking after them',
  last_order_name: 'The name of their previous order',
  service_list: 'The departments that worked on the order',
});

const PLACEHOLDER_NAMES = Object.freeze(Object.keys(PLACEHOLDERS));

const PATTERN = /\{\{\s*([a-z_]+)\s*\}\}/g;

class TemplateError extends Error {
  constructor(message, { unknown = [], missing = [] } = {}) {
    super(message);
    this.name = 'TemplateError';
    this.unknown = unknown;
    this.missing = missing;
  }
}

/** Every placeholder a body uses, in order of first appearance, deduplicated. */
function placeholdersIn(body) {
  const found = [];
  for (const match of String(body ?? '').matchAll(PATTERN)) {
    if (!found.includes(match[1])) found.push(match[1]);
  }
  return found;
}

/**
 * Placeholders the studio has invented. Checked when a template is written, so
 * a typo is caught by the person writing it rather than by a client reading
 * "Hello {{clinet_name}}".
 */
function unknownPlaceholders(body) {
  return placeholdersIn(body).filter((name) => !PLACEHOLDER_NAMES.includes(name));
}

/**
 * Fills a template. Refuses rather than guessing: if the record needed for a
 * placeholder is not there, the message does not go out at all.
 */
function render(body, values = {}) {
  const unknown = unknownPlaceholders(body);
  if (unknown.length > 0) {
    return { ok: false, reason: 'unknown_placeholder', unknown };
  }

  const missing = placeholdersIn(body).filter((name) => {
    const value = values[name];
    return value === null || value === undefined || value === '';
  });

  if (missing.length > 0) {
    return { ok: false, reason: 'missing_value', missing };
  }

  return {
    ok: true,
    text: String(body).replace(PATTERN, (_, name) => String(values[name])),
  };
}

/**
 * A preview for whoever is writing the template, using obviously fake values.
 *
 * The values are deliberately not plausible-looking: a preview that reads like
 * a real client is a preview somebody will mistake for one.
 */
const SAMPLE_VALUES = Object.freeze({
  client_name: '[client name]',
  project_name: '[project name]',
  project_code: 'PRJ-0000',
  studio_name: '[studio name]',
  item_count: '12',
  items_done: '4',
  items_awaiting_you: '2',
  deadline: '[deadline]',
  delivered_on: '[delivery date]',
  channel_link: '[their channel]',
  contact_name: '[contact]',
  last_order_name: '[previous order]',
  service_list: 'Modelling, VFX',
});

function preview(body) {
  return render(body, SAMPLE_VALUES);
}

module.exports = {
  PLACEHOLDERS,
  PLACEHOLDER_NAMES,
  SAMPLE_VALUES,
  TemplateError,
  placeholdersIn,
  unknownPlaceholders,
  render,
  preview,
};
