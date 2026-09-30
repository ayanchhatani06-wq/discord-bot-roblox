const projectsRepo = require('../db/repos/projects');
const tasksRepo = require('../db/repos/tasks');
const clientsRepo = require('../db/repos/clients');
const offersRepo = require('../db/repos/offers');
const submissionsRepo = require('../db/repos/submissions');
const paymentsRepo = require('../db/repos/payments');
const evidenceRepo = require('../db/repos/evidence');
const paymentSchedule = require('./paymentSchedule');
const { listAudit } = require('../db/repos/core');
const { formatAmount } = require('../domain/money');

/**
 * Everything that happened on one order, in one document.
 *
 * All of this is already recorded. The point is that during a chargeback or an
 * argument, nobody wants to run ten commands and stitch the answer together
 * under pressure — and the moment you are doing that is the moment you miss
 * the one thing that mattered.
 *
 * It states what is recorded and what is not. A gap said out loud is more use
 * than a gap you discover while someone is disputing your invoice.
 */

function when(ms) {
  return ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : 'not recorded';
}

function money(minor, currency) {
  return minor === null || minor === undefined || !currency ? 'not recorded' : formatAmount(minor, currency);
}

/**
 * Gathers the case.
 *
 * Returns structure rather than text so the same facts can be rendered as a
 * Discord message, a file, or a web page without any of them re-deciding what
 * the facts are.
 */
function build(db, guildId, project) {
  const client = project.client_id ? clientsRepo.getClient(db, guildId, project.client_id) : null;
  const tasks = tasksRepo.listTasksForProject(db, project.id);
  const schedule = paymentSchedule.scheduleFor(db, guildId, project);

  const items = tasks.map((task) => {
    const offer = offersRepo.offerHistory(db, task.id);
    const accepted = offer.find((entry) => entry.state === offersRepo.OFFER_STATES.ACCEPTED) || null;
    const submissions = submissionsRepo.listSubmissions(db, task.id);
    const decisions = submissionsRepo.listClientDecisions(db, task.id);

    return {
      task,
      acceptedAt: accepted?.responded_at ?? task.accepted_at ?? null,
      acceptedTerms: accepted?.terms_json ?? task.accepted_terms_json ?? null,
      submissions: submissions.map((submission) => ({
        version: submission.version,
        kind: submission.kind,
        submittedAt: submission.submitted_at,
        submittedBy: submission.submitted_by,
        releasedToClientAt: submission.client_visible_at,
        links: submissionsRepo.links(submission),
      })),
      decisions: decisions.map((decision) => ({
        decision: decision.decision,
        recordedAt: decision.recorded_at,
        recordedBy: decision.recorded_by,
        feedback: decision.feedback,
        reference: decision.reference_url,
        outOfScope: decision.out_of_scope === 1,
      })),
      deliveredAt: task.delivered_at,
      deliveredBy: task.delivered_by,
      deliveredVersion: task.delivered_version,
    };
  });

  const receipts = paymentsRepo.listPaymentsForProject(db, project.id, { direction: 'client_receipt' });
  const payouts = paymentsRepo.listPaymentsForProject(db, project.id, { direction: 'payout' });

  const files = evidenceRepo.forProject(db, guildId, project.id);
  const integrity = evidenceRepo.verifyAll(db, guildId);

  const audit = listAudit(db, { guildId, entityType: 'project', entityId: project.id, limit: 200 });

  // Said plainly rather than left for somebody to notice at the worst moment.
  const gaps = [];
  if (!client) gaps.push('This order is not linked to a client record, so there is no authorised contact on file.');
  if (schedule.totalMinor === null) gaps.push('No client amount was ever recorded for this order.');

  for (const item of items) {
    if (item.task.state === 'cancelled') continue;
    if (!item.acceptedAt) {
      gaps.push(`${item.task.code}: no record of anybody accepting the terms.`);
    }
    if (item.submissions.length === 0) {
      gaps.push(`${item.task.code}: nothing was ever submitted.`);
    }
    if (item.decisions.length === 0 && item.task.state === 'client_approved') {
      gaps.push(`${item.task.code}: marked approved with no client decision recorded against it.`);
    }
    if (!item.submissions.some((submission) => submission.releasedToClientAt)) {
      gaps.push(`${item.task.code}: nothing was ever released to the client to look at.`);
    }
  }

  if (files.length === 0) {
    gaps.push('No screenshots or files have been filed as proof on this order.');
  }
  if (integrity.missing.length > 0) {
    gaps.push(`${integrity.missing.length} filed file(s) are missing from disk.`);
  }
  if (integrity.changed.length > 0) {
    gaps.push(`${integrity.changed.length} filed file(s) no longer match the hash recorded when they were filed.`);
  }

  const authorisedAccounts = client
    ? clientsRepo.listAccounts(db, client.id).filter((account) => !account.revoked_at).length
    : 0;

  return {
    project, client, authorisedAccounts, items, schedule,
    receipts, payouts, files, integrity, audit, gaps, builtAt: Date.now(),
  };
}

