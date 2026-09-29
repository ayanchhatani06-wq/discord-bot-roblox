const test = require('node:test');
const assert = require('node:assert/strict');

const { openDatabase } = require('../src/db');
const configRepo = require('../src/db/repos/config');
const clientsRepo = require('../src/db/repos/clients');
const enquiriesRepo = require('../src/db/repos/enquiries');
const projectsRepo = require('../src/db/repos/projects');
const tasksRepo = require('../src/db/repos/tasks');
const quoteFlow = require('../src/services/quoteFlow');
const { listAudit } = require('../src/db/repos/core');
const { TASK_STATES } = require('../src/domain/taskState');

const GUILD = 'guild-1';
const OWNER = 'owner-1';
const MANAGER = 'manager-1';
const CLIENT_USER = 'client-user-1';

function setup() {
  const db = openDatabase({ file: ':memory:' });
  configRepo.ensureConfig(db, GUILD);
  configRepo.seedDefaultDepartments(db, GUILD, OWNER);
  configRepo.updateConfig(db, GUILD, { owner_user_id: OWNER }, OWNER);
  return db;
}

function withTemplates(db) {
  for (const [key, price] of [['modelling', 4000], ['vfx', 3000], ['animation', 6000]]) {
    const department = configRepo.getDepartmentByKey(db, GUILD, key);
    enquiriesRepo.upsertTemplate(db, GUILD, {
      key, label: department.name, departmentId: department.id,
      unitAmountMinor: price, currency: 'USD', turnaroundDays: 5, revisionRounds: 2,
    }, OWNER);
  }
}

function makeEnquiry(db, service = '12 models, 4 vfx, 2 animations', extra = {}) {
  const parsed = quoteFlow.parseServiceRequest(db, GUILD, service);
  return enquiriesRepo.createEnquiry(db, GUILD, {
    serviceRequest: service,
    parsed: parsed.items,
    referencesText: 'https://example.com/board',
    formatsText: 'FBX and PNG textures',
    notes: 'Stylised, low poly',
    ...extra,
  }, MANAGER);
}

test('an enquiry is matched onto the studio departments', () => {
  const db = setup();
  const enquiry = makeEnquiry(db);
  const items = enquiriesRepo.parsedItems(enquiry);

  assert.equal(enquiry.code, 'ENQ-0001');
  assert.equal(enquiry.status, 'new');
  assert.deepEqual(items.map((item) => [item.departmentKey, item.count]), [
    ['modelling', 12], ['vfx', 4], ['animation', 2],
  ]);
  db.close();
});

test('a request that matches nothing is recorded but flagged as unpriceable', () => {
  const db = setup();
  const enquiry = makeEnquiry(db, 'some interpretive dance');

  assert.equal(enquiriesRepo.parsedItems(enquiry).length, 0);
  const draft = quoteFlow.draftFromEnquiry(db, GUILD, enquiry);
  assert.equal(draft.ok, false);
  assert.equal(draft.reason, 'no_parsed_items');
  db.close();
});

test('a draft quote is built from templates and totals correctly', () => {
  const db = setup();
  withTemplates(db);
  const enquiry = makeEnquiry(db);

  const draft = quoteFlow.draftFromEnquiry(db, GUILD, enquiry);
  assert.equal(draft.ok, true);
  assert.equal(draft.complete, true);
  // 12 x $40 + 4 x $30 + 2 x $60 = $480 + $120 + $120 = $720
  assert.equal(draft.totalMinor, 72000);
  assert.equal(draft.currency, 'USD');
  assert.equal(draft.turnaroundDays, 5);
  db.close();
});

test('items with no template come back needing a price rather than priced at zero', () => {
  const db = setup();
  const modelling = configRepo.getDepartmentByKey(db, GUILD, 'modelling');
  enquiriesRepo.upsertTemplate(db, GUILD, {
    key: 'modelling', label: 'Modelling', departmentId: modelling.id,
    unitAmountMinor: 4000, currency: 'USD',
  }, OWNER);

  const enquiry = makeEnquiry(db, '2 models, 3 vfx');
  const draft = quoteFlow.draftFromEnquiry(db, GUILD, enquiry);

  assert.equal(draft.ok, true);
  assert.equal(draft.complete, false, 'not safe to send without a human pricing the rest');
  assert.equal(draft.lines.find((line) => line.needsPrice).unitMinor, null);
  assert.match(draft.warnings.join(' '), /No price template for VFX/);
  // The total covers only what is priced; it is not presented as the full figure.
  assert.equal(draft.totalMinor, 8000);
  db.close();
});

