const configRepo = require('../db/repos/config');
const tasksRepo = require('../db/repos/tasks');
const { recordAudit } = require('../db/repos/core');
const reports = require('./reports');
const { notifyUser } = require('./notify');

/**
 * Owner-configurable automation.
 *
 * A rule is a choice between things the bot already knows how to do safely,
 * never a script. Both the condition and the action come from closed lists in
 * this file, so no rule can be made to move money, change pay, approve work,
 * offer a task, or send a client anything that was not already approved. The
 * worst a rule can do is tell somebody about a task or put a flag on one.
 *
 * Every rule can also be previewed: run against the last N days without acting,
 * so the owner sees what it *would* have done before it is allowed to do it.
 */

const TRIGGERS = Object.freeze({
  OVERDUE: 'overdue',
  DUE_SOON: 'due_soon',
  UNASSIGNED_TOO_LONG: 'unassigned_too_long',
  NO_PROGRESS: 'no_progress',
  AWAITING_CLIENT_TOO_LONG: 'awaiting_client_too_long',
  APPROVED_UNPAID: 'approved_unpaid',
  BLOCKED: 'blocked',
});

const TRIGGER_LABELS = Object.freeze({
  overdue: 'A task is past its deadline',
  due_soon: 'A task is due within three days',
  unassigned_too_long: 'A task has had nobody on it for N days',
  no_progress: 'A task has had no progress update for N days',
  awaiting_client_too_long: 'A task has been with the client for N days',
  approved_unpaid: 'Approved work still owes somebody money',
  blocked: 'A task is blocked and nobody has cleared it',
});

/** Triggers where the threshold is meaningful. The rest ignore it. */
const THRESHOLD_TRIGGERS = Object.freeze([
  TRIGGERS.UNASSIGNED_TOO_LONG,
  TRIGGERS.NO_PROGRESS,
  TRIGGERS.AWAITING_CLIENT_TOO_LONG,
]);

const ACTIONS = Object.freeze({
  TELL_OWNER: 'tell_owner',
  TELL_LEADER: 'tell_leader',
  TELL_PERSON: 'tell_person',
  FLAG_FOR_REVIEW: 'flag_for_review',
});

const ACTION_LABELS = Object.freeze({
  tell_owner: 'Send you a private message',
  tell_leader: "Send the task's group leader a private message",
  tell_person: 'Send one named person a private message',
  flag_for_review: 'Flag the task for a decision (it appears on /manage flags)',
});

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

const DAY_MS = reports.DAY_MS;

/**
 * Which tasks a rule currently applies to.
 *
 * Reuses the same filters the reports use, so a rule cannot quietly mean
 * something different from what `/report` shows for the same words.
 */
