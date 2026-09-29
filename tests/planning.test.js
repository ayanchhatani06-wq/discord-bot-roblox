const test = require('node:test');
const assert = require('node:assert/strict');

const { openDatabase } = require('../src/db');
const configRepo = require('../src/db/repos/config');
const projectsRepo = require('../src/db/repos/projects');
const tasksRepo = require('../src/db/repos/tasks');
const planningRepo = require('../src/db/repos/planning');
const { checkTaskReadiness } = require('../src/services/readiness');
const { listAudit } = require('../src/db/repos/core');
const { TASK_STATES } = require('../src/domain/taskState');
const { DAY_MS } = require('../src/utils/time');

const GUILD = 'guild-1';
const OWNER = 'owner-1';
const LEADER = 'leader-1';
const ARTIST = 'artist-1';

function setup() {
  const db = openDatabase({ file: ':memory:' });
  configRepo.ensureConfig(db, GUILD);
  configRepo.seedDefaultDepartments(db, GUILD, OWNER);
  configRepo.updateConfig(db, GUILD, { owner_user_id: OWNER }, OWNER);
  return db;
}

function makeProject(db) {
  return projectsRepo.createProject(db, GUILD, {
    name: 'Pack', brief: 'Project brief', referenceLinks: 'https://example.com/refs',
  }, OWNER);
}

function makeTask(db, project, { dept = 'modelling', title = 'Model', complete = true, state = TASK_STATES.UNASSIGNED, deadline = null } = {}) {
  const task = tasksRepo.createTask(db, GUILD, {
    projectId: project.id,
    title,
    departmentId: configRepo.getDepartmentByKey(db, GUILD, dept).id,
    leaderUserId: LEADER,
    brief: complete ? 'Task brief' : null,
    deliverables: complete ? ['Source file', 'Export'] : [],
    formats: complete ? 'FBX' : null,
    deadlineUtc: deadline,
  }, OWNER);

  if (complete) {
    tasksRepo.approvePay(db, GUILD, task.id, { amountMinor: 2500, currency: 'USD', actorUserId: OWNER });
  }
  if (state !== TASK_STATES.UNASSIGNED) {
    db.prepare('UPDATE tasks SET state = ?, artist_user_id = ? WHERE id = ?').run(state, ARTIST, task.id);
  }
  return tasksRepo.getTask(db, GUILD, task.id);
}

test('a complete task is ready to offer', () => {
  const db = setup();
  const task = makeTask(db, makeProject(db));

  const readiness = checkTaskReadiness(db, GUILD, task);
  assert.equal(readiness.ok, true);
  assert.deepEqual(readiness.blockers, []);
  db.close();
});

test('missing pay, deliverables or a brief block an offer', () => {
  const db = setup();
  const project = projectsRepo.createProject(db, GUILD, { name: 'Bare' }, OWNER);
  const task = makeTask(db, project, { complete: false });

  const readiness = checkTaskReadiness(db, GUILD, task);
  assert.equal(readiness.ok, false);
  assert.match(readiness.blockers.join(' '), /No pay has been set/);
  assert.match(readiness.blockers.join(' '), /No deliverables/);
  assert.match(readiness.blockers.join(' '), /no brief/i);
  db.close();
});

test('a proposed but unapproved figure still blocks the offer', () => {
  const db = setup();
  const project = makeProject(db);
  const task = tasksRepo.createTask(db, GUILD, {
    projectId: project.id, title: 'T',
    departmentId: configRepo.getDepartmentByKey(db, GUILD, 'modelling').id,
    brief: 'x', deliverables: ['a'],
  }, OWNER);
  tasksRepo.proposePay(db, GUILD, task.id, { amountMinor: 2000, currency: 'USD', actorUserId: LEADER });

  const readiness = checkTaskReadiness(db, GUILD, tasksRepo.getTask(db, GUILD, task.id));
  assert.equal(readiness.ok, false);
  assert.match(readiness.blockers.join(' '), /proposed but not approved/);
  db.close();
});

test('a missing deadline warns but does not block', () => {
  const db = setup();
  const task = makeTask(db, makeProject(db));

  const readiness = checkTaskReadiness(db, GUILD, task);
  assert.equal(readiness.ok, true);
  assert.match(readiness.warnings.join(' '), /No deadline/);
  db.close();
});

test('the project brief and references count toward completeness', () => {
  const db = setup();
  const project = makeProject(db);
  const task = tasksRepo.createTask(db, GUILD, {
    projectId: project.id, title: 'Inherits', deliverables: ['a'],
    departmentId: configRepo.getDepartmentByKey(db, GUILD, 'modelling').id,
  }, OWNER);
  tasksRepo.approvePay(db, GUILD, task.id, { amountMinor: 1000, currency: 'USD', actorUserId: OWNER });

  const readiness = checkTaskReadiness(db, GUILD, tasksRepo.getTask(db, GUILD, task.id));
  assert.equal(readiness.ok, true, 'the project brief covers the task');
  assert.ok(!readiness.warnings.join(' ').includes('reference'));
  db.close();
});

