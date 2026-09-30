const test = require('node:test');
const assert = require('node:assert/strict');

const { openDatabase } = require('../src/db');
const configRepo = require('../src/db/repos/config');
const staffRepo = require('../src/db/repos/staff');
const clientsRepo = require('../src/db/repos/clients');
const projectsRepo = require('../src/db/repos/projects');
const webRepo = require('../src/db/repos/web');
const doctor = require('../src/services/doctor');

const GUILD = 'guild-1';
const OWNER = 'owner-1';

/** A studio that is properly set up, so each test can break one thing. */
function healthy() {
  const db = openDatabase({ file: ':memory:' });
  configRepo.ensureConfig(db, GUILD);
  configRepo.seedDefaultDepartments(db, GUILD, OWNER);
  configRepo.updateConfig(db, GUILD, {
    owner_user_id: OWNER,
    fallback_channel_id: 'fallback',
    staff_board_channel_id: 'boards',
    summary_channel_id: 'summary',
    studio_name: 'Cylops Studio',
  }, OWNER);

  for (const department of configRepo.listDepartments(db, GUILD)) {
    db.prepare('UPDATE departments SET leader_role_id = ?, member_role_id = ? WHERE id = ?')
      .run(`lead-${department.key}`, `member-${department.key}`, department.id);
  }

  staffRepo.ensureStaff(db, GUILD, OWNER, 'Owner');
  staffRepo.setTimezone(db, GUILD, OWNER, 'UTC', OWNER);
  staffRepo.updateStaff(db, GUILD, OWNER, {
    department_id: configRepo.getDepartmentByKey(db, GUILD, 'modelling').id,
  }, OWNER);

  return db;
}

const titles = (db) => doctor.diagnose(db, GUILD).findings.map((item) => item.title);

test('a properly set up studio has nothing to report', () => {
  const db = healthy();
  const result = doctor.diagnose(db, GUILD);

  assert.deepEqual(result.findings, [], `unexpected: ${titles(db).join(' | ')}`);
  assert.equal(result.breaks, 0);
});

test('a missing fallback channel counts as breaking, because offers vanish silently', () => {
  const db = healthy();
  configRepo.updateConfig(db, GUILD, { fallback_channel_id: null }, OWNER);

  const result = doctor.diagnose(db, GUILD);
  const found = result.findings.find((item) => /fallback/i.test(item.title));

  assert.ok(found);
  assert.equal(found.severity, doctor.SEVERITY.BREAKS);
  assert.match(found.detail, /never receives them/);
});

test('a client with orders and no way in is a breaking problem', () => {
  const db = healthy();
  const client = clientsRepo.createClient(db, GUILD, { displayName: 'Unreachable Ltd' }, OWNER);
  const project = projectsRepo.createProject(db, GUILD, { name: 'Order' }, OWNER);
  clientsRepo.linkProject(db, GUILD, project.id, client.id, OWNER, { clientChannelId: 'c1' });

  const found = doctor.diagnose(db, GUILD).findings.find((item) => /cannot open anything/.test(item.title));
  assert.ok(found);
  assert.equal(found.severity, doctor.SEVERITY.BREAKS);
  assert.match(found.detail, /Unreachable Ltd/);
});

test('a client reachable by email alone is not reported', () => {
  const db = healthy();
  const client = clientsRepo.createClient(db, GUILD, { displayName: 'Email Only' }, OWNER);
  const project = projectsRepo.createProject(db, GUILD, { name: 'Order' }, OWNER);
  clientsRepo.linkProject(db, GUILD, project.id, client.id, OWNER, { clientChannelId: 'c1' });

  webRepo.addClientEmail(db, GUILD, client.id, { email: 'them@example.com' }, OWNER);

  assert.equal(
    doctor.diagnose(db, GUILD).findings.some((item) => /cannot open anything/.test(item.title)),
    false,
    'an email identity is a real way in, the same as a Discord account'
  );
});

test('a client with no orders is not reported, because nothing was posted for them', () => {
  const db = healthy();
  clientsRepo.createClient(db, GUILD, { displayName: 'Just A Record' }, OWNER);

  assert.equal(
    doctor.diagnose(db, GUILD).findings.some((item) => /cannot open anything/.test(item.title)),
    false
  );
});

test('a missing timezone is flagged as risky, because it fails quietly', () => {
  const db = healthy();
  staffRepo.ensureStaff(db, GUILD, 'artist-1', 'Artist');
  staffRepo.updateStaff(db, GUILD, 'artist-1', {
    department_id: configRepo.getDepartmentByKey(db, GUILD, 'modelling').id,
  }, OWNER);

  const found = doctor.diagnose(db, GUILD).findings.find((item) => /timezone/.test(item.title));
  assert.ok(found);
  assert.equal(found.severity, doctor.SEVERITY.RISKY);
  assert.match(found.detail, /quietly/);
});

test('a department with no leader role is flagged', () => {
  const db = healthy();
  const modelling = configRepo.getDepartmentByKey(db, GUILD, 'modelling');
  db.prepare('UPDATE departments SET leader_role_id = NULL WHERE id = ?').run(modelling.id);

  const found = doctor.diagnose(db, GUILD).findings.find((item) => /leader role/.test(item.title));
  assert.ok(found);
  assert.match(found.detail, /Modelling/);
});

test('templates written but never approved are flagged, since nothing would send', () => {
  const db = healthy();
  const messagingRepo = require('../src/db/repos/messaging');
  messagingRepo.upsertTemplate(db, GUILD, {
    key: 'confirm', label: 'Confirmation', kind: 'transactional', body: 'Hello {{client_name}}.',
  }, OWNER);

  const found = doctor.diagnose(db, GUILD).findings.find((item) => /none approved/.test(item.title));
  assert.ok(found);
  assert.equal(found.severity, doctor.SEVERITY.RISKY);

  messagingRepo.approveTemplate(db, GUILD, 'confirm', OWNER);
  assert.equal(
    doctor.diagnose(db, GUILD).findings.some((item) => /none approved/.test(item.title)),
    false
  );
});

test('findings come back worst first', () => {
  const db = healthy();
  configRepo.updateConfig(db, GUILD, { fallback_channel_id: null, summary_channel_id: null }, OWNER);
  staffRepo.ensureStaff(db, GUILD, 'artist-1', 'Artist');

  const order = doctor.diagnose(db, GUILD).findings.map((item) => doctor.ORDER.indexOf(item.severity));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
});

test('every finding says what to do about it', () => {
  const db = openDatabase({ file: ':memory:' });
  configRepo.ensureConfig(db, GUILD);

  const result = doctor.diagnose(db, GUILD);
  assert.ok(result.findings.length > 0);
  assert.ok(result.findings.every((item) => item.fix && item.detail),
    'a problem with no stated remedy is just an accusation');
});