test('templates in different currencies refuse to become one quote', () => {
  const db = setup();
  const modelling = configRepo.getDepartmentByKey(db, GUILD, 'modelling');
  const vfx = configRepo.getDepartmentByKey(db, GUILD, 'vfx');
  enquiriesRepo.upsertTemplate(db, GUILD, { key: 'modelling', label: 'M', departmentId: modelling.id, unitAmountMinor: 4000, currency: 'USD' }, OWNER);
  enquiriesRepo.upsertTemplate(db, GUILD, { key: 'vfx', label: 'V', departmentId: vfx.id, unitAmountMinor: 500, currency: 'ROBUX' }, OWNER);

  const draft = quoteFlow.draftFromEnquiry(db, GUILD, makeEnquiry(db, '2 models, 2 vfx'));
  assert.equal(draft.ok, false);
  assert.equal(draft.reason, 'mixed_currencies');
  db.close();
});

test('a quote cannot be sent until the owner approves it', () => {
  const db = setup();
  withTemplates(db);
  const enquiry = makeEnquiry(db);
  const draft = quoteFlow.draftFromEnquiry(db, GUILD, enquiry);

  const quote = enquiriesRepo.createQuote(db, GUILD, enquiry.id, {
    lines: draft.lines, totalMinor: draft.totalMinor, currency: draft.currency,
  }, MANAGER);

  assert.equal(quote.status, 'draft');
  // Sending a draft is refused outright.
  assert.equal(enquiriesRepo.markQuoteSent(db, GUILD, quote.id, MANAGER), null);

  const approved = enquiriesRepo.approveQuote(db, GUILD, quote.id, OWNER);
  assert.equal(approved.status, 'approved');
  assert.equal(approved.approved_by, OWNER);

  const sent = enquiriesRepo.markQuoteSent(db, GUILD, quote.id, MANAGER);
  assert.equal(sent.status, 'sent');
  db.close();
});

test('approving is only possible once, from draft', () => {
  const db = setup();
  withTemplates(db);
  const enquiry = makeEnquiry(db);
  const quote = enquiriesRepo.createQuote(db, GUILD, enquiry.id, { lines: [], totalMinor: 1000, currency: 'USD' }, MANAGER);

  assert.ok(enquiriesRepo.approveQuote(db, GUILD, quote.id, OWNER));
  assert.equal(enquiriesRepo.approveQuote(db, GUILD, quote.id, OWNER), null, 'a second approval is a no-op');
  db.close();
});

test('a revised quote supersedes the previous one rather than leaving two live', () => {
  const db = setup();
  const enquiry = makeEnquiry(db);

  const first = enquiriesRepo.createQuote(db, GUILD, enquiry.id, { lines: [], totalMinor: 50000, currency: 'USD' }, MANAGER);
  enquiriesRepo.approveQuote(db, GUILD, first.id, OWNER);
  enquiriesRepo.markQuoteSent(db, GUILD, first.id, MANAGER);

  const second = enquiriesRepo.createQuote(db, GUILD, enquiry.id, { lines: [], totalMinor: 60000, currency: 'USD' }, MANAGER);

  assert.equal(second.version, 2);
  assert.equal(enquiriesRepo.getQuote(db, GUILD, first.id).status, 'superseded');
  assert.equal(enquiriesRepo.latestQuote(db, enquiry.id).id, second.id);
  assert.equal(second.status, 'draft', 'the new price needs approving on its own merits');
  db.close();
});