test('a dependency chain records what waits on what', () => {
  const db = setup();
  const project = makeProject(db);
  const model = makeTask(db, project, { title: 'Model' });
  const rig = makeTask(db, project, { title: 'Rig', dept: 'scripting' });
  const animation = makeTask(db, project, { title: 'Animation', dept: 'animation' });

  assert.equal(planningRepo.addDependency(db, GUILD, { taskId: rig.id, dependsOnTaskId: model.id }, OWNER).ok, true);
  assert.equal(planningRepo.addDependency(db, GUILD, { taskId: animation.id, dependsOnTaskId: rig.id }, OWNER).ok, true);

  assert.deepEqual(planningRepo.dependenciesOf(db, rig.id).map((row) => row.code), [model.code]);
  assert.deepEqual(planningRepo.dependentsOf(db, model.id).map((row) => row.code), [rig.code]);
  db.close();
});

test('a dependency loop is refused', () => {
  const db = setup();
  const project = makeProject(db);
  const a = makeTask(db, project, { title: 'A' });
  const b = makeTask(db, project, { title: 'B' });
  const c = makeTask(db, project, { title: 'C' });

  planningRepo.addDependency(db, GUILD, { taskId: b.id, dependsOnTaskId: a.id }, OWNER);
  planningRepo.addDependency(db, GUILD, { taskId: c.id, dependsOnTaskId: b.id }, OWNER);

  // a -> b -> c, so making a depend on c would close the loop.
  const cycle = planningRepo.addDependency(db, GUILD, { taskId: a.id, dependsOnTaskId: c.id }, OWNER);
  assert.equal(cycle.ok, false);
  assert.equal(cycle.reason, 'cycle');

  const self = planningRepo.addDependency(db, GUILD, { taskId: a.id, dependsOnTaskId: a.id }, OWNER);
  assert.equal(self.reason, 'self_dependency');

  const duplicate = planningRepo.addDependency(db, GUILD, { taskId: b.id, dependsOnTaskId: a.id }, OWNER);
  assert.equal(duplicate.reason, 'already_exists');
  db.close();
});

test('an unmet dependency warns the leader without blocking the offer', () => {
  const db = setup();
  const project = makeProject(db);
  const model = makeTask(db, project, { title: 'Model' });
  const rig = makeTask(db, project, { title: 'Rig', dept: 'scripting' });
  planningRepo.addDependency(db, GUILD, { taskId: rig.id, dependsOnTaskId: model.id }, OWNER);

  const readiness = checkTaskReadiness(db, GUILD, rig);
  assert.equal(readiness.ok, true, 'a leader may still start it early if they judge that right');
  assert.equal(readiness.unmetDependencies.length, 1);
  assert.match(readiness.warnings.join(' '), /has not passed review yet/);
  db.close();
});

test('a dependency is met once the prerequisite passes internal review', () => {
  const db = setup();
  const project = makeProject(db);
  const model = makeTask(db, project, { title: 'Model' });
  const rig = makeTask(db, project, { title: 'Rig', dept: 'scripting' });
  planningRepo.addDependency(db, GUILD, { taskId: rig.id, dependsOnTaskId: model.id }, OWNER);

  db.prepare("UPDATE tasks SET state = 'awaiting_client' WHERE id = ?").run(model.id);
  assert.equal(planningRepo.unmetDependencies(db, rig.id).length, 0);
  db.close();
});

test('the next team is told once, when their prerequisite becomes ready', () => {
  const db = setup();
  const project = makeProject(db);
  const model = makeTask(db, project, { title: 'Model' });
  const rig = makeTask(db, project, { title: 'Rig', dept: 'scripting' });
  const added = planningRepo.addDependency(db, GUILD, { taskId: rig.id, dependsOnTaskId: model.id }, OWNER);

  assert.equal(planningRepo.newlyReadyDependencies(db, GUILD).length, 0, 'nothing to announce yet');

  db.prepare("UPDATE tasks SET state = 'awaiting_client' WHERE id = ?").run(model.id);
  const ready = planningRepo.newlyReadyDependencies(db, GUILD);
  assert.equal(ready.length, 1);
  assert.equal(ready[0].down_code, rig.code);

  planningRepo.markDependencyNotified(db, added.dependency.id);
  assert.equal(planningRepo.newlyReadyDependencies(db, GUILD).length, 0, 'and not announced twice');
  db.close();
});

