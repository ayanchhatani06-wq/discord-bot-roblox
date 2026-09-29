const { nextCode, recordAudit } = require('./core');

/**
 * Procedures, trials, recommendations, temporary leadership and offboarding.
 *
 * No Discord code here, deliberately: the same rules have to hold when the
 * website reads them.
 */

const TRIAL_STATES = Object.freeze({
  OFFERED: 'offered',
  ACCEPTED: 'accepted',
  DECLINED: 'declined',
  SUBMITTED: 'submitted',
  PASSED: 'passed',
  FAILED: 'failed',
  WITHDRAWN: 'withdrawn',
});

const OPEN_TRIAL_STATES = Object.freeze([
  TRIAL_STATES.OFFERED,
  TRIAL_STATES.ACCEPTED,
  TRIAL_STATES.SUBMITTED,
]);

// ---------------------------------------------------------------------------
// Procedures
// ---------------------------------------------------------------------------

/**
 * Creates a procedure, or replaces an existing one's text.
 *
 * Changing the text raises the version, which is what makes every prior
 * acknowledgement stale: somebody who agreed to version 1 has not agreed to
 * version 2, and the bot must not pretend otherwise.
 */
function upsertProcedure(db, guildId, { key, title, body, audience = 'all', departmentId = null }, actorUserId) {
  const now = Date.now();
  const existing = getProcedure(db, guildId, key);

  if (!existing) {
    const created = db.prepare(`
      INSERT INTO procedures (guild_id, key, title, body, audience, department_id, created_by, created_at, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *
    `).get(guildId, key, title, body, audience, departmentId, actorUserId, now, actorUserId, now);

    recordAudit(db, {
      guildId, actorUserId, action: 'procedure.create', entityType: 'procedure', entityId: created.id,
      after: { key, title, version: 1 },
    });
    return { procedure: created, versionChanged: false };
  }

  const textChanged = existing.title !== title || existing.body !== body;
  const version = textChanged ? existing.version + 1 : existing.version;

  db.prepare(`
    UPDATE procedures SET title = ?, body = ?, audience = ?, department_id = ?, version = ?, updated_by = ?, updated_at = ?
    WHERE id = ?
  `).run(title, body, audience, departmentId, version, actorUserId, now, existing.id);

  recordAudit(db, {
    guildId, actorUserId, action: 'procedure.update', entityType: 'procedure', entityId: existing.id,
    before: { version: existing.version },
    after: { version },
    detail: textChanged
      ? 'Text changed, so everybody must acknowledge the new version.'
      : 'Audience or scope changed; acknowledgements stand.',
  });

  return { procedure: getProcedure(db, guildId, key), versionChanged: textChanged };
}

function getProcedure(db, guildId, key) {
  return db.prepare('SELECT * FROM procedures WHERE guild_id = ? AND key = ?').get(guildId, key) || null;
}

function getProcedureById(db, guildId, id) {
  return db.prepare('SELECT * FROM procedures WHERE guild_id = ? AND id = ?').get(guildId, id) || null;
}

function listProcedures(db, guildId, { activeOnly = true } = {}) {
  const sql = activeOnly
    ? 'SELECT * FROM procedures WHERE guild_id = ? AND active = 1 ORDER BY title'
    : 'SELECT * FROM procedures WHERE guild_id = ? ORDER BY title';
  return db.prepare(sql).all(guildId);
}

function setProcedureActive(db, guildId, key, active, actorUserId) {
  db.prepare('UPDATE procedures SET active = ?, updated_by = ?, updated_at = ? WHERE guild_id = ? AND key = ?')
    .run(active ? 1 : 0, actorUserId, Date.now(), guildId, key);
  recordAudit(db, {
    guildId, actorUserId, action: 'procedure.active', entityType: 'procedure', entityId: key, after: { active },
  });
  return getProcedure(db, guildId, key);
}

