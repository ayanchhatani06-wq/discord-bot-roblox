const test = require('node:test');
const assert = require('node:assert/strict');

const { openDatabase } = require('../src/db');
const configRepo = require('../src/db/repos/config');
const staffRepo = require('../src/db/repos/staff');
const projectsRepo = require('../src/db/repos/projects');
const tasksRepo = require('../src/db/repos/tasks');
const offersRepo = require('../src/db/repos/offers');
const remindersRepo = require('../src/db/repos/reminders');
const { sweepGuild, KINDS } = require('../src/services/reminders');
const { buildWeeklySummary } = require('../src/services/summary');
const { TASK_STATES } = require('../src/domain/taskState');
const { HOUR_MS, DAY_MS } = require('../src/utils/time');

const GUILD = 'guild-1';
const OWNER = 'owner-1';
const LEADER = 'leader-1';
const ARTIST = 'artist-1';

// A fixed instant: 12:00 UTC = 17:00 in Karachi, outside any quiet hours.
const NOW = Date.UTC(2026, 5, 15, 12, 0);

function setup() {
  const db = openDatabase({ file: ':memory:' });
  configRepo.ensureConfig(db, GUILD);
  configRepo.seedDefaultDepartments(db, GUILD, OWNER);
  configRepo.updateConfig(db, GUILD, { owner_user_id: OWNER }, OWNER);

  staffRepo.ensureStaff(db, GUILD, ARTIST, 'Artist One');
  staffRepo.updateStaff(db, GUILD, ARTIST, { timezone: 'Asia/Karachi' });
  staffRepo.ensureStaff(db, GUILD, LEADER, 'Leader One');
  staffRepo.updateStaff(db, GUILD, LEADER, { timezone: 'Europe/London' });
  return db;
}

function makeTask(db, overrides = {}) {
  const project = projectsRepo.createProject(db, GUILD, { name: 'P', clientAmountMinor: 4000, clientCurrency: 'USD' }, OWNER);
  const task = tasksRepo.createTask(db, GUILD, {
    projectId: project.id,
    title: 'Model',
    departmentId: configRepo.getDepartmentByKey(db, GUILD, 'modelling').id,
    leaderUserId: LEADER,
    ...overrides,
  }, OWNER);
  return { project, task };
}

function linesFor(batch, userId) {
  return (batch.byUser.get(userId) || []).map((entry) => entry.line);
}

function kindsFor(batch, userId) {
  return (batch.byUser.get(userId) || []).map((entry) => entry.kind);
}

test('an unanswered offer chases the artist first, not the leader', () => {
  const db = setup();
  const { task } = makeTask(db);
  tasksRepo.approvePay(db, GUILD, task.id, { amountMinor: 2500, currency: 'USD', actorUserId: OWNER });
  tasksRepo.applyTransition(db, GUILD, task.id, 'offer', { actorUserId: LEADER, patch: { artist_user_id: ARTIST } });

  const offer = offersRepo.createOffer(db, GUILD, {
    taskId: task.id, artistUserId: ARTIST, offeredBy: LEADER, terms: {},
  });
  db.prepare('UPDATE task_offers SET offered_at = ? WHERE id = ?').run(NOW - 20 * HOUR_MS, offer.id);

  const batch = sweepGuild(db, GUILD, { now: NOW });
  assert.ok(kindsFor(batch, ARTIST).includes(KINDS.OFFER_UNANSWERED));
  assert.ok(!kindsFor(batch, LEADER).includes(KINDS.OFFER_ESCALATED), 'the leader is not told on the first pass');
  assert.equal(offersRepo.getOffer(db, offer.id).reminder_sent_at !== null, true);
  db.close();
});

test('an offer still unanswered after the artist was chased escalates to the leader', () => {
  const db = setup();
  const { task } = makeTask(db);
  tasksRepo.approvePay(db, GUILD, task.id, { amountMinor: 2500, currency: 'USD', actorUserId: OWNER });
  tasksRepo.applyTransition(db, GUILD, task.id, 'offer', { actorUserId: LEADER, patch: { artist_user_id: ARTIST } });

  const offer = offersRepo.createOffer(db, GUILD, {
    taskId: task.id, artistUserId: ARTIST, offeredBy: LEADER, terms: {},
  });
  db.prepare('UPDATE task_offers SET offered_at = ?, reminder_sent_at = ? WHERE id = ?')
    .run(NOW - 3 * DAY_MS, NOW - 2 * DAY_MS, offer.id);

  const batch = sweepGuild(db, GUILD, { now: NOW });
  const leaderLines = linesFor(batch, LEADER);
  assert.ok(kindsFor(batch, LEADER).includes(KINDS.OFFER_ESCALATED));
  assert.match(leaderLines.join('\n'), /has not answered/);
  assert.equal(offersRepo.getOffer(db, offer.id).escalated_at !== null, true);
  db.close();
});

