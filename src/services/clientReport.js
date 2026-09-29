const tasksRepo = require('../db/repos/tasks');
const submissionsRepo = require('../db/repos/submissions');
const configRepo = require('../db/repos/config');
const { TASK_STATES } = require('../domain/taskState');
const { discordTimestamp } = require('../utils/time');

/**
 * Everything a client is told comes from here.
 *
 * Three rules are structural rather than a matter of care:
 *  - only client-facing facts are read at all: no artist names, no pay, no
 *    internal review notes, no internal source links
 *  - nothing is ever estimated. There are no completion percentages, no
 *    explanations for delays and no predicted dates: a missing deadline is
 *    reported as missing
 *  - building a report never writes to project records
 */

const BUCKETS = Object.freeze({
  IN_PRODUCTION: 'in_production',
  IN_STUDIO_REVIEW: 'in_studio_review',
  AWAITING_YOUR_APPROVAL: 'awaiting_your_approval',
  APPROVED_BY_YOU: 'approved_by_you',
  DELIVERED: 'delivered',
  PAUSED: 'paused',
  CANCELLED: 'cancelled',
});

const BUCKET_LABELS = Object.freeze({
  in_production: 'in progress',
  in_studio_review: 'in studio review',
  awaiting_your_approval: 'ready for your review',
  approved_by_you: 'approved by you',
  delivered: 'delivered',
  paused: 'paused',
  cancelled: 'cancelled',
});

/**
 * Deliberately does not expose whether a task is unassigned, offered or being
 * worked on: who is staffed to what is not the client's business.
 */
function bucketFor(task) {
  if (task.delivered_at) return BUCKETS.DELIVERED;

  switch (task.state) {
    case TASK_STATES.CLIENT_APPROVED:
      return BUCKETS.APPROVED_BY_YOU;
    case TASK_STATES.AWAITING_CLIENT:
      return BUCKETS.AWAITING_YOUR_APPROVAL;
    case TASK_STATES.INTERNAL_REVIEW:
      return BUCKETS.IN_STUDIO_REVIEW;
    case TASK_STATES.ON_HOLD:
      return BUCKETS.PAUSED;
    case TASK_STATES.CANCELLED:
      return BUCKETS.CANCELLED;
    default:
      return BUCKETS.IN_PRODUCTION;
  }
}

/** Submissions a person has explicitly released to the client, latest first. */
function clientVisibleSubmission(db, taskId) {
  return db.prepare(`
    SELECT * FROM submissions
    WHERE task_id = ? AND client_visible_at IS NOT NULL
    ORDER BY version DESC LIMIT 1
  `).get(taskId) || null;
}

function buildProjectReport(db, guildId, project, { now = Date.now() } = {}) {
  const tasks = tasksRepo.listTasksForProject(db, project.id);
  const live = tasks.filter((task) => task.state !== TASK_STATES.CANCELLED);

  const counts = Object.fromEntries(Object.values(BUCKETS).map((bucket) => [bucket, 0]));
  const awaitingApproval = [];
  const previews = [];
  const departments = new Map();
  let lastUpdatedAt = project.updated_at || project.created_at;

  for (const task of tasks) {
    const bucket = bucketFor(task);
    counts[bucket] += 1;
    if (task.updated_at > lastUpdatedAt) lastUpdatedAt = task.updated_at;

    const department = configRepo.getDepartment(db, guildId, task.department_id);
    const label = department?.name || 'Other';
    if (!departments.has(label)) departments.set(label, 0);
    if (task.state !== TASK_STATES.CANCELLED) departments.set(label, departments.get(label) + 1);

    const submission = clientVisibleSubmission(db, task.id);
    if (submission) {
      const entry = {
        taskId: task.id,
        code: task.code,
        title: task.title,
        version: submission.version,
        submissionId: submission.id,
        links: submissionsRepo.links(submission),
        releasedAt: submission.client_visible_at,
        bucket,
      };
      previews.push(entry);
      if (submission.client_visible_at > lastUpdatedAt) lastUpdatedAt = submission.client_visible_at;
      if (bucket === BUCKETS.AWAITING_YOUR_APPROVAL) awaitingApproval.push(entry);
    }
  }

  // Awaiting-approval items with nothing released yet are still counted, but
  // they cannot be reviewed, so they are reported separately rather than
  // implying a preview exists.
  const awaitingWithoutPreview = counts[BUCKETS.AWAITING_YOUR_APPROVAL] - awaitingApproval.length;

  const decisions = db.prepare(`
    SELECT cd.*, t.code, t.title FROM client_decisions cd
    JOIN tasks t ON t.id = cd.task_id
    WHERE t.project_id = ?
    ORDER BY cd.recorded_at DESC LIMIT 10
  `).all(project.id);

  const openRequests = db.prepare(`
    SELECT * FROM client_requests
    WHERE project_id = ? AND status IN ('open', 'in_progress')
    ORDER BY created_at DESC
  `).all(project.id);

  const missing = {
    deadline: project.deadline_utc === null || project.deadline_utc === undefined,
    tasks: tasks.length === 0,
    progressUpdate: live.length > 0 && previews.length === 0,
  };

  return {
    project,
    now,
    total: live.length,
    cancelled: counts[BUCKETS.CANCELLED],
    counts,
    departments: [...departments.entries()].map(([name, count]) => ({ name, count })),
    previews,
    awaitingApproval,
    awaitingWithoutPreview,
    decisions,
    openRequests,
    deadlineUtc: project.deadline_utc ?? null,
    lastUpdatedAt,
    missing,
    nextAction: nextActionFor({ counts, awaitingApproval, missing }),
  };
}

