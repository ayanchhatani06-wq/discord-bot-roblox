const messagingRepo = require('../db/repos/messaging');
const clientsRepo = require('../db/repos/clients');
const configRepo = require('../db/repos/config');
const projectsRepo = require('../db/repos/projects');
const tasksRepo = require('../db/repos/tasks');
const clientReport = require('./clientReport');
const { render } = require('../domain/templates');
const { discordTimestamp } = require('../utils/time');
const { TASK_STATES } = require('../domain/taskState');

/**
 * Automated messages to clients, and the rules that keep them tolerable.
 *
 * Every guard here answers a way this feature could embarrass the studio:
 * sending unapproved wording, sending twice, spamming a bulk order item by
 * item, chasing somebody who has just complained, talking over a client who
 * asked a question, or marketing at somebody who never opted in. The guards are
 * checked when a message is queued *and* again when it is about to go out,
 * because the situation can change in between — a client can complain after the
 * chase was scheduled but before it was due.
 */

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_DIGEST_MINUTES = 60;
const DEFAULT_MAX_PROMOTIONAL_PER_WEEK = 1;

const BLOCKED = Object.freeze({
  NO_TEMPLATE: 'no_approved_template',
  NO_CHANNEL: 'no_client_channel',
  NO_CLIENT: 'no_client_record',
  NOT_OPTED_IN: 'not_opted_in',
  STOPPED: 'client_asked_to_stop',
  PAUSED: 'paused',
  OPEN_ISSUE: 'open_issue',
  UNHANDLED_REPLY: 'unhandled_reply',
  SEND_LIMIT: 'send_limit_reached',
  MISSING_VALUE: 'missing_value',
});

const BLOCKED_TEXT = Object.freeze({
  no_approved_template: 'no approved template for this event',
  no_client_channel: 'the project has no client channel',
  no_client_record: 'the project has no client record',
  not_opted_in: 'the client has not opted in to promotional messages',
  client_asked_to_stop: 'the client asked to stop receiving these',
  paused: 'messages to this client are paused',
  open_issue: 'the client has an unresolved problem open',
  unhandled_reply: 'the client wrote to us and nobody has answered yet',
  send_limit_reached: 'it would exceed the send limit for this client',
  missing_value: 'a value the template needs is not recorded',
});

/**
 * Placeholder values, all read from records.
 *
 * Anything not recorded is left out rather than guessed at, which makes the
 * template refuse to render — better than a client receiving a sentence built
 * around a blank.
 */
function valuesFor(db, guildId, { project = null, client = null, extra = {} } = {}) {
  const config = configRepo.getConfig(db, guildId);
  const values = {
    studio_name: config?.studio_name || null,
    client_name: client?.display_name || null,
    contact_name: null,
    ...extra,
  };

  if (project) {
    const report = clientReport.buildProjectReport(db, guildId, project);
    const services = [...new Set(
      tasksRepo.listTasksForProject(db, project.id)
        .filter((task) => task.state !== TASK_STATES.CANCELLED)
        .map((task) => configRepo.listDepartments(db, guildId).find((dept) => dept.id === task.department_id)?.name)
        .filter(Boolean)
    )];

    Object.assign(values, {
      project_name: project.name,
      project_code: project.code,
      item_count: String(report.total),
      items_done: String(report.counts[clientReport.BUCKETS.APPROVED_BY_YOU]),
      items_awaiting_you: String(report.counts[clientReport.BUCKETS.AWAITING_YOUR_APPROVAL]),
      deadline: project.deadline_utc ? discordTimestamp(project.deadline_utc, 'D') : 'not set',
      channel_link: project.client_channel_id ? `<#${project.client_channel_id}>` : null,
      service_list: services.join(', ') || null,
    });
  }

  return values;
}

/**
 * Whether a message of this kind may go to this client right now.
 *
 * Deliberately conservative: anything unclear is a block, because a message the
 * studio did not mean to send cannot be unsent.
 */