test('quiet hours defer a reminder instead of dropping it', () => {
  const db = setup();
  // 02:00 in Karachi is inside 22:00-07:00 quiet hours.
  const quietNow = Date.UTC(2026, 5, 15, 21, 0);
  staffRepo.updateStaff(db, GUILD, ARTIST, { quiet_start_minute: 22 * 60, quiet_end_minute: 7 * 60 });

  const { task } = makeTask(db, { deadlineUtc: quietNow + 3 * HOUR_MS });
  tasksRepo.assignArtist(db, GUILD, task.id, ARTIST, OWNER);
  db.prepare("UPDATE tasks SET state = 'in_progress' WHERE id = ?").run(task.id);

  const batch = sweepGuild(db, GUILD, { now: quietNow });
  assert.equal(batch.byUser.has(ARTIST), false, 'nothing is sent during quiet hours');
  assert.equal(batch.deferred.length >= 1, true);

  const state = remindersRepo.getState(db, GUILD, KINDS.DEADLINE_UPCOMING, 'task', task.id);
  assert.ok(state.deferred_to > quietNow, 'it is held until quiet hours end');
  assert.equal(state.last_sent_at, null, 'and is not marked as sent');
  db.close();
});

test('a deferred reminder is delivered once quiet hours are over', () => {
  const db = setup();
  const quietNow = Date.UTC(2026, 5, 15, 21, 0);
  const afterQuiet = Date.UTC(2026, 5, 16, 6, 0); // 11:00 in Karachi
  staffRepo.updateStaff(db, GUILD, ARTIST, { quiet_start_minute: 22 * 60, quiet_end_minute: 7 * 60 });

  const { task } = makeTask(db, { deadlineUtc: afterQuiet + 3 * HOUR_MS });
  tasksRepo.assignArtist(db, GUILD, task.id, ARTIST, OWNER);
  db.prepare("UPDATE tasks SET state = 'in_progress' WHERE id = ?").run(task.id);

  sweepGuild(db, GUILD, { now: quietNow });
  const later = sweepGuild(db, GUILD, { now: afterQuiet });

  assert.ok(kindsFor(later, ARTIST).includes(KINDS.DEADLINE_UPCOMING));
  db.close();
});

test('the studio default quiet hours apply to staff who set none of their own', () => {
  const db = setup();
  configRepo.updateConfig(db, GUILD, { quiet_start_minute: 22 * 60, quiet_end_minute: 7 * 60 }, OWNER);
  const quietNow = Date.UTC(2026, 5, 15, 21, 0); // 02:00 Karachi

  const { task } = makeTask(db, { deadlineUtc: quietNow + 3 * HOUR_MS });
  tasksRepo.assignArtist(db, GUILD, task.id, ARTIST, OWNER);
  db.prepare("UPDATE tasks SET state = 'in_progress' WHERE id = ?").run(task.id);

  const batch = sweepGuild(db, GUILD, { now: quietNow });
  assert.equal(batch.byUser.has(ARTIST), false);
  assert.ok(batch.deferred.length >= 1);
  db.close();
});

test('the same reminder is not repeated on every sweep', () => {
  const db = setup();
  // 40 hours out: inside the 48-hour warning window, and still in the future
  // a day later so it stays "upcoming" rather than turning overdue.
  const { task } = makeTask(db, { deadlineUtc: NOW + 40 * HOUR_MS });
  tasksRepo.assignArtist(db, GUILD, task.id, ARTIST, OWNER);
  db.prepare("UPDATE tasks SET state = 'in_progress' WHERE id = ?").run(task.id);

  const first = sweepGuild(db, GUILD, { now: NOW });
  assert.ok(kindsFor(first, ARTIST).includes(KINDS.DEADLINE_UPCOMING));

  // Marking sent is what the real send does after delivery succeeds.
  remindersRepo.markSent(db, GUILD, KINDS.DEADLINE_UPCOMING, 'task', task.id, NOW);

  const second = sweepGuild(db, GUILD, { now: NOW + HOUR_MS });
  assert.equal(kindsFor(second, ARTIST).includes(KINDS.DEADLINE_UPCOMING), false);

  const nextDay = sweepGuild(db, GUILD, { now: NOW + 25 * HOUR_MS });
  assert.equal(kindsFor(nextDay, ARTIST).includes(KINDS.DEADLINE_UPCOMING), true, 'it may repeat after the interval');
  db.close();
});

