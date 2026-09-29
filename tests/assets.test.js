const test = require('node:test');
const assert = require('node:assert/strict');

const { openDatabase } = require('../src/db');
const configRepo = require('../src/db/repos/config');
const clientsRepo = require('../src/db/repos/clients');
const projectsRepo = require('../src/db/repos/projects');
const tasksRepo = require('../src/db/repos/tasks');
const submissionsRepo = require('../src/db/repos/submissions');
const assetsRepo = require('../src/db/repos/assets');
const delivery = require('../src/services/delivery');
const clientReport = require('../src/services/clientReport');
const { listAudit } = require('../src/db/repos/core');
const { TASK_STATES } = require('../src/domain/taskState');
const { DAY_MS } = require('../src/utils/time');

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

function submittedTask(db, { state = TASK_STATES.INTERNAL_REVIEW, checklistComplete = true } = {}) {
  const client = clientsRepo.createClient(db, GUILD, { displayName: 'Demo Studios' }, OWNER);
  clientsRepo.addAccount(db, GUILD, client.id, { userId: CLIENT_USER }, OWNER);
  const project = projectsRepo.createProject(db, GUILD, {
    name: 'Pack', clientAmountMinor: 40000, clientCurrency: 'USD',
  }, OWNER);
  clientsRepo.linkProject(db, GUILD, project.id, client.id, OWNER);

  const department = configRepo.getDepartmentByKey(db, GUILD, 'modelling');
  const task = tasksRepo.createTask(db, GUILD, {
    projectId: project.id, title: 'Model 1', departmentId: department.id,
    leaderUserId: LEADER, deliverables: ['Source file', 'Exported model'],
  }, OWNER);
  db.prepare('UPDATE tasks SET state = ?, artist_user_id = ? WHERE id = ?').run(state, ARTIST, task.id);

  const submission = submissionsRepo.addSubmission(db, GUILD, task.id, {
    kind: 'final',
    notes: 'done',
    links: ['https://example.com/model.fbx', 'https://example.com/textures.zip'],
    internalLinks: ['https://example.com/working.blend'],
    checklist: [
      { item: 'Source file', included: true },
      { item: 'Exported model', included: checklistComplete },
    ],
    submittedBy: ARTIST,
  });

  assetsRepo.recordSubmissionAssets(db, GUILD, {
    submission,
    task: tasksRepo.getTask(db, GUILD, task.id),
    deliverableLinks: ['https://example.com/model.fbx', 'https://example.com/textures.zip'],
    internalLinks: ['https://example.com/working.blend'],
    assetType: 'modelling',
  });

  return {
    client,
    project: projectsRepo.getProject(db, GUILD, project.id),
    task: tasksRepo.getTask(db, GUILD, task.id),
    submission,
  };
}

test('submitted links become archive assets, split by kind', () => {
  const db = setup();
  const { task } = submittedTask(db);

  const all = assetsRepo.listForTask(db, task.id);
  assert.equal(all.length, 3);
  assert.equal(all.filter((asset) => asset.kind === 'deliverable').length, 2);
  assert.equal(all.filter((asset) => asset.kind === 'source').length, 1);
  assert.equal(all.every((asset) => asset.asset_type === 'modelling'), true);
  db.close();
});

test('releasing a submission never releases its source files', () => {
  const db = setup();
  const { task, submission } = submittedTask(db);

  submissionsRepo.markClientVisible(db, GUILD, submission.id, LEADER);
  const released = assetsRepo.releaseSubmissionAssets(db, submission.id);

  assert.equal(released, 2, 'only the two deliverables');
  const source = assetsRepo.listForTask(db, task.id, { kind: 'source' })[0];
  assert.equal(source.client_released_at, null, 'the working file stays internal');
  db.close();
});

test('the client never sees source files even after release', () => {
  const db = setup();
  const { project, task, submission } = submittedTask(db, { state: TASK_STATES.AWAITING_CLIENT });
  submissionsRepo.markClientVisible(db, GUILD, submission.id, LEADER);
  assetsRepo.releaseSubmissionAssets(db, submission.id);

  const report = clientReport.buildProjectReport(db, GUILD, project);
  const rendered = JSON.stringify(report.previews);

  assert.ok(rendered.includes('model.fbx'));
  assert.ok(!rendered.includes('working.blend'), 'the source file must never reach the client view');
  db.close();
});