/** Which procedures apply to this person, given how they sit in the studio. */
function proceduresFor(db, guildId, { departmentId = null, isLeader = false } = {}) {
  return listProcedures(db, guildId).filter((procedure) => {
    if (procedure.audience === 'all') return true;
    if (procedure.audience === 'leaders') return isLeader;
    return procedure.department_id !== null && procedure.department_id === departmentId;
  });
}

function acknowledge(db, guildId, procedureId, userId) {
  const procedure = getProcedureById(db, guildId, procedureId);
  if (!procedure) return { ok: false, reason: 'not_found' };

  const result = db.prepare(`
    INSERT INTO procedure_acknowledgements (guild_id, procedure_id, user_id, version, acknowledged_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (procedure_id, user_id, version) DO NOTHING
  `).run(guildId, procedureId, userId, procedure.version, Date.now());

  if (result.changes > 0) {
    recordAudit(db, {
      guildId, actorUserId: userId, action: 'procedure.acknowledge',
      entityType: 'procedure', entityId: procedureId,
      after: { version: procedure.version },
    });
  }

  return { ok: true, procedure, alreadyAcknowledged: result.changes === 0 };
}

/** Whether this person has acknowledged the *current* version, not any version. */
function hasAcknowledged(db, procedure, userId) {
  return Boolean(db.prepare(`
    SELECT 1 FROM procedure_acknowledgements
    WHERE procedure_id = ? AND user_id = ? AND version = ?
  `).get(procedure.id, userId, procedure.version));
}

function outstandingProcedures(db, guildId, userId, context = {}) {
  return proceduresFor(db, guildId, context).filter((procedure) => !hasAcknowledged(db, procedure, userId));
}

function acknowledgementsFor(db, guildId, procedureId) {
  return db.prepare(`
    SELECT * FROM procedure_acknowledgements WHERE guild_id = ? AND procedure_id = ?
    ORDER BY acknowledged_at DESC
  `).all(guildId, procedureId);
}

// ---------------------------------------------------------------------------
// Trials
// ---------------------------------------------------------------------------

function createTrial(db, guildId, {
  userId, departmentId = null, title, brief, terms,
  payMinor = null, payCurrency = null, deadlineUtc = null,
}, actorUserId) {
  return db.transaction(() => {
    const now = Date.now();
    const code = nextCode(db, guildId, 'trial');

    const trial = db.prepare(`
      INSERT INTO trials (guild_id, code, user_id, department_id, title, brief, terms,
        pay_minor, pay_currency, deadline_utc, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *
    `).get(guildId, code, userId, departmentId, title, brief, terms,
      payMinor, payCurrency, deadlineUtc, actorUserId, now, now);

    recordAudit(db, {
      guildId, actorUserId, action: 'trial.create', entityType: 'trial', entityId: trial.id,
      after: { code, user_id: userId, pay_minor: payMinor, pay_currency: payCurrency, deadline_utc: deadlineUtc },
    });
    return trial;
  })();
}

function getTrial(db, guildId, id) {
  return db.prepare('SELECT * FROM trials WHERE guild_id = ? AND id = ?').get(guildId, id) || null;
}

function getTrialByCode(db, guildId, code) {
  return db.prepare('SELECT * FROM trials WHERE guild_id = ? AND code = ?').get(guildId, String(code).toUpperCase()) || null;
}

function listTrials(db, guildId, { status = null, userId = null, limit = 50 } = {}) {
  const clauses = ['guild_id = ?'];
  const params = [guildId];

  if (status === 'open') clauses.push(`status IN ('${OPEN_TRIAL_STATES.join("','")}')`);
  else if (status) { clauses.push('status = ?'); params.push(status); }
  if (userId) { clauses.push('user_id = ?'); params.push(userId); }

  return db.prepare(`
    SELECT * FROM trials WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT ?
  `).all(...params, limit);
}

/**
 * Moves a trial on, but only from a state it may legally move from.
 *
 * The check and the write share one statement, so a second click cannot land
 * between them and decide the same trial twice.
 */
