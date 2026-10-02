const test = require('node:test');
const assert = require('node:assert/strict');

const board = require('../src/services/staffBoard');
const { AVAILABILITY } = require('../src/db/repos/staff');

const NOW = new Date('2026-06-15T09:30:00Z');

function staff(overrides = {}) {
  return {
    user_id: 'artist-1',
    display_name: 'Artist One',
    timezone: 'Asia/Karachi',
    availability: AVAILABILITY.ACCEPTING,
    specialties: null,
    software: null,
    portfolio_url: null,
    working_days: null,
    working_start_minute: null,
    working_end_minute: null,
    away_until: null,
    ...overrides,
  };
}

test('a staff line shows identity, local time and workload', () => {
  const line = board.renderStaffLine(staff(), { activeCount: 3, now: NOW });

  assert.match(line, /<@artist-1>/);
  assert.match(line, /2:30 PM \(Mon\)/);
  // Read as GMT+5 rather than Asia/Karachi: the zone name is what is stored,
  // the offset is what somebody scanning a board is asking.
  assert.match(line, /GMT\+5/);
  assert.doesNotMatch(line, /Asia\/Karachi/);
  assert.match(line, /3 active/);
  assert.match(line, /🟢/);
});

test('the shared board never leaks briefs, client details or money', () => {
  const line = board.renderStaffLine(
    staff({ specialties: 'Hard-surface props', software: 'Blender', portfolio_url: 'https://example.com/p' }),
    { activeCount: 1, now: NOW }
  );

  for (const forbidden of ['$', 'R$', 'pay', 'client', 'brief', 'USD', 'ROBUX']) {
    assert.ok(!line.toLowerCase().includes(forbidden.toLowerCase()), `board line must not mention ${forbidden}`);
  }
  assert.match(line, /Hard-surface props/);
  assert.match(line, /\[portfolio\]\(https:\/\/example\.com\/p\)/);
});

test('missing timezone is stated rather than guessed', () => {
  const line = board.renderStaffLine(staff({ timezone: null }), { now: NOW });
  assert.match(line, /no timezone set/);
  assert.match(line, /0 active/);
});

test('away members show their return date', () => {
  const line = board.renderStaffLine(
    staff({ availability: AVAILABILITY.AWAY, away_until: Date.UTC(2026, 9, 20) }),
    { now: NOW }
  );
  assert.match(line, /⚪/);
  assert.match(line, /away until <t:\d+:d>/);
});

test('boards paginate so a growing department stays readable', () => {
  const rows = Array.from({ length: 47 }, (_, i) => staff({ user_id: `artist-${i}`, display_name: `Artist ${i}` }));
  const pages = board.buildDepartmentPages({
    department: { id: 1, name: 'Modelling', leader_role_id: 'role-lead' },
    staffRows: rows,
    activeCounts: new Map(),
    now: NOW,
  });

  assert.ok(pages.length >= 3, `expected multiple pages, got ${pages.length}`);
  const first = pages[0].toJSON();
  assert.match(first.title, /Modelling \(1\/\d+\)/);
  assert.ok(first.description.length <= 4096, 'description must fit the embed limit');

  // Every member appears exactly once across the pages.
  const rendered = pages.map((page) => page.toJSON().description).join('\n');
  for (const row of rows) {
    const occurrences = rendered.split(`<@${row.user_id}>`).length - 1;
    assert.equal(occurrences, 1, `${row.user_id} appeared ${occurrences} times`);
  }
});

