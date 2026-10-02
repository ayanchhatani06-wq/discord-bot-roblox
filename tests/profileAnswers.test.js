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
const answers = require('../src/services/profileAnswers');
const { buildProfileEmbed, buildProfileComponents } = require('../src/services/profileView');
const profileForms = require('../src/interactions/profile');

const GUILD = 'guild-1';
const OWNER = 'owner-1';
const ARTIST = 'artist-1';

function setup() {
  process.env.PORTFOLIO_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'answers-'));
  const db = openDatabase({ file: ':memory:' });
  configRepo.ensureConfig(db, GUILD);
  configRepo.seedDefaultDepartments(db, GUILD, OWNER);
  staffRepo.ensureStaff(db, GUILD, ARTIST, 'Abubakar');
  return db;
}

/** A modal submission carrying exactly these boxes, as discord.js presents it. */
function submitted(boxes) {
  return {
    fields: {
      getTextInputValue(id) {
        if (!(id in boxes)) throw new Error(`Field with custom id "${id}" not found`);
        return boxes[id];
      },
    },
  };
}

function person(db) {
  const staff = staffRepo.getStaff(db, GUILD, ARTIST);
  return roster.assess(staff, { pictures: portfolioImages.countFor(db, GUILD, ARTIST) });
}

// ---------------------------------------------------------------- what counts as "no"

test('the ways people say no are read as no', () => {
  for (const word of ['no', 'No', 'NONE', 'n/a', 'na', '-', 'nothing', 'not yet', 'I dont have', 'no.', 'Nope']) {
    assert.equal(answers.isDecline(word), true, word);
  }
});

test('words that merely start like no are not', () => {
  // The failure that would matter: a real answer silently thrown away.
  for (const word of ['november', 'nobody', 'note', 'Nomad Sculpt', 'Blender', 'none of the above was used']) {
    assert.equal(answers.isDecline(word), false, word);
  }
});

test('a blank box takes an earlier no back rather than repeating it', () => {
  assert.deepEqual(answers.readAnswer(''), { value: null, declined: false });
  assert.deepEqual(answers.readAnswer('   '), { value: null, declined: false });
  assert.deepEqual(answers.readAnswer('none'), { value: null, declined: true });
  assert.deepEqual(answers.readAnswer(' UI Designer '), { value: 'UI Designer', declined: false });
});

test('the decline list adds and removes without disturbing the rest', () => {
  let staff = { profile_declined: null };
  staff = { profile_declined: answers.withDecline(staff, 'pictures', true) };
  staff = { profile_declined: answers.withDecline(staff, 'hours', true) };
  assert.equal(staff.profile_declined, 'hours,pictures');

  staff = { profile_declined: answers.withDecline(staff, 'pictures', false) };
  assert.equal(staff.profile_declined, 'hours');

  staff = { profile_declined: answers.withDecline(staff, 'hours', false) };
  assert.equal(staff.profile_declined, null, 'empty goes back to null, not an empty string');
});

// ---------------------------------------------------------------- the details form

test('the details form now asks for title and experience', () => {
  // The reason this exists: people filled in the old form, saw nothing about
  // role or experience, and asked what was left.
  const ids = profileForms.detailsModal({}).toJSON().components.map((row) => row.components[0].custom_id);
  assert.deepEqual(ids, ['sub_role', 'experience', 'specialties', 'software', 'portfolio_url']);
});

test('every box label fits Discord’s 45-character limit', () => {
  for (const modal of [profileForms.detailsModal({}), profileForms.robloxModal({}), profileForms.hoursModal({})]) {
    for (const row of modal.toJSON().components) {
      const { label } = row.components[0];
      assert.ok(label.length <= 45, `"${label}" is ${label.length} characters`);
    }
  }
});

test('a no is saved as answered and the box is left empty', () => {
  const db = setup();
  const staff = staffRepo.getStaff(db, GUILD, ARTIST);
  const { patch, problems } = profileForms.answersPatch(
    staff,
    ['sub_role', 'experience', 'specialties', 'software', 'portfolio_url'],
    submitted({ sub_role: 'UI Designer', experience: 'none', specialties: 'menus', software: 'Figma', portfolio_url: 'no' }),
  );

  assert.deepEqual(problems, []);
  assert.equal(patch.sub_role, 'UI Designer');
  assert.equal(patch.experience, null, 'the word "none" is not stored as their experience');
  assert.equal(patch.portfolio_url, null);
  assert.equal(patch.profile_declined, 'experience,portfolio_url');
});