function setTrialStatus(db, guildId, id, status, { from, actorUserId, columns = {} }) {
  const setPairs = ['status = ?', 'updated_at = ?'];
  const values = [status, Date.now()];

  for (const [column, value] of Object.entries(columns)) {
    setPairs.push(`${column} = ?`);
    values.push(value);
  }

  const fromList = Array.isArray(from) ? from : [from];
  const result = db.prepare(`
    UPDATE trials SET ${setPairs.join(', ')}
    WHERE guild_id = ? AND id = ? AND status IN (${fromList.map(() => '?').join(', ')})
  `).run(...values, guildId, id, ...fromList);

  if (result.changes === 0) return null;

  recordAudit(db, {
    guildId, actorUserId, action: `trial.${status}`, entityType: 'trial', entityId: id,
    before: { status: fromList.join('/') }, after: { status },
  });
  return getTrial(db, guildId, id);
}

// ---------------------------------------------------------------------------
// Recommendations
// ---------------------------------------------------------------------------

function createRecommendation(db, guildId, { subjectUserId, kind, departmentId = null, note }, actorUserId) {
  const recommendation = db.prepare(`
    INSERT INTO recommendations (guild_id, subject_user_id, kind, department_id, note, recommended_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *
  `).get(guildId, subjectUserId, kind, departmentId, note, actorUserId, Date.now());

  recordAudit(db, {
    guildId, actorUserId, action: 'recommendation.create', entityType: 'recommendation', entityId: recommendation.id,
    after: { subject_user_id: subjectUserId, kind },
    detail: 'A recommendation only. Roles are granted in Discord by whoever the studio allows.',
  });
  return recommendation;
}

function listRecommendations(db, guildId, { status = 'pending', subjectUserId = null, limit = 50 } = {}) {
  const clauses = ['guild_id = ?'];
  const params = [guildId];
  if (status !== 'all') { clauses.push('status = ?'); params.push(status); }
  if (subjectUserId) { clauses.push('subject_user_id = ?'); params.push(subjectUserId); }

  return db.prepare(`
    SELECT * FROM recommendations WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT ?
  `).all(...params, limit);
}

function getRecommendation(db, guildId, id) {
  return db.prepare('SELECT * FROM recommendations WHERE guild_id = ? AND id = ?').get(guildId, id) || null;
}

function decideRecommendation(db, guildId, id, { accept, actorUserId, note = null }) {
  const result = db.prepare(`
    UPDATE recommendations SET status = ?, decided_by = ?, decided_at = ?, decision_note = ?
    WHERE guild_id = ? AND id = ? AND status = 'pending'
  `).run(accept ? 'accepted' : 'declined', actorUserId, Date.now(), note, guildId, id);

  if (result.changes === 0) return null;

  recordAudit(db, {
    guildId, actorUserId, action: accept ? 'recommendation.accept' : 'recommendation.decline',
    entityType: 'recommendation', entityId: id, detail: note,
  });
  return getRecommendation(db, guildId, id);
}

// ---------------------------------------------------------------------------
// Backup leaders
// ---------------------------------------------------------------------------

function grantBackupLeader(db, guildId, { departmentId, userId, responsibilities, startsAt, expiresAt }, actorUserId) {
  const now = Date.now();
  const grant = db.prepare(`
    INSERT INTO backup_leaders (guild_id, department_id, user_id, responsibilities, starts_at, expires_at, granted_by, granted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *
  `).get(guildId, departmentId, userId, responsibilities, startsAt, expiresAt, actorUserId, now);

  recordAudit(db, {
    guildId, actorUserId, action: 'backup_leader.grant', entityType: 'department', entityId: departmentId,
    after: { user_id: userId, starts_at: startsAt, expires_at: expiresAt, responsibilities },
    detail: 'Temporary. It ends at the stated time whether or not anybody revokes it.',
  });
  return grant;
}