test('delivery is blocked until the configured conditions are met', () => {
  const db = setup();
  const { task } = submittedTask(db, { state: TASK_STATES.INTERNAL_REVIEW });

  const readiness = delivery.checkDeliveryReadiness(db, GUILD, task);
  assert.equal(readiness.ok, false);
  assert.match(readiness.blockers.join(' '), /client has not approved/i);
  db.close();
});

test('an incomplete checklist blocks delivery', () => {
  const db = setup();
  const { task } = submittedTask(db, { state: TASK_STATES.CLIENT_APPROVED, checklistComplete: false });

  const readiness = delivery.checkDeliveryReadiness(db, GUILD, task);
  assert.equal(readiness.ok, false);
  assert.match(readiness.blockers.join(' '), /Exported model/);
  db.close();
});

test('an approved item with complete files is ready to release', () => {
  const db = setup();
  const { task } = submittedTask(db, { state: TASK_STATES.CLIENT_APPROVED });

  const readiness = delivery.checkDeliveryReadiness(db, GUILD, task);
  assert.equal(readiness.ok, true);
  assert.equal(readiness.deliverables.length, 2);
  assert.deepEqual(readiness.blockers, []);
  db.close();
});

test('requiring client payment is configurable and enforced', () => {
  const db = setup();
  const { project, task } = submittedTask(db, { state: TASK_STATES.CLIENT_APPROVED });

  delivery.setDeliveryConditions(db, GUILD, { require_client_paid: true }, OWNER);
  assert.match(delivery.checkDeliveryReadiness(db, GUILD, task).blockers.join(' '), /not recorded as received/);

  db.prepare(`
    INSERT INTO payments (guild_id, direction, project_id, amount_minor, currency, recorded_by, recorded_at, idempotency_key)
    VALUES (?, 'client_receipt', ?, 40000, 'USD', ?, ?, 'r1')
  `).run(GUILD, project.id, OWNER, Date.now());

  assert.equal(delivery.checkDeliveryReadiness(db, GUILD, tasksRepo.getTask(db, GUILD, task.id)).ok, true);
  db.close();
});

test('delivery records who released which version and when', () => {
  const db = setup();
  const { task } = submittedTask(db, { state: TASK_STATES.CLIENT_APPROVED });

  const result = delivery.authorizeDelivery(db, GUILD, task, { actorUserId: OWNER, note: 'Sent by email' });

  assert.equal(result.ok, true);
  assert.equal(result.task.delivered_by, OWNER);
  assert.equal(result.task.delivered_version, 1);
  assert.ok(result.task.delivered_at > 0);
  assert.equal(result.task.delivery_note, 'Sent by email');

  const delivered = assetsRepo.listForTask(db, task.id, { kind: 'deliverable' });
  assert.ok(delivered.every((asset) => asset.delivered_at > 0));
  db.close();
});

test('the same item cannot be delivered twice', () => {
  const db = setup();
  const { task } = submittedTask(db, { state: TASK_STATES.CLIENT_APPROVED });
  delivery.authorizeDelivery(db, GUILD, task, { actorUserId: OWNER });

  const again = delivery.authorizeDelivery(db, GUILD, tasksRepo.getTask(db, GUILD, task.id), { actorUserId: OWNER });
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'already_delivered');
  db.close();
});

test('an override is allowed but recorded as one', () => {
  const db = setup();
  const { task } = submittedTask(db, { state: TASK_STATES.INTERNAL_REVIEW });

  const blocked = delivery.authorizeDelivery(db, GUILD, task, { actorUserId: OWNER });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'conditions_not_met');

  const forced = delivery.authorizeDelivery(db, GUILD, task, { actorUserId: OWNER, override: true });
  assert.equal(forced.ok, true);
  assert.equal(forced.overridden, true);

  const entry = listAudit(db, { guildId: GUILD, entityType: 'task', entityId: task.id })
    .find((row) => row.action === 'task.deliver');
  assert.equal(JSON.parse(entry.after_json).overridden, true);
  assert.match(entry.detail, /Released despite/);
  db.close();
});

