const tasksRepo = require('../db/repos/tasks');
const offersRepo = require('../db/repos/offers');
const projectsRepo = require('../db/repos/projects');
const configRepo = require('../db/repos/config');
const staffRepo = require('../db/repos/staff');
const { offerEmbed, offerComponents, taskSummaryLine } = require('./taskView');
const { notifyUser } = require('./notify');
const { formatAmount } = require('../domain/money');
const { discordTimestamp } = require('../utils/time');

/**
 * Reasons a leader should stop and think before offering. Never a hard block:
 * the studio's rule is that leaders choose their own artists, so the bot warns
 * and asks for a second click instead of refusing.
 */
function candidateWarnings(db, guildId, { staff, department }) {
  const warnings = [];
  if (!staff) return ['This person has no studio profile yet.'];

  if (staff.availability === staffRepo.AVAILABILITY.AWAY) {
    warnings.push(
      staff.away_until
        ? `They are marked **away** until ${discordTimestamp(staff.away_until, 'd')}.`
        : 'They are marked **away**.'
    );
  }
  if (staff.availability === staffRepo.AVAILABILITY.AT_CAPACITY) {
    warnings.push('They have marked themselves **at capacity**.');
  }

  const active = staffRepo.activeTaskCount(db, guildId, staff.user_id);
  if (department?.task_cap && active >= department.task_cap) {
    warnings.push(`They already hold **${active}** active tasks (department cap ${department.task_cap}).`);
  }
  if (!staff.timezone) warnings.push('They have not set a timezone, so deadlines cannot be checked against their hours.');
  if (staff.removed_at) warnings.push('They appear to have left the server.');

  return warnings;
}

/**
 * Records the offer and sends it to the artist.
 *
 * The state change and the offer row commit together, so a task can never be
 * left "offered" without a live offer. Delivery happens afterwards and its
 * failure is reported rather than rolling back a valid offer.
 */
async function sendOffer(client, db, { guildId, task, artistUserId, offeredBy, guildName = null }) {
  if (!tasksRepo.isPayApproved(task)) {
    return { ok: false, reason: 'pay_not_approved' };
  }

  const { offer, updatedTask } = db.transaction(() => {
    const fresh = tasksRepo.getTask(db, guildId, task.id);
    const terms = tasksRepo.termsSnapshot({ ...fresh, artist_user_id: artistUserId });

    const updated = tasksRepo.applyTransition(db, guildId, task.id, 'offer', {
      actorUserId: offeredBy,
      patch: { artist_user_id: artistUserId },
      detail: `Offered to ${artistUserId}`,
    });

    const created = offersRepo.createOffer(db, guildId, {
      taskId: task.id,
      artistUserId,
      offeredBy,
      terms,
    });

    return { offer: created, updatedTask: updated };
  })();

  const project = projectsRepo.getProject(db, guildId, updatedTask.project_id);
  const department = configRepo.getDepartment(db, guildId, updatedTask.department_id);

  const delivery = await notifyUser(client, db, guildId, artistUserId, {
    embeds: [offerEmbed({ task: updatedTask, project, department, guildName, db, guildId })],
    components: offerComponents(offer.id),
  }, { fallbackNote: 'You have a task offer waiting.' });

  return { ok: true, offer, task: updatedTask, delivery };
}

async function acceptOffer(client, db, { guildId, offerId, actorUserId }) {
  const offer = offersRepo.getOffer(db, offerId);
  if (!offer) return { ok: false, reason: 'offer_not_found' };
  if (offer.artist_user_id !== actorUserId) return { ok: false, reason: 'not_your_offer' };
  if (offer.state !== offersRepo.OFFER_STATES.PENDING) return { ok: false, reason: 'already_answered', offer };

  const task = tasksRepo.getTask(db, guildId, offer.task_id);
  if (!task) return { ok: false, reason: 'task_not_found' };

  const result = db.transaction(() => {
    const resolved = offersRepo.resolveOffer(db, guildId, offerId, offersRepo.OFFER_STATES.ACCEPTED, { actorUserId });
    // resolveOffer only updates a pending row, so a second click lands here.
    if (!resolved) return null;

    const updated = tasksRepo.applyTransition(db, guildId, task.id, 'offer_accept', {
      actorUserId,
      patch: {
        accepted_at: Date.now(),
        accepted_terms_json: offer.terms_json,
        last_progress_at: Date.now(),
      },
      guardKey: `offer-accept:${offerId}`,
      detail: 'Artist accepted the recorded terms',
    });

    tasksRepo.acknowledgeTermChanges(db, task.id, actorUserId);
    return updated;
  })();

  if (!result) return { ok: false, reason: 'already_answered', offer: offersRepo.getOffer(db, offerId) };

  if (task.leader_user_id) {
    await notifyUser(client, db, guildId, task.leader_user_id, {
      content: `✅ <@${actorUserId}> accepted **${task.code} · ${task.title}**.\n${taskSummaryLine(result)}`,
    }).catch(() => null);
  }

  return { ok: true, task: result, offer };
}

