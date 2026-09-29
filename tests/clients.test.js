const test = require('node:test');
const assert = require('node:assert/strict');

const { openDatabase } = require('../src/db');
const configRepo = require('../src/db/repos/config');
const clientsRepo = require('../src/db/repos/clients');
const projectsRepo = require('../src/db/repos/projects');
const tasksRepo = require('../src/db/repos/tasks');
const submissionsRepo = require('../src/db/repos/submissions');
const clientReport = require('../src/services/clientReport');
const dashboard = require('../src/services/clientDashboard');
const { TASK_STATES } = require('../src/domain/taskState');

const GUILD = 'guild-1';
const OWNER = 'owner-1';
const LEADER = 'leader-1';
const ARTIST = 'artist-1';
const CLIENT_USER = 'client-user-1';
const OTHER_CLIENT_USER = 'client-user-2';

function setup() {
  const db = openDatabase({ file: ':memory:' });
  configRepo.ensureConfig(db, GUILD);
  configRepo.seedDefaultDepartments(db, GUILD, OWNER);
  configRepo.updateConfig(db, GUILD, { owner_user_id: OWNER }, OWNER);
  return db;
}

function makeClientAndProject(db, { accountId = CLIENT_USER, canApprove = true } = {}) {
  const client = clientsRepo.createClient(db, GUILD, { displayName: 'Demo Studios' }, OWNER);
  clientsRepo.addAccount(db, GUILD, client.id, { userId: accountId, canApprove }, OWNER);

  const project = projectsRepo.createProject(db, GUILD, {
    name: 'Asset pack',
    clientAmountMinor: 40000,
    clientCurrency: 'USD',
    deadlineUtc: Date.UTC(2026, 9, 12),
  }, OWNER);

  clientsRepo.linkProject(db, GUILD, project.id, client.id, OWNER, { clientChannelId: 'chan-1' });
  return { client, project: projectsRepo.getProject(db, GUILD, project.id) };
}

function addTask(db, project, { state = TASK_STATES.IN_PROGRESS, title = 'Model', dept = 'modelling' } = {}) {
  const task = tasksRepo.createTask(db, GUILD, {
    projectId: project.id,
    title,
    departmentId: configRepo.getDepartmentByKey(db, GUILD, dept).id,
    leaderUserId: LEADER,
    deliverables: ['Source file', 'Exported model'],
  }, OWNER);

  db.prepare('UPDATE tasks SET state = ?, artist_user_id = ? WHERE id = ?').run(state, ARTIST, task.id);
  return tasksRepo.getTask(db, GUILD, task.id);
}

function releaseSubmission(db, task, { version = 1 } = {}) {
  const submission = submissionsRepo.addSubmission(db, GUILD, task.id, {
    kind: 'final',
    notes: 'internal note the client must not see',
    links: ['https://example.com/preview'],
    checklist: [],
    submittedBy: ARTIST,
  });
  submissionsRepo.markClientVisible(db, GUILD, submission.id, LEADER);
  return submissionsRepo.getSubmission(db, submission.id);
}

test('only an authorized account for that client can reach a project', () => {
  const db = setup();
  const { project } = makeClientAndProject(db);

  assert.equal(clientsRepo.authorizeProjectAccess(db, GUILD, project.id, CLIENT_USER).ok, true);
  assert.equal(clientsRepo.authorizeProjectAccess(db, GUILD, project.id, OTHER_CLIENT_USER).ok, false);
  // Staff are not client accounts either: authority comes from the table, not a role.
  assert.equal(clientsRepo.authorizeProjectAccess(db, GUILD, project.id, OWNER).ok, false);
  db.close();
});

test('a revoked account loses access immediately', () => {
  const db = setup();
  const { client, project } = makeClientAndProject(db);

  assert.equal(clientsRepo.authorizeProjectAccess(db, GUILD, project.id, CLIENT_USER).ok, true);
  clientsRepo.revokeAccount(db, GUILD, client.id, CLIENT_USER, OWNER);
  assert.equal(clientsRepo.authorizeProjectAccess(db, GUILD, project.id, CLIENT_USER).ok, false);
  db.close();
});

