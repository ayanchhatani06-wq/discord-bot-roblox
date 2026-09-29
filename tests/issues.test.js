const test = require('node:test');
const assert = require('node:assert/strict');

const { openDatabase } = require('../src/db');
const configRepo = require('../src/db/repos/config');
const clientsRepo = require('../src/db/repos/clients');
const projectsRepo = require('../src/db/repos/projects');
const tasksRepo = require('../src/db/repos/tasks');
const escalationsRepo = require('../src/db/repos/escalations');
const { listAudit } = require('../src/db/repos/core');
const { TASK_STATES } = require('../src/domain/taskState');

const GUILD = 'guild-1';
const OWNER = 'owner-1';
const LEADER = 'leader-1';
const ARTIST = 'artist-1';
const CLIENT_USER = 'client-user-1';

function setup() {
  const db = openDatabase({ file: ':memory:' });
  configRepo.ensureConfig(db, GUILD);
  configRepo.seedDefaultDepartments(db, GUILD, OWNER);
  configRepo.updateConfig(db, GUILD, { owner_user_id: OWNER }, OWNER);
  return db;
}

function deliveredTask(db) {
  const client = clientsRepo.createClient(db, GUILD, { displayName: 'Demo Studios' }, OWNER);
  clientsRepo.addAccount(db, GUILD, client.id, { userId: CLIENT_USER }, OWNER);

  const project = projectsRepo.createProject(db, GUILD, { name: 'Pack' }, OWNER);
  clientsRepo.linkProject(db, GUILD, project.id, client.id, OWNER, { clientChannelId: 'chan-1' });

  const task = tasksRepo.createTask(db, GUILD, {
    projectId: project.id,
    title: 'Model 1',
    departmentId: configRepo.getDepartmentByKey(db, GUILD, 'modelling').id,
    leaderUserId: LEADER,
    revisionRounds: 2,
  }, OWNER);

  db.prepare("UPDATE tasks SET state = 'client_approved', artist_user_id = ?, completed_at = ? WHERE id = ?")
    .run(ARTIST, Date.now(), task.id);

  return { client, project: projectsRepo.getProject(db, GUILD, project.id), task: tasksRepo.getTask(db, GUILD, task.id) };
}

function reportIssue(db, { client, project, task }, body = 'The exported model is missing textures') {
  return clientsRepo.createRequest(db, GUILD, {
    projectId: project.id,
    taskId: task.id,
    clientId: client.id,
    raisedBy: CLIENT_USER,
    kind: 'delivery_issue',
    body,
  });
}

test('a reported problem is recorded against the exact item', () => {
  const db = setup();
  const fixture = deliveredTask(db);
  const issue = reportIssue(db, fixture);

  assert.equal(issue.kind, 'delivery_issue');
  assert.equal(issue.task_id, fixture.task.id);
  assert.equal(issue.status, 'open');
  assert.equal(issue.decision, null, 'nothing is judged automatically');
  db.close();
});

test('reporting a problem does not change the task by itself', () => {
  const db = setup();
  const fixture = deliveredTask(db);
  const before = tasksRepo.getTask(db, GUILD, fixture.task.id);

  reportIssue(db, fixture);

  assert.deepEqual(tasksRepo.getTask(db, GUILD, fixture.task.id), before);
  db.close();
});

test('an in-scope judgement puts the work back with the artist at no charge', () => {
  const db = setup();
  const fixture = deliveredTask(db);
  const issue = reportIssue(db, fixture);

  clientsRepo.decideIssue(db, GUILD, issue.id, {
    decision: 'in_scope', actorUserId: LEADER, note: 'Textures were genuinely missing',
  });
  const reopened = tasksRepo.applyTransition(db, GUILD, fixture.task.id, 'client_reopen', {
    actorUserId: LEADER, detail: 'Issue judged in scope',
  });

  const decided = clientsRepo.getRequest(db, GUILD, issue.id);
  assert.equal(decided.decision, 'in_scope');
  assert.equal(decided.charge_approved_by, null, 'no charge is attached to a correction');
  assert.equal(decided.status, 'in_progress');
  assert.equal(reopened.state, TASK_STATES.REVISION_NEEDED);
  db.close();
});

test('additional work records who approved the charge', () => {
  const db = setup();
  const fixture = deliveredTask(db);
  const issue = reportIssue(db, fixture, 'Actually we want it in a different style');

  clientsRepo.decideIssue(db, GUILD, issue.id, {
    decision: 'additional_work',
    actorUserId: OWNER,
    chargeApprovedBy: OWNER,
    note: 'This is a new brief, not a fix',
  });

  const decided = clientsRepo.getRequest(db, GUILD, issue.id);
  assert.equal(decided.decision, 'additional_work');
  assert.equal(decided.charge_approved_by, OWNER);
  // The task is untouched: extra work is quoted, not silently started.
  assert.equal(tasksRepo.getTask(db, GUILD, fixture.task.id).state, TASK_STATES.CLIENT_APPROVED);
  db.close();
});

test('a no-fault judgement closes the issue immediately', () => {
  const db = setup();
  const fixture = deliveredTask(db);
  const issue = reportIssue(db, fixture);

  clientsRepo.decideIssue(db, GUILD, issue.id, {
    decision: 'no_fault', actorUserId: LEADER, note: 'Delivered files match the agreed spec',
  });

  const decided = clientsRepo.getRequest(db, GUILD, issue.id);
  assert.equal(decided.status, 'resolved');
  assert.equal(clientsRepo.hasOpenIssue(db, GUILD, fixture.client.id), false);
  db.close();
});

