const configRepo = require('../db/repos/config');
const projectsRepo = require('../db/repos/projects');
const tasksRepo = require('../db/repos/tasks');
const offersRepo = require('../db/repos/offers');
const submissionsRepo = require('../db/repos/submissions');
const paymentsRepo = require('../db/repos/payments');
const allocationFlow = require('./allocationFlow');
const paymentState = require('./paymentState');
const { parseBulkSpec, taskTitlesFor } = require('../domain/bulkSpec');
const { DAY_MS } = require('../utils/time');

const SAMPLE_MARKER = '[SAMPLE]';
const SAMPLE_CLIENT_REF = 'SAMPLE — safe to delete';

/**
 * Builds one demonstration project that exercises the whole workflow, so the
 * owner can see every screen with real data in it before touching live jobs.
 *
 * Everything it creates is marked and can be removed in one command. Sample
 * tasks are driven through the states directly rather than by sending offers,
 * so nobody is DMed about work that does not exist.
 */
function createSampleProject(db, guildId, { ownerId, leaderId, artistId, now = Date.now() }) {
  const departments = configRepo.listDepartments(db, guildId);
  if (departments.length === 0) return { ok: false, reason: 'no_departments' };

  const parsed = parseBulkSpec('3 models, 2 vfx, 1 animation', departments);
  if (parsed.items.length === 0) {
    return { ok: false, reason: 'departments_unrecognised', errors: parsed.errors };
  }

  return db.transaction(() => {
    const project = projectsRepo.createProject(db, guildId, {
      name: `${SAMPLE_MARKER} Demo game asset pack`,
      clientRef: SAMPLE_CLIENT_REF,
      brief: 'A worked example: three models, two effects and one animation for a demo client.',
      referenceLinks: 'https://example.com/reference-board',
      deadlineUtc: now + 14 * DAY_MS,
      clientAmountMinor: 40000,
      clientCurrency: 'USD',
      managerUserId: ownerId,
      finderUserId: null,
      modUserId: null,
      ticketUrl: null,
    }, ownerId);

    const created = [];
    for (const item of parsed.items) {
      const checklist = configRepo.departmentChecklist(item.department);
      for (const title of taskTitlesFor(item)) {
        created.push(tasksRepo.createTask(db, guildId, {
          projectId: project.id,
          title: `${SAMPLE_MARKER} ${title}`,
          departmentId: item.department.id,
          brief: 'Sample task. Delete the sample project when you are done looking around.',
          deliverables: checklist,
          deadlineUtc: now + 10 * DAY_MS,
          revisionRounds: 2,
          revisionNotes: 'Two rounds of client revisions included.',
          leaderUserId: leaderId,
        }, ownerId));
      }
    }

    // 1. Left unassigned and unpaid: this is what a leader's queue looks like.
    const queued = created[0];

    // 2. Pay proposed by a leader, waiting on the owner.
    tasksRepo.proposePay(db, guildId, created[1].id, {
      amountMinor: 2000, currency: 'USD', actorUserId: leaderId,
    });

    // 3. Offered and waiting for an answer.
    const offered = created[2];
    tasksRepo.approvePay(db, guildId, offered.id, { amountMinor: 2500, currency: 'USD', actorUserId: ownerId });
    tasksRepo.applyTransition(db, guildId, offered.id, 'offer', {
      actorUserId: leaderId,
      patch: { artist_user_id: artistId },
      detail: 'Sample offer',
    });
    offersRepo.createOffer(db, guildId, {
      taskId: offered.id,
      artistUserId: artistId,
      offeredBy: leaderId,
      terms: tasksRepo.termsSnapshot({ ...tasksRepo.getTask(db, guildId, offered.id), artist_user_id: artistId }),
    });

    // 4. Accepted and in progress, with a progress note posted.
    const inProgress = created[3];
    tasksRepo.approvePay(db, guildId, inProgress.id, { amountMinor: 1500, currency: 'USD', actorUserId: ownerId });
    tasksRepo.applyTransition(db, guildId, inProgress.id, 'offer', {
      actorUserId: leaderId, patch: { artist_user_id: artistId },
    });
    const acceptedOffer = offersRepo.createOffer(db, guildId, {
      taskId: inProgress.id, artistUserId: artistId, offeredBy: leaderId,
      terms: tasksRepo.termsSnapshot({ ...tasksRepo.getTask(db, guildId, inProgress.id), artist_user_id: artistId }),
    });
    offersRepo.resolveOffer(db, guildId, acceptedOffer.id, 'accepted', { actorUserId: artistId });
    tasksRepo.applyTransition(db, guildId, inProgress.id, 'offer_accept', {
      actorUserId: artistId,
      patch: { accepted_at: now - 2 * DAY_MS, accepted_terms_json: acceptedOffer.terms_json, last_progress_at: now - DAY_MS },
    });
    submissionsRepo.addSubmission(db, guildId, inProgress.id, {
      kind: 'progress',
      notes: 'Blockout finished, starting on detail.',
      links: ['https://example.com/sample-progress'],
      submittedBy: artistId,
    });

    // 5. Submitted and sitting with the leader for internal review.
    const inReview = created[4];
    tasksRepo.approvePay(db, guildId, inReview.id, { amountMinor: 1500, currency: 'USD', actorUserId: ownerId });
    tasksRepo.applyTransition(db, guildId, inReview.id, 'offer', {
      actorUserId: leaderId, patch: { artist_user_id: artistId },
    });
    const reviewOffer = offersRepo.createOffer(db, guildId, {
      taskId: inReview.id, artistUserId: artistId, offeredBy: leaderId, terms: {},
    });
    offersRepo.resolveOffer(db, guildId, reviewOffer.id, 'accepted', { actorUserId: artistId });
    tasksRepo.applyTransition(db, guildId, inReview.id, 'offer_accept', {
      actorUserId: artistId, patch: { accepted_at: now - 3 * DAY_MS },
    });
    submissionsRepo.addSubmission(db, guildId, inReview.id, {
      kind: 'final',
      notes: 'All deliverables attached.',
      links: ['https://example.com/sample-final'],
      checklist: configRepo.departmentChecklist(
        configRepo.getDepartment(db, guildId, inReview.department_id)
      ).map((item) => ({ item, included: true })),
      submittedBy: artistId,
    });
    tasksRepo.applyTransition(db, guildId, inReview.id, 'submit_final', {
      actorUserId: artistId, patch: { last_progress_at: now - DAY_MS },
    });

    // 6. All the way through: approved by the client, client paid, artist paid,
    //    and the split recorded. This is what the finished state looks like.
    const done = created[5];
    tasksRepo.approvePay(db, guildId, done.id, { amountMinor: 2500, currency: 'USD', actorUserId: ownerId });
    tasksRepo.applyTransition(db, guildId, done.id, 'offer', {
      actorUserId: leaderId, patch: { artist_user_id: artistId },
    });
    const doneOffer = offersRepo.createOffer(db, guildId, {
      taskId: done.id, artistUserId: artistId, offeredBy: leaderId, terms: {},
    });
    offersRepo.resolveOffer(db, guildId, doneOffer.id, 'accepted', { actorUserId: artistId });
    tasksRepo.applyTransition(db, guildId, done.id, 'offer_accept', {
      actorUserId: artistId, patch: { accepted_at: now - 6 * DAY_MS },
    });
    const finalSubmission = submissionsRepo.addSubmission(db, guildId, done.id, {
      kind: 'final',
      notes: 'Final files.',
      links: ['https://example.com/sample-delivered'],
      checklist: [],
      submittedBy: artistId,
    });
    tasksRepo.applyTransition(db, guildId, done.id, 'submit_final', { actorUserId: artistId });
    submissionsRepo.addReview(db, guildId, done.id, {
      submissionId: finalSubmission.id, reviewerUserId: leaderId, decision: 'ready_for_client',
    });
    tasksRepo.applyTransition(db, guildId, done.id, 'review_ready_for_client', { actorUserId: leaderId });
    submissionsRepo.addClientDecision(db, guildId, done.id, {
      submissionId: finalSubmission.id,
      decision: 'approved',
      feedback: 'Client was happy with it.',
      referenceUrl: 'https://discord.com/channels/0/0/0',
      recordedBy: ownerId,
    });
    tasksRepo.applyTransition(db, guildId, done.id, 'client_approve', { actorUserId: ownerId });

    paymentsRepo.recordPayment(db, guildId, {
      direction: paymentsRepo.DIRECTIONS.CLIENT_RECEIPT,
      projectId: project.id,
      amountMinor: 40000,
      currency: 'USD',
      methodLabel: 'PayPal',
      note: 'Sample client payment',
      recordedBy: ownerId,
      idempotencyKey: `sample-receipt:${project.id}`,
    });
    projectsRepo.markClientPaidInFull(db, guildId, project.id, ownerId);
    paymentState.recomputeProjectPaymentStates(db, guildId, project.id, ownerId);

    paymentsRepo.recordPayment(db, guildId, {
      direction: paymentsRepo.DIRECTIONS.PAYOUT,
      projectId: project.id,
      taskId: done.id,
      payeeUserId: artistId,
      amountMinor: 2500,
      currency: 'USD',
      methodLabel: 'PayPal',
      note: 'Sample artist payout',
      recordedBy: ownerId,
      idempotencyKey: `sample-payout:${done.id}`,
    });
    paymentState.recomputeTaskPaymentState(db, guildId, done.id, ownerId, 'Sample payout');
    allocationFlow.persistForTask(db, guildId, tasksRepo.getTask(db, guildId, done.id), ownerId);

    return {
      ok: true,
      project,
      taskCount: created.length,
      showcase: {
        queued: queued.code,
        payProposed: created[1].code,
        offered: offered.code,
        inProgress: inProgress.code,
        inReview: inReview.code,
        finished: done.code,
      },
    };
  })();
}

function listSampleProjects(db, guildId) {
  return db.prepare("SELECT * FROM projects WHERE guild_id = ? AND name LIKE ?")
    .all(guildId, `${SAMPLE_MARKER}%`);
}

/**
 * Removes the demonstration data. Tasks cascade with the project; payments keep
 * their rows by design but are cleared here because they never represented real
 * money.
 */
function removeSampleData(db, guildId) {
  const projects = listSampleProjects(db, guildId);
  let removedTasks = 0;

  db.transaction(() => {
    for (const project of projects) {
      removedTasks += db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE project_id = ?').get(project.id).n;
      db.prepare('DELETE FROM payments WHERE project_id = ?').run(project.id);
      db.prepare('DELETE FROM projects WHERE id = ?').run(project.id);
    }
  })();

  return { removedProjects: projects.length, removedTasks };
}

module.exports = { SAMPLE_MARKER, SAMPLE_CLIENT_REF, createSampleProject, listSampleProjects, removeSampleData };
