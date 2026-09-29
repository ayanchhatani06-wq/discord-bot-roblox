const test = require('node:test');
const assert = require('node:assert/strict');

const { openDatabase } = require('../src/db');
const staffRepo = require('../src/db/repos/staff');
const configRepo = require('../src/db/repos/config');
const { nextCode, listAudit } = require('../src/db/repos/core');
const { TASK_STATES } = require('../src/domain/taskState');

const GUILD = 'guild-1';

function setup() {
  const db = openDatabase({ file: ':memory:' });
  configRepo.ensureConfig(db, GUILD);
  configRepo.seedDefaultDepartments(db, GUILD, 'owner-1');
  return db;
}

function addTask(db, { artist, state, departmentId, deadline = null }) {
  const now = Date.now();
  const projectId = db.prepare(`
    INSERT INTO projects (guild_id, code, name, created_by, created_at, updated_at)
    VALUES (?, ?, 'P', 'owner-1', ?, ?) RETURNING id
  `).get(GUILD, nextCode(db, GUILD, 'project'), now, now).id;

  return db.prepare(`
    INSERT INTO tasks (guild_id, project_id, code, title, department_id, artist_user_id, state, deadline_utc, created_by, created_at, updated_at)
    VALUES (?, ?, ?, 'T', ?, ?, ?, ?, 'owner-1', ?, ?) RETURNING id
  `).get(GUILD, projectId, nextCode(db, GUILD, 'task'), departmentId, artist, state, deadline, now, now).id;
}

test('default departments are seeded once with the studio specialties', () => {
  const db = setup();
  const departments = configRepo.listDepartments(db, GUILD);
  const keys = departments.map((dept) => dept.key);

  for (const expected of ['modelling', 'building', 'animation', 'vfx', 'ui', 'gfx', 'scripting', 'sfx']) {
    assert.ok(keys.includes(expected), `missing department ${expected}`);
  }

  // Seeding twice must not duplicate.
  assert.deepEqual(configRepo.seedDefaultDepartments(db, GUILD, 'owner-1'), []);
  assert.equal(configRepo.listDepartments(db, GUILD).length, departments.length);

  const modelling = configRepo.getDepartmentByKey(db, GUILD, 'modelling');
  assert.deepEqual(configRepo.departmentChecklist(modelling), ['Source file', 'Exported model', 'Textures', 'Previews']);
  db.close();
});

test('a profile is incomplete until it has a timezone and a department', () => {
  const db = setup();
  const staff = staffRepo.ensureStaff(db, GUILD, 'artist-1', 'Artist One');

  assert.equal(staffRepo.isProfileComplete(staff), false);
  assert.equal(staff.availability, 'accepting');

  staffRepo.setTimezone(db, GUILD, 'artist-1', 'Asia/Karachi');
  assert.equal(staffRepo.isProfileComplete(staffRepo.getStaff(db, GUILD, 'artist-1')), false);

  const modelling = configRepo.getDepartmentByKey(db, GUILD, 'modelling');
  staffRepo.updateStaff(db, GUILD, 'artist-1', { department_id: modelling.id });
  assert.equal(staffRepo.isProfileComplete(staffRepo.getStaff(db, GUILD, 'artist-1')), true);
  db.close();
});

test('availability is explicit, timestamped and audited', () => {
  const db = setup();
  staffRepo.ensureStaff(db, GUILD, 'artist-1', 'Artist One');

  const away = staffRepo.setAvailability(db, GUILD, 'artist-1', 'away', {
    awayUntil: Date.UTC(2026, 9, 20),
    note: 'Exams',
  });

  assert.equal(away.availability, 'away');
  assert.equal(away.away_until, Date.UTC(2026, 9, 20));
  assert.equal(away.away_note, 'Exams');
  assert.ok(away.availability_updated_at > 0);

  // Returning clears the away details rather than leaving a stale return date.
  const back = staffRepo.setAvailability(db, GUILD, 'artist-1', 'accepting');
  assert.equal(back.away_until, null);
  assert.equal(back.away_note, null);

  const trail = listAudit(db, { guildId: GUILD, entityType: 'staff', entityId: 'artist-1' });
  assert.equal(trail.filter((row) => row.action === 'staff.availability').length, 2);

  assert.throws(() => staffRepo.setAvailability(db, GUILD, 'artist-1', 'vibing'), /Unknown availability/);
  db.close();
});