test('downstream work is flagged when its prerequisite is late, without moving anything', () => {
  const db = setup();
  const project = makeProject(db);
  const model = makeTask(db, project, { title: 'Model', deadline: Date.now() - DAY_MS });
  const rig = makeTask(db, project, { title: 'Rig', dept: 'scripting', deadline: Date.now() + 5 * DAY_MS });
  planningRepo.addDependency(db, GUILD, { taskId: rig.id, dependsOnTaskId: model.id }, OWNER);

  const risks = planningRepo.downstreamAtRisk(db, GUILD);
  assert.equal(risks.length, 1);
  assert.equal(risks[0].down_code, rig.code);

  // The downstream deadline is untouched: flagging is not deciding.
  assert.equal(tasksRepo.getTask(db, GUILD, rig.id).deadline_utc, rig.deadline_utc);
  db.close();
});

test('a prerequisite due after the work that needs it is flagged as out of order', () => {
  const db = setup();
  const project = makeProject(db);
  const model = makeTask(db, project, { title: 'Model', deadline: Date.now() + 10 * DAY_MS });
  const rig = makeTask(db, project, { title: 'Rig', dept: 'scripting', deadline: Date.now() + 5 * DAY_MS });
  planningRepo.addDependency(db, GUILD, { taskId: rig.id, dependsOnTaskId: model.id }, OWNER);

  assert.equal(planningRepo.downstreamAtRisk(db, GUILD).length, 1);
  db.close();
});

test('finished downstream work is not reported as at risk', () => {
  const db = setup();
  const project = makeProject(db);
  const model = makeTask(db, project, { title: 'Model', deadline: Date.now() - DAY_MS });
  const rig = makeTask(db, project, { title: 'Rig', dept: 'scripting', state: TASK_STATES.CLIENT_APPROVED });
  planningRepo.addDependency(db, GUILD, { taskId: rig.id, dependsOnTaskId: model.id }, OWNER);

  assert.equal(planningRepo.downstreamAtRisk(db, GUILD).length, 0);
  db.close();
});

test('a blocker records the reason and leaves the task where it is', () => {
  const db = setup();
  const task = makeTask(db, makeProject(db), { state: TASK_STATES.IN_PROGRESS });

  const blocker = planningRepo.raiseBlocker(db, GUILD, {
    taskId: task.id, raisedBy: ARTIST, reason: 'The reference files are corrupted', attachment: 'https://example.com/shot.png',
  });

  assert.equal(blocker.status, 'open');
  assert.equal(planningRepo.openBlockersForTask(db, task.id).length, 1);
  // Being stuck is not the same as handing the work back.
  const after = tasksRepo.getTask(db, GUILD, task.id);
  assert.equal(after.state, TASK_STATES.IN_PROGRESS);
  assert.equal(after.artist_user_id, ARTIST);
  db.close();
});

test('a blocker appears in readiness warnings and clears cleanly', () => {
  const db = setup();
  const task = makeTask(db, makeProject(db));
  const blocker = planningRepo.raiseBlocker(db, GUILD, { taskId: task.id, raisedBy: ARTIST, reason: 'Waiting on refs' });

  assert.match(checkTaskReadiness(db, GUILD, task).warnings.join(' '), /unresolved blocker/);

  const cleared = planningRepo.clearBlocker(db, GUILD, blocker.id, { actorUserId: LEADER, resolution: 'Refs re-sent' });
  assert.equal(cleared.status, 'cleared');
  assert.equal(cleared.cleared_by, LEADER);
  assert.equal(planningRepo.openBlockersForTask(db, task.id).length, 0);
  assert.equal(planningRepo.clearBlocker(db, GUILD, blocker.id, { actorUserId: LEADER }), null, 'clearing twice is a no-op');
  db.close();
});

test('a deadline request leaves the current date alone until decided', () => {
  const db = setup();
  const original = Date.now() + 2 * DAY_MS;
  const task = makeTask(db, makeProject(db), { state: TASK_STATES.IN_PROGRESS, deadline: original });

  const request = planningRepo.requestDeadlineChange(db, GUILD, {
    taskId: task.id, requestedBy: ARTIST, previousDeadline: original,
    requestedDeadline: original + 5 * DAY_MS, reason: 'Scope grew',
  });

  assert.equal(request.status, 'pending');
  assert.equal(tasksRepo.getTask(db, GUILD, task.id).deadline_utc, original, 'unchanged while pending');
  db.close();
});