test('the pipeline moves through every stage and is audited', () => {
  const db = setup();
  withTemplates(db);
  const enquiry = makeEnquiry(db);

  enquiriesRepo.setStatus(db, GUILD, enquiry.id, 'needs_info', MANAGER, { detail: 'Need the style reference' });
  assert.equal(enquiriesRepo.getEnquiry(db, GUILD, enquiry.id).status, 'needs_info');

  const draft = quoteFlow.draftFromEnquiry(db, GUILD, enquiry);
  const quote = enquiriesRepo.createQuote(db, GUILD, enquiry.id, {
    lines: draft.lines, totalMinor: draft.totalMinor, currency: draft.currency,
  }, MANAGER);
  enquiriesRepo.setStatus(db, GUILD, enquiry.id, 'quote_prepared', MANAGER);
  enquiriesRepo.approveQuote(db, GUILD, quote.id, OWNER);
  enquiriesRepo.markQuoteSent(db, GUILD, quote.id, MANAGER);
  enquiriesRepo.setStatus(db, GUILD, enquiry.id, 'quote_sent', MANAGER);

  const trail = listAudit(db, { guildId: GUILD, entityType: 'enquiry', entityId: enquiry.id });
  const actions = trail.map((row) => row.action);
  assert.ok(actions.includes('enquiry.create'));
  assert.ok(actions.filter((action) => action === 'enquiry.status').length >= 3);

  assert.throws(() => enquiriesRepo.setStatus(db, GUILD, enquiry.id, 'maybe', MANAGER), /Unknown enquiry status/);
  db.close();
});

test('accepting an enquiry becomes a project with its tasks and no retyping', () => {
  const db = setup();
  withTemplates(db);
  const client = clientsRepo.createClient(db, GUILD, { displayName: 'Demo Studios' }, OWNER);
  clientsRepo.addAccount(db, GUILD, client.id, { userId: CLIENT_USER }, OWNER);
  const enquiry = makeEnquiry(db, '12 models, 4 vfx, 2 animations', { clientId: client.id });

  const result = quoteFlow.convertToProject(db, GUILD, enquiry, {
    actorUserId: OWNER, clientAmountMinor: 72000, currency: 'USD',
  });

  assert.equal(result.ok, true);
  assert.equal(result.tasks.length, 18);

  const project = projectsRepo.getProject(db, GUILD, result.project.id);
  assert.equal(project.client_amount_minor, 72000);
  assert.equal(project.client_id, client.id, 'the client comes across too');
  assert.match(project.brief, /12 models, 4 vfx, 2 animations/);
  assert.match(project.brief, /FBX and PNG textures/);
  assert.match(project.brief, /Stylised, low poly/);
  assert.equal(project.reference_links, 'https://example.com/board');

  // The enquiry now points at what it became.
  const after = enquiriesRepo.getEnquiry(db, GUILD, enquiry.id);
  assert.equal(after.status, 'accepted');
  assert.equal(after.project_id, project.id);
  db.close();
});

test('converted tasks start unassigned with no artist pay set', () => {
  const db = setup();
  withTemplates(db);
  const enquiry = makeEnquiry(db, '3 models');
  const result = quoteFlow.convertToProject(db, GUILD, enquiry, {
    actorUserId: OWNER, clientAmountMinor: 12000, currency: 'USD',
  });

  for (const task of result.tasks) {
    const fresh = tasksRepo.getTask(db, GUILD, task.id);
    assert.equal(fresh.state, TASK_STATES.UNASSIGNED);
    // What the client pays is not what an artist is paid; the owner sets that.
    assert.equal(fresh.artist_pay_minor, null);
    assert.equal(fresh.pay_state, 'unset');
    assert.equal(fresh.revision_rounds, 2, 'but the template revision scope carries across');
  }
  db.close();
});

test('an enquiry cannot be converted twice', () => {
  const db = setup();
  const enquiry = makeEnquiry(db, '2 models');
  quoteFlow.convertToProject(db, GUILD, enquiry, { actorUserId: OWNER });

  const again = quoteFlow.convertToProject(db, GUILD, enquiriesRepo.getEnquiry(db, GUILD, enquiry.id), { actorUserId: OWNER });
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'already_converted');
  assert.equal(projectsRepo.listProjects(db, GUILD, { status: 'all' }).length, 1);
  db.close();
});