async function declineOffer(client, db, { guildId, offerId, actorUserId, reason }) {
  const offer = offersRepo.getOffer(db, offerId);
  if (!offer) return { ok: false, reason: 'offer_not_found' };
  if (offer.artist_user_id !== actorUserId) return { ok: false, reason: 'not_your_offer' };
  if (offer.state !== offersRepo.OFFER_STATES.PENDING) return { ok: false, reason: 'already_answered', offer };

  const task = tasksRepo.getTask(db, guildId, offer.task_id);
  if (!task) return { ok: false, reason: 'task_not_found' };

  const result = db.transaction(() => {
    const resolved = offersRepo.resolveOffer(db, guildId, offerId, offersRepo.OFFER_STATES.DECLINED, {
      actorUserId,
      declineReason: reason,
    });
    if (!resolved) return null;

    // Back to the leader's queue with the artist cleared.
    return tasksRepo.applyTransition(db, guildId, task.id, 'offer_decline', {
      actorUserId,
      patch: { artist_user_id: null },
      guardKey: `offer-decline:${offerId}`,
      detail: reason,
    });
  })();

  if (!result) return { ok: false, reason: 'already_answered', offer: offersRepo.getOffer(db, offerId) };

  if (task.leader_user_id) {
    await notifyUser(client, db, guildId, task.leader_user_id, {
      content:
        `✖️ <@${actorUserId}> declined **${task.code} · ${task.title}**.\n` +
        `Reason: ${reason}\nIt is back in your unassigned queue — \`/task queue\`.`,
    }).catch(() => null);
  }

  return { ok: true, task: result, offer };
}

async function withdrawOffer(client, db, { guildId, taskId, actorUserId, reason = null }) {
  const offer = offersRepo.getPendingOffer(db, taskId);
  if (!offer) return { ok: false, reason: 'no_pending_offer' };

  const result = db.transaction(() => {
    const resolved = offersRepo.resolveOffer(db, guildId, offer.id, offersRepo.OFFER_STATES.WITHDRAWN, {
      actorUserId,
      declineReason: reason,
    });
    if (!resolved) return null;
    return tasksRepo.applyTransition(db, guildId, taskId, 'offer_withdraw', {
      actorUserId,
      patch: { artist_user_id: null },
      detail: reason,
    });
  })();

  if (!result) return { ok: false, reason: 'already_answered' };

  await notifyUser(client, db, guildId, offer.artist_user_id, {
    content: `The offer for **${result.code} · ${result.title}** was withdrawn.${reason ? `\nReason: ${reason}` : ''}`,
  }).catch(() => null);

  return { ok: true, task: result, offer };
}

function describeTerms(terms) {
  const lines = [];
  if (terms.artist_pay_minor !== null && terms.artist_pay_currency) {
    lines.push(`Pay: ${formatAmount(terms.artist_pay_minor, terms.artist_pay_currency)}`);
  }
  if (terms.deadline_utc) lines.push(`Deadline: ${discordTimestamp(terms.deadline_utc, 'F')}`);
  if (terms.revision_rounds !== null && terms.revision_rounds !== undefined) {
    lines.push(`Revisions: ${terms.revision_rounds} round(s)`);
  }
  if (Array.isArray(terms.deliverables) && terms.deliverables.length > 0) {
    lines.push(`Deliverables: ${terms.deliverables.join(', ')}`);
  }
  return lines.join('\n');
}

module.exports = { candidateWarnings, sendOffer, acceptOffer, declineOffer, withdrawOffer, describeTerms };
