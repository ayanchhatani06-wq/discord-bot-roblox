const staffRepo = require('../db/repos/staff');
const configRepo = require('../db/repos/config');
const { ACTIVE_STATES } = require('../domain/taskState');

/**
 * Who is likely to be free, and when.
 *
 * The question this answers is the one asked before saying yes to a client:
 * can we take this on next week? Guessing it wrong is how a studio ends up
 * either turning away work it could have done or promising work it cannot.
 *
 * Where a department records a cap (`/setup department task_cap:`), that is the
 * limit used — the same figure the assign flow already warns against, so the two
 * cannot disagree. Where no cap is set this reports the load and says plainly
 * that there is nothing to measure it against, rather than inventing a threshold
 * the studio never chose.
 *
 * Work with no deadline is counted and named as unknown rather than assumed
 * finished, because assuming it finishes is exactly the mistake that overbooks
 * people.
 */

const DAY = 24 * 60 * 60 * 1000;

const OUTLOOK = Object.freeze({
  AWAY: 'away',
  FULL: 'full',
  FINISHING: 'finishing',
  LOADED: 'loaded',
  FREE: 'free',
});

const OUTLOOK_LABELS = Object.freeze({
  away: 'Away for part or all of it',
  full: 'Says they are at capacity',
  finishing: 'Should be finishing up',
  loaded: 'Carrying work through the window',
  free: 'Nothing on',
});

const OUTLOOK_EMOJI = Object.freeze({
  away: '🌙', full: '🛑', finishing: '🟡', loaded: '🔵', free: '🟢',
});

/**
 * One person's workload across the window.
 *
 * Three buckets, because they mean different things. Work due before the window
 * should be finished by then. Work due inside it is what actually competes with
 * anything new. Work with no deadline could be either, and is reported as
 * unknown instead of being quietly put in whichever bucket suits.
 */
