const tasksRepo = require('../db/repos/tasks');
const projectsRepo = require('../db/repos/projects');
const paymentState = require('./paymentState');
const { TASK_STATES, ACTIVE_STATES } = require('../domain/taskState');

/**
 * Reports over what the studio has actually recorded.
 *
 * Two rules shape this file. First, waiting time is attributed honestly: time
 * a job spends with the client is not the artist's delay, and lumping them
 * together produces numbers that blame the wrong person. Second, nothing here
 * ranks people. A league table of task counts rewards whoever takes the small
 * jobs, so the staff view is alphabetical and carries its own caveat.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Which side of the studio each state's waiting time belongs to. */
const WAITING_OWNER = Object.freeze({
  [TASK_STATES.UNASSIGNED]: 'studio',
  [TASK_STATES.OFFERED]: 'studio',
  [TASK_STATES.IN_PROGRESS]: 'studio',
  [TASK_STATES.INTERNAL_REVIEW]: 'studio',
  [TASK_STATES.REVISION_NEEDED]: 'studio',
  [TASK_STATES.AWAITING_CLIENT]: 'client',
  [TASK_STATES.ON_HOLD]: 'hold',
  [TASK_STATES.CLIENT_APPROVED]: 'done',
  [TASK_STATES.CANCELLED]: 'done',
});

/**
 * Reconstructs when a task was in which state, from the audit trail.
 *
 * The audit log is the record of what happened, so the timeline is derived
 * rather than stored a second time: a separate history table could disagree
 * with the audit trail, and then neither could be trusted.
 */
function stateTimeline(db, guildId, task, { now = Date.now() } = {}) {
  const rows = db.prepare(`
    SELECT after_json, created_at FROM audit_log
    WHERE guild_id = ? AND entity_type = 'task' AND entity_id = ? AND action LIKE 'task.%'
    ORDER BY created_at, id
  `).all(guildId, String(task.id));

  const segments = [];
  let currentState = TASK_STATES.UNASSIGNED;
  let since = task.created_at;

  for (const row of rows) {
    let after = null;
    try {
      after = row.after_json ? JSON.parse(row.after_json) : null;
    } catch {
      after = null;
    }
    if (!after?.state || after.state === currentState) continue;

    segments.push({ state: currentState, from: since, to: row.created_at });
    currentState = after.state;
    since = row.created_at;
  }

  segments.push({ state: currentState, from: since, to: now, open: true });
  return segments.filter((segment) => segment.to > segment.from);
}

/**
 * How long a task has been waiting, split by whose wait it is.
 *
 * A job sitting with a client for three weeks is not a slow artist, and a
 * report that cannot tell the difference will get somebody blamed unfairly.
 */
function waitingBreakdown(db, guildId, task, { now = Date.now() } = {}) {
  const totals = { studio: 0, client: 0, hold: 0, done: 0 };

  for (const segment of stateTimeline(db, guildId, task, { now })) {
    const owner = WAITING_OWNER[segment.state] || 'studio';
    totals[owner] += segment.to - segment.from;
  }

  return {
    ...totals,
    totalMs: totals.studio + totals.client + totals.hold,
    currentState: task.state,
    currentSince: stateTimeline(db, guildId, task, { now }).at(-1)?.from ?? task.created_at,
  };
}