test('the latest client-approved version is identifiable', () => {
  const db = setup();
  const { task, submission } = submittedTask(db, { state: TASK_STATES.AWAITING_CLIENT });

  assert.equal(delivery.latestApprovedVersion(db, task.id), null);

  submissionsRepo.addClientDecision(db, GUILD, task.id, {
    submissionId: submission.id, decision: 'approved', recordedBy: CLIENT_USER,
  });

  const approved = delivery.latestApprovedVersion(db, task.id);
  assert.equal(approved.version, 1);
  assert.equal(approved.recordedBy, CLIENT_USER);
  db.close();
});

// --- portfolio rights ----------------------------------------------------

test('with nothing recorded, nobody may use the work', () => {
  const db = setup();
  const { project, task } = submittedTask(db);
  const asset = assetsRepo.listForTask(db, task.id)[0];

  const rights = assetsRepo.resolvePortfolioRights(asset, project);
  assert.equal(rights.recorded, false);
  assert.equal(rights.staffAllowed, false);
  assert.equal(rights.studioAllowed, false);
  assert.equal(rights.staffUsableNow, false);
  db.close();
});

test('project permission applies to all its files', () => {
  const db = setup();
  const { project, task } = submittedTask(db);

  assetsRepo.setProjectRights(db, GUILD, project.id, {
    staffAllowed: true, studioAllowed: false, actorUserId: OWNER,
  });

  const fresh = projectsRepo.getProject(db, GUILD, project.id);
  const rights = assetsRepo.resolvePortfolioRights(assetsRepo.listForTask(db, task.id)[0], fresh);

  assert.equal(rights.recorded, true);
  assert.equal(rights.staffUsableNow, true);
  assert.equal(rights.studioUsableNow, false, 'the studio was not granted it');
  assert.equal(rights.source, 'project');
  db.close();
});

test('permission that starts later is not usable yet', () => {
  const db = setup();
  const { project, task } = submittedTask(db);
  const future = Date.now() + 30 * DAY_MS;

  assetsRepo.setProjectRights(db, GUILD, project.id, {
    staffAllowed: true, studioAllowed: true, fromUtc: future,
    restrictions: 'Not before the game launches', actorUserId: OWNER,
  });

  const fresh = projectsRepo.getProject(db, GUILD, project.id);
  const rights = assetsRepo.resolvePortfolioRights(assetsRepo.listForTask(db, task.id)[0], fresh);

  assert.equal(rights.recorded, true);
  assert.equal(rights.staffAllowed, true, 'permitted in principle');
  assert.equal(rights.started, false);
  assert.equal(rights.staffUsableNow, false, 'but not yet');
  assert.equal(rights.restrictions, 'Not before the game launches');
  db.close();
});

test('one file can override its project', () => {
  const db = setup();
  const { project, task } = submittedTask(db);
  assetsRepo.setProjectRights(db, GUILD, project.id, { staffAllowed: true, studioAllowed: true, actorUserId: OWNER });

  const asset = assetsRepo.listForTask(db, task.id)[0];
  assetsRepo.setAssetRights(db, GUILD, asset.id, {
    staffAllowed: false, studioAllowed: false, restrictions: 'Client asked for this one to stay private', actorUserId: OWNER,
  });

  const fresh = projectsRepo.getProject(db, GUILD, project.id);
  const rights = assetsRepo.resolvePortfolioRights(assetsRepo.getAsset(db, GUILD, asset.id), fresh);

  assert.equal(rights.staffUsableNow, false);
  assert.equal(rights.studioUsableNow, false);
  assert.equal(rights.source, 'asset');
  db.close();
});

test('the publishable portfolio contains only permitted, started deliverables', () => {
  const db = setup();
  const allowed = submittedTask(db);
  const forbidden = submittedTask(db);

  assetsRepo.setProjectRights(db, GUILD, allowed.project.id, { staffAllowed: true, studioAllowed: true, actorUserId: OWNER });
  assetsRepo.setProjectRights(db, GUILD, forbidden.project.id, { staffAllowed: true, studioAllowed: false, actorUserId: OWNER });

  const publishable = assetsRepo.publishablePortfolio(db, GUILD);

  assert.ok(publishable.length > 0);
  assert.ok(publishable.every((row) => row.project_id === allowed.project.id));
  assert.ok(publishable.every((row) => row.kind === 'deliverable'), 'never source files');
  db.close();
});