test('a deadline that passes turns from an upcoming warning into an overdue one', () => {
  const db = setup();
  const { task } = makeTask(db, { deadlineUtc: NOW + 3 * HOUR_MS });
  tasksRepo.assignArtist(db, GUILD, task.id, ARTIST, OWNER);
  db.prepare("UPDATE tasks SET state = 'in_progress' WHERE id = ?").run(task.id);

  assert.ok(kindsFor(sweepGuild(db, GUILD, { now: NOW }), ARTIST).includes(KINDS.DEADLINE_UPCOMING));

  const afterward = sweepGuild(db, GUILD, { now: NOW + DAY_MS });
  assert.ok(kindsFor(afterward, ARTIST).includes(KINDS.DEADLINE_OVERDUE));
  assert.equal(kindsFor(afterward, ARTIST).includes(KINDS.DEADLINE_UPCOMING), false);
  db.close();
});

test('overdue work tells both the artist and their leader', () => {
  const db = setup();
  const { task } = makeTask(db, { deadlineUtc: NOW - DAY_MS });
  tasksRepo.assignArtist(db, GUILD, task.id, ARTIST, OWNER);
  db.prepare("UPDATE tasks SET state = 'in_progress' WHERE id = ?").run(task.id);

  const batch = sweepGuild(db, GUILD, { now: NOW });
  assert.ok(kindsFor(batch, ARTIST).includes(KINDS.DEADLINE_OVERDUE));
  assert.ok(kindsFor(batch, LEADER).includes(KINDS.DEADLINE_OVERDUE));
  db.close();
});

test('work with no recent progress nudges the artist', () => {
  const db = setup();
  const { task } = makeTask(db);
  tasksRepo.assignArtist(db, GUILD, task.id, ARTIST, OWNER);
  db.prepare("UPDATE tasks SET state = 'in_progress', last_progress_at = ? WHERE id = ?")
    .run(NOW - 5 * DAY_MS, task.id);

  const batch = sweepGuild(db, GUILD, { now: NOW });
  assert.ok(kindsFor(batch, ARTIST).includes(KINDS.STALE_PROGRESS));

  // A fresh update stops the nudge.
  db.prepare('UPDATE tasks SET last_progress_at = ? WHERE id = ?').run(NOW - HOUR_MS, task.id);
  remindersRepo.clearForEntity(db, GUILD, 'task', task.id);
  const after = sweepGuild(db, GUILD, { now: NOW });
  assert.equal(kindsFor(after, ARTIST).includes(KINDS.STALE_PROGRESS), false);
  db.close();
});

test('submissions waiting on review go to the leader, and client waits go to the owner', () => {
  const db = setup();
  const { task: review } = makeTask(db);
  tasksRepo.assignArtist(db, GUILD, review.id, ARTIST, OWNER);
  db.prepare("UPDATE tasks SET state = 'internal_review' WHERE id = ?").run(review.id);

  const { task: client } = makeTask(db);
  db.prepare("UPDATE tasks SET state = 'awaiting_client' WHERE id = ?").run(client.id);

  const batch = sweepGuild(db, GUILD, { now: NOW });
  assert.ok(kindsFor(batch, LEADER).includes(KINDS.AWAITING_REVIEW));
  assert.ok(kindsFor(batch, OWNER).includes(KINDS.AWAITING_CLIENT));
  db.close();
});

test('approved work with money owed reminds the owner to pay', () => {
  const db = setup();
  const { project, task } = makeTask(db);
  tasksRepo.approvePay(db, GUILD, task.id, { amountMinor: 2500, currency: 'USD', actorUserId: OWNER });
  tasksRepo.assignArtist(db, GUILD, task.id, ARTIST, OWNER);
  db.prepare("UPDATE tasks SET state = 'client_approved', payment_state = 'payable' WHERE id = ?").run(task.id);

  const batch = sweepGuild(db, GUILD, { now: NOW });
  const lines = linesFor(batch, OWNER).join('\n');
  assert.ok(kindsFor(batch, OWNER).includes(KINDS.APPROVED_UNPAID));
  assert.match(lines, /\$25\.00/);
  db.close();
});