test('one client cannot see another client\'s order', () => {
  const db = setup();
  makeClientAndProject(db);
  const second = clientsRepo.createClient(db, GUILD, { displayName: 'Other Studios' }, OWNER);
  clientsRepo.addAccount(db, GUILD, second.id, { userId: OTHER_CLIENT_USER }, OWNER);
  const theirProject = projectsRepo.createProject(db, GUILD, { name: 'Their job' }, OWNER);
  clientsRepo.linkProject(db, GUILD, theirProject.id, second.id, OWNER);

  const visible = clientsRepo.listProjectsForAccount(db, GUILD, OTHER_CLIENT_USER);
  assert.equal(visible.length, 1);
  assert.equal(visible[0].id, theirProject.id);
  db.close();
});

test('a project with no client attached is reachable by nobody', () => {
  const db = setup();
  const orphan = projectsRepo.createProject(db, GUILD, { name: 'Internal work' }, OWNER);
  assert.equal(clientsRepo.authorizeProjectAccess(db, GUILD, orphan.id, CLIENT_USER).ok, false);
  db.close();
});

test('view-only accounts can see but not approve', () => {
  const db = setup();
  const { project } = makeClientAndProject(db, { canApprove: false });
  const access = clientsRepo.authorizeProjectAccess(db, GUILD, project.id, CLIENT_USER);

  assert.equal(access.ok, true);
  assert.equal(access.canApprove, false);
  db.close();
});

test('the report buckets work the way a client would describe it', () => {
  const db = setup();
  const { project } = makeClientAndProject(db);

  addTask(db, project, { state: TASK_STATES.IN_PROGRESS });
  addTask(db, project, { state: TASK_STATES.UNASSIGNED });
  addTask(db, project, { state: TASK_STATES.INTERNAL_REVIEW });
  addTask(db, project, { state: TASK_STATES.AWAITING_CLIENT });
  addTask(db, project, { state: TASK_STATES.CLIENT_APPROVED });

  const report = clientReport.buildProjectReport(db, GUILD, project);

  assert.equal(report.total, 5);
  assert.equal(report.counts[clientReport.BUCKETS.IN_PRODUCTION], 2, 'unassigned and in progress read the same to a client');
  assert.equal(report.counts[clientReport.BUCKETS.IN_STUDIO_REVIEW], 1);
  assert.equal(report.counts[clientReport.BUCKETS.AWAITING_YOUR_APPROVAL], 1);
  assert.equal(report.counts[clientReport.BUCKETS.APPROVED_BY_YOU], 1);
  db.close();
});

test('the client is never told whether work is unassigned or who holds it', () => {
  const db = setup();
  const { project } = makeClientAndProject(db);
  addTask(db, project, { state: TASK_STATES.UNASSIGNED });
  addTask(db, project, { state: TASK_STATES.OFFERED });

  const report = clientReport.buildProjectReport(db, GUILD, project);
  const rendered = JSON.stringify(dashboard.dashboardEmbed(report).toJSON());

  assert.equal(report.counts[clientReport.BUCKETS.IN_PRODUCTION], 2);
  assert.ok(!rendered.includes(ARTIST), 'no artist id');
  assert.ok(!rendered.includes(LEADER), 'no leader id');
  assert.ok(!/unassigned|offered/i.test(rendered), 'no staffing state leaks');
  db.close();
});

test('nothing internal reaches the dashboard: no pay, no notes, no staff', () => {
  const db = setup();
  const { project } = makeClientAndProject(db);
  const task = addTask(db, project, { state: TASK_STATES.AWAITING_CLIENT });
  tasksRepo.approvePay(db, GUILD, task.id, { amountMinor: 2500, currency: 'USD', actorUserId: OWNER });
  releaseSubmission(db, task);

  const report = clientReport.buildProjectReport(db, GUILD, project);
  const rendered = JSON.stringify([
    dashboard.dashboardEmbed(report).toJSON(),
    ...dashboard.previewEmbeds(report).map((embed) => embed.toJSON()),
    dashboard.deliverablesEmbed(db, GUILD, report).toJSON(),
  ]);

  assert.ok(!rendered.includes('2500'), 'no pay figures');
  assert.ok(!rendered.includes('$25'), 'no formatted pay');
  assert.ok(!rendered.includes('internal note'), 'no submission notes meant for staff');
  assert.ok(!rendered.includes(ARTIST) && !rendered.includes(LEADER), 'no staff identities');
  db.close();
});