/** The same split across a project, so "why is this late" has an answer. */
function projectWaiting(db, guildId, projectId, { now = Date.now() } = {}) {
  const totals = { studio: 0, client: 0, hold: 0 };
  const tasks = tasksRepo.listTasksForProject(db, projectId)
    .filter((task) => task.state !== TASK_STATES.CANCELLED);

  for (const task of tasks) {
    const breakdown = waitingBreakdown(db, guildId, task, { now });
    totals.studio += breakdown.studio;
    totals.client += breakdown.client;
    totals.hold += breakdown.hold;
  }

  return { ...totals, tasks: tasks.length };
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

const FILTERS = Object.freeze({
  UNASSIGNED: 'unassigned',
  OVERDUE: 'overdue',
  DUE_SOON: 'due_soon',
  AWAITING_CLIENT: 'awaiting_client',
  IN_REVISION: 'in_revision',
  NO_PROGRESS: 'no_progress',
  UNPAID: 'unpaid',
  NO_DEADLINE: 'no_deadline',
  BLOCKED: 'blocked',
});

const FILTER_LABELS = Object.freeze({
  unassigned: 'Nobody is doing it',
  overdue: 'Past its deadline',
  due_soon: 'Due within three days',
  awaiting_client: 'Waiting on the client',
  in_revision: 'Back with the artist for changes',
  no_progress: 'No progress update in a while',
  unpaid: 'Approved but somebody is still owed',
  no_deadline: 'No deadline agreed',
  blocked: 'Blocked by something',
});

/**
 * Tasks matching a filter. Each filter is a plain question a person would ask,
 * rather than a query language nobody will remember.
 */
function filterTasks(db, guildId, filter, { departmentId = null, now = Date.now(), staleDays = 3 } = {}) {
  const inDepartment = (task) => departmentId === null || task.department_id === departmentId;

  const pick = (states) => tasksRepo.listTasksInStates(db, guildId, states).filter(inDepartment);

  switch (filter) {
    case FILTERS.UNASSIGNED:
      return pick([TASK_STATES.UNASSIGNED]);

    case FILTERS.AWAITING_CLIENT:
      return pick([TASK_STATES.AWAITING_CLIENT]);

    case FILTERS.IN_REVISION:
      return pick([TASK_STATES.REVISION_NEEDED]);

    case FILTERS.OVERDUE:
      return pick([...ACTIVE_STATES, TASK_STATES.AWAITING_CLIENT])
        .filter((task) => task.deadline_utc && task.deadline_utc < now);

    case FILTERS.DUE_SOON:
      return pick([...ACTIVE_STATES, TASK_STATES.AWAITING_CLIENT])
        .filter((task) => task.deadline_utc && task.deadline_utc >= now && task.deadline_utc - now <= 3 * DAY_MS);

    case FILTERS.NO_DEADLINE:
      return pick([...ACTIVE_STATES, TASK_STATES.UNASSIGNED]).filter((task) => !task.deadline_utc);

    case FILTERS.NO_PROGRESS:
      // Only work somebody is actually holding: an unassigned task has nobody
      // to chase, and calling it stale would be blaming a vacancy.
      return pick([TASK_STATES.IN_PROGRESS, TASK_STATES.REVISION_NEEDED])
        .filter((task) => (task.last_progress_at || task.updated_at) < now - staleDays * DAY_MS);

    case FILTERS.UNPAID:
      return pick([TASK_STATES.CLIENT_APPROVED])
        .filter((task) => paymentState.settlementOf(db, task).outstanding > 0);

    case FILTERS.BLOCKED: {
      const blocked = new Set(
        db.prepare(`
          SELECT DISTINCT task_id FROM task_blockers WHERE guild_id = ? AND status = 'open'
        `).all(guildId).map((row) => row.task_id)
      );
      return pick([...ACTIVE_STATES, TASK_STATES.ON_HOLD]).filter((task) => blocked.has(task.id));
    }

    default:
      return [];
  }
}

function filterCounts(db, guildId, { departmentId = null, now = Date.now() } = {}) {
  return Object.fromEntries(
    Object.values(FILTERS).map((filter) => [filter, filterTasks(db, guildId, filter, { departmentId, now }).length])
  );
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

const NO_RANKING_NOTE =
  'Not a league table. Counts depend on what each person was given, so somebody ' +
  'who took three large jobs will always look slower than somebody who took ten small ones.';

/**
 * A rounded picture of one person's work.
 *
 * Deliberately returns no score and no position. The caller cannot sort by
 * "best" because there is no such number here to sort by.
 */
function personPicture(db, guildId, userId, { since = 0, now = Date.now() } = {}) {
  const tasks = db.prepare(`
    SELECT DISTINCT t.* FROM tasks t
    LEFT JOIN task_contributors c ON c.task_id = t.id AND c.removed_at IS NULL
    WHERE t.guild_id = ? AND (t.artist_user_id = ? OR c.user_id = ?) AND t.created_at >= ?
  `).all(guildId, userId, userId, since);

  const approved = tasks.filter((task) => task.state === TASK_STATES.CLIENT_APPROVED);
  const active = tasks.filter((task) => ACTIVE_STATES.includes(task.state));

  // On time is measured against the deadline that was agreed, and only for
  // work that had one; work with no deadline cannot be late.
  const withDeadline = approved.filter((task) => task.deadline_utc && task.completed_at);
  const onTime = withDeadline.filter((task) => task.completed_at <= task.deadline_utc);

  const revisionRounds = db.prepare(`
    SELECT COUNT(*) AS n FROM client_decisions d
    JOIN tasks t ON t.id = d.task_id
    WHERE t.guild_id = ? AND t.artist_user_id = ? AND d.decision = 'revisions_requested'
  `).get(guildId, userId).n;

  const studioTime = approved.reduce((sum, task) => sum + waitingBreakdown(db, guildId, task, { now }).studio, 0);

  return {
    userId,
    approved: approved.length,
    active: active.length,
    onTime: onTime.length,
    measuredForTimeliness: withDeadline.length,
    revisionRounds,
    medianStudioDays: approved.length === 0 ? null : Math.round(studioTime / approved.length / DAY_MS),
    note: NO_RANKING_NOTE,
  };
}

/** Everybody's picture, ordered by name so the list itself implies no ranking. */
function peoplePictures(db, guildId, userIds, options = {}) {
  return userIds
    .map((userId) => personPicture(db, guildId, userId, options))
    .sort((a, b) => a.userId.localeCompare(b.userId));
}

// ---------------------------------------------------------------------------
// Money and pipeline
// ---------------------------------------------------------------------------

function payoutsOutstanding(db, guildId) {
  const rows = [];
  for (const task of tasksRepo.listTasksInStates(db, guildId, [TASK_STATES.CLIENT_APPROVED])) {
    for (const entry of paymentState.owedOnTask(db, task)) {
      if (entry.remainingMinor > 0) rows.push({ task, ...entry });
    }
  }
  return rows;
}

function enquiryFunnel(db, guildId, { since = 0 } = {}) {
  const rows = db.prepare(`
    SELECT status, COUNT(*) AS n FROM enquiries WHERE guild_id = ? AND created_at >= ? GROUP BY status
  `).all(guildId, since);
  return Object.fromEntries(rows.map((row) => [row.status, row.n]));
}

function projectsNeedingAttention(db, guildId, { now = Date.now() } = {}) {
  const results = [];

  for (const project of projectsRepo.listProjects(db, guildId, { status: 'active', limit: 200 })) {
    const waiting = projectWaiting(db, guildId, project.id, { now });
    const overdue = project.deadline_utc && project.deadline_utc < now;
    const stalled = waiting.studio > 14 * DAY_MS && waiting.tasks > 0;

    if (overdue || stalled) {
      results.push({ project, waiting, overdue: Boolean(overdue), stalled });
    }
  }

  return results;
}

module.exports = {
  DAY_MS,
  FILTERS,
  FILTER_LABELS,
  WAITING_OWNER,
  NO_RANKING_NOTE,
  stateTimeline,
  waitingBreakdown,
  projectWaiting,
  filterTasks,
  filterCounts,
  personPicture,
  peoplePictures,
  payoutsOutstanding,
  enquiryFunnel,
  projectsNeedingAttention,
};