function matches(db, guildId, rule, { now = Date.now() } = {}) {
  const scope = { departmentId: rule.department_id ?? null, now };
  const days = rule.threshold ?? 3;

  switch (rule.trigger_key) {
    case TRIGGERS.OVERDUE:
      return reports.filterTasks(db, guildId, reports.FILTERS.OVERDUE, scope);

    case TRIGGERS.DUE_SOON:
      return reports.filterTasks(db, guildId, reports.FILTERS.DUE_SOON, scope);

    case TRIGGERS.BLOCKED:
      return reports.filterTasks(db, guildId, reports.FILTERS.BLOCKED, scope);

    case TRIGGERS.APPROVED_UNPAID:
      return reports.filterTasks(db, guildId, reports.FILTERS.UNPAID, scope);

    case TRIGGERS.NO_PROGRESS:
      return reports.filterTasks(db, guildId, reports.FILTERS.NO_PROGRESS, { ...scope, staleDays: days });

    case TRIGGERS.UNASSIGNED_TOO_LONG:
      return reports.filterTasks(db, guildId, reports.FILTERS.UNASSIGNED, scope)
        .filter((task) => task.created_at < now - days * DAY_MS);

    case TRIGGERS.AWAITING_CLIENT_TOO_LONG:
      return reports.filterTasks(db, guildId, reports.FILTERS.AWAITING_CLIENT, scope)
        .filter((task) => task.updated_at < now - days * DAY_MS);

    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

function upsertRule(db, guildId, { key, label, triggerKey, threshold = null, departmentId = null, actionKey, targetUserId = null, note = null }, actorUserId) {
  if (!Object.values(TRIGGERS).includes(triggerKey)) return { ok: false, reason: 'unknown_trigger' };
  if (!Object.values(ACTIONS).includes(actionKey)) return { ok: false, reason: 'unknown_action' };
  if (actionKey === ACTIONS.TELL_PERSON && !targetUserId) return { ok: false, reason: 'no_target' };

  const now = Date.now();
  const existing = getRule(db, guildId, key);

  // A changed rule is a different rule, so it goes back to disabled and has to
  // be previewed and switched on again deliberately.
  db.prepare(`
    INSERT INTO automation_rules (guild_id, key, label, trigger_key, threshold, department_id, action_key, target_user_id, note, created_by, created_at, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (guild_id, key) DO UPDATE SET
      label = excluded.label, trigger_key = excluded.trigger_key, threshold = excluded.threshold,
      department_id = excluded.department_id, action_key = excluded.action_key,
      target_user_id = excluded.target_user_id, note = excluded.note,
      enabled = 0, updated_by = excluded.updated_by, updated_at = excluded.updated_at
  `).run(guildId, key, label, triggerKey, threshold, departmentId, actionKey, targetUserId, note, actorUserId, now, actorUserId, now);

  const rule = getRule(db, guildId, key);
  recordAudit(db, {
    guildId, actorUserId, action: existing ? 'automation.update' : 'automation.create',
    entityType: 'automation_rule', entityId: rule.id,
    after: { key, trigger: triggerKey, action: actionKey, threshold },
    detail: 'Disabled until it is switched on. Preview it first.',
  });
  return { ok: true, rule, wasExisting: Boolean(existing) };
}

function getRule(db, guildId, key) {
  return db.prepare('SELECT * FROM automation_rules WHERE guild_id = ? AND key = ?').get(guildId, key) || null;
}

function listRules(db, guildId, { enabledOnly = false } = {}) {
  const sql = enabledOnly
    ? 'SELECT * FROM automation_rules WHERE guild_id = ? AND enabled = 1 ORDER BY label'
    : 'SELECT * FROM automation_rules WHERE guild_id = ? ORDER BY label';
  return db.prepare(sql).all(guildId);
}

function setRuleEnabled(db, guildId, key, enabled, actorUserId) {
  const result = db.prepare('UPDATE automation_rules SET enabled = ?, updated_by = ?, updated_at = ? WHERE guild_id = ? AND key = ?')
    .run(enabled ? 1 : 0, actorUserId, Date.now(), guildId, key);
  if (result.changes === 0) return null;

  recordAudit(db, {
    guildId, actorUserId, action: enabled ? 'automation.enable' : 'automation.disable',
    entityType: 'automation_rule', entityId: key,
  });
  return getRule(db, guildId, key);
}

function deleteRule(db, guildId, key, actorUserId) {
  const rule = getRule(db, guildId, key);
  if (!rule) return null;
  db.prepare('DELETE FROM automation_rules WHERE id = ?').run(rule.id);
  recordAudit(db, { guildId, actorUserId, action: 'automation.delete', entityType: 'automation_rule', entityId: key });
  return rule;
}

/**
 * What this rule would do right now, without doing any of it.
 *
 * Also says which of those it has already acted on, so the owner can see the
 * difference between "this rule is about to shout about 40 tasks" and "it has
 * already handled 38 of them and would mention two".
 */
function preview(db, guildId, rule, { now = Date.now(), limit = 25 } = {}) {
  const matched = matches(db, guildId, rule, { now });
  const already = new Set(
    db.prepare('SELECT entity_id FROM automation_events WHERE rule_id = ?').all(rule.id).map((row) => row.entity_id)
  );

  const fresh = matched.filter((task) => !already.has(String(task.id)));
  return {
    rule,
    matched: matched.length,
    alreadyActed: matched.length - fresh.length,
    wouldAct: fresh.length,
    sample: fresh.slice(0, limit),
    recipient: describeRecipient(rule),
  };
}

function describeRecipient(rule) {
  switch (rule.action_key) {
    case ACTIONS.TELL_OWNER: return 'you';
    case ACTIONS.TELL_LEADER: return "each task's group leader";
    case ACTIONS.TELL_PERSON: return `<@${rule.target_user_id}>`;
    case ACTIONS.FLAG_FOR_REVIEW: return 'nobody — it flags the task instead';
    default: return 'nobody';
  }
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

function recipientFor(db, guildId, rule, task) {
  switch (rule.action_key) {
    case ACTIONS.TELL_OWNER: return configRepo.getConfig(db, guildId)?.owner_user_id || null;
    case ACTIONS.TELL_LEADER: return task.leader_user_id || null;
    case ACTIONS.TELL_PERSON: return rule.target_user_id || null;
    default: return null;
  }
}

function messageFor(rule, task) {
  return (
    `🔔 **${rule.label}**\n` +
    `**${task.code} · ${task.title}** — ${TRIGGER_LABELS[rule.trigger_key] || rule.trigger_key}.\n` +
    `${rule.note ? `> ${rule.note}\n` : ''}` +
    '_Sent by one of your automation rules. Turn it off with `/automation off`._'
  );
}

/**
 * Runs one rule. Each task is acted on once per rule, ever — the unique dedupe
 * key is what stops a daily rule becoming a daily nag about the same task.
 */
async function runRule(discordClient, db, guildId, rule, { now = Date.now(), dryRun = false } = {}) {
  const result = { rule: rule.key, acted: 0, skipped: 0, failed: 0 };

  for (const task of matches(db, guildId, rule, { now })) {
    const dedupeKey = `${rule.id}:task:${task.id}`;

    let claimed = false;
    if (!dryRun) {
      try {
        db.prepare(`
          INSERT INTO automation_events (guild_id, rule_id, entity_type, entity_id, dedupe_key, detail, created_at)
          VALUES (?, ?, 'task', ?, ?, ?, ?)
        `).run(guildId, rule.id, String(task.id), dedupeKey, rule.action_key, now);
        claimed = true;
      } catch (error) {
        if (!String(error.message).includes('UNIQUE')) throw error;
      }
    }

    if (!claimed) {
      result.skipped += 1;
      continue;
    }

    if (rule.action_key === ACTIONS.FLAG_FOR_REVIEW) {
      tasksRepo.setFlag(db, guildId, task.id, 'scope', true, null, `Automation rule: ${rule.label}`);
      result.acted += 1;
      continue;
    }

    const recipient = recipientFor(db, guildId, rule, task);
    if (!recipient) {
      result.failed += 1;
      continue;
    }

    const sent = await notifyUser(discordClient, db, guildId, recipient, { content: messageFor(rule, task) })
      .catch(() => ({ delivered: false }));

    if (sent?.delivered === false) result.failed += 1;
    else result.acted += 1;
  }

  if (!dryRun) {
    db.prepare('UPDATE automation_rules SET last_run_at = ? WHERE id = ?').run(now, rule.id);
  }
  return result;
}

async function runAll(discordClient, db, guildId, { now = Date.now() } = {}) {
  const results = [];
  for (const rule of listRules(db, guildId, { enabledOnly: true })) {
    results.push(await runRule(discordClient, db, guildId, rule, { now }));
  }
  return results;
}

module.exports = {
  TRIGGERS,
  TRIGGER_LABELS,
  THRESHOLD_TRIGGERS,
  ACTIONS,
  ACTION_LABELS,
  matches,
  upsertRule,
  getRule,
  listRules,
  setRuleEnabled,
  deleteRule,
  preview,
  describeRecipient,
  recipientFor,
  messageFor,
  runRule,
  runAll,
};