test('only released versions are visible, not every submission', () => {
  const db = setup();
  const { project } = makeClientAndProject(db);
  const task = addTask(db, project, { state: TASK_STATES.INTERNAL_REVIEW });

  submissionsRepo.addSubmission(db, GUILD, task.id, {
    kind: 'final', links: ['https://example.com/internal-wip'], submittedBy: ARTIST,
  });

  const before = clientReport.buildProjectReport(db, GUILD, project);
  assert.equal(before.previews.length, 0, 'unreleased work is invisible to the client');
  assert.ok(!JSON.stringify(dashboard.previewEmbeds(before)).includes('internal-wip'));

  const latest = submissionsRepo.latestSubmission(db, task.id, { kind: 'final' });
  submissionsRepo.markClientVisible(db, GUILD, latest.id, LEADER);

  const after = clientReport.buildProjectReport(db, GUILD, project);
  assert.equal(after.previews.length, 1);
  db.close();
});

test('the status paragraph counts items and never estimates progress', () => {
  const db = setup();
  const { project } = makeClientAndProject(db);
  for (let i = 0; i < 5; i += 1) addTask(db, project, { state: TASK_STATES.IN_PROGRESS });
  for (let i = 0; i < 4; i += 1) addTask(db, project, { state: TASK_STATES.CLIENT_APPROVED });
  for (let i = 0; i < 3; i += 1) {
    const task = addTask(db, project, { state: TASK_STATES.AWAITING_CLIENT });
    releaseSubmission(db, task);
  }

  const report = clientReport.buildProjectReport(db, GUILD, project);
  const paragraph = clientReport.statusParagraph(report);

  assert.match(paragraph, /12 items/);
  assert.match(paragraph, /4 approved by you/);
  assert.match(paragraph, /3 ready for your review/);
  assert.match(paragraph, /5 in progress/);
  assert.match(paragraph, /Review the 3 previews/);
  assert.ok(!/%/.test(paragraph), 'never a completion percentage');
  assert.ok(!/should be|expect|soon|on track|likely/i.test(paragraph), 'never a prediction');
  db.close();
});

test('a missing deadline is stated as missing, not guessed', () => {
  const db = setup();
  const client = clientsRepo.createClient(db, GUILD, { displayName: 'No Deadline Co' }, OWNER);
  clientsRepo.addAccount(db, GUILD, client.id, { userId: CLIENT_USER }, OWNER);
  const project = projectsRepo.createProject(db, GUILD, { name: 'Undated' }, OWNER);
  clientsRepo.linkProject(db, GUILD, project.id, client.id, OWNER);
  addTask(db, projectsRepo.getProject(db, GUILD, project.id));

  const report = clientReport.buildProjectReport(db, GUILD, projectsRepo.getProject(db, GUILD, project.id));
  const answer = clientReport.answerQuestion('delivery_date', report);

  assert.equal(report.missing.deadline, true);
  assert.match(answer.body, /No delivery date is recorded/);
  assert.match(answer.body, /will not guess/);
  assert.match(answer.body, /Contact Manager/);
  db.close();
});

test('every listed client question has a deterministic answer', () => {
  const db = setup();
  const { project } = makeClientAndProject(db);
  const task = addTask(db, project, { state: TASK_STATES.AWAITING_CLIENT });
  releaseSubmission(db, task);
  addTask(db, project, { state: TASK_STATES.CLIENT_APPROVED });

  const report = clientReport.buildProjectReport(db, GUILD, project);
  const expected = [
    'whats_done', 'in_progress', 'latest_preview', 'delivery_date',
    'need_from_me', 'changes_made', 'items_left', 'order_more',
  ];

  for (const kind of expected) {
    const answer = clientReport.answerQuestion(kind, report);
    assert.ok(answer, `${kind} has no answer`);
    assert.ok(answer.body.length > 0);
    assert.match(answer.body, /last updated/i, `${kind} must state when the information is from`);
  }

  assert.equal(clientReport.answerQuestion('what_is_the_meaning_of_life', report), null);
  db.close();
});