test('the first page carries the leader, availability summary and an updated stamp', () => {
  const pages = board.buildDepartmentPages({
    department: { id: 1, name: 'VFX', leader_role_id: 'role-vfx-lead' },
    staffRows: [
      staff({ user_id: 'a', availability: AVAILABILITY.ACCEPTING }),
      staff({ user_id: 'b', availability: AVAILABILITY.AT_CAPACITY }),
      staff({ user_id: 'c', availability: AVAILABILITY.AWAY }),
    ],
    activeCounts: new Map([['a', 2]]),
    now: NOW,
  });

  const json = pages[0].toJSON();
  const fields = new Map(json.fields.map((field) => [field.name, field.value]));

  assert.equal(fields.get('Group leader'), '<@&role-vfx-lead>');
  assert.match(fields.get('Availability'), /1 accepting/);
  assert.match(fields.get('Availability'), /1 at capacity/);
  assert.match(fields.get('Availability'), /1 away/);
  // Rendered as a Discord timestamp so each viewer reads it in their own time.
  assert.match(fields.get('Updated'), /^<t:\d+:T>$/);
  assert.match(json.footer.text, /not Discord presence/);
});

test('an empty department still renders a page', () => {
  const pages = board.buildDepartmentPages({
    department: { id: 9, name: 'SFX', leader_role_id: null },
    staffRows: [],
    activeCounts: new Map(),
    now: NOW,
  });

  assert.equal(pages.length, 1);
  const json = pages[0].toJSON();
  assert.match(json.description, /Nobody in this department yet/);
  assert.equal(new Map(json.fields.map((f) => [f.name, f.value])).get('Group leader'), '_not set_');
});

test('staff with no department are rendered under their own heading', () => {
  const pages = board.buildDepartmentPages({
    department: null,
    staffRows: [staff()],
    activeCounts: new Map(),
    now: NOW,
  });
  assert.match(pages[0].toJSON().title, /Unassigned staff/);
});

test('department time view sorts west to east and flags missing zones', () => {
  const lines = board.departmentTimeLines(
    [
      staff({ user_id: 'karachi', timezone: 'Asia/Karachi' }),
      staff({ user_id: 'la', timezone: 'America/Los_Angeles' }),
      staff({ user_id: 'london', timezone: 'Europe/London' }),
      staff({ user_id: 'nozone', timezone: null }),
    ],
    { now: NOW }
  );

  assert.match(lines[0], /<@la>/);
  assert.match(lines[1], /<@london>/);
  assert.match(lines[2], /<@karachi>/);
  assert.match(lines[3], /no timezone set/);
  assert.match(lines[2], /GMT\+5/);
});

test('line chunking respects both the count and character limits', () => {
  const short = Array.from({ length: 5 }, (_, i) => `line ${i}`);
  assert.equal(board.chunkLines(short).length, 1);

  const long = Array.from({ length: 4 }, () => 'x'.repeat(1500));
  const pages = board.chunkLines(long);
  assert.ok(pages.length >= 2);
  for (const page of pages) {
    assert.ok(page.join('\n').length <= 3800);
  }
  assert.deepEqual(board.chunkLines([]), [[]]);
});

test('a half-hour zone keeps its minutes and UTC reads as plain GMT', () => {
  // India and Nepal are not on whole hours, so dropping the minutes would put
  // somebody half an hour out — which is exactly the kind of quiet error a
  // readable label is supposed to prevent.
  const { formatGmtLabel, gmtLabelFor } = require('../src/utils/time');

  assert.equal(formatGmtLabel(0), 'GMT');
  assert.equal(formatGmtLabel(300), 'GMT+5');
  assert.equal(formatGmtLabel(-300), 'GMT-5');
  assert.equal(formatGmtLabel(330), 'GMT+5:30');
  assert.equal(formatGmtLabel(345), 'GMT+5:45');
  assert.equal(formatGmtLabel(-210), 'GMT-3:30');

  assert.equal(gmtLabelFor('Asia/Kolkata'), 'GMT+5:30');
  assert.equal(gmtLabelFor('Asia/Kathmandu'), 'GMT+5:45');
  assert.equal(gmtLabelFor('UTC'), 'GMT');
  // A stored zone that is no longer valid must not take a board down with it.
  assert.equal(gmtLabelFor('Not/AZone'), null);
  assert.equal(gmtLabelFor(null), null);
});
