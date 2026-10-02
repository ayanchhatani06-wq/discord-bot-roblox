const { recordAudit } = require('./core');
const { ACTIVE_STATES } = require('../../domain/taskState');

const AVAILABILITY = Object.freeze({
  ACCEPTING: 'accepting',
  AT_CAPACITY: 'at_capacity',
  AWAY: 'away',
});

const AVAILABILITY_LABELS = Object.freeze({
  accepting: 'Accepting tasks',
  at_capacity: 'At capacity',
  away: 'Away',
});

const AVAILABILITY_EMOJI = Object.freeze({
  accepting: '🟢',
  at_capacity: '🟠',
  away: '⚪',
});

const EDITABLE_FIELDS = [
  'display_name', 'department_id', 'leader_user_id', 'timezone', 'specialties',
  'sub_role', 'experience', 'profile_declined',
  'software', 'portfolio_url', 'roblox_username', 'working_days',
  'working_start_minute', 'working_end_minute', 'quiet_start_minute', 'quiet_end_minute',
];

function ensureStaff(db, guildId, userId, displayName = null) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO staff (guild_id, user_id, display_name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (guild_id, user_id) DO NOTHING
  `).run(guildId, userId, displayName, now, now);
  return getStaff(db, guildId, userId);
}

function getStaff(db, guildId, userId) {
  return db.prepare('SELECT * FROM staff WHERE guild_id = ? AND user_id = ?').get(guildId, userId) || null;
}

function listStaff(db, guildId, { departmentId = undefined, includeRemoved = false } = {}) {
  const clauses = ['guild_id = ?'];
  const params = [guildId];

  if (departmentId !== undefined) {
    if (departmentId === null) clauses.push('department_id IS NULL');
    else { clauses.push('department_id = ?'); params.push(departmentId); }
  }
  if (!includeRemoved) clauses.push('removed_at IS NULL');

  return db.prepare(`SELECT * FROM staff WHERE ${clauses.join(' AND ')} ORDER BY display_name COLLATE NOCASE`).all(...params);
}

function updateStaff(db, guildId, userId, patch, actorUserId = null) {
  const before = ensureStaff(db, guildId, userId);
  const entries = Object.entries(patch).filter(([key]) => EDITABLE_FIELDS.includes(key));
  if (entries.length === 0) return before;

  const assignments = entries.map(([key]) => `${key} = ?`).join(', ');
  db.prepare(`UPDATE staff SET ${assignments}, updated_at = ? WHERE guild_id = ? AND user_id = ?`)
    .run(...entries.map(([, value]) => value), Date.now(), guildId, userId);

  const after = getStaff(db, guildId, userId);
  recordAudit(db, {
    guildId,
    actorUserId: actorUserId ?? userId,
    action: 'staff.update',
    entityType: 'staff',
    entityId: userId,
    before: Object.fromEntries(entries.map(([key]) => [key, before[key]])),
    after: Object.fromEntries(entries.map(([key]) => [key, after[key]])),
  });
  return after;
}

function setTimezone(db, guildId, userId, timezone, actorUserId = null) {
  return updateStaff(db, guildId, userId, { timezone }, actorUserId);
}

/**
 * Availability is explicitly declared and never inferred from Discord presence:
 * being online is not the same as being free to take work.
 */
function setAvailability(db, guildId, userId, availability, { awayUntil = null, note = null, actorUserId = null } = {}) {
  if (!Object.values(AVAILABILITY).includes(availability)) {
    throw new Error(`Unknown availability: ${availability}`);
  }

  const before = ensureStaff(db, guildId, userId);
  const now = Date.now();
  db.prepare(`
    UPDATE staff SET availability = ?, availability_updated_at = ?, away_until = ?, away_note = ?, updated_at = ?
    WHERE guild_id = ? AND user_id = ?
  `).run(
    availability,
    now,
    availability === AVAILABILITY.AWAY ? awayUntil : null,
    availability === AVAILABILITY.AWAY ? note : null,
    now,
    guildId,
    userId
  );

  const after = getStaff(db, guildId, userId);
  recordAudit(db, {
    guildId,
    actorUserId: actorUserId ?? userId,
    action: 'staff.availability',
    entityType: 'staff',
    entityId: userId,
    before: { availability: before.availability, away_until: before.away_until },
    after: { availability: after.availability, away_until: after.away_until },
  });
  return after;
}

function markOnboarded(db, guildId, userId) {
  db.prepare('UPDATE staff SET onboarded_at = COALESCE(onboarded_at, ?), updated_at = ? WHERE guild_id = ? AND user_id = ?')
    .run(Date.now(), Date.now(), guildId, userId);
  return getStaff(db, guildId, userId);
}

/**
 * Soft removal: history, submissions and payment records must survive somebody
 * leaving the server, so the row is flagged rather than deleted.
 */
function markRemoved(db, guildId, userId, actorUserId = null) {
  db.prepare('UPDATE staff SET removed_at = ?, updated_at = ? WHERE guild_id = ? AND user_id = ?')
    .run(Date.now(), Date.now(), guildId, userId);
  recordAudit(db, { guildId, actorUserId, action: 'staff.remove', entityType: 'staff', entityId: userId });
  return getStaff(db, guildId, userId);
}

function restoreStaff(db, guildId, userId, actorUserId = null) {
  db.prepare('UPDATE staff SET removed_at = NULL, updated_at = ? WHERE guild_id = ? AND user_id = ?')
    .run(Date.now(), guildId, userId);
  recordAudit(db, { guildId, actorUserId, action: 'staff.restore', entityType: 'staff', entityId: userId });
  return getStaff(db, guildId, userId);
}

function activeTaskCount(db, guildId, userId) {
  const placeholders = ACTIVE_STATES.map(() => '?').join(', ');
  return db.prepare(`
    SELECT COUNT(*) AS n FROM tasks
    WHERE guild_id = ? AND artist_user_id = ? AND state IN (${placeholders})
  `).get(guildId, userId, ...ACTIVE_STATES).n;
}

function activeTaskCounts(db, guildId) {
  const placeholders = ACTIVE_STATES.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT artist_user_id AS userId, COUNT(*) AS n FROM tasks
    WHERE guild_id = ? AND artist_user_id IS NOT NULL AND state IN (${placeholders})
    GROUP BY artist_user_id
  `).all(guildId, ...ACTIVE_STATES);

  return new Map(rows.map((row) => [row.userId, row.n]));
}

