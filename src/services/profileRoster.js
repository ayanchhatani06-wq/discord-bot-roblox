const staffRepo = require('../db/repos/staff');
const configRepo = require('../db/repos/config');
const portfolioImages = require('./portfolioImages');
const { gmtLabelFor } = require('../utils/time');

/**
 * Who has filled in what.
 *
 * `/profile view` answers this one person at a time, which is fine when you
 * already know who to ask about and useless when the question is "who still
 * has not done it" — the question somebody actually has, a week after telling
 * the team to set their profiles up.
 *
 * Two fields are separated from the rest because they are not cosmetic:
 * without a timezone every deadline that person sees is read in the wrong one,
 * and without a department they appear on no board and in no assignment
 * shortlist. Those break things quietly. The others only make the board
 * thinner, and a roster that shouts equally about both teaches people to
 * ignore it.
 */

const FIELDS = Object.freeze([
  { key: 'timezone', label: 'timezone', required: true, has: (staff) => Boolean(staff.timezone) },
  { key: 'department', label: 'department', required: true, has: (staff) => Boolean(staff.department_id) },
  { key: 'sub_role', label: 'role title', has: (staff) => Boolean(staff.sub_role) },
  { key: 'experience', label: 'experience', has: (staff) => Boolean(staff.experience) },
  { key: 'specialties', label: 'specialties', has: (staff) => Boolean(staff.specialties) },
  { key: 'software', label: 'software', has: (staff) => Boolean(staff.software) },
  { key: 'portfolio_url', label: 'portfolio link', has: (staff) => Boolean(staff.portfolio_url) },
  { key: 'roblox_username', label: 'Roblox name', has: (staff) => Boolean(staff.roblox_username) },
  {
    key: 'hours',
    label: 'working hours',
    has: (staff) => staff.working_start_minute !== null && staff.working_start_minute !== undefined,
  },
  { key: 'pictures', label: 'portfolio pictures', has: (staff, extra) => extra.pictures > 0 },
]);

const OPTIONAL_COUNT = FIELDS.filter((field) => !field.required).length;

function assess(staff, extra) {
  const missing = FIELDS.filter((field) => !field.has(staff, extra));
  return {
    missing: missing.map((field) => field.label),
    missingRequired: missing.filter((field) => field.required).map((field) => field.label),
    optionalFilled: OPTIONAL_COUNT - missing.filter((field) => !field.required).length,
    optionalTotal: OPTIONAL_COUNT,
  };
}

/**
 * The roster, worst first.
 *
 * Sorted so the people who need chasing are at the top rather than wherever
 * the alphabet put them — a list that has to be read to the bottom to find the
 * problem does not get read to the bottom.
 */
function roster(db, guildId, { departmentId = undefined, departmentIds = null, onlyIncomplete = false } = {}) {
  const departments = new Map(configRepo.listDepartments(db, guildId).map((dept) => [dept.id, dept]));

  // departmentIds limits the whole roster, counts included, so a leader reading
  // it is told how their own department is doing rather than being given the
  // studio's totals with somebody else's gaps folded in.
  const allowed = departmentIds ? new Set(departmentIds) : null;

  const people = staffRepo.listStaff(db, guildId, { departmentId })
    .filter((staff) => !allowed || allowed.has(staff.department_id))
    .map((staff) => {
    const pictures = portfolioImages.countFor(db, guildId, staff.user_id);
    return {
      staff,
      department: staff.department_id ? departments.get(staff.department_id) || null : null,
      pictures,
      ...assess(staff, { pictures }),
    };
  });

  people.sort((a, b) => {
    const byRequired = b.missingRequired.length - a.missingRequired.length;
    if (byRequired !== 0) return byRequired;
    const byOptional = a.optionalFilled - b.optionalFilled;
    if (byOptional !== 0) return byOptional;
    return (a.staff.display_name || '').localeCompare(b.staff.display_name || '');
  });

  const shown = onlyIncomplete ? people.filter((person) => person.missing.length > 0) : people;

  return {
    people: shown,
    total: people.length,
    complete: people.filter((person) => person.missing.length === 0).length,
    blocked: people.filter((person) => person.missingRequired.length > 0).length,
    // Named so a caller can say what the filter hid rather than silently
    // showing a shorter list than the studio has people.
    hidden: people.length - shown.length,
  };
}

/** One line per person, for an embed. */
function describe(person) {
  const { staff } = person;
  const icon = person.missingRequired.length > 0 ? '🔴' : person.missing.length > 0 ? '🟡' : '🟢';

  const title = [staff.sub_role, staff.experience].filter(Boolean).join(' · ');
  const head = `${icon} <@${staff.user_id}>${title ? ` — ${title}` : ''}`;

  const bits = [];
  if (person.department) bits.push(person.department.name);
  // GMT+5 rather than Asia/Karachi: the zone name is what is stored, the
  // offset is what somebody reading a roster is actually asking.
  if (staff.timezone) bits.push(gmtLabelFor(staff.timezone) || staff.timezone);
  if (person.pictures > 0) bits.push(`🖼️ ${person.pictures}`);
  bits.push(`${person.optionalFilled}/${person.optionalTotal} details`);

  const missing = person.missing.length > 0
    ? `\n┗ missing: ${person.missing.join(', ')}`
    : '';

  return `${head}\n┗ ${bits.join(' · ')}${missing}`;
}

module.exports = { FIELDS, OPTIONAL_COUNT, assess, roster, describe };