/** The pack as plain text, for a file somebody can send or print. */
function render(pack) {
  const lines = [];
  const add = (text = '') => lines.push(text);

  add(`ORDER RECORD — ${pack.project.code} · ${pack.project.name}`);
  add(`Prepared ${when(pack.builtAt)}`);
  add('='.repeat(72));
  add();

  add('CLIENT');
  add(`  ${pack.client ? pack.client.display_name : 'No client record linked to this order.'}`);
  if (pack.client) {
    add(`  Authorised accounts on file: ${pack.authorisedAccounts}`);
    add(`  Contact recorded: ${pack.client.preferred_contact || 'none'}`);
  }
  add();

  add('WHAT WAS AGREED');
  add(`  Client amount: ${money(pack.schedule.totalMinor, pack.schedule.currency)}`);
  if (pack.schedule.hasSchedule) {
    for (const line of pack.schedule.milestones) {
      add(`    - ${line.milestone.label}: ${money(line.milestone.amount_minor, line.milestone.currency)}` +
        `${line.waived ? ' (waived)' : line.covered ? ' (covered)' : ` (${money(line.outstandingMinor, line.milestone.currency)} outstanding)`}`);
    }
  }
  add(`  Deadline: ${when(pack.project.deadline_utc)}`);
  add(`  Brief on file: ${pack.project.brief ? 'yes' : 'no'}`);
  add();

  add(`ITEMS (${pack.items.length})`);
  for (const item of pack.items) {
    add();
    add(`  ${item.task.code} · ${item.task.title}`);
    add(`    State: ${String(item.task.state).replace(/_/g, ' ')}`);
    add(`    Terms accepted: ${when(item.acceptedAt)}`);

    add(`    Submissions (${item.submissions.length}):`);
    for (const submission of item.submissions) {
      add(`      v${submission.version} ${submission.kind} — submitted ${when(submission.submittedAt)}` +
        `, released to client ${when(submission.releasedToClientAt)}`);
      for (const link of submission.links) add(`        ${link}`);
    }

    add(`    Client decisions (${item.decisions.length}):`);
    for (const decision of item.decisions) {
      add(`      ${decision.decision} — recorded ${when(decision.recordedAt)} by ${decision.recordedBy}` +
        `${decision.outOfScope ? ' [flagged out of scope]' : ''}`);
      if (decision.feedback) add(`        "${String(decision.feedback).slice(0, 300)}"`);
      if (decision.reference) add(`        reference: ${decision.reference}`);
    }

    add(`    Delivered: ${item.deliveredAt ? `${when(item.deliveredAt)} (version ${item.deliveredVersion}) by ${item.deliveredBy}` : 'not delivered'}`);
  }
  add();

  add(`MONEY IN (${pack.receipts.length})`);
  for (const receipt of pack.receipts) {
    add(`  ${money(receipt.amount_minor, receipt.currency)} — ${when(receipt.recorded_at)}` +
      `${receipt.method_label ? ` via ${receipt.method_label}` : ''}, entered by ${receipt.recorded_by}`);
  }
  add(`  Total received: ${money(pack.schedule.receivedMinor, pack.schedule.currency)}`);
  add();

  add(`MONEY OUT (${pack.payouts.length})`);
  for (const payout of pack.payouts) {
    add(`  ${money(payout.amount_minor, payout.currency)} to ${payout.payee_user_id}` +
      ` — ${when(payout.recorded_at)}` +
      `${payout.confirmed_at ? `, confirmed received ${when(payout.confirmed_at)}` : ', not confirmed received'}` +
      `${payout.failed_at ? `, FAILED ${when(payout.failed_at)}: ${payout.failure_note || ''}` : ''}`);
  }
  add();

  add(`FILES KEPT AS PROOF (${pack.files.length})`);
  for (const file of pack.files) {
    add(`  ${file.filename} — ${file.kind}, filed ${when(file.added_at)} by ${file.added_by}`);
    add(`    sha256: ${file.sha256}`);
    if (file.note) add(`    note: ${file.note}`);
  }
  add(`  Integrity: ${pack.integrity.ok} of ${pack.integrity.checked} still match the hash recorded when filed.`);
  add();

  if (pack.gaps.length > 0) {
    add(`GAPS IN THE RECORD (${pack.gaps.length})`);
    add('  Stated here so they are not discovered mid-dispute.');
    for (const gap of pack.gaps) add(`  - ${gap}`);
    add();
  }

  add(`AUDIT TRAIL (${pack.audit.length} most recent entries)`);
  for (const entry of pack.audit.slice(0, 80)) {
    add(`  ${when(entry.created_at)}  ${entry.action.padEnd(28)} by ${entry.actor_user_id || 'system'}` +
      `${entry.detail ? ` — ${entry.detail}` : ''}`);
  }
  add();
  add('='.repeat(72));
  add('Every timestamp above was written when the thing happened, not when this');
  add('document was produced.');

  return lines.join('\n');
}

module.exports = { when, money, build, render };