function loadFor(db, guildId, userId, from, until) {
  const placeholders = ACTIVE_STATES.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT t.id, t.code, t.title, t.deadline_utc, t.state
    FROM tasks t
    WHERE t.guild_id = ? AND t.artist_user_id = ? AND t.state IN (${placeholders})
    ORDER BY t.deadline_utc IS NULL, t.deadline_utc
  `).all(guildId, userId, ...ACTIVE_STATES);

  const contributing = db.prepare(`
    SELECT t.id, t.code, t.title, t.deadline_utc, t.state
    FROM task_contributors c
    JOIN tasks t ON t.id = c.task_id
    WHERE t.guild_id = ? AND c.user_id = ? AND c.removed_at IS NULL
      AND t.state IN (${placeholders}) AND (t.artist_user_id IS NULL OR t.artist_user_id != ?)
    ORDER BY t.deadline_utc IS NULL, t.deadline_utc
  `).all(guildId, userId, ...ACTIVE_STATES, userId);

  const all = [...rows, ...contributing];

  return {
    tasks: all,
    // What a department cap counts: tasks actually out with them right now.
    activeCount: all.length,
    dueBefore: all.filter((task) => task.deadline_utc !== null && task.deadline_utc < from),
    dueInWindow: all.filter((task) => task.deadline_utc !== null && task.deadline_utc >= from && task.deadline_utc <= until),
    dueAfter: all.filter((task) => task.deadline_utc !== null && task.deadline_utc > until),
    noDeadline: all.filter((task) => task.deadline_utc === null),
  };
}

/** Whether somebody's recorded absence overlaps the window at all. */
function awayDuring(member, from, until) {
  if (member.availability !== staffRepo.AVAILABILITY.AWAY) return false;
  // Away with no return date is away for the whole window.
  if (!member.away_until) return true;
  return member.away_until >= from;
}

function outlookFor(member, load, from, until, department = null) {
  if (awayDuring(member, from, until)) return OUTLOOK.AWAY;
  if (member.availability === staffRepo.AVAILABILITY.AT_CAPACITY) return OUTLOOK.FULL;

  // A department cap is a real limit somebody chose, so it decides.
  if (department?.task_cap && load.activeCount >= department.task_cap) return OUTLOOK.FULL;

  const committed = load.dueInWindow.length + load.dueAfter.length + load.noDeadline.length;
  if (committed === 0) {
    // Overdue work still counts as work: somebody with nothing but a missed
    // deadline is not free, they are behind.
    return load.dueBefore.length > 0 ? OUTLOOK.FINISHING : OUTLOOK.FREE;
  }
  if (load.dueInWindow.length > 0 && load.dueAfter.length === 0) return OUTLOOK.FINISHING;
  return OUTLOOK.LOADED;
}

/**
 * The forecast for a window, one entry per person.
 *
 * Sorted with the most obviously free first, so the answer to "who can take
 * this" is at the top.
 */
function forecast(db, guildId, { from = Date.now(), days = 7, departmentId = undefined } = {}) {
  const until = from + days * DAY;
  const departments = new Map(configRepo.listDepartments(db, guildId).map((dept) => [dept.id, dept]));
  const members = staffRepo.listStaff(db, guildId, { departmentId });

  const people = members.map((member) => {
    const load = loadFor(db, guildId, member.user_id, from, until);
    const department = member.department_id ? departments.get(member.department_id) || null : null;
    return {
      member,
      department,
      cap: department?.task_cap ?? null,
      load,
      outlook: outlookFor(member, load, from, until, department),
      returnsAt: member.availability === staffRepo.AVAILABILITY.AWAY ? member.away_until : null,
    };
  });

  const order = [OUTLOOK.FREE, OUTLOOK.FINISHING, OUTLOOK.LOADED, OUTLOOK.FULL, OUTLOOK.AWAY];
  people.sort((a, b) => {
    const byOutlook = order.indexOf(a.outlook) - order.indexOf(b.outlook);
    if (byOutlook !== 0) return byOutlook;
    return a.load.tasks.length - b.load.tasks.length;
  });

  const counts = order.reduce((out, outlook) => {
    out[outlook] = people.filter((person) => person.outlook === outlook).length;
    return out;
  }, {});

  return {
    from,
    until,
    days,
    people,
    counts,
    // Named so a reader knows what the forecast cannot see.
    unknownDeadlines: people.reduce((sum, person) => sum + person.load.noDeadline.length, 0),
    // Departments with nobody's limit written down, so the caveat can name them
    // instead of claiming the studio records no limits at all.
    withoutCap: [...new Set(people.filter((person) => !person.cap && person.department)
      .map((person) => person.department.name))],
    byDepartment: [...departments.values()].map((dept) => ({
      department: dept,
      free: people.filter((person) => person.department?.id === dept.id
        && (person.outlook === OUTLOOK.FREE || person.outlook === OUTLOOK.FINISHING)).length,
      total: people.filter((person) => person.department?.id === dept.id).length,
    })),
  };
}

/** One line per person, for a Discord embed. */
function describePerson(person) {
  const load = person.load;
  const bits = [];
  if (load.dueInWindow.length > 0) bits.push(`${load.dueInWindow.length} due in the window`);
  if (load.dueAfter.length > 0) bits.push(`${load.dueAfter.length} running past it`);
  if (load.dueBefore.length > 0) bits.push(`${load.dueBefore.length} already overdue`);
  if (load.noDeadline.length > 0) bits.push(`${load.noDeadline.length} with no deadline set`);

  return `${OUTLOOK_EMOJI[person.outlook]} **${person.member.display_name || person.member.user_id}**` +
    `${person.department ? ` · ${person.department.name}` : ''}\n` +
    `┗ ${person.cap ? `**${load.activeCount} of ${person.cap}** on now` : `${load.activeCount} on now`}` +
    `${bits.length > 0 ? ` — ${bits.join(', ')}` : ''}`;
}

module.exports = {
  DAY,
  OUTLOOK,
  OUTLOOK_LABELS,
  OUTLOOK_EMOJI,
  loadFor,
  awayDuring,
  outlookFor,
  forecast,
  describePerson,
};
