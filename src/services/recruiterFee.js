const staffRepo = require('../db/repos/staff');
const projectsRepo = require('../db/repos/projects');
const { recordAudit } = require('../db/repos/core');
const { formatAmount } = require('../domain/money');

/**
 * The recruiter's cut.
 *
 * Whoever brings somebody onto the team gets 20% of that person's **first
 * payout**, taken from the payout itself. Once, not per task.
 *
 * It is deliberately not a fifth share of the studio's pool. Finder, leader,
 * mod and owner are percentages of what is left after the artist is paid, and
 * they total 100% — adding a fifth would mean taking from the other four, and
 * the base would be wrong anyway, because this is a percentage of the artist's
 * pay rather than of the pool. Taking it from the payout leaves the pool exactly
 * as it was and means the studio can never pay out more than came in.
 *
 * The rule that keeps it honest: the artist is told before they accept their
 * first task. A figure agreed as $35 that arrives as $28 is a broken promise
 * even when the arrangement itself is fair.
 */

const DEFAULT_FEE_BP = 2000; // 20%

function feeBasisPoints(config = {}) {
  const raw = Number(config.recruiter_fee_bp);
  return Number.isInteger(raw) && raw >= 0 && raw <= 10000 ? raw : DEFAULT_FEE_BP;
}

/** Records who brought somebody onto the team. */
function setRecruiter(db, guildId, { userId, recruiterUserId, actorUserId }) {
  if (userId === recruiterUserId) {
    return { ok: false, reason: 'self' };
  }

  const member = staffRepo.getStaff(db, guildId, userId);
  if (!member) return { ok: false, reason: 'not_staff' };

  if (member.recruiter_fee_taken_at) {
    // Changing it now would hand the fee to somebody who was not owed it, or
    // take it twice. The record of who was actually paid stays as it is.
    return { ok: false, reason: 'already_paid', member };
  }

  db.prepare(`
    UPDATE staff SET recruited_by = ?, recruited_at = ?, recruited_by_set_by = ?, updated_at = ?
    WHERE guild_id = ? AND user_id = ?
  `).run(recruiterUserId, Date.now(), actorUserId, Date.now(), guildId, userId);

  recordAudit(db, {
    guildId, actorUserId, action: 'staff.recruiter.set', entityType: 'staff', entityId: userId,
    before: { recruited_by: member.recruited_by },
    after: { recruited_by: recruiterUserId },
  });

  return { ok: true, member: staffRepo.getStaff(db, guildId, userId) };
}

function clearRecruiter(db, guildId, userId, actorUserId) {
  const member = staffRepo.getStaff(db, guildId, userId);
  if (!member) return { ok: false, reason: 'not_staff' };
  if (member.recruiter_fee_taken_at) return { ok: false, reason: 'already_paid', member };

  db.prepare('UPDATE staff SET recruited_by = NULL, recruited_at = NULL, updated_at = ? WHERE guild_id = ? AND user_id = ?')
    .run(Date.now(), guildId, userId);
  recordAudit(db, {
    guildId, actorUserId, action: 'staff.recruiter.clear', entityType: 'staff', entityId: userId,
    before: { recruited_by: member.recruited_by },
  });
  return { ok: true };
}

/**
 * Whether this payout carries the recruiter's cut, and how much.
 *
 * Returns a reason when it does not, so the payout message can say why rather
 * than leaving somebody to wonder whether it was forgotten.
 */
function feeFor(db, guildId, { artistUserId, task = null, amountMinor, currency, config = {} }) {
  const member = staffRepo.getStaff(db, guildId, artistUserId);
  if (!member?.recruited_by) return { applies: false, reason: 'no_recruiter' };
  if (member.recruiter_fee_taken_at) return { applies: false, reason: 'already_taken' };
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) return { applies: false, reason: 'no_amount' };

  const recruiterUserId = member.recruited_by;

  // Somebody who brought in the client already takes the finder's 20% of the
  // pool on this task. The studio's choice was that the finder's cut wins and
  // the recruiter's does not stack on top of it.
  if (task?.project_id) {
    const project = projectsRepo.getProject(db, guildId, task.project_id);
    if (project?.finder_user_id && project.finder_user_id === recruiterUserId) {
      return { applies: false, reason: 'is_finder', recruiterUserId };
    }
  }

  // Paying somebody their own recruit's fee would be a loop.
  if (recruiterUserId === artistUserId) return { applies: false, reason: 'self' };

  const bp = feeBasisPoints(config);
  if (bp === 0) return { applies: false, reason: 'fee_is_zero' };

  // Rounded down, so the fee can never exceed the payout it comes out of.
  const feeMinor = Math.floor((amountMinor * bp) / 10000);
  if (feeMinor <= 0) return { applies: false, reason: 'rounds_to_nothing' };

  return {
    applies: true,
    feeMinor,
    artistReceivesMinor: amountMinor - feeMinor,
    recruiterUserId,
    basisPoints: bp,
    currency,
  };
}

/** Marks the one-time fee as taken, so a second payout does not collect it again. */
function markTaken(db, guildId, artistUserId, actorUserId, detail = null) {
  const result = db.prepare(`
    UPDATE staff SET recruiter_fee_taken_at = ?, updated_at = ?
    WHERE guild_id = ? AND user_id = ? AND recruiter_fee_taken_at IS NULL
  `).run(Date.now(), Date.now(), guildId, artistUserId);

  if (result.changes === 0) return false;
  recordAudit(db, {
    guildId, actorUserId, action: 'staff.recruiter_fee.taken',
    entityType: 'staff', entityId: artistUserId, detail,
  });
  return true;
}

/**
 * The sentence an artist is shown before accepting their first task.
 *
 * Written out in full rather than as a percentage, because "20% introduction
 * fee" and "you will receive $28" are read very differently at the moment
 * somebody decides whether to take a job.
 */
function disclosureFor(db, guildId, { artistUserId, amountMinor, currency, config = {}, task = null }) {
  const fee = feeFor(db, guildId, { artistUserId, task, amountMinor, currency, config });
  if (!fee.applies) return null;

  return (
    `This is your first paid task, so a one-time **${fee.basisPoints / 100}% introduction fee** of ` +
    `**${formatAmount(fee.feeMinor, currency)}** goes to <@${fee.recruiterUserId}>, who brought you onto the team.\n` +
    `**You will receive ${formatAmount(fee.artistReceivesMinor, currency)}** for this task. ` +
    'Every task after this one is the full amount.'
  );
}

module.exports = {
  DEFAULT_FEE_BP,
  feeBasisPoints,
  setRecruiter,
  clearRecruiter,
  feeFor,
  markTaken,
  disclosureFor,
};