test('asking a question does not change any project record', () => {
  const db = setup();
  const { project } = makeClientAndProject(db);
  const task = addTask(db, project, { state: TASK_STATES.AWAITING_CLIENT });

  const before = tasksRepo.getTask(db, GUILD, task.id);
  const report = clientReport.buildProjectReport(db, GUILD, project);
  for (const kind of Object.keys(clientReport.QUESTIONS)) clientReport.answerQuestion(kind, report);

  const after = tasksRepo.getTask(db, GUILD, task.id);
  assert.deepEqual(after, before, 'building a report is read-only');
  db.close();
});

test('approving one item of a bulk order leaves the rest alone', () => {
  const db = setup();
  const { project } = makeClientAndProject(db);
  const first = addTask(db, project, { state: TASK_STATES.AWAITING_CLIENT, title: 'Model 1' });
  const second = addTask(db, project, { state: TASK_STATES.AWAITING_CLIENT, title: 'Model 2' });
  const firstSubmission = releaseSubmission(db, first);
  releaseSubmission(db, second);

  submissionsRepo.addClientDecision(db, GUILD, first.id, {
    submissionId: firstSubmission.id, decision: 'approved', recordedBy: CLIENT_USER,
  });
  tasksRepo.applyTransition(db, GUILD, first.id, 'client_approve', { actorUserId: CLIENT_USER });

  assert.equal(tasksRepo.getTask(db, GUILD, first.id).state, TASK_STATES.CLIENT_APPROVED);
  assert.equal(tasksRepo.getTask(db, GUILD, second.id).state, TASK_STATES.AWAITING_CLIENT);

  const report = clientReport.buildProjectReport(db, GUILD, project);
  assert.equal(report.counts[clientReport.BUCKETS.APPROVED_BY_YOU], 1);
  assert.equal(report.counts[clientReport.BUCKETS.AWAITING_YOUR_APPROVAL], 1);
  db.close();
});

test('an approval button is bound to one exact version', () => {
  const db = setup();
  const { project } = makeClientAndProject(db);
  const task = addTask(db, project, { state: TASK_STATES.AWAITING_CLIENT });
  const firstVersion = releaseSubmission(db, task);

  // A newer version is released; the old button must no longer be the latest.
  const secondSubmission = submissionsRepo.addSubmission(db, GUILD, task.id, {
    kind: 'final', links: ['https://example.com/v2'], submittedBy: ARTIST,
  });
  submissionsRepo.markClientVisible(db, GUILD, secondSubmission.id, LEADER);

  const latest = clientReport.clientVisibleSubmission(db, task.id);
  assert.equal(latest.id, secondSubmission.id);
  assert.notEqual(latest.id, firstVersion.id, 'the stale button no longer matches the current version');

  const [row] = dashboard.approvalComponents(task.id, firstVersion.id);
  const ids = row.toJSON().components.map((component) => component.custom_id);
  assert.ok(ids.every((id) => id.endsWith(String(firstVersion.id))), 'the version is carried in the control itself');
  db.close();
});

test('delivered work is reported separately from approved work', () => {
  const db = setup();
  const { project } = makeClientAndProject(db);
  const approved = addTask(db, project, { state: TASK_STATES.CLIENT_APPROVED });
  const delivered = addTask(db, project, { state: TASK_STATES.CLIENT_APPROVED });
  db.prepare('UPDATE tasks SET delivered_at = ?, delivered_by = ? WHERE id = ?').run(Date.now(), OWNER, delivered.id);

  const report = clientReport.buildProjectReport(db, GUILD, project);
  assert.equal(report.counts[clientReport.BUCKETS.APPROVED_BY_YOU], 1);
  assert.equal(report.counts[clientReport.BUCKETS.DELIVERED], 1);
  assert.match(clientReport.answerQuestion('whats_done', report).body, /1 item delivered/);
  db.close();
});