test('converting an unmatched enquiry is refused rather than creating an empty project', () => {
  const db = setup();
  const enquiry = makeEnquiry(db, 'something we do not do');
  const result = quoteFlow.convertToProject(db, GUILD, enquiry, { actorUserId: OWNER });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no_parsed_items');
  assert.equal(projectsRepo.listProjects(db, GUILD, { status: 'all' }).length, 0);
  db.close();
});

test('a declined quote keeps the record of what was offered', () => {
  const db = setup();
  const enquiry = makeEnquiry(db, '2 models');
  const quote = enquiriesRepo.createQuote(db, GUILD, enquiry.id, { lines: [], totalMinor: 8000, currency: 'USD' }, MANAGER);
  enquiriesRepo.approveQuote(db, GUILD, quote.id, OWNER);
  enquiriesRepo.markQuoteSent(db, GUILD, quote.id, MANAGER);

  enquiriesRepo.respondToQuote(db, GUILD, quote.id, { accepted: false, actorUserId: MANAGER, declineReason: 'Too expensive' });
  enquiriesRepo.setStatus(db, GUILD, enquiry.id, 'declined', MANAGER, { closedReason: 'Too expensive' });

  const declined = enquiriesRepo.getQuote(db, GUILD, quote.id);
  assert.equal(declined.status, 'declined');
  assert.equal(declined.decline_reason, 'Too expensive');
  assert.equal(declined.total_minor, 8000, 'what was offered is still on record');
  db.close();
});

test('outstanding quote value counts only what is actually sent', () => {
  const db = setup();
  const sentEnquiry = makeEnquiry(db, '2 models');
  const sentQuote = enquiriesRepo.createQuote(db, GUILD, sentEnquiry.id, { lines: [], totalMinor: 8000, currency: 'USD' }, MANAGER);
  enquiriesRepo.approveQuote(db, GUILD, sentQuote.id, OWNER);
  enquiriesRepo.markQuoteSent(db, GUILD, sentQuote.id, MANAGER);

  const draftEnquiry = makeEnquiry(db, '5 models');
  enquiriesRepo.createQuote(db, GUILD, draftEnquiry.id, { lines: [], totalMinor: 20000, currency: 'USD' }, MANAGER);

  const outstanding = enquiriesRepo.outstandingQuoteValue(db, GUILD);
  assert.equal(outstanding.get('USD'), 8000, 'an unapproved draft is not outstanding business');
  db.close();
});

test('the pipeline counts every stage', () => {
  const db = setup();
  makeEnquiry(db, '1 model');
  const second = makeEnquiry(db, '2 models');
  enquiriesRepo.setStatus(db, GUILD, second.id, 'declined', MANAGER);

  const counts = enquiriesRepo.pipelineCounts(db, GUILD);
  assert.equal(counts.new, 1);
  assert.equal(counts.declined, 1);
  assert.equal(counts.accepted, 0);

  assert.equal(enquiriesRepo.listEnquiries(db, GUILD, { status: 'open' }).length, 1, 'declined is not open');
  db.close();
});

test('a template only pre-fills and never prices by itself', () => {
  const db = setup();
  const modelling = configRepo.getDepartmentByKey(db, GUILD, 'modelling');
  const template = enquiriesRepo.upsertTemplate(db, GUILD, {
    key: 'modelling', label: 'Modelling', departmentId: modelling.id,
    unitAmountMinor: 4000, currency: 'USD', turnaroundDays: 5,
  }, OWNER);

  const enquiry = makeEnquiry(db, '3 models');
  const draft = quoteFlow.draftFromEnquiry(db, GUILD, enquiry);
  const quote = enquiriesRepo.createQuote(db, GUILD, enquiry.id, {
    lines: draft.lines, totalMinor: draft.totalMinor, currency: draft.currency,
  }, MANAGER);

  assert.equal(template.unit_amount_minor, 4000);
  assert.equal(quote.total_minor, 12000);
  // Even straight from a template, it is still only a draft.
  assert.equal(quote.status, 'draft');
  assert.equal(quote.approved_by, null);
  db.close();
});