test('someone whose away date has passed is asked, not switched back for them', () => {
  const db = setup();
  staffRepo.setAvailability(db, GUILD, ARTIST, 'away', { awayUntil: NOW - DAY_MS });

  const batch = sweepGuild(db, GUILD, { now: NOW });
  assert.ok(kindsFor(batch, ARTIST).includes(KINDS.AWAY_RETURNED));
  assert.match(linesFor(batch, ARTIST).join('\n'), /I have not changed it for you/);
  assert.equal(staffRepo.getStaff(db, GUILD, ARTIST).availability, 'away');
  db.close();
});

test('several reminders for one person are batched into a single message', () => {
  const db = setup();
  const { task: overdue } = makeTask(db, { deadlineUtc: NOW - DAY_MS });
  tasksRepo.assignArtist(db, GUILD, overdue.id, ARTIST, OWNER);
  db.prepare("UPDATE tasks SET state = 'in_progress', last_progress_at = ? WHERE id = ?")
    .run(NOW - 10 * DAY_MS, overdue.id);

  const { task: second } = makeTask(db, { deadlineUtc: NOW - 2 * DAY_MS });
  tasksRepo.assignArtist(db, GUILD, second.id, ARTIST, OWNER);
  db.prepare("UPDATE tasks SET state = 'in_progress', last_progress_at = ? WHERE id = ?")
    .run(NOW - 10 * DAY_MS, second.id);

  const batch = sweepGuild(db, GUILD, { now: NOW });
  const entries = batch.byUser.get(ARTIST);

  assert.ok(entries.length >= 4, 'two overdue plus two stale');
  assert.equal(batch.byUser.size <= 3, true, 'grouped per person, not per task');
  db.close();
});

test('the weekly summary reports work, workload and what is owed', () => {
  const db = setup();
  const { project, task } = makeTask(db);
  tasksRepo.approvePay(db, GUILD, task.id, { amountMinor: 2500, currency: 'USD', actorUserId: OWNER });
  tasksRepo.assignArtist(db, GUILD, task.id, ARTIST, OWNER);
  db.prepare("UPDATE tasks SET state = 'client_approved', payment_state = 'payable', completed_at = ? WHERE id = ?")
    .run(NOW - DAY_MS, task.id);

  const { task: late } = makeTask(db, { deadlineUtc: NOW - 2 * DAY_MS });
  tasksRepo.assignArtist(db, GUILD, late.id, ARTIST, OWNER);
  db.prepare("UPDATE tasks SET state = 'in_progress' WHERE id = ?").run(late.id);

  const embed = buildWeeklySummary(db, GUILD, { now: NOW }).toJSON();
  const fields = new Map(embed.fields.map((field) => [field.name.replace(/\s*\(\d+\)$/, ''), field.value]));

  assert.match([...fields.keys()].join(','), /Client-approved this week/);
  assert.match(fields.get('🔴 Overdue'), new RegExp(late.code));
  assert.match(fields.get('Department workload'), /Modelling/);
  assert.match(fields.get('💰 Payouts outstanding'), /\$25\.00/);
  db.close();
});

test('an empty studio produces a summary rather than an error', () => {
  const db = setup();
  const embed = buildWeeklySummary(db, GUILD, { now: NOW }).toJSON();

  assert.equal(embed.title, 'Weekly studio summary');
  assert.ok(embed.fields.length >= 5);
  assert.match(embed.fields.map((field) => field.value).join(' '), /none|nothing/i);
  db.close();
});

test('reminder state can be cleared when work moves on', () => {
  const db = setup();
  remindersRepo.markSent(db, GUILD, KINDS.DEADLINE_UPCOMING, 'task', 42, NOW);
  assert.equal(remindersRepo.isDue(db, GUILD, KINDS.DEADLINE_UPCOMING, 'task', 42, { minIntervalMs: DAY_MS, now: NOW }), false);

  remindersRepo.clearForEntity(db, GUILD, 'task', 42);
  assert.equal(remindersRepo.isDue(db, GUILD, KINDS.DEADLINE_UPCOMING, 'task', 42, { minIntervalMs: DAY_MS, now: NOW }), true);
  db.close();
});
