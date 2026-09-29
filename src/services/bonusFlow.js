const configRepo = require('../db/repos/config');
const contributorsRepo = require('../db/repos/contributors');
const { recordAudit } = require('../db/repos/core');
const { TASK_STATES } = require('../domain/taskState');

/**
 * Bonus milestones, such as "every 10 approved animations".
 *
 * Counting is cumulative and milestones are indexed, so the tenth approved
 * item can only ever earn milestone 1. Re-running the evaluation is therefore
 * harmless: a unique key on (rule, person, milestone) makes double counting
 * impossible even if two evaluations race.
 */

function upsertRule(db, guildId, { key, label, departmentId = null, threshold, amountMinor, currency }, actorUserId) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO bonus_rules (guild_id, key, label, department_id, threshold, amount_minor, currency, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (guild_id, key) DO UPDATE SET
      label = excluded.label, department_id = excluded.department_id, threshold = excluded.threshold,
      amount_minor = excluded.amount_minor, currency = excluded.currency, updated_at = excluded.updated_at
  `).run(guildId, key, label, departmentId, threshold, amountMinor, currency, actorUserId, now, now);

  const rule = getRule(db, guildId, key);
  recordAudit(db, {
    guildId, actorUserId, action: 'bonus_rule.upsert', entityType: 'bonus_rule', entityId: rule.id,
    after: { key, threshold, amount_minor: amountMinor, currency },
  });
  return rule;
}

function getRule(db, guildId, key) {
  return db.prepare('SELECT * FROM bonus_rules WHERE guild_id = ? AND key = ?').get(guildId, key) || null;
}

function listRules(db, guildId, { activeOnly = false } = {}) {
  const sql = activeOnly
    ? 'SELECT * FROM bonus_rules WHERE guild_id = ? AND active = 1 ORDER BY label'
    : 'SELECT * FROM bonus_rules WHERE guild_id = ? ORDER BY label';
  return db.prepare(sql).all(guildId);
}

function setRuleActive(db, guildId, key, active, actorUserId) {
  db.prepare('UPDATE bonus_rules SET active = ?, updated_at = ? WHERE guild_id = ? AND key = ?')
    .run(active ? 1 : 0, Date.now(), guildId, key);
  recordAudit(db, {
    guildId, actorUserId, action: 'bonus_rule.active', entityType: 'bonus_rule', entityId: key, after: { active },
  });
  return getRule(db, guildId, key);
}

/**
 * How much work counts toward a rule for one person.
 *
 * Only client-approved work counts, and each task counts once per person even
 * if they contributed in several ways to it.
 */
function qualifyingCount(db, guildId, rule, userId) {
  // Named parameters keep the repeated user id unambiguous.
  const departmentClause = rule.department_id ? 'AND t.department_id = @departmentId' : '';

  const row = db.prepare(`
    SELECT COUNT(DISTINCT t.id) AS n FROM tasks t
    LEFT JOIN task_contributors c ON c.task_id = t.id AND c.removed_at IS NULL
    WHERE t.guild_id = @guildId
      AND (t.artist_user_id = @userId OR c.user_id = @userId)
      AND t.state = @state
      ${departmentClause}
  `).get({
    guildId,
    userId,
    state: TASK_STATES.CLIENT_APPROVED,
    ...(rule.department_id ? { departmentId: rule.department_id } : {}),
  });

  return row.n;
}

/**
 * Creates awards for milestones newly reached. Never pays anything: awards
 * start pending and wait for the owner.
 */
function evaluateForUser(db, guildId, userId, { actorUserId = null } = {}) {
  const created = [];

  for (const rule of listRules(db, guildId, { activeOnly: true })) {
    const count = qualifyingCount(db, guildId, rule, userId);
    const earned = Math.floor(count / rule.threshold);
    if (earned === 0) continue;

    const highest = db.prepare(`
      SELECT COALESCE(MAX(milestone_index), 0) AS highest FROM bonus_awards
      WHERE rule_id = ? AND user_id = ?
    `).get(rule.id, userId).highest;

    for (let milestone = highest + 1; milestone <= earned; milestone += 1) {
      try {
        const award = db.prepare(`
          INSERT INTO bonus_awards (guild_id, rule_id, user_id, milestone_index, qualifying_count, amount_minor, currency, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *
        `).get(guildId, rule.id, userId, milestone, milestone * rule.threshold, rule.amount_minor, rule.currency, Date.now());

        created.push({ award, rule });
        recordAudit(db, {
          guildId, actorUserId, action: 'bonus.earned', entityType: 'bonus_award', entityId: award.id,
          after: { user_id: userId, rule: rule.key, milestone, amount_minor: rule.amount_minor },
          detail: 'Flagged for owner approval; nothing is payable yet.',
        });
      } catch (error) {
        // The unique key did its job: this milestone already exists.
        if (!String(error.message).includes('UNIQUE')) throw error;
      }
    }
  }

  return created;
}

/** Everyone who worked on a task, so approval can trigger an evaluation. */
function participantsOf(db, task) {
  const people = new Set();
  if (task.artist_user_id) people.add(task.artist_user_id);
  for (const contributor of contributorsRepo.listForTask(db, task.id)) people.add(contributor.user_id);
  return [...people];
}

function evaluateForTask(db, guildId, task, { actorUserId = null } = {}) {
  if (task.state !== TASK_STATES.CLIENT_APPROVED) return [];
  const created = [];
  for (const userId of participantsOf(db, task)) {
    created.push(...evaluateForUser(db, guildId, userId, { actorUserId }));
  }
  return created;
}

function listAwards(db, guildId, { status = 'pending', userId = null, limit = 50 } = {}) {
  const clauses = ['a.guild_id = ?'];
  const params = [guildId];

  if (status !== 'all') { clauses.push('a.status = ?'); params.push(status); }
  if (userId) { clauses.push('a.user_id = ?'); params.push(userId); }

  return db.prepare(`
    SELECT a.*, r.label AS rule_label, r.key AS rule_key, r.threshold
    FROM bonus_awards a JOIN bonus_rules r ON r.id = a.rule_id
    WHERE ${clauses.join(' AND ')}
    ORDER BY a.created_at DESC LIMIT ?
  `).all(...params, limit);
}

function getAward(db, guildId, id) {
  return db.prepare(`
    SELECT a.*, r.label AS rule_label, r.key AS rule_key FROM bonus_awards a
    JOIN bonus_rules r ON r.id = a.rule_id
    WHERE a.guild_id = ? AND a.id = ?
  `).get(guildId, id) || null;
}

function decideAward(db, guildId, id, { approve, actorUserId, reason = null }) {
  const result = db.prepare(`
    UPDATE bonus_awards SET status = ?, approved_by = ?, approved_at = ?, declined_reason = ?
    WHERE guild_id = ? AND id = ? AND status = 'pending'
  `).run(approve ? 'approved' : 'declined', actorUserId, Date.now(), approve ? null : reason, guildId, id);

  if (result.changes === 0) return null;

  recordAudit(db, {
    guildId, actorUserId, action: approve ? 'bonus.approve' : 'bonus.decline',
    entityType: 'bonus_award', entityId: id, detail: reason,
  });
  return getAward(db, guildId, id);
}

function markAwardPaid(db, guildId, id, actorUserId) {
  const result = db.prepare(`
    UPDATE bonus_awards SET status = 'paid' WHERE guild_id = ? AND id = ? AND status = 'approved'
  `).run(guildId, id);

  if (result.changes === 0) return null;
  recordAudit(db, { guildId, actorUserId, action: 'bonus.paid', entityType: 'bonus_award', entityId: id });
  return getAward(db, guildId, id);
}

module.exports = {
  upsertRule,
  getRule,
  listRules,
  setRuleActive,
  qualifyingCount,
  evaluateForUser,
  evaluateForTask,
  participantsOf,
  listAwards,
  getAward,
  decideAward,
  markAwardPaid,
};