test('archive search filters by project, artist, type and permission', () => {
  const db = setup();
  const first = submittedTask(db);
  assetsRepo.setProjectRights(db, GUILD, first.project.id, { staffAllowed: true, studioAllowed: true, actorUserId: OWNER });

  assert.equal(assetsRepo.search(db, GUILD, { projectId: first.project.id }).length, 3);
  assert.equal(assetsRepo.search(db, GUILD, { artistUserId: ARTIST }).length, 3);
  assert.equal(assetsRepo.search(db, GUILD, { artistUserId: 'nobody' }).length, 0);
  assert.equal(assetsRepo.search(db, GUILD, { assetType: 'modelling' }).length, 3);
  assert.equal(assetsRepo.search(db, GUILD, { kind: 'source' }).length, 1);
  assert.equal(assetsRepo.search(db, GUILD, { query: 'textures' }).length, 1);
  assert.equal(assetsRepo.search(db, GUILD, { portfolio: 'studio' }).length, 3);

  const second = submittedTask(db);
  assert.equal(assetsRepo.search(db, GUILD, { portfolio: 'none' }).length, 3, 'the project with no permission recorded');
  assert.equal(assetsRepo.search(db, GUILD, { projectId: second.project.id, portfolio: 'studio' }).length, 0);
  db.close();
});

test('a rights summary shows what is still unrecorded', () => {
  const db = setup();
  const { project } = submittedTask(db);

  const before = assetsRepo.rightsSummary(db, GUILD, project.id);
  assert.equal(before.total, 3);
  assert.equal(before.unrecorded, 3);
  assert.equal(before.studioOk, 0);

  assetsRepo.setProjectRights(db, GUILD, project.id, { staffAllowed: true, studioAllowed: true, actorUserId: OWNER });
  const after = assetsRepo.rightsSummary(db, GUILD, project.id);
  assert.equal(after.unrecorded, 0);
  assert.equal(after.studioOk, 3);
  db.close();
});

test('recording portfolio permission is audited', () => {
  const db = setup();
  const { project } = submittedTask(db);
  assetsRepo.setProjectRights(db, GUILD, project.id, {
    staffAllowed: true, studioAllowed: false, restrictions: 'Credit required', actorUserId: OWNER,
  });

  const entry = listAudit(db, { guildId: GUILD, entityType: 'project', entityId: project.id })
    .find((row) => row.action === 'portfolio.rights.project');

  assert.ok(entry);
  assert.equal(entry.actor_user_id, OWNER);
  assert.equal(JSON.parse(entry.after_json).restrictions, 'Credit required');
  db.close();
});

test('delivery conditions round-trip and default sensibly', () => {
  const db = setup();
  const defaults = delivery.deliveryConditions(configRepo.getConfig(db, GUILD));

  assert.equal(defaults.require_client_approval, true);
  assert.equal(defaults.require_client_paid, false);
  assert.equal(defaults.require_checklist_complete, true);

  delivery.setDeliveryConditions(db, GUILD, { require_client_paid: true }, OWNER);
  const updated = delivery.deliveryConditions(configRepo.getConfig(db, GUILD));
  assert.equal(updated.require_client_paid, true);
  assert.equal(updated.require_client_approval, true, 'unspecified conditions keep their value');
  db.close();
});

test('approved work waiting to be released is listed', () => {
  const db = setup();
  const ready = submittedTask(db, { state: TASK_STATES.CLIENT_APPROVED });
  submittedTask(db, { state: TASK_STATES.IN_PROGRESS });

  const pending = delivery.undeliveredApproved(db, GUILD);
  assert.deepEqual(pending.map((task) => task.id), [ready.task.id]);

  delivery.authorizeDelivery(db, GUILD, ready.task, { actorUserId: OWNER });
  assert.equal(delivery.undeliveredApproved(db, GUILD).length, 0);
  db.close();
});