/**
 * What the client should do next, or plainly that there is nothing for them.
 * Never a prediction about what the studio will do.
 */
function nextActionFor({ counts, awaitingApproval, missing }) {
  if (awaitingApproval.length > 0) {
    return `Review the ${awaitingApproval.length} preview${awaitingApproval.length === 1 ? '' : 's'} below and approve or request changes.`;
  }
  if (counts[BUCKETS.AWAITING_YOUR_APPROVAL] > 0) {
    return 'Some items are marked ready for you, but no preview has been released yet. Ask the manager to send them.';
  }
  if (missing.tasks) return 'Nothing has been set up on this order yet.';
  if (counts[BUCKETS.IN_PRODUCTION] > 0 || counts[BUCKETS.IN_STUDIO_REVIEW] > 0) {
    return 'Nothing needed from you right now — work is with the studio.';
  }
  if (counts[BUCKETS.DELIVERED] > 0 && counts[BUCKETS.APPROVED_BY_YOU] === 0) {
    return 'Everything on this order has been delivered.';
  }
  return 'Nothing needed from you right now.';
}

function describeCounts(report) {
  const parts = [];
  const order = [
    BUCKETS.DELIVERED,
    BUCKETS.APPROVED_BY_YOU,
    BUCKETS.AWAITING_YOUR_APPROVAL,
    BUCKETS.IN_STUDIO_REVIEW,
    BUCKETS.IN_PRODUCTION,
    BUCKETS.PAUSED,
  ];

  for (const bucket of order) {
    const count = report.counts[bucket];
    if (count > 0) parts.push(`${count} ${BUCKET_LABELS[bucket]}`);
  }

  return parts.length > 0 ? parts.join(', ') : 'nothing set up yet';
}

function deadlineSentence(report) {
  if (report.deadlineUtc) {
    return `The agreed delivery date on record is ${discordTimestamp(report.deadlineUtc, 'D')}.`;
  }
  return 'No delivery date is recorded on this order. I will not guess one — use **Contact Manager** and I will pass it on.';
}

function lastUpdatedSentence(report) {
  return `_Information last updated ${discordTimestamp(report.lastUpdatedAt, 'R')}._`;
}

/**
 * Deterministic answers to the questions clients actually ask, drawn straight
 * from records. No model is involved, so nothing can be fabricated and the
 * answers work whether or not any AI service is reachable.
 */