function guardCheck(db, guildId, client, { kind, now = Date.now() } = {}) {
  if (!client) return { ok: false, reason: BLOCKED.NO_CLIENT };

  const prefs = messagingRepo.getPrefs(db, client.id);

  if (prefs?.paused_until && prefs.paused_until > now) {
    return { ok: false, reason: BLOCKED.PAUSED, until: prefs.paused_until };
  }

  // A client with an unresolved problem should hear from a person, not from an
  // automation. This applies to transactional messages too.
  if (clientsRepo.hasOpenIssue(db, guildId, client.id)) {
    return { ok: false, reason: BLOCKED.OPEN_ISSUE };
  }

  if (messagingRepo.hasUnhandledReply(db, client.id)) {
    return { ok: false, reason: BLOCKED.UNHANDLED_REPLY };
  }

  if (kind === messagingRepo.KINDS.PROMOTIONAL) {
    if (client.promo_stopped_at) return { ok: false, reason: BLOCKED.STOPPED };
    if (client.promo_opt_in !== 1) return { ok: false, reason: BLOCKED.NOT_OPTED_IN };

    const limit = prefs?.max_per_week ?? DEFAULT_MAX_PROMOTIONAL_PER_WEEK;
    const sent = messagingRepo.sentCountSince(db, client.id, now - WEEK_MS, {
      kind: messagingRepo.KINDS.PROMOTIONAL,
    });
    if (sent >= limit) return { ok: false, reason: BLOCKED.SEND_LIMIT, limit, sent };
  }

  return { ok: true };
}

/**
 * Queues the approved template for an event, if there is one and the rules
 * allow it. Returns a reason rather than throwing, because most callers are
 * event handlers doing something more important.
 */
function queueForTrigger(db, guildId, trigger, {
  project = null,
  clientId = null,
  dedupeSuffix = '',
  delayMs = 0,
  digestKey = null,
  extraValues = {},
  queuedBy = null,
  now = Date.now(),
} = {}) {
  const resolvedClientId = clientId ?? project?.client_id ?? null;
  if (!resolvedClientId) return { ok: false, reason: BLOCKED.NO_CLIENT };

  const client = clientsRepo.getClient(db, guildId, resolvedClientId);
  if (!client) return { ok: false, reason: BLOCKED.NO_CLIENT };

  const [template] = messagingRepo.listTemplates(db, guildId, { approvedOnly: true, triggerEvent: trigger });
  if (!template) return { ok: false, reason: BLOCKED.NO_TEMPLATE };

  const guard = guardCheck(db, guildId, client, { kind: template.kind, now });
  if (!guard.ok) return { ok: false, reason: guard.reason, detail: BLOCKED_TEXT[guard.reason] };

  const rendered = render(template.body, valuesFor(db, guildId, { project, client, extra: extraValues }));
  if (!rendered.ok) {
    return { ok: false, reason: BLOCKED.MISSING_VALUE, missing: rendered.missing, unknown: rendered.unknown };
  }

  return {
    ...messagingRepo.queueMessage(db, guildId, {
      clientId: client.id,
      projectId: project?.id ?? null,
      templateKey: template.key,
      templateVersion: template.version,
      kind: template.kind,
      triggerEvent: trigger,
      body: rendered.text,
      // The suffix is what distinguishes one preview-ready message from the
      // next on the same project; without it the second would be swallowed.
      dedupeKey: `${guildId}:${trigger}:${project?.id ?? 'none'}:${client.id}:${dedupeSuffix}`,
      digestKey,
      sendAfter: now + delayMs,
      queuedBy,
    }),
    template,
  };
}

/**
 * Merges queued messages that share a digest key into one.
 *
 * A bulk order of 18 items would otherwise produce 18 near-identical messages.
 * The first message's text is kept and the rest are folded into a line saying
 * how many, which is the honest summary and not a rewrite of anybody's words.
 */
function digestFor(db, guildId, message) {
  if (!message.digest_key) return { body: message.body, merged: [] };

  const group = messagingRepo.digestGroup(db, guildId, message.digest_key)
    .filter((row) => row.id !== message.id);

  if (group.length === 0) return { body: message.body, merged: [] };

  return {
    body: `${message.body}\n\n_This covers ${group.length + 1} items on your order._`,
    merged: group,
  };
}