test('active task counts include unanswered offers but not finished work', () => {
  const db = setup();
  const modelling = configRepo.getDepartmentByKey(db, GUILD, 'modelling');
  staffRepo.ensureStaff(db, GUILD, 'artist-1', 'Artist One');

  addTask(db, { artist: 'artist-1', state: TASK_STATES.OFFERED, departmentId: modelling.id });
  addTask(db, { artist: 'artist-1', state: TASK_STATES.IN_PROGRESS, departmentId: modelling.id });
  addTask(db, { artist: 'artist-1', state: TASK_STATES.REVISION_NEEDED, departmentId: modelling.id });
  addTask(db, { artist: 'artist-1', state: TASK_STATES.INTERNAL_REVIEW, departmentId: modelling.id });
  addTask(db, { artist: 'artist-1', state: TASK_STATES.CLIENT_APPROVED, departmentId: modelling.id });
  addTask(db, { artist: 'artist-1', state: TASK_STATES.CANCELLED, departmentId: modelling.id });
  addTask(db, { artist: 'artist-1', state: TASK_STATES.AWAITING_CLIENT, departmentId: modelling.id });

  assert.equal(staffRepo.activeTaskCount(db, GUILD, 'artist-1'), 4);
  assert.equal(staffRepo.activeTaskCounts(db, GUILD).get('artist-1'), 4);
  assert.equal(staffRepo.activeTaskCount(db, GUILD, 'artist-2'), 0);
  db.close();
});

test('the soonest deadline of live work is reported per artist', () => {
  const db = setup();
  const modelling = configRepo.getDepartmentByKey(db, GUILD, 'modelling');
  const soon = Date.UTC(2026, 9, 10);
  const later = Date.UTC(2026, 9, 20);

  addTask(db, { artist: 'artist-1', state: TASK_STATES.IN_PROGRESS, departmentId: modelling.id, deadline: later });
  addTask(db, { artist: 'artist-1', state: TASK_STATES.IN_PROGRESS, departmentId: modelling.id, deadline: soon });
  // Finished work must not pull the "next deadline" backwards.
  addTask(db, { artist: 'artist-1', state: TASK_STATES.CLIENT_APPROVED, departmentId: modelling.id, deadline: Date.UTC(2026, 1, 1) });

  assert.equal(staffRepo.nextDeadlines(db, GUILD).get('artist-1'), soon);
  db.close();
});

test('departing staff leave the directory but keep their record', () => {
  const db = setup();
  staffRepo.ensureStaff(db, GUILD, 'artist-1', 'Artist One');
  staffRepo.setTimezone(db, GUILD, 'artist-1', 'Europe/London');

  staffRepo.markRemoved(db, GUILD, 'artist-1', 'owner-1');
  assert.equal(staffRepo.listStaff(db, GUILD).length, 0);
  assert.equal(staffRepo.listStaff(db, GUILD, { includeRemoved: true }).length, 1);
  assert.equal(staffRepo.getStaff(db, GUILD, 'artist-1').timezone, 'Europe/London');

  staffRepo.restoreStaff(db, GUILD, 'artist-1', 'owner-1');
  assert.equal(staffRepo.listStaff(db, GUILD).length, 1);
  db.close();
});