test('a portfolio link must be a link — or none', () => {
  const db = setup();
  const staff = staffRepo.getStaff(db, GUILD, ARTIST);
  const validate = {
    portfolio_url: (value) => (/^https?:\/\//i.test(value) ? null : 'must be a link'),
  };

  const bad = profileForms.answersPatch(staff, ['portfolio_url'], submitted({ portfolio_url: 'my behance' }), { validate });
  assert.deepEqual(bad.problems, ['must be a link']);

  const none = profileForms.answersPatch(staff, ['portfolio_url'], submitted({ portfolio_url: 'none' }), { validate });
  assert.deepEqual(none.problems, [], '"none" is not checked as a link');
});

test('a form from an old panel saves what it had and leaves the rest alone', () => {
  // Somebody with yesterday's panel open submits yesterday's form: no title or
  // experience boxes, a Roblox box instead. discord.js throws on a missing box,
  // so this would have failed the whole save.
  const db = setup();
  staffRepo.updateStaff(db, GUILD, ARTIST, { sub_role: 'UI Designer' }, ARTIST);
  const staff = staffRepo.getStaff(db, GUILD, ARTIST);

  const { patch } = profileForms.answersPatch(
    staff,
    ['sub_role', 'experience', 'specialties', 'software', 'portfolio_url', 'roblox_username'],
    submitted({ specialties: 'menus', software: 'Figma', portfolio_url: 'https://a.test', roblox_username: 'abu' }),
  );

  assert.equal(patch.roblox_username, 'abu');
  assert.ok(!('sub_role' in patch), 'a box the form did not have must not be cleared');
});

// ---------------------------------------------------------------- what the roster makes of it

test('an answered no is not listed as missing', () => {
  const db = setup();
  staffRepo.updateStaff(db, GUILD, ARTIST, {
    timezone: 'Asia/Karachi',
    department_id: configRepo.listDepartments(db, GUILD)[0].id,
    sub_role: 'UI Designer', experience: '2 years', specialties: 'menus', software: 'Figma',
    portfolio_url: 'https://a.test',
    profile_declined: 'hours,pictures,roblox_username',
  }, OWNER);

  const result = person(db);
  assert.deepEqual(result.missing, [], `still missing: ${result.missing.join(', ')}`);
});

test('what is remaining is answered with where to fix it, grouped', () => {
  const db = setup();
  staffRepo.updateStaff(db, GUILD, ARTIST, {
    specialties: 'menus', software: 'Figma', portfolio_url: 'https://a.test', roblox_username: 'abu',
  }, OWNER);

  // Abubakar's exact situation: the old form all filled in.
  const steps = roster.nextSteps(person(db));
  assert.match(steps, /role title, experience\*\* — 📝 Edit details/);
  assert.match(steps, /timezone/);
  assert.match(steps, /portfolio pictures/);
  assert.match(steps, /\/profile portfolio none/, 'the way to say you have none is offered');
  // Title and experience share a form, so they share a line.
  assert.equal((steps.match(/Edit details/g) || []).length, 1);
});

test('a complete profile has no next steps', () => {
  const db = setup();
  staffRepo.updateStaff(db, GUILD, ARTIST, {
    timezone: 'Asia/Karachi',
    department_id: configRepo.listDepartments(db, GUILD)[0].id,
    profile_declined: 'experience,hours,pictures,portfolio_url,roblox_username,software,specialties,sub_role',
  }, OWNER);
  assert.equal(roster.nextSteps(person(db)), null);
});

test('adding a picture is what clears an earlier "no pictures"', () => {
  const db = setup();
  staffRepo.updateStaff(db, GUILD, ARTIST, { profile_declined: 'pictures' }, OWNER);
  assert.ok(!person(db).missing.includes('portfolio pictures'));

  staffRepo.updateStaff(db, GUILD, ARTIST, { profile_declined: 'hours,pictures' }, OWNER);
  portfolioImages.add(db, GUILD, ARTIST, {
    buffer: Buffer.from([1, 2, 3]), filename: 'a.png', contentType: 'image/png',
  }, ARTIST);

  // The stored answer itself, not just how the roster reads it — the roster
  // would say "not missing" either way, which is what made the first version
  // of this test prove nothing.
  assert.equal(staffRepo.getStaff(db, GUILD, ARTIST).profile_declined, 'hours');
});

// ---------------------------------------------------------------- what other people see

test('the profile shows a no as answered, distinct from blank', () => {
  const db = setup();
  staffRepo.updateStaff(db, GUILD, ARTIST, { profile_declined: 'portfolio_url,hours', software: 'Figma' }, OWNER);
  const fields = buildProfileEmbed({ staff: staffRepo.getStaff(db, GUILD, ARTIST), department: null }).toJSON().fields;

  assert.ok(fields.some((f) => f.name === 'Portfolio' && f.value === '_none_'));
  assert.ok(fields.some((f) => f.name === 'Usual hours' && /no fixed hours/.test(f.value)));
  assert.ok(!fields.some((f) => f.name === 'Specialties'), 'never answered stays absent');
});

test('the panel button says what is inside it', () => {
  const db = setup();
  const labels = buildProfileComponents(staffRepo.getStaff(db, GUILD, ARTIST))
    .flatMap((row) => row.toJSON().components.map((c) => c.label));
  assert.ok(labels.includes('Title, experience & skills'));
  assert.ok(labels.includes('Roblox name'));
});
