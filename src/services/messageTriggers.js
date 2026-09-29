const messagingRepo = require('../db/repos/messaging');
const clientsRepo = require('../db/repos/clients');
const projectsRepo = require('../db/repos/projects');
const tasksRepo = require('../db/repos/tasks');
const clientMessaging = require('./clientMessaging');
const { TASK_STATES } = require('../domain/taskState');
const { discordTimestamp } = require('../utils/time');

/**
 * Where automated client messages come from.
 *
 * Every trigger is raised from a fact the studio already recorded — a preview
 * released, an order delivered, a client silent for days — never from a guess
 * about what a client might want. Each one queues at most one message, because
 * the dedupe key is derived from the thing that happened rather than from when
 * the sweep happened to run.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULTS = Object.freeze({
  chaseAfterDays: 3,
  checkInAfterDays: 7,
  reviewRequestAfterDays: 14,
  repeatOrderAfterDays: 60,
});

const { TRIGGERS } = messagingRepo;

/**
 * An order has been confirmed for a client. Raised where a project is linked to
 * a client, which is the first moment there is anybody to write to.
 */
function orderConfirmed(db, guildId, project, { queuedBy = null } = {}) {
  return clientMessaging.queueForTrigger(db, guildId, TRIGGERS.ORDER_CONFIRMED, {
    project,
    dedupeSuffix: 'confirmed',
    queuedBy,
  });
}

/**
 * Work has started. Raised the first time any task on the project is in
 * progress, and only once for the project however many tasks follow.
 */
function productionStarted(db, guildId, project, { queuedBy = null } = {}) {
  return clientMessaging.queueForTrigger(db, guildId, TRIGGERS.PRODUCTION_STARTED, {
    project,
    dedupeSuffix: 'started',
    queuedBy,
  });
}

/**
 * A preview is ready for the client to look at.
 *
 * Deduplicated per submission, so re-running the review does not re-announce
 * the same version. Digested per project and day, so a bulk order becomes one
 * message rather than eighteen.
 */
function previewReady(db, guildId, project, { taskId, submissionId, queuedBy = null, now = Date.now() } = {}) {
  const day = Math.floor(now / DAY_MS);
  return clientMessaging.queueForTrigger(db, guildId, TRIGGERS.PREVIEW_READY, {
    project,
    dedupeSuffix: `preview:${taskId}:${submissionId}`,
    digestKey: `${guildId}:preview:${project.id}:${day}`,
    // Held briefly so the rest of a batch can join the same digest instead of
    // each item arriving as its own message.
    delayMs: clientMessaging.DEFAULT_DIGEST_MINUTES * 60 * 1000,
    queuedBy,
    now,
  });
}

function delivered(db, guildId, project, { taskId, version, queuedBy = null, now = Date.now() } = {}) {
  const day = Math.floor(now / DAY_MS);
  return clientMessaging.queueForTrigger(db, guildId, TRIGGERS.DELIVERED, {
    project,
    dedupeSuffix: `delivered:${taskId}:${version}`,
    digestKey: `${guildId}:delivered:${project.id}:${day}`,
    delayMs: clientMessaging.DEFAULT_DIGEST_MINUTES * 60 * 1000,
    extraValues: { delivered_on: discordTimestamp(now, 'D') },
    queuedBy,
    now,
  });
}

/** A related service the studio could add to an order. Always the owner's call. */
function crossServiceOffer(db, guildId, project, { queuedBy = null, now = Date.now() } = {}) {
  return clientMessaging.queueForTrigger(db, guildId, TRIGGERS.CROSS_SERVICE, {
    project,
    dedupeSuffix: `cross:${Math.floor(now / DAY_MS)}`,
    queuedBy,
    now,
  });
}

/**
 * Projects where the client has gone quiet on a preview.
 *
 * Measured from when the work was sent, not from when this ran, so a sweep that
 * was offline for a week does not suddenly chase everybody.
 */
function chaseSilentClients(db, guildId, { now = Date.now(), afterDays = DEFAULTS.chaseAfterDays } = {}) {
  const cutoff = now - afterDays * DAY_MS;
  const byProject = new Map();

  for (const task of tasksRepo.listTasksInStates(db, guildId, [TASK_STATES.AWAITING_CLIENT])) {
    if (!task.updated_at || task.updated_at > cutoff) continue;
    if (!byProject.has(task.project_id)) byProject.set(task.project_id, []);
    byProject.get(task.project_id).push(task);
  }

  const queued = [];
  for (const [projectId, tasks] of byProject) {
    const project = projectsRepo.getProject(db, guildId, projectId);
    if (!project) continue;

    // One chase per project per week: silence is not a reason to write daily.
    const week = Math.floor(now / (7 * DAY_MS));
    const result = clientMessaging.queueForTrigger(db, guildId, TRIGGERS.AWAITING_CLIENT_CHASE, {
      project,
      dedupeSuffix: `chase:${week}`,
      extraValues: { items_awaiting_you: String(tasks.length) },
      now,
    });
    if (result.ok && result.created) queued.push(result.message);
  }

  return queued;
}

