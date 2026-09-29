const test = require('node:test');
const assert = require('node:assert/strict');
const time = require('../src/utils/time');

test('accepts IANA identifiers and rejects abbreviations and countries', () => {
  for (const zone of ['Asia/Karachi', 'Europe/London', 'America/Los_Angeles', 'UTC']) {
    assert.equal(time.isValidTimezone(zone), true, `${zone} should be valid`);
  }
  // Abbreviations and country names are ambiguous, which is exactly why the
  // bot refuses them as input.
  for (const bad of ['PST', 'EST', 'GMT+5', 'Pakistan', 'India', 'America']) {
    assert.equal(time.isValidTimezone(bad), false, `${bad} should be rejected`);
  }
});

test('search finds zones from partial city names', () => {
  assert.ok(time.searchTimezones('karachi').includes('Asia/Karachi'));
  assert.ok(time.searchTimezones('los ang').includes('America/Los_Angeles'));
  assert.ok(time.searchTimezones('london').includes('Europe/London'));
  assert.ok(time.searchTimezones('', 5).length === 5);
});

test('offsets follow daylight saving, per zone', () => {
  // Karachi has no DST: same offset in January and July.
  const janKarachi = time.getOffsetMinutes('Asia/Karachi', new Date('2026-01-15T12:00:00Z'));
  const julKarachi = time.getOffsetMinutes('Asia/Karachi', new Date('2026-07-15T12:00:00Z'));
  assert.equal(janKarachi, 300);
  assert.equal(julKarachi, 300);

  // London does: UTC+0 in winter, UTC+1 in summer.
  assert.equal(time.getOffsetMinutes('Europe/London', new Date('2026-01-15T12:00:00Z')), 0);
  assert.equal(time.getOffsetMinutes('Europe/London', new Date('2026-07-15T12:00:00Z')), 60);

  // Los Angeles: UTC-8 winter, UTC-7 summer.
  assert.equal(time.getOffsetMinutes('America/Los_Angeles', new Date('2026-01-15T12:00:00Z')), -480);
  assert.equal(time.getOffsetMinutes('America/Los_Angeles', new Date('2026-07-15T12:00:00Z')), -420);
});

test('formats offsets including half-hour zones', () => {
  assert.equal(time.formatOffsetLabel(300), 'UTC+05:00');
  assert.equal(time.formatOffsetLabel(-480), 'UTC-08:00');
  assert.equal(time.formatOffsetLabel(0), 'UTC+00:00');
  assert.equal(time.formatOffsetLabel(330), 'UTC+05:30');
  assert.equal(time.getOffsetMinutes('Asia/Kolkata', new Date('2026-01-15T12:00:00Z')), 330);
});

test('converts a wall-clock reading in a zone to the right UTC instant', () => {
  const result = time.wallTimeToUtc({ year: 2026, month: 6, day: 15, hour: 14, minute: 30 }, 'Asia/Karachi');
  assert.equal(result.ok, true);
  // 14:30 in Karachi (UTC+5) is 09:30 UTC.
  assert.equal(new Date(result.utcMs).toISOString(), '2026-06-15T09:30:00.000Z');
  assert.equal(result.ambiguous, false);
});

test('the hour skipped by a spring-forward does not exist', () => {
  // US clocks jump 02:00 -> 03:00 on 8 March 2026, so 02:30 never happens.
  const result = time.wallTimeToUtc({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, 'America/New_York');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'nonexistent_local_time');
});

test('the hour repeated by a fall-back is reported as ambiguous', () => {
  // US clocks fall back 02:00 -> 01:00 on 1 November 2026, so 01:30 happens twice.
  const result = time.wallTimeToUtc({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, 'America/New_York');
  assert.equal(result.ok, true);
  assert.equal(result.ambiguous, true);
  assert.equal(result.alternatives.length, 1);
  // The earlier of the two instants is chosen.
  assert.ok(result.utcMs < result.alternatives[0].utcMs);
});

test('an invalid zone cannot produce a deadline', () => {
  assert.equal(time.wallTimeToUtc({ year: 2026, month: 1, day: 1, hour: 9, minute: 0 }, 'PST').reason, 'invalid_timezone');
});

test('deadline input is parsed and echoed back for confirmation', () => {
  const result = time.parseDeadlineInput('2026-10-05 14:30', 'Europe/London');
  assert.equal(result.ok, true);
  assert.equal(result.impliedEndOfDay, false);
  assert.match(result.preview, /Oct 5, 2026/);
  assert.match(result.preview, /Europe\/London/);
  assert.match(result.preview, /UTC\+01:00/);
  assert.equal(new Date(result.utcMs).toISOString(), '2026-10-05T13:30:00.000Z');
});

test('a bare date becomes end of day and says so', () => {
  const result = time.parseDeadlineInput('2026-10-05', 'Asia/Karachi');
  assert.equal(result.ok, true);
  assert.equal(result.impliedEndOfDay, true);
  assert.equal(new Date(result.utcMs).toISOString(), '2026-10-05T18:59:00.000Z');
});

test('unparsable or out-of-range deadlines are rejected with a hint', () => {
  const bad = time.parseDeadlineInput('next tuesday', 'UTC');
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'unparsable');
  assert.match(bad.hint, /YYYY-MM-DD/);
  assert.equal(time.parseDeadlineInput('2026-13-05', 'UTC').reason, 'out_of_range');
  assert.equal(time.parseDeadlineInput('2026-10-05 25:00', 'UTC').ok, false);
});