function nextDeadlines(db, guildId) {
  const placeholders = ACTIVE_STATES.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT artist_user_id AS userId, MIN(deadline_utc) AS deadline FROM tasks
    WHERE guild_id = ? AND artist_user_id IS NOT NULL AND deadline_utc IS NOT NULL
      AND state IN (${placeholders})
    GROUP BY artist_user_id
  `).all(guildId, ...ACTIVE_STATES);

  return new Map(rows.map((row) => [row.userId, row.deadline]));
}

/**
 * Staff who have returned from an away period, so the bot can prompt them
 * rather than silently flipping their availability back.
 */
function listReturnedFromAway(db, guildId, at = Date.now()) {
  return db.prepare(`
    SELECT * FROM staff
    WHERE guild_id = ? AND availability = 'away' AND away_until IS NOT NULL AND away_until <= ?
      AND removed_at IS NULL
  `).all(guildId, at);
}

function isProfileComplete(staff) {
  return Boolean(staff && staff.timezone && staff.department_id);
}

module.exports = {
  AVAILABILITY,
  AVAILABILITY_LABELS,
  AVAILABILITY_EMOJI,
  EDITABLE_FIELDS,
  ensureStaff,
  getStaff,
  listStaff,
  updateStaff,
  setTimezone,
  setAvailability,
  markOnboarded,
  markRemoved,
  restoreStaff,
  activeTaskCount,
  activeTaskCounts,
  nextDeadlines,
  listReturnedFromAway,
  isProfileComplete,
};