/** Projects whose work is all delivered, a while afterwards. */
function deliveredProjectsOlderThan(db, guildId, days, now) {
  const cutoff = now - days * DAY_MS;
  const results = [];

  for (const project of projectsRepo.listProjects(db, guildId, { status: 'delivered', limit: 200 })) {
    const tasks = tasksRepo.listTasksForProject(db, project.id)
      .filter((task) => task.state !== TASK_STATES.CANCELLED);
    if (tasks.length === 0) continue;

    const lastDelivery = Math.max(...tasks.map((task) => task.delivered_at || 0));
    if (lastDelivery === 0 || lastDelivery > cutoff) continue;
    results.push({ project, lastDelivery });
  }

  return results;
}

function postDeliveryCheckIns(db, guildId, { now = Date.now(), afterDays = DEFAULTS.checkInAfterDays } = {}) {
  const queued = [];
  for (const { project, lastDelivery } of deliveredProjectsOlderThan(db, guildId, afterDays, now)) {
    const result = clientMessaging.queueForTrigger(db, guildId, TRIGGERS.POST_DELIVERY_CHECK_IN, {
      project,
      dedupeSuffix: 'check_in',
      extraValues: { delivered_on: discordTimestamp(lastDelivery, 'D') },
      now,
    });
    if (result.ok && result.created) queued.push(result.message);
  }
  return queued;
}

function reviewRequests(db, guildId, { now = Date.now(), afterDays = DEFAULTS.reviewRequestAfterDays } = {}) {
  const queued = [];
  for (const { project, lastDelivery } of deliveredProjectsOlderThan(db, guildId, afterDays, now)) {
    const result = clientMessaging.queueForTrigger(db, guildId, TRIGGERS.REVIEW_REQUEST, {
      project,
      dedupeSuffix: 'review',
      extraValues: { delivered_on: discordTimestamp(lastDelivery, 'D') },
      now,
    });
    if (result.ok && result.created) queued.push(result.message);
  }
  return queued;
}

/**
 * Past clients with nothing live, a good while later.
 *
 * Promotional, so it only reaches somebody who opted in and is still subject to
 * the per-client send limit. Deduplicated per quarter, not per sweep, so a
 * client hears this at most a few times a year.
 */
function repeatOrderReminders(db, guildId, { now = Date.now(), afterDays = DEFAULTS.repeatOrderAfterDays } = {}) {
  const queued = [];
  const quarter = Math.floor(now / (90 * DAY_MS));

  for (const client of clientsRepo.listClients(db, guildId, { limit: 200 })) {
    if (client.promo_opt_in !== 1 || client.promo_stopped_at) continue;

    const history = clientsRepo.clientOrderHistory(db, guildId, client.id);
    const hasLive = history.some((project) => project.status === 'active');
    if (hasLive || history.length === 0) continue;

    const last = history[0];
    const lastTouched = last.updated_at || last.created_at;
    if (lastTouched > now - afterDays * DAY_MS) continue;

    const result = clientMessaging.queueForTrigger(db, guildId, TRIGGERS.REPEAT_ORDER, {
      clientId: client.id,
      project: projectsRepo.getProject(db, guildId, last.id),
      dedupeSuffix: `repeat:${quarter}`,
      extraValues: { last_order_name: last.name },
      now,
    });
    if (result.ok && result.created) queued.push(result.message);
  }

  return queued;
}

/**
 * The daily pass. Queues only; sending is a separate step so that a burst of
 * queued messages still goes out under the same rate and pause rules.
 */
function sweep(db, guildId, { now = Date.now() } = {}) {
  return {
    chases: chaseSilentClients(db, guildId, { now }),
    checkIns: postDeliveryCheckIns(db, guildId, { now }),
    reviews: reviewRequests(db, guildId, { now }),
    repeats: repeatOrderReminders(db, guildId, { now }),
  };
}

module.exports = {
  DAY_MS,
  DEFAULTS,
  orderConfirmed,
  productionStarted,
  previewReady,
  delivered,
  crossServiceOffer,
  chaseSilentClients,
  postDeliveryCheckIns,
  reviewRequests,
  repeatOrderReminders,
  sweep,
};