test('an open problem pauses promotion until it is closed', () => {
  const db = setup();
  const fixture = deliveredTask(db);
  const issue = reportIssue(db, fixture);

  assert.equal(clientsRepo.hasOpenIssue(db, GUILD, fixture.client.id), true);

  clientsRepo.decideIssue(db, GUILD, issue.id, { decision: 'in_scope', actorUserId: LEADER, note: 'fixing' });
  assert.equal(clientsRepo.hasOpenIssue(db, GUILD, fixture.client.id), true, 'still open while being fixed');

  clientsRepo.resolveRequest(db, GUILD, issue.id, { status: 'resolved', resolution: 'Re-delivered', actorUserId: OWNER });
  assert.equal(clientsRepo.hasOpenIssue(db, GUILD, fixture.client.id), false);
  db.close();
});

test('an unknown judgement is rejected rather than stored', () => {
  const db = setup();
  const fixture = deliveredTask(db);
  const issue = reportIssue(db, fixture);

  assert.throws(
    () => clientsRepo.decideIssue(db, GUILD, issue.id, { decision: 'whatever', actorUserId: OWNER }),
    /Unknown issue decision/
  );
  assert.equal(clientsRepo.getRequest(db, GUILD, issue.id).decision, null);
  db.close();
});

test('issue judgements are audited with who decided what', () => {
  const db = setup();
  const fixture = deliveredTask(db);
  const issue = reportIssue(db, fixture);

  clientsRepo.decideIssue(db, GUILD, issue.id, {
    decision: 'additional_work', actorUserId: OWNER, chargeApprovedBy: OWNER, note: 'new scope',
  });

  const trail = listAudit(db, { guildId: GUILD, entityType: 'client_request', entityId: issue.id });
  const entry = trail.find((row) => row.action === 'client.issue.decide');
  assert.ok(entry);
  assert.equal(entry.actor_user_id, OWNER);
  assert.equal(JSON.parse(entry.after_json).decision, 'additional_work');
  db.close();
});

// --- staff escalations ---------------------------------------------------

test('a staff concern goes to the owner and not through their leader', () => {
  const db = setup();
  const escalation = escalationsRepo.raise(db, GUILD, {
    raisedBy: ARTIST,
    category: 'assignment',
    subject: 'Reassigned without being told',
    body: 'My task was moved while I was mid-way through it.',
    aboutUserId: LEADER,
  });

  assert.equal(escalation.status, 'open');
  assert.equal(escalation.raised_by, ARTIST);
  assert.equal(escalationsRepo.openCount(db, GUILD), 1);

  // The audit records that something was raised, not what it said, so the
  // detail stays between the raiser and the owner.
  const trail = listAudit(db, { guildId: GUILD, entityType: 'escalation', entityId: escalation.id });
  const entry = trail.find((row) => row.action === 'escalation.raise');
  assert.ok(entry);
  assert.ok(!JSON.stringify(entry).includes('mid-way through it'), 'the body is not copied into the shared audit trail');
  db.close();
});

test('staff see only their own concerns', () => {
  const db = setup();
  escalationsRepo.raise(db, GUILD, { raisedBy: ARTIST, category: 'payment', subject: 'Unpaid task', body: 'x' });
  escalationsRepo.raise(db, GUILD, { raisedBy: 'artist-2', category: 'workload', subject: 'Too much', body: 'y' });

  assert.equal(escalationsRepo.listForRaiser(db, GUILD, ARTIST).length, 1);
  assert.equal(escalationsRepo.listForRaiser(db, GUILD, 'artist-2').length, 1);
  assert.equal(escalationsRepo.list(db, GUILD, { status: 'all' }).length, 2, 'the owner sees both');
  db.close();
});

test('a concern moves open to acknowledged to resolved', () => {
  const db = setup();
  const escalation = escalationsRepo.raise(db, GUILD, {
    raisedBy: ARTIST, category: 'payment', subject: 'Not paid for TSK-0004', body: 'Approved three weeks ago.',
  });

  const acknowledged = escalationsRepo.acknowledge(db, GUILD, escalation.id, OWNER);
  assert.equal(acknowledged.status, 'acknowledged');
  assert.equal(acknowledged.acknowledged_by, OWNER);

  const resolved = escalationsRepo.resolve(db, GUILD, escalation.id, {
    status: 'resolved', resolution: 'Paid today', actorUserId: OWNER,
  });
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.resolution, 'Paid today');
  assert.equal(escalationsRepo.openCount(db, GUILD), 0);
  db.close();
});

test('acknowledging twice does not overwrite who saw it first', () => {
  const db = setup();
  const escalation = escalationsRepo.raise(db, GUILD, {
    raisedBy: ARTIST, category: 'other', subject: 's', body: 'b',
  });

  escalationsRepo.acknowledge(db, GUILD, escalation.id, OWNER);
  const again = escalationsRepo.acknowledge(db, GUILD, escalation.id, 'someone-else');

  assert.equal(again.acknowledged_by, OWNER);
  db.close();
});

test('only the listed categories are accepted', () => {
  const db = setup();
  assert.throws(
    () => escalationsRepo.raise(db, GUILD, { raisedBy: ARTIST, category: 'gossip', subject: 's', body: 'b' }),
    /CHECK constraint failed/
  );
  db.close();
});

test('a concern survives the related task being deleted', () => {
  const db = setup();
  const fixture = deliveredTask(db);
  const escalation = escalationsRepo.raise(db, GUILD, {
    raisedBy: ARTIST, category: 'payment', subject: 'Unpaid', body: 'x', taskId: fixture.task.id,
  });

  db.prepare('DELETE FROM projects WHERE id = ?').run(fixture.project.id);

  const after = escalationsRepo.get(db, GUILD, escalation.id);
  assert.ok(after, 'the concern itself is kept');
  assert.equal(after.task_id, null);
  assert.equal(after.body, 'x');
  db.close();
});