const QUESTIONS = {
  whats_done: {
    label: "What's done?",
    answer(report) {
      const delivered = report.counts[BUCKETS.DELIVERED];
      const approved = report.counts[BUCKETS.APPROVED_BY_YOU];

      if (delivered + approved === 0) {
        return 'Nothing has been approved or delivered yet.';
      }
      const bits = [];
      if (approved > 0) bits.push(`${approved} item${approved === 1 ? '' : 's'} you have approved`);
      if (delivered > 0) bits.push(`${delivered} item${delivered === 1 ? '' : 's'} delivered`);
      return `So far: ${bits.join(' and ')}. Of ${report.total} item${report.total === 1 ? '' : 's'} on this order.`;
    },
  },
  in_progress: {
    label: "What's still being worked on?",
    answer(report) {
      const production = report.counts[BUCKETS.IN_PRODUCTION];
      const review = report.counts[BUCKETS.IN_STUDIO_REVIEW];
      const paused = report.counts[BUCKETS.PAUSED];

      if (production + review + paused === 0) return 'Nothing is currently in production.';
      const bits = [];
      if (production > 0) bits.push(`${production} in progress`);
      if (review > 0) bits.push(`${review} in studio review before it reaches you`);
      if (paused > 0) bits.push(`${paused} paused`);
      return `Currently: ${bits.join(', ')}.`;
    },
  },
  latest_preview: {
    label: 'Can I see the latest preview?',
    answer(report) {
      if (report.previews.length === 0) {
        return 'No previews have been released to you yet. Use **Contact Manager** if you expected one.';
      }
      const newest = [...report.previews].sort((a, b) => b.releasedAt - a.releasedAt)[0];
      return `The most recent preview released to you is **${newest.title}** (version ${newest.version}), ` +
        `sent ${discordTimestamp(newest.releasedAt, 'R')}. Use **View Previews** for all of them.`;
    },
  },
  delivery_date: {
    label: 'When is delivery?',
    answer(report) {
      return deadlineSentence(report);
    },
  },
  need_from_me: {
    label: 'What do you need from me?',
    answer(report) {
      const lines = [report.nextAction];
      if (report.openRequests.length > 0) {
        lines.push(`${report.openRequests.length} request${report.openRequests.length === 1 ? '' : 's'} from you ${report.openRequests.length === 1 ? 'is' : 'are'} still open with the studio.`);
      }
      return lines.join('\n');
    },
  },
  changes_made: {
    label: 'What changes have been made?',
    answer(report) {
      const revisions = report.decisions.filter((row) => row.decision === 'revisions_requested');
      if (revisions.length === 0) {
        return 'No change requests are recorded on this order yet.';
      }
      const lines = revisions.slice(0, 5).map((row) =>
        `• **${row.title}** — changes requested ${discordTimestamp(row.recorded_at, 'd')}` +
        `${row.feedback ? `: ${String(row.feedback).slice(0, 200)}` : ''}`
      );
      return `${revisions.length} change request${revisions.length === 1 ? '' : 's'} recorded:\n${lines.join('\n')}`;
    },
  },
  items_left: {
    label: 'How many items are left?',
    answer(report) {
      const outstanding = report.counts[BUCKETS.IN_PRODUCTION] +
        report.counts[BUCKETS.IN_STUDIO_REVIEW] +
        report.counts[BUCKETS.AWAITING_YOUR_APPROVAL] +
        report.counts[BUCKETS.PAUSED];

      if (report.total === 0) return 'Nothing has been set up on this order yet.';
      return `${outstanding} of ${report.total} item${report.total === 1 ? '' : 's'} ${outstanding === 1 ? 'is' : 'are'} still outstanding. ` +
        `Breakdown: ${describeCounts(report)}.`;
    },
  },
  order_more: {
    label: 'Can I order more?',
    answer() {
      return 'Yes — use **Request Another Service** and it goes to the studio owner. ' +
        'Pricing and delivery dates are always confirmed by the owner before anything is agreed.';
    },
  },
};

/**
 * The headline status paragraph, in the shape of the studio's own example.
 * Counts only: no percentages, no predictions.
 */
function statusParagraph(report) {
  if (report.total === 0) {
    return `**${report.project.name}** has no items set up yet.`;
  }

  const lines = [
    `Your order contains ${report.total} item${report.total === 1 ? '' : 's'}: ${describeCounts(report)}.`,
    `**Your next action:** ${report.nextAction}`,
    deadlineSentence(report),
  ];

  if (report.missing.progressUpdate) {
    lines.push('No preview has been released to you on this order yet.');
  }
  if (report.cancelled > 0) {
    lines.push(`${report.cancelled} item${report.cancelled === 1 ? '' : 's'} on this order ${report.cancelled === 1 ? 'was' : 'were'} cancelled.`);
  }

  return lines.join('\n');
}

function answerQuestion(kind, report) {
  const question = QUESTIONS[kind];
  if (!question) return null;
  return {
    label: question.label,
    body: `${question.answer(report)}\n\n${lastUpdatedSentence(report)}`,
  };
}

module.exports = {
  BUCKETS,
  BUCKET_LABELS,
  QUESTIONS,
  bucketFor,
  clientVisibleSubmission,
  buildProjectReport,
  nextActionFor,
  describeCounts,
  deadlineSentence,
  lastUpdatedSentence,
  statusParagraph,
  answerQuestion,
};