test('Discord timestamps are emitted so each viewer sees their own local time', () => {
  const ms = Date.UTC(2026, 9, 5, 13, 30);
  assert.equal(time.discordTimestamp(ms), `<t:${ms / 1000}:F>`);
  assert.equal(time.discordTimestamp(new Date(ms), 'R'), `<t:${ms / 1000}:R>`);
});

test('quiet hours wrap past midnight', () => {
  const quiet = { timeZone: 'Asia/Karachi', quietStartMinute: 22 * 60, quietEndMinute: 7 * 60 };

  // 23:00 Karachi = 18:00 UTC -> inside quiet hours.
  assert.equal(time.isWithinQuietHours({ at: new Date('2026-06-15T18:00:00Z'), ...quiet }), true);
  // 03:00 Karachi = 22:00 UTC previous day -> still inside.
  assert.equal(time.isWithinQuietHours({ at: new Date('2026-06-14T22:00:00Z'), ...quiet }), true);
  // 09:00 Karachi = 04:00 UTC -> outside.
  assert.equal(time.isWithinQuietHours({ at: new Date('2026-06-15T04:00:00Z'), ...quiet }), false);
  // Unset quiet hours never suppress anything.
  assert.equal(time.isWithinQuietHours({ at: new Date(), timeZone: 'Asia/Karachi' }), false);
});

test('a reminder inside quiet hours is deferred to when they end', () => {
  const at = new Date('2026-06-15T18:00:00Z'); // 23:00 Karachi
  const endsAt = time.quietHoursEndAt({
    at,
    timeZone: 'Asia/Karachi',
    quietStartMinute: 22 * 60,
    quietEndMinute: 7 * 60,
  });

  assert.ok(endsAt > at.getTime());
  // Should land at 07:00 Karachi the next morning = 02:00 UTC on the 16th.
  assert.equal(new Date(endsAt).toISOString(), '2026-06-16T02:00:00.000Z');
  assert.equal(
    time.quietHoursEndAt({ at: new Date('2026-06-15T04:00:00Z'), timeZone: 'Asia/Karachi', quietStartMinute: 22 * 60, quietEndMinute: 7 * 60 }),
    null,
    'nothing to defer outside quiet hours'
  );
});

test('working hours are read in the staff member\'s own timezone', () => {
  const profile = {
    timeZone: 'Europe/London',
    workingDays: 'mon,tue,wed,thu,fri',
    workingStartMinute: 9 * 60,
    workingEndMinute: 17 * 60,
  };

  // Monday 2026-10-05 12:00 London = 11:00 UTC -> working.
  assert.equal(time.isWithinWorkingHours({ at: new Date('2026-10-05T11:00:00Z'), ...profile }), true);
  // Monday 20:00 London -> outside hours.
  assert.equal(time.isWithinWorkingHours({ at: new Date('2026-10-05T19:00:00Z'), ...profile }), false);
  // Sunday 2026-10-04 12:00 -> not a working day.
  assert.equal(time.isWithinWorkingHours({ at: new Date('2026-10-04T11:00:00Z'), ...profile }), false);
  // Unset hours are unknown rather than false.
  assert.equal(time.isWithinWorkingHours({ at: new Date(), timeZone: 'Europe/London' }), null);
});

test('clock helpers round-trip and reject nonsense', () => {
  assert.equal(time.parseClockInput('09:30'), 570);
  assert.equal(time.parseClockInput('9:30'), 570);
  assert.equal(time.parseClockInput('23:59'), 1439);
  assert.equal(time.parseClockInput('24:00'), null);
  assert.equal(time.parseClockInput('9.30'), null);
  assert.equal(time.formatClockMinutes(570), '09:30');
  assert.equal(time.formatClockMinutes(1439), '23:59');
});

test('working days accept names or numbers and format back', () => {
  assert.deepEqual(time.normalizeWorkingDays('mon,tue'), [1, 2]);
  assert.deepEqual(time.normalizeWorkingDays('1,2,3'), [1, 2, 3]);
  assert.deepEqual(time.normalizeWorkingDays([1, 5]), [1, 5]);
  assert.equal(time.formatWorkingDays('mon,tue,wed,thu,fri'), 'Mon, Tue, Wed, Thu, Fri');
  assert.equal(time.formatWorkingDays(null), null);
});

test('local time rendering includes weekday for board readability', () => {
  const rendered = time.formatTimeInZone('Asia/Karachi', new Date('2026-06-15T09:30:00Z'));
  assert.match(rendered, /2:30 PM \(Mon\)/);
});