function revokeBackupLeader(db, guildId, id, actorUserId) {
  const result = db.prepare(`
    UPDATE backup_leaders SET revoked_at = ?, revoked_by = ? WHERE guild_id = ? AND id = ? AND revoked_at IS NULL
  `).run(Date.now(), actorUserId, guildId, id);

  if (result.changes === 0) return null;
  recordAudit(db, { guildId, actorUserId, action: 'backup_leader.revoke', entityType: 'backup_leader', entityId: id });
  return db.prepare('SELECT * FROM backup_leaders WHERE id = ?').get(id);
}

/**
 * Departments this person currently stands in for.
 *
 * The window is evaluated on every call rather than cleaned up by a job, so an
 * expired grant confers nothing even if the bot was offline when it lapsed.
 */
function activeBackupDepartmentIds(db, guildId, userId, now = Date.now()) {
  return db.prepare(`
    SELECT department_id FROM backup_leaders
    WHERE guild_id = ? AND user_id = ? AND revoked_at IS NULL AND starts_at <= ? AND expires_at > ?
  `).all(guildId, userId, now, now).map((row) => row.department_id);
}

function listBackupLeaders(db, guildId, { includeExpired = false, now = Date.now() } = {}) {
  if (includeExpired) {
    return db.prepare('SELECT * FROM backup_leaders WHERE guild_id = ? ORDER BY expires_at DESC').all(guildId);
  }
  return db.prepare(`
    SELECT * FROM backup_leaders
    WHERE guild_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY expires_at
  `).all(guildId, now);
}

// ---------------------------------------------------------------------------
// Departures
// ---------------------------------------------------------------------------

function recordDeparture(db, guildId, { userId, reason = null, handoverNote = null, snapshot }, actorUserId) {
  const departure = db.prepare(`
    INSERT INTO departures (guild_id, user_id, reason, handover_note, snapshot_json, started_by, started_at)
    VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *
  `).get(guildId, userId, reason, handoverNote, JSON.stringify(snapshot), actorUserId, Date.now());

  recordAudit(db, {
    guildId, actorUserId, action: 'departure.start', entityType: 'staff', entityId: userId,
    after: { reason },
    detail: 'Records what was left behind. Nothing is deleted.',
  });
  return departure;
}

function completeDeparture(db, guildId, id, actorUserId) {
  const result = db.prepare(`
    UPDATE departures SET completed_by = ?, completed_at = ? WHERE guild_id = ? AND id = ? AND completed_at IS NULL
  `).run(actorUserId, Date.now(), guildId, id);
  if (result.changes === 0) return null;

  recordAudit(db, { guildId, actorUserId, action: 'departure.complete', entityType: 'departure', entityId: id });
  return db.prepare('SELECT * FROM departures WHERE id = ?').get(id);
}

function listDepartures(db, guildId, { openOnly = false, limit = 25 } = {}) {
  const sql = openOnly
    ? 'SELECT * FROM departures WHERE guild_id = ? AND completed_at IS NULL ORDER BY started_at DESC LIMIT ?'
    : 'SELECT * FROM departures WHERE guild_id = ? ORDER BY started_at DESC LIMIT ?';
  return db.prepare(sql).all(guildId, limit);
}

module.exports = {
  TRIAL_STATES,
  OPEN_TRIAL_STATES,
  upsertProcedure,
  getProcedure,
  getProcedureById,
  listProcedures,
  setProcedureActive,
  proceduresFor,
  acknowledge,
  hasAcknowledged,
  outstandingProcedures,
  acknowledgementsFor,
  createTrial,
  getTrial,
  getTrialByCode,
  listTrials,
  setTrialStatus,
  createRecommendation,
  listRecommendations,
  getRecommendation,
  decideRecommendation,
  grantBackupLeader,
  revokeBackupLeader,
  activeBackupDepartmentIds,
  listBackupLeaders,
  recordDeparture,
  completeDeparture,
  listDepartures,
};
