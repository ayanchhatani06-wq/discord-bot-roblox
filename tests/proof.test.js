const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDatabase } = require('../src/db');
const configRepo = require('../src/db/repos/config');
const projectsRepo = require('../src/db/repos/projects');
const tasksRepo = require('../src/db/repos/tasks');
const clientsRepo = require('../src/db/repos/clients');
const evidenceRepo = require('../src/db/repos/evidence');
const disputePack = require('../src/services/disputePack');

const GUILD = 'guild-1';
const OWNER = 'owner-1';
const STAFF = 'staff-1';

// A directory per test run, so nothing here can touch the real evidence store.
let scratch;
test.before(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cylops-evidence-'));
  process.env.EVIDENCE_DIR = scratch;
});
test.after(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
  delete process.env.EVIDENCE_DIR;
});

function setup() {
  const db = openDatabase({ file: ':memory:' });
  configRepo.ensureConfig(db, GUILD);
  configRepo.seedDefaultDepartments(db, GUILD, OWNER);
  configRepo.updateConfig(db, GUILD, { owner_user_id: OWNER }, OWNER);
  return db;
}

function png(text) {
  // Not a real PNG; the store never parses images, it only hashes the bytes.
  return Buffer.from(`fake-png:${text}`);
}

function store(db, buffer, overrides = {}) {
  return evidenceRepo.store(db, GUILD, {
    buffer,
    filename: 'screenshot.png',
    contentType: 'image/png',
    kind: 'payment',
    ...overrides,
  }, STAFF);
}

test('a screenshot is kept as bytes, not as a link to Discord', () => {
  const db = setup();
  const result = store(db, png('paid'));

  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  assert.equal(result.evidence.bytes, png('paid').length);
  assert.equal(result.evidence.sha256.length, 64);

  // The file is really on disk, under the hash rather than the given name.
  const absolute = path.join(scratch, result.evidence.stored_path);
  assert.equal(fs.existsSync(absolute), true);
  assert.equal(fs.readFileSync(absolute).equals(png('paid')), true);
  db.close();
});

test('the same file filed twice is one record, not two', () => {
  const db = setup();
  const first = store(db, png('same'));
  const second = store(db, png('same'), { note: 'sent again by mistake' });

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.evidence.id, first.evidence.id);
  assert.equal(evidenceRepo.listFor(db, GUILD, {}).length, 1);
  db.close();
});

test('two different files are two records even with the same name', () => {
  const db = setup();
  store(db, png('one'));
  store(db, png('two'));
  assert.equal(evidenceRepo.listFor(db, GUILD, {}).length, 2);
  db.close();
});

test('a file changed on disk after filing is refused, not returned', () => {
  const db = setup();
  const stored = store(db, png('original'));

  const absolute = path.join(scratch, stored.evidence.stored_path);
  fs.writeFileSync(absolute, png('tampered'));

  const read = evidenceRepo.read(db, GUILD, stored.evidence.id);
  assert.equal(read.ok, false);
  assert.equal(read.reason, 'hash_mismatch', 'a changed file is worse than a missing one');
  db.close();
});

test('a file deleted from disk is reported missing rather than crashing', () => {
  const db = setup();
  const stored = store(db, png('will-vanish'));
  fs.rmSync(path.join(scratch, stored.evidence.stored_path));

  const read = evidenceRepo.read(db, GUILD, stored.evidence.id);
  assert.equal(read.ok, false);
  assert.equal(read.reason, 'missing_file');
  db.close();
});

test('verifyAll separates what is intact, missing and changed', () => {
  const db = setup();
  const intact = store(db, png('intact'));
  const gone = store(db, png('gone'));
  const changed = store(db, png('changed'));

  fs.rmSync(path.join(scratch, gone.evidence.stored_path));
  fs.writeFileSync(path.join(scratch, changed.evidence.stored_path), png('not the same'));

  const result = evidenceRepo.verifyAll(db, GUILD);
  assert.equal(result.checked, 3);
  assert.equal(result.ok, 1);
  assert.deepEqual(result.missing.map((row) => row.id), [gone.evidence.id]);
  assert.deepEqual(result.changed.map((row) => row.id), [changed.evidence.id]);
  assert.equal(evidenceRepo.read(db, GUILD, intact.evidence.id).ok, true);
  db.close();
});

test('an executable is refused however it is labelled', () => {
  const db = setup();
  const refused = store(db, Buffer.from('MZ\x90\x00'), {
    filename: 'totally-a-screenshot.exe',
    contentType: 'application/x-msdownload',
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'unsupported_type');
  assert.equal(evidenceRepo.listFor(db, GUILD, {}).length, 0);
  db.close();
});

test('an oversized file is refused before anything is written', () => {
  const db = setup();
  const refused = store(db, Buffer.alloc(evidenceRepo.MAX_BYTES + 1, 1));
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'too_large');
  assert.equal(evidenceRepo.totalBytes(db, GUILD), 0);
  db.close();
});

test('an empty file is refused', () => {
  const db = setup();
  assert.equal(store(db, Buffer.alloc(0)).reason, 'empty');
  db.close();
});