test('approving an extension moves the date and keeps the old one on record', () => {
  const db = setup();
  const original = Date.now() + 2 * DAY_MS;
  const requested = original + 5 * DAY_MS;
  const task = makeTask(db, makeProject(db), { state: TASK_STATES.IN_PROGRESS, deadline: original });

  const request = planningRepo.requestDeadlineChange(db, GUILD, {
    taskId: task.id, requestedBy: ARTIST, previousDeadline: original, requestedDeadline: requested, reason: 'Scope grew',
  });
  const decided = planningRepo.decideDeadlineRequest(db, GUILD, request.id, {
    approve: true, actorUserId: LEADER, note: 'Fine, client told',
  });

  assert.equal(decided.status, 'approved');
  assert.equal(decided.decided_by, LEADER);
  assert.equal(decided.previous_deadline, original, 'what was originally agreed is still visible');
  assert.equal(tasksRepo.getTask(db, GUILD, task.id).deadline_utc, requested);

  const history = planningRepo.deadlineHistory(db, task.id);
  assert.equal(history.length, 1);
  db.close();
});

test('declining an extension leaves the deadline untouched', () => {
  const db = setup();
  const original = Date.now() + 2 * DAY_MS;
  const task = makeTask(db, makeProject(db), { state: TASK_STATES.IN_PROGRESS, deadline: original });

  const request = planningRepo.requestDeadlineChange(db, GUILD, {
    taskId: task.id, requestedBy: ARTIST, previousDeadline: original,
    requestedDeadline: original + DAY_MS, reason: 'x',
  });
  const decided = planningRepo.decideDeadlineRequest(db, GUILD, request.id, { approve: false, actorUserId: LEADER });

  assert.equal(decided.status, 'declined');
  assert.equal(tasksRepo.getTask(db, GUILD, task.id).deadline_utc, original);
  assert.equal(planningRepo.decideDeadlineRequest(db, GUILD, request.id, { approve: true, actorUserId: LEADER }), null);
  db.close();
});

test('deadline decisions are audited with both dates', () => {
  const db = setup();
  const original = Date.now() + 2 * DAY_MS;
  const task = makeTask(db, makeProject(db), { deadline: original });
  const request = planningRepo.requestDeadlineChange(db, GUILD, {
    taskId: task.id, requestedBy: ARTIST, previousDeadline: original,
    requestedDeadline: original + DAY_MS, reason: 'x',
  });
  planningRepo.decideDeadlineRequest(db, GUILD, request.id, { approve: true, actorUserId: LEADER });

  const entry = listAudit(db, { guildId: GUILD, entityType: 'task', entityId: task.id })
    .find((row) => row.action === 'deadline.approve');

  assert.ok(entry);
  assert.equal(entry.actor_user_id, LEADER);
  assert.equal(JSON.parse(entry.before_json).deadline_utc, original);
  assert.equal(JSON.parse(entry.after_json).deadline_utc, original + DAY_MS);
  db.close();
});

test('a task template stores everything needed to create work from it', () => {
  const db = setup();
  const department = configRepo.getDepartmentByKey(db, GUILD, 'modelling');

  const template = planningRepo.upsertTemplate(db, GUILD, {
    key: 'character-model',
    label: 'Character model',
    departmentId: department.id,
    brief: 'Stylised character, game ready',
    deliverables: ['Source file', 'Exported model', 'Textures'],
    formats: 'FBX + PNG',
    revisionRounds: 2,
    defaultDays: 7,
  }, OWNER);

  assert.equal(template.key, 'character-model');
  assert.deepEqual(planningRepo.templateDeliverables(template), ['Source file', 'Exported model', 'Textures']);

  // Saving again updates rather than duplicating.
  planningRepo.upsertTemplate(db, GUILD, {
    key: 'character-model', label: 'Character model v2', departmentId: department.id, deliverables: ['Source file'],
  }, OWNER);
  assert.equal(planningRepo.listTemplates(db, GUILD).length, 1);
  assert.equal(planningRepo.getTemplate(db, GUILD, 'character-model').label, 'Character model v2');
  db.close();
});

test('deleting a dependency does not delete the tasks', () => {
  const db = setup();
  const project = makeProject(db);
  const model = makeTask(db, project, { title: 'Model' });
  const rig = makeTask(db, project, { title: 'Rig', dept: 'scripting' });
  planningRepo.addDependency(db, GUILD, { taskId: rig.id, dependsOnTaskId: model.id }, OWNER);

  assert.equal(planningRepo.removeDependency(db, GUILD, rig.id, model.id, OWNER), true);
  assert.equal(planningRepo.dependenciesOf(db, rig.id).length, 0);
  assert.ok(tasksRepo.getTask(db, GUILD, model.id));
  assert.ok(tasksRepo.getTask(db, GUILD, rig.id));
  db.close();
});

test('dependencies disappear with the task they belonged to', () => {
  const db = setup();
  const project = makeProject(db);
  const model = makeTask(db, project, { title: 'Model' });
  const rig = makeTask(db, project, { title: 'Rig', dept: 'scripting' });
  planningRepo.addDependency(db, GUILD, { taskId: rig.id, dependsOnTaskId: model.id }, OWNER);

  db.prepare('DELETE FROM projects WHERE id = ?').run(project.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM task_dependencies').get().n, 0);
  db.close();
});