test('items marked ready with nothing released are reported honestly', () => {
  const db = setup();
  const { project } = makeClientAndProject(db);
  addTask(db, project, { state: TASK_STATES.AWAITING_CLIENT });

  const report = clientReport.buildProjectReport(db, GUILD, project);
  assert.equal(report.awaitingWithoutPreview, 1);
  assert.match(report.nextAction, /no preview has been released/i);
  db.close();
});

test('client requests are recorded, routed and never alter task state', () => {
  const db = setup();
  const { client, project } = makeClientAndProject(db);
  const task = addTask(db, project, { state: TASK_STATES.IN_PROGRESS });
  const before = tasksRepo.getTask(db, GUILD, task.id);

  clientsRepo.createRequest(db, GUILD, {
    projectId: project.id, clientId: client.id, raisedBy: CLIENT_USER,
    kind: 'new_service', body: 'Can we add rigging?',
  });

  assert.deepEqual(tasksRepo.getTask(db, GUILD, task.id), before);
  const open = clientsRepo.listRequests(db, GUILD, { status: 'open' });
  assert.equal(open.length, 1);
  assert.equal(open[0].kind, 'new_service');
  db.close();
});

test('an open issue pauses promotional messaging for that client', () => {
  const db = setup();
  const { client, project } = makeClientAndProject(db);
  assert.equal(clientsRepo.hasOpenIssue(db, GUILD, client.id), false);

  const request = clientsRepo.createRequest(db, GUILD, {
    projectId: project.id, clientId: client.id, raisedBy: CLIENT_USER,
    kind: 'delivery_issue', body: 'The file is corrupted',
  });
  assert.equal(clientsRepo.hasOpenIssue(db, GUILD, client.id), true);

  clientsRepo.resolveRequest(db, GUILD, request.id, { status: 'resolved', resolution: 'Re-sent', actorUserId: OWNER });
  assert.equal(clientsRepo.hasOpenIssue(db, GUILD, client.id), false);
  db.close();
});

test('possible duplicate client records are flagged, not merged', () => {
  const db = setup();
  clientsRepo.createClient(db, GUILD, { displayName: 'Demo Studios' }, OWNER);
  clientsRepo.createClient(db, GUILD, { displayName: 'demo studios!' }, OWNER);
  clientsRepo.createClient(db, GUILD, { displayName: 'Totally Different' }, OWNER);

  const groups = clientsRepo.findPossibleDuplicates(db, GUILD);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].length, 2);
  assert.equal(clientsRepo.listClients(db, GUILD).length, 3, 'nothing was merged automatically');
  db.close();
});

test('order history and finder attribution are kept per client', () => {
  const db = setup();
  const client = clientsRepo.createClient(db, GUILD, { displayName: 'Repeat Co', finderUserId: 'finder-1' }, OWNER);

  for (const name of ['First order', 'Second order']) {
    const project = projectsRepo.createProject(db, GUILD, { name }, OWNER);
    clientsRepo.linkProject(db, GUILD, project.id, client.id, OWNER);
  }

  const history = clientsRepo.clientOrderHistory(db, GUILD, client.id);
  assert.equal(history.length, 2);
  assert.equal(clientsRepo.getClient(db, GUILD, client.id).finder_user_id, 'finder-1');
  db.close();
});

test('the dashboard offers every requested button', () => {
  const db = setup();
  const { project } = makeClientAndProject(db);
  const rows = dashboard.dashboardComponents(project.id, { hasPreviews: true, canApprove: true });
  const labels = rows.flatMap((row) => row.toJSON().components.map((component) => component.label));

  for (const expected of [
    'View Progress', 'View Previews', 'Request Changes', 'Ask a Question',
    'View Deliverables', 'Request Another Service', 'Contact Manager',
  ]) {
    assert.ok(labels.includes(expected), `missing the ${expected} button`);
  }
  assert.ok(rows.length <= 5);
  db.close();
});

test('the preview button is disabled when there is nothing released', () => {
  const db = setup();
  const { project } = makeClientAndProject(db);
  const rows = dashboard.dashboardComponents(project.id, { hasPreviews: false, canApprove: true });
  const previews = rows.flatMap((row) => row.toJSON().components).find((component) => component.label === 'View Previews');

  assert.equal(previews.disabled, true);
  db.close();
});