async function resolveChannel(discordClient, channelId) {
  if (!channelId) return null;
  const cached = discordClient.channels.cache.get(channelId);
  if (cached) return cached;
  return discordClient.channels.fetch(channelId).catch(() => null);
}

/**
 * Sends what is due. Guards are re-checked here, not just at queue time: a
 * client can complain, reply, or ask to stop between scheduling and sending,
 * and the later fact is the one that should win.
 */
async function processQueue(discordClient, db, guildId, { now = Date.now(), limit = 25 } = {}) {
  const results = { sent: 0, blocked: 0, failed: 0, merged: 0 };

  for (const message of messagingRepo.dueMessages(db, guildId, { now, limit })) {
    // It may have been folded into a digest by an earlier iteration.
    const fresh = messagingRepo.getMessage(db, guildId, message.id);
    if (!fresh || fresh.status !== messagingRepo.STATUSES.QUEUED) continue;

    const client = clientsRepo.getClient(db, guildId, fresh.client_id);
    const guard = guardCheck(db, guildId, client, { kind: fresh.kind, now });
    if (!guard.ok) {
      messagingRepo.markBlocked(db, fresh.id, BLOCKED_TEXT[guard.reason] || guard.reason);
      results.blocked += 1;
      continue;
    }

    const project = fresh.project_id ? projectsRepo.getProject(db, guildId, fresh.project_id) : null;
    const channelId = project?.client_channel_id || null;
    if (!channelId) {
      messagingRepo.markBlocked(db, fresh.id, BLOCKED_TEXT[BLOCKED.NO_CHANNEL]);
      results.blocked += 1;
      continue;
    }

    const channel = await resolveChannel(discordClient, channelId);
    if (!channel || typeof channel.send !== 'function') {
      messagingRepo.markFailed(db, fresh.id, 'the client channel could not be reached');
      results.failed += 1;
      continue;
    }

    const { body, merged } = digestFor(db, guildId, fresh);
    const posted = await channel.send({ content: body.slice(0, 2000) }).catch((error) => {
      messagingRepo.markFailed(db, fresh.id, error.message || 'send failed');
      return null;
    });

    if (!posted) {
      results.failed += 1;
      continue;
    }

    messagingRepo.markSent(db, fresh.id, { channelId, messageId: posted.id });
    results.sent += 1;

    // The folded-in messages are marked sent against the same Discord message,
    // so history shows what each one was for and nothing looks unsent.
    for (const other of merged) {
      messagingRepo.markSent(db, other.id, { channelId, messageId: posted.id });
      results.merged += 1;
    }
  }

  return results;
}

/**
 * A client wrote in their channel. Their sequence stops until somebody has
 * dealt with it, and their leader or the owner is told.
 */
function recordClientReply(db, guildId, { project, client, userId, channelId, messageId, content }) {
  const reply = messagingRepo.recordReply(db, guildId, {
    clientId: client.id,
    projectId: project?.id ?? null,
    userId,
    channelId,
    messageId,
    excerpt: content,
  });

  // Anything queued and not yet sent would now be talking over them.
  const cancelled = messagingRepo.cancelQueuedForClient(db, guildId, client.id, {
    kind: messagingRepo.KINDS.PROMOTIONAL,
  });

  return { reply, cancelledPromotional: cancelled };
}

function whoToTell(db, guildId, client, project) {
  const prefs = messagingRepo.getPrefs(db, client.id);
  const config = configRepo.getConfig(db, guildId);

  // Follow-up ownership, then the project manager, then the owner. Somebody is
  // always told; the message never simply lands nowhere.
  return prefs?.follow_up_user_id
    || project?.manager_user_id
    || client.finder_user_id
    || config?.owner_user_id
    || null;
}

module.exports = {
  WEEK_MS,
  DEFAULT_DIGEST_MINUTES,
  DEFAULT_MAX_PROMOTIONAL_PER_WEEK,
  BLOCKED,
  BLOCKED_TEXT,
  valuesFor,
  guardCheck,
  queueForTrigger,
  digestFor,
  processQueue,
  recordClientReply,
  whoToTell,
};