test('staff whose away date has passed are listed for a prompt, not flipped automatically', () => {
  const db = setup();
  staffRepo.ensureStaff(db, GUILD, 'artist-1', 'One');
  staffRepo.ensureStaff(db, GUILD, 'artist-2', 'Two');

  staffRepo.setAvailability(db, GUILD, 'artist-1', 'away', { awayUntil: Date.now() - 1000 });
  staffRepo.setAvailability(db, GUILD, 'artist-2', 'away', { awayUntil: Date.now() + 60_000 });

  const returned = staffRepo.listReturnedFromAway(db, GUILD);
  assert.deepEqual(returned.map((row) => row.user_id), ['artist-1']);
  // Still away in the database: the bot asks rather than deciding for them.
  assert.equal(staffRepo.getStaff(db, GUILD, 'artist-1').availability, 'away');
  db.close();
});

test('only whitelisted profile fields can be written', () => {
  const db = setup();
  staffRepo.ensureStaff(db, GUILD, 'artist-1', 'One');

  staffRepo.updateStaff(db, GUILD, 'artist-1', {
    specialties: 'Stylised props',
    availability: 'away',
    removed_at: 12345,
  });

  const staff = staffRepo.getStaff(db, GUILD, 'artist-1');
  assert.equal(staff.specialties, 'Stylised props');
  assert.equal(staff.availability, 'accepting', 'availability has its own audited path');
  assert.equal(staff.removed_at, null, 'removal is not an editable profile field');
  db.close();
});

test('allocation percentages default to the studio split and round-trip', () => {
  const db = setup();
  assert.deepEqual(configRepo.getAllocationPercentages(db, GUILD), { finder: 2000, leader: 2000, mod: 1000, owner: 5000 });

  configRepo.setAllocationPercentages(db, GUILD, { finder: 1000, leader: 3000, mod: 1000, owner: 5000 }, 'owner-1');
  assert.deepEqual(configRepo.getAllocationPercentages(db, GUILD), { finder: 1000, leader: 3000, mod: 1000, owner: 5000 });

  assert.throws(
    () => configRepo.setAllocationPercentages(db, GUILD, { finder: 1000, leader: 1000, mod: 1000, owner: 1000 }, 'owner-1'),
    /must total 100%/
  );
  // The rejected write left the previous values intact.
  assert.deepEqual(configRepo.getAllocationPercentages(db, GUILD), { finder: 1000, leader: 3000, mod: 1000, owner: 5000 });
  db.close();
});

test('board message ids are tracked per board key so deletions can be detected', () => {
  const db = setup();
  configRepo.setBoardMessage(db, GUILD, 'dept:1:p0', 'chan-1', 'msg-1');
  assert.equal(configRepo.getBoardMessage(db, GUILD, 'dept:1:p0').message_id, 'msg-1');

  configRepo.setBoardMessage(db, GUILD, 'dept:1:p0', 'chan-1', 'msg-2');
  assert.equal(configRepo.getBoardMessage(db, GUILD, 'dept:1:p0').message_id, 'msg-2');
  assert.equal(configRepo.listBoardMessages(db, GUILD).length, 1);

  configRepo.deleteBoardMessage(db, GUILD, 'dept:1:p0');
  assert.equal(configRepo.getBoardMessage(db, GUILD, 'dept:1:p0'), null);
  db.close();
});

test('config changes are audited with before and after values', () => {
  const db = setup();
  configRepo.updateConfig(db, GUILD, { staff_board_channel_id: 'chan-1', board_refresh_minutes: 5 }, 'owner-1');

  const trail = listAudit(db, { guildId: GUILD, entityType: 'guild', entityId: GUILD });
  const update = trail.find((row) => row.action === 'config.update');
  assert.ok(update);
  assert.deepEqual(JSON.parse(update.after_json), { staff_board_channel_id: 'chan-1', board_refresh_minutes: 5 });
  assert.equal(configRepo.getConfig(db, GUILD).board_refresh_minutes, 5);

  // Unknown columns are ignored rather than injected into the SQL.
  configRepo.updateConfig(db, GUILD, { 'nonsense; DROP TABLE staff': 1 }, 'owner-1');
  assert.ok(configRepo.getConfig(db, GUILD));
  db.close();
});