test('a hostile filename cannot escape the evidence directory', () => {
  const db = setup();
  const stored = store(db, png('traversal'), { filename: '../../../../etc/passwd' });

  assert.equal(stored.ok, true);
  // The path on disk comes from the hash, so the given name cannot steer it.
  const absolute = path.resolve(scratch, stored.evidence.stored_path);
  assert.equal(absolute.startsWith(path.resolve(scratch)), true, 'stayed inside the evidence directory');
  db.close();
});

test('proof filed against a task is found when asking about its order', () => {
  const db = setup();
  const project = projectsRepo.createProject(db, GUILD, {
    name: 'Order', clientAmountMinor: 4000, clientCurrency: 'USD',
  }, OWNER);
  const task = tasksRepo.createTask(db, GUILD, {
    projectId: project.id,
    title: 'Model',
    departmentId: configRepo.getDepartmentByKey(db, GUILD, 'modelling').id,
    leaderUserId: OWNER,
  }, OWNER);

  store(db, png('on the task'), { taskId: task.id, projectId: null });
  store(db, png('on the order'), { projectId: project.id });

  const found = evidenceRepo.forProject(db, GUILD, project.id);
  assert.equal(found.length, 2, 'a file attached to a task belongs to that task\'s order too');
  db.close();
});

test('the order record names the gaps in it instead of reading as complete', () => {
  const db = setup();
  const project = projectsRepo.createProject(db, GUILD, {
    name: 'Order', clientAmountMinor: 4000, clientCurrency: 'USD',
  }, OWNER);
  tasksRepo.createTask(db, GUILD, {
    projectId: project.id,
    title: 'Model',
    departmentId: configRepo.getDepartmentByKey(db, GUILD, 'modelling').id,
    leaderUserId: OWNER,
  }, OWNER);

  const pack = disputePack.build(db, GUILD, projectsRepo.getProject(db, GUILD, project.id));
  const text = disputePack.render(pack);

  assert.ok(pack.gaps.length > 0, 'a bare order has gaps and should say so');
  assert.ok(
    pack.gaps.some((gap) => gap.includes('not linked to a client')),
    'no client on the order is a gap worth naming'
  );
  assert.ok(
    pack.gaps.some((gap) => gap.includes('accepting the terms')),
    'nobody accepted the terms, which is exactly what a dispute turns on'
  );
  assert.ok(
    pack.gaps.some((gap) => gap.includes('No screenshots')),
    'no proof on file is itself a gap'
  );
  assert.ok(text.includes('GAPS IN THE RECORD'), 'the gaps appear in the document, not just the data');
  assert.ok(text.includes('written when the thing happened'));
  db.close();
});

test('the order record counts a linked client and their authorised accounts', () => {
  const db = setup();
  const client = clientsRepo.createClient(db, GUILD, { displayName: 'A Client' }, OWNER);
  clientsRepo.addAccount(db, GUILD, client.id, { userId: 'client-discord-1' }, OWNER);

  const project = projectsRepo.createProject(db, GUILD, {
    name: 'Order', clientAmountMinor: 4000, clientCurrency: 'USD',
  }, OWNER);
  clientsRepo.linkProject(db, GUILD, project.id, client.id, OWNER);

  const pack = disputePack.build(db, GUILD, projectsRepo.getProject(db, GUILD, project.id));
  assert.equal(pack.client.id, client.id);
  assert.equal(pack.authorisedAccounts, 1);
  assert.equal(
    pack.gaps.some((gap) => gap.includes('not linked to a client')), false,
    'a linked client is not a gap'
  );
  db.close();
});

test('a backup copies the filed files, not just the records pointing at them', () => {
  const exporter = require('../src/services/exporter');
  const db = setup();
  const stored = store(db, png('must survive a restore'));

  const destination = path.join(scratch, 'copy-target');
  const result = exporter.backupEvidence(scratch, destination);

  assert.ok(result.copied >= 1);
  const copiedFile = path.join(destination, stored.evidence.stored_path);
  assert.equal(fs.existsSync(copiedFile), true, 'the bytes are in the backup, not just the hash');
  assert.equal(fs.readFileSync(copiedFile).equals(png('must survive a restore')), true);

  // Run twice: a file already there has the same contents by definition, since
  // its name is its hash.
  const again = exporter.backupEvidence(scratch, destination);
  assert.ok(again.skipped >= 1);

  fs.rmSync(destination, { recursive: true, force: true });
  db.close();
});

test('a backup destination inside the evidence directory does not copy its own copies', () => {
  const exporter = require('../src/services/exporter');
  const db = setup();
  store(db, png('nested destination'));

  // The pathological case: somebody sets BACKUP_DIR inside EVIDENCE_DIR.
  const nested = path.join(scratch, 'nested-backup');
  const first = exporter.backupEvidence(scratch, nested);
  assert.ok(first.copied >= 1);

  const second = exporter.backupEvidence(scratch, nested);
  assert.equal(second.copied, 0, 'the second run finds nothing new, rather than copying the copies');

  assert.equal(fs.existsSync(path.join(nested, 'nested-backup')), false, 'no copy of the backup inside itself');

  // And the degenerate case of backing a directory up onto itself.
  const same = exporter.backupEvidence(scratch, scratch);
  assert.equal(same.reason, 'same_directory');
  assert.equal(same.copied, 0);

  fs.rmSync(nested, { recursive: true, force: true });
  db.close();
});
