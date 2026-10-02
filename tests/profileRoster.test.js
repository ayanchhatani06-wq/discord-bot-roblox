const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { openDatabase } = require('../src/db');
const configRepo = require('../src/db/repos/config');
const staffRepo = require('../src/db/repos/staff');
const portfolioImages = require('../src/services/portfolioImages');
const roster = require('../src/services/profileRoster');

const GUILD = 'guild-1';
const OWNER = 'owner-1';

function setup() {
  process.env.PORTFOLIO_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-'));
  const db = openDatabase({ file: ':memory:' });
  configRepo.ensureConfig(db, GUILD);
  configRepo.seedDefaultDepartments(db, GUILD, OWNER);
  return db;
}

function departmentId(db, key = 'building') {
  return configRepo.listDepartments(db, GUILD).find((d) => d.key === key).id;
}

/** Someone with everything filled in, so tests can take things away from it. */
function completePerson(db, userId, name = 'Milton') {
  staffRepo.ensureStaff(db, GUILD, userId, name);
  staffRepo.updateStaff(db, GUILD, userId, {
    timezone: 'Asia/Dubai',
    department_id: departmentId(db),
    sub_role: 'Interior Builder',
    experience: '10+ years',
    specialties: 'Interiors, lighting',
    software: 'Blender',
    portfolio_url: 'https://example.test/milton',
    roblox_username: 'milton_rbx',
    working_start_minute: 9 * 60,
    working_end_minute: 17 * 60,
  }, OWNER);

  portfolioImages.add(db, GUILD, userId, {
    buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]),
    filename: `${userId}.png`,
    contentType: 'image/png',
  }, userId);

  return staffRepo.getStaff(db, GUILD, userId);
}

test('a fully filled profile counts as complete', () => {
  const db = setup();
  completePerson(db, 'artist-1');

  const result = roster.roster(db, GUILD);
  assert.equal(result.total, 1);
  assert.equal(result.complete, 1);
  assert.equal(result.blocked, 0);
  assert.deepEqual(result.people[0].missing, []);
});

test('a missing timezone or department is counted apart from the rest', () => {
  const db = setup();
  completePerson(db, 'artist-1');
  staffRepo.updateStaff(db, GUILD, 'artist-1', { timezone: null }, OWNER);

  const result = roster.roster(db, GUILD);
  assert.equal(result.blocked, 1, 'no timezone means every deadline reads wrong');
  assert.deepEqual(result.people[0].missingRequired, ['timezone']);
});

test('a cosmetic gap is not treated as a blocker', () => {
  const db = setup();
  completePerson(db, 'artist-1');
  staffRepo.updateStaff(db, GUILD, 'artist-1', { roblox_username: null }, OWNER);

  const result = roster.roster(db, GUILD);
  assert.equal(result.blocked, 0);
  assert.equal(result.complete, 0);
  assert.deepEqual(result.people[0].missing, ['Roblox name']);
});

test('pictures count towards the profile', () => {
  const db = setup();
  staffRepo.ensureStaff(db, GUILD, 'artist-1', 'Milton');

  const before = roster.roster(db, GUILD).people[0];
  assert.ok(before.missing.includes('portfolio pictures'));
  assert.equal(before.pictures, 0);

  portfolioImages.add(db, GUILD, 'artist-1', {
    buffer: Buffer.from([1, 2, 3, 4]), filename: 'a.png', contentType: 'image/png',
  }, 'artist-1');

  const after = roster.roster(db, GUILD).people[0];
  assert.equal(after.pictures, 1);
  assert.ok(!after.missing.includes('portfolio pictures'));
});

test('the people who need chasing are at the top', () => {
  const db = setup();
  completePerson(db, 'done-1', 'Finished');

  staffRepo.ensureStaff(db, GUILD, 'empty-1', 'Nothing');

  completePerson(db, 'partial-1', 'Partly');
  staffRepo.updateStaff(db, GUILD, 'partial-1', { software: null, experience: null }, OWNER);

  const order = roster.roster(db, GUILD).people.map((p) => p.staff.user_id);
  assert.equal(order[0], 'empty-1', 'the one missing required fields comes first');
  assert.equal(order[2], 'done-1', 'the complete one comes last');
});

test('the filter says how many it hid rather than just showing fewer', () => {
  const db = setup();
  completePerson(db, 'done-1');
  staffRepo.ensureStaff(db, GUILD, 'empty-1', 'Nothing');

  const all = roster.roster(db, GUILD);
  assert.equal(all.people.length, 2);
  assert.equal(all.hidden, 0);

  const incomplete = roster.roster(db, GUILD, { onlyIncomplete: true });
  assert.equal(incomplete.people.length, 1);
  assert.equal(incomplete.hidden, 1);
  // The totals describe the studio, not the filtered view.
  assert.equal(incomplete.total, 2);
  assert.equal(incomplete.complete, 1);
});

test('one department can be asked about on its own', () => {
  const db = setup();
  completePerson(db, 'builder-1');
  staffRepo.ensureStaff(db, GUILD, 'animator-1', 'Ani');
  staffRepo.updateStaff(db, GUILD, 'animator-1', { department_id: departmentId(db, 'animation') }, OWNER);

  const building = roster.roster(db, GUILD, { departmentId: departmentId(db) });
  assert.deepEqual(building.people.map((p) => p.staff.user_id), ['builder-1']);
});

test('an empty studio is reported rather than crashed on', () => {
  const db = setup();
  const result = roster.roster(db, GUILD);
  assert.equal(result.total, 0);
  assert.deepEqual(result.people, []);
});

test('the line names the person, their title and what is missing', () => {
  const db = setup();
  completePerson(db, 'artist-1');
  staffRepo.updateStaff(db, GUILD, 'artist-1', { software: null }, OWNER);

  const line = roster.describe(roster.roster(db, GUILD).people[0]);
  assert.match(line, /<@artist-1>/);
  assert.match(line, /Interior Builder/);
  assert.match(line, /10\+ years/);
  assert.match(line, /missing: software/);
  assert.match(line, /🟡/, 'amber: worth filling in, nothing broken');
});

test('somebody with nothing set is marked red', () => {
  const db = setup();
  staffRepo.ensureStaff(db, GUILD, 'artist-1', 'New');
  const line = roster.describe(roster.roster(db, GUILD).people[0]);
  assert.match(line, /🔴/);
  assert.match(line, /timezone/);
});

test('a leader reading the roster sees only the departments they lead', () => {
  const db = setup();
  completePerson(db, 'builder-1', 'Builder');

  staffRepo.ensureStaff(db, GUILD, 'animator-1', 'Ani');
  staffRepo.updateStaff(db, GUILD, 'animator-1', {
    department_id: departmentId(db, 'animation'),
  }, OWNER);

  const scoped = roster.roster(db, GUILD, { departmentIds: [departmentId(db)] });

  assert.deepEqual(scoped.people.map((p) => p.staff.user_id), ['builder-1']);
  // The totals describe what they can see, not the studio, so a leader is not
  // told "1 of 2 complete" about somebody they cannot look at.
  assert.equal(scoped.total, 1);
  assert.equal(scoped.complete, 1);
});

test('an empty scope shows nobody rather than everybody', () => {
  // The failure that matters: a leader who leads nothing must not fall through
  // to the whole studio.
  const db = setup();
  completePerson(db, 'builder-1');
  const scoped = roster.roster(db, GUILD, { departmentIds: [] });
  assert.equal(scoped.total, 0);
  assert.deepEqual(scoped.people, []);
});
