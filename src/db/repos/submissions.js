const { recordAudit } = require('./core');

/**
 * Submissions are append-only and versioned per task: a revision adds a new
 * version rather than overwriting what was sent before, so the history of what
 * was delivered and when survives.
 */
function addSubmission(db, guildId, taskId, {
  kind,
  notes = null,
  links = [],
  internalLinks = [],
  checklist = [],
  submittedBy,
}) {
  return db.transaction(() => {
    const row = db.prepare('SELECT COALESCE(MAX(version), 0) AS latest FROM submissions WHERE task_id = ?').get(taskId);
    const version = row.latest + 1;

    const submission = db.prepare(`
      INSERT INTO submissions (task_id, version, kind, notes, links_json, internal_links_json, checklist_json, submitted_by, submitted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *
    `).get(
      taskId, version, kind, notes, JSON.stringify(links), JSON.stringify(internalLinks),
      JSON.stringify(checklist), submittedBy, Date.now()
    );

    recordAudit(db, {
      guildId, actorUserId: submittedBy, action: `submission.${kind}`,
      entityType: 'task', entityId: taskId,
      after: { version, links: links.length, checklist },
    });
    return submission;
  })();
}

function listSubmissions(db, taskId, { kind = null } = {}) {
  if (kind) {
    return db.prepare('SELECT * FROM submissions WHERE task_id = ? AND kind = ? ORDER BY version').all(taskId, kind);
  }
  return db.prepare('SELECT * FROM submissions WHERE task_id = ? ORDER BY version').all(taskId);
}

function latestSubmission(db, taskId, { kind = null } = {}) {
  if (kind) {
    return db.prepare('SELECT * FROM submissions WHERE task_id = ? AND kind = ? ORDER BY version DESC LIMIT 1').get(taskId, kind) || null;
  }
  return db.prepare('SELECT * FROM submissions WHERE task_id = ? ORDER BY version DESC LIMIT 1').get(taskId) || null;
}

/** Recent submissions by one person, across every task they have worked on. */
function listRecentByUser(db, guildId, userId, { limit = 10 } = {}) {
  return db.prepare(`
    SELECT s.*, t.code AS task_code, t.title AS task_title, t.state AS task_state
    FROM submissions s
    JOIN tasks t ON t.id = s.task_id
    WHERE t.guild_id = ? AND s.submitted_by = ?
    ORDER BY s.submitted_at DESC LIMIT ?
  `).all(guildId, userId, limit);
}

function getSubmission(db, submissionId) {
  return db.prepare('SELECT * FROM submissions WHERE id = ?').get(submissionId) || null;
}

function links(submission) {
  try {
    const parsed = JSON.parse(submission?.links_json || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Source and working files. Never released to a client. */
function internalLinks(submission) {
  try {
    const parsed = JSON.parse(submission?.internal_links_json || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function checklist(submission) {
  try {
    const parsed = JSON.parse(submission?.checklist_json || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Releases one version to the client. Nothing is client-visible until a person
 * does this, which is what keeps internal working files off the dashboard.
 */
function markClientVisible(db, guildId, submissionId, actorUserId) {
  db.prepare(`
    UPDATE submissions SET client_visible_at = ?, client_visible_by = ?
    WHERE id = ? AND client_visible_at IS NULL
  `).run(Date.now(), actorUserId, submissionId);

  recordAudit(db, {
    guildId, actorUserId, action: 'submission.release', entityType: 'submission', entityId: submissionId,
    detail: 'Released to the client',
  });
  return getSubmission(db, submissionId);
}

/** An internal quality review by the group leader. Never a client decision. */
function addReview(db, guildId, taskId, { submissionId = null, reviewerUserId, decision, notes = null }) {
  const review = db.prepare(`
    INSERT INTO reviews (task_id, submission_id, reviewer_user_id, decision, notes, created_at)
    VALUES (?, ?, ?, ?, ?, ?) RETURNING *
  `).get(taskId, submissionId, reviewerUserId, decision, notes, Date.now());

  recordAudit(db, {
    guildId, actorUserId: reviewerUserId, action: `review.${decision}`,
    entityType: 'task', entityId: taskId,
    after: { submission_id: submissionId, decision }, detail: notes,
  });
  return review;
}

function listReviews(db, taskId) {
  return db.prepare('SELECT * FROM reviews WHERE task_id = ? ORDER BY created_at').all(taskId);
}

/**
 * What the client decided, as reported by the staff member who spoke to them.
 * Append-only, and always records who wrote it down and when, because the bot
 * has no direct contact with the client.
 */
function addClientDecision(db, guildId, taskId, {
  submissionId = null,
  decision,
  feedback = null,
  referenceUrl = null,
  outOfScope = false,
  recordedBy,
}) {
  const row = db.prepare(`
    INSERT INTO client_decisions (task_id, submission_id, decision, feedback, reference_url, out_of_scope, recorded_by, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *
  `).get(taskId, submissionId, decision, feedback, referenceUrl, outOfScope ? 1 : 0, recordedBy, Date.now());

  recordAudit(db, {
    guildId, actorUserId: recordedBy, action: `client.${decision}`,
    entityType: 'task', entityId: taskId,
    after: { decision, out_of_scope: outOfScope ? 1 : 0, reference_url: referenceUrl },
    detail: feedback,
  });
  return row;
}

function listClientDecisions(db, taskId) {
  return db.prepare('SELECT * FROM client_decisions WHERE task_id = ? ORDER BY recorded_at').all(taskId);
}

function latestClientDecision(db, taskId) {
  return db.prepare('SELECT * FROM client_decisions WHERE task_id = ? ORDER BY recorded_at DESC LIMIT 1').get(taskId) || null;
}

/** How many times the client has sent work back — used against the agreed scope. */
function revisionRoundsUsed(db, taskId) {
  return db.prepare(`
    SELECT COUNT(*) AS n FROM client_decisions WHERE task_id = ? AND decision = 'revisions_requested'
  `).get(taskId).n;
}

function fullHistory(db, taskId) {
  return {
    submissions: listSubmissions(db, taskId),
    reviews: listReviews(db, taskId),
    clientDecisions: listClientDecisions(db, taskId),
  };
}

module.exports = {
  addSubmission,
  listSubmissions,
  latestSubmission,
  listRecentByUser,
  getSubmission,
  links,
  internalLinks,
  checklist,
  markClientVisible,
  addReview,
  listReviews,
  addClientDecision,
  listClientDecisions,
  latestClientDecision,
  revisionRoundsUsed,
  fullHistory,
};
