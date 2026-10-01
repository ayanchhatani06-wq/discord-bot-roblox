const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { openDatabase } = require('../src/db');
const configRepo = require('../src/db/repos/config');
const staffRepo = require('../src/db/repos/staff');
const portfolio = require('../src/services/portfolioImages');
const { buildProfileEmbed } = require('../src/services/profileView');

const GUILD = 'guild-1';
const OWNER = 'owner-1';
const ARTIST = 'artist-1';

/** A real directory per test, so nothing writes into the project's data folder. */
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portfolio-'));
  process.env.PORTFOLIO_DIR = dir;

  const db = openDatabase({ file: ':memory:' });
  configRepo.ensureConfig(db, GUILD);
  staffRepo.ensureStaff(db, GUILD, ARTIST, 'Milton');
  return { db, dir };
}

/** A tiny but genuine PNG, so content type and bytes are real. */
function png(seed = 1) {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(32, seed),
  ]);
}

function add(db, { buffer = png(), filename = 'lobby.png', contentType = 'image/png', caption = null } = {}) {
  return portfolio.add(db, GUILD, ARTIST, { buffer, filename, contentType, caption }, ARTIST);
}

// ---------------------------------------------------------------- storing

test('a picture is written to disk and recorded', () => {
  const { db, dir } = setup();
  const result = add(db, { caption: 'Neo lobby' });

  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  assert.equal(result.image.caption, 'Neo lobby');

  const onDisk = path.join(dir, result.image.stored_path);
  assert.ok(fs.existsSync(onDisk), 'the bytes should be on disk, not just referenced');
  assert.deepEqual(fs.readFileSync(onDisk), png());
});

test('the file is kept, not the Discord link', () => {
  // The whole reason this exists: an attachment URL dies with its message.
  const { db } = setup();
  const result = add(db);
  const columns = Object.keys(result.image);
  assert.ok(columns.includes('stored_path'));
  assert.ok(!columns.some((c) => c.includes('url')), 'no URL column to rot');
});

test('the same picture twice is one entry', () => {
  const { db } = setup();
  const first = add(db);
  const second = add(db);

  assert.equal(second.created, false);
  assert.equal(second.image.id, first.image.id);
  assert.equal(portfolio.countFor(db, GUILD, ARTIST), 1);
});

test('a person is capped, and the cap does not block re-adding what they have', () => {
  const { db } = setup();
  for (let i = 0; i < portfolio.MAX_PER_PERSON; i += 1) {
    assert.equal(add(db, { buffer: png(i), filename: `shot-${i}.png` }).ok, true, `picture ${i}`);
  }

  const overflow = add(db, { buffer: png(99), filename: 'one-too-many.png' });
  assert.equal(overflow.ok, false);
  assert.equal(overflow.reason, 'too_many');

  // A duplicate of something already stored is not a new picture, so it is
  // answered rather than refused for being over the limit.
  const duplicate = add(db, { buffer: png(0), filename: 'shot-0.png' });
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.created, false);
});

test('only pictures are accepted', () => {
  const { db } = setup();
  for (const contentType of ['application/pdf', 'text/plain', 'application/zip', null]) {
    const result = add(db, { contentType, filename: 'thing.pdf' });
    assert.equal(result.ok, false, `${contentType} should be refused`);
    assert.equal(result.reason, 'unsupported_type');
  }
});

test('an oversized file is refused before anything is written', () => {
  const { db, dir } = setup();
  const result = portfolio.add(db, GUILD, ARTIST, {
    buffer: Buffer.alloc(portfolio.MAX_BYTES + 1, 7), filename: 'huge.png', contentType: 'image/png',
  }, ARTIST);

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'too_large');
  assert.deepEqual(fs.readdirSync(dir), [], 'nothing should have been written');
});

test('an empty file is refused', () => {
  const { db } = setup();
  const result = add(db, { buffer: Buffer.alloc(0) });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'empty');
});

// ---------------------------------------------------------------- reading and removing

test('the bytes come back for sending', () => {
  const { db } = setup();
  const added = add(db);
  const read = portfolio.read(db, GUILD, added.image.id);

  assert.equal(read.missing, false);
  assert.deepEqual(read.buffer, png());
});

test('a record whose file vanished says so rather than throwing', () => {
  const { db, dir } = setup();
  const added = add(db);
  fs.unlinkSync(path.join(dir, added.image.stored_path));

  const read = portfolio.read(db, GUILD, added.image.id);
  assert.equal(read.missing, true);
  assert.equal(read.buffer, null);
});

test('removing takes the file with it', () => {
  const { db, dir } = setup();
  const added = add(db);
  const onDisk = path.join(dir, added.image.stored_path);

  const result = portfolio.remove(db, GUILD, added.image.id, ARTIST);
  assert.equal(result.ok, true);
  assert.equal(result.fileRemoved, true);
  assert.ok(!fs.existsSync(onDisk));
});

test('two people showing the same piece keep it when one removes it', () => {
  const { db, dir } = setup();
  staffRepo.ensureStaff(db, GUILD, 'artist-2', 'Danisaads');

  const mine = add(db);
  const theirs = portfolio.add(db, GUILD, 'artist-2', {
    buffer: png(), filename: 'lobby.png', contentType: 'image/png',
  }, 'artist-2');

  const result = portfolio.remove(db, GUILD, mine.image.id, ARTIST);
  assert.equal(result.fileRemoved, false, 'the other person still shows it');
  assert.ok(fs.existsSync(path.join(dir, theirs.image.stored_path)));
  assert.equal(portfolio.read(db, GUILD, theirs.image.id).missing, false);
});

test('you cannot remove somebody else’s picture', () => {
  const { db } = setup();
  const added = add(db);

  const result = portfolio.remove(db, GUILD, added.image.id, 'someone-else');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not_found');
  assert.equal(portfolio.countFor(db, GUILD, ARTIST), 1, 'it should still be there');
});

// ---------------------------------------------------------------- role and experience

test('the sub-role and experience are saved and shown', () => {
  const { db } = setup();
  staffRepo.updateStaff(db, GUILD, ARTIST, {
    sub_role: 'Interior Builder', experience: '10+ years',
  }, ARTIST);

  const staff = staffRepo.getStaff(db, GUILD, ARTIST);
  assert.equal(staff.sub_role, 'Interior Builder');
  assert.equal(staff.experience, '10+ years');

  const embed = buildProfileEmbed({ staff, department: { name: 'Building' } }).toJSON();
  const department = embed.fields.find((f) => f.name === 'Department');
  assert.match(department.value, /Building/);
  assert.match(department.value, /Interior Builder/);
  assert.ok(embed.fields.some((f) => f.name === 'Experience' && f.value === '10+ years'));
});

test('a profile without them renders no empty fields', () => {
  const { db } = setup();
  const embed = buildProfileEmbed({
    staff: staffRepo.getStaff(db, GUILD, ARTIST), department: null,
  }).toJSON();

  assert.ok(!embed.fields.some((f) => f.name === 'Experience'));
  assert.ok(!embed.fields.some((f) => f.value === 'undefined' || f.value === 'null'));
});
