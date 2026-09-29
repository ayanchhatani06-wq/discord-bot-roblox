const test = require('node:test');
const assert = require('node:assert/strict');

const { openDatabase } = require('../src/db');
const configRepo = require('../src/db/repos/config');
const clientsRepo = require('../src/db/repos/clients');
const projectsRepo = require('../src/db/repos/projects');
const tasksRepo = require('../src/db/repos/tasks');
const messagingRepo = require('../src/db/repos/messaging');
const clientMessaging = require('../src/services/clientMessaging');
const messageTriggers = require('../src/services/messageTriggers');
const templates = require('../src/domain/templates');

const GUILD = 'guild-1';
const OWNER = 'owner-1';
const CLIENT_USER = 'client-user-1';

const { TRIGGERS, KINDS } = messagingRepo;

function setup() {
  const db = openDatabase({ file: ':memory:' });
  configRepo.ensureConfig(db, GUILD);
  configRepo.seedDefaultDepartments(db, GUILD, OWNER);
  configRepo.updateConfig(db, GUILD, { owner_user_id: OWNER, studio_name: 'Test Studio' }, OWNER);
  return db;
}

function makeClient(db, overrides = {}) {
  const client = clientsRepo.createClient(db, GUILD, {
    displayName: 'Acme Games', ...overrides,
  }, OWNER);
  clientsRepo.addAccount(db, GUILD, client.id, { userId: CLIENT_USER }, OWNER);
  return client;
}

function makeProject(db, client, overrides = {}) {
  const project = projectsRepo.createProject(db, GUILD, { name: 'Lobby pack', ...overrides }, OWNER);
  clientsRepo.linkProject(db, GUILD, project.id, client.id, OWNER, { clientChannelId: 'channel-1' });
  return projectsRepo.getProject(db, GUILD, project.id);
}

function approvedTemplate(db, { key = 'confirm', trigger = TRIGGERS.ORDER_CONFIRMED, kind = KINDS.TRANSACTIONAL, body = 'Hello {{client_name}}, {{project_name}} is confirmed.' } = {}) {
  messagingRepo.upsertTemplate(db, GUILD, {
    key, label: key, kind, triggerEvent: trigger, body,
  }, OWNER);
  return messagingRepo.approveTemplate(db, GUILD, key, OWNER);
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

test('a template using an invented placeholder is refused when it is written', () => {
  const db = setup();
  const result = messagingRepo.upsertTemplate(db, GUILD, {
    key: 'oops', label: 'Oops', kind: KINDS.TRANSACTIONAL, body: 'Hi {{clinet_name}}',
  }, OWNER);

  assert.equal(result.ok, false);
  assert.deepEqual(result.unknown, ['clinet_name']);
  assert.equal(messagingRepo.getTemplate(db, GUILD, 'oops'), null, 'nothing was stored');
});

test('a template starts as a draft and cannot send until it is approved', () => {
  const db = setup();
  const client = makeClient(db);
  const project = makeProject(db, client);

  messagingRepo.upsertTemplate(db, GUILD, {
    key: 'confirm', label: 'Confirmation', kind: KINDS.TRANSACTIONAL,
    triggerEvent: TRIGGERS.ORDER_CONFIRMED, body: 'Hello {{client_name}}.',
  }, OWNER);

  const blocked = messageTriggers.orderConfirmed(db, GUILD, project);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, clientMessaging.BLOCKED.NO_TEMPLATE, 'a draft is not a template that sends');

  messagingRepo.approveTemplate(db, GUILD, 'confirm', OWNER);
  assert.equal(messageTriggers.orderConfirmed(db, GUILD, project).created, true);
});

test('rewriting an approved template withdraws its approval', () => {
  const db = setup();
  approvedTemplate(db);

  const edited = messagingRepo.upsertTemplate(db, GUILD, {
    key: 'confirm', label: 'confirm', kind: KINDS.TRANSACTIONAL,
    triggerEvent: TRIGGERS.ORDER_CONFIRMED, body: 'Hello {{client_name}}, something new.',
  }, OWNER);

  assert.equal(edited.wordingChanged, true);
  assert.equal(edited.template.status, 'draft');
  assert.equal(edited.template.approved_by, null);
  assert.equal(edited.template.version, 2);
});

test('changing only the label keeps the approval', () => {
  const db = setup();
  approvedTemplate(db);

  const edited = messagingRepo.upsertTemplate(db, GUILD, {
    key: 'confirm', label: 'A friendlier name', kind: KINDS.TRANSACTIONAL,
    triggerEvent: TRIGGERS.ORDER_CONFIRMED, body: 'Hello {{client_name}}, {{project_name}} is confirmed.',
  }, OWNER);

  assert.equal(edited.wordingChanged, false);
  assert.equal(edited.template.status, 'approved');
});

test('a placeholder with nothing behind it stops the message rather than sending a gap', () => {
  const db = setup();
  const rendered = templates.render('Hello {{client_name}}, your {{project_name}}.', { client_name: 'Acme' });

  assert.equal(rendered.ok, false);
  assert.equal(rendered.reason, 'missing_value');
  assert.deepEqual(rendered.missing, ['project_name']);
});

// ---------------------------------------------------------------------------
// Queueing and deduplication
// ---------------------------------------------------------------------------

test('the same event cannot queue the same message twice', () => {
  const db = setup();
  const client = makeClient(db);
  const project = makeProject(db, client);
  approvedTemplate(db);

  assert.equal(messageTriggers.orderConfirmed(db, GUILD, project).created, true);
  assert.equal(messageTriggers.orderConfirmed(db, GUILD, project).created, false, 'the second is swallowed');
  assert.equal(messagingRepo.history(db, GUILD, { clientId: client.id }).length, 1);
});

test('each preview is its own message, but they share one digest', () => {
  const db = setup();
  const client = makeClient(db);
  const project = makeProject(db, client);
  approvedTemplate(db, {
    key: 'preview', trigger: TRIGGERS.PREVIEW_READY,
    body: '{{client_name}}, a preview is ready for {{project_name}}.',
  });

  const now = Date.now();
  const first = messageTriggers.previewReady(db, GUILD, project, { taskId: 1, submissionId: 1, now });
  const second = messageTriggers.previewReady(db, GUILD, project, { taskId: 2, submissionId: 2, now });
  const repeat = messageTriggers.previewReady(db, GUILD, project, { taskId: 1, submissionId: 1, now });

  assert.equal(first.created, true);
  assert.equal(second.created, true);
  assert.equal(repeat.created, false, 're-reviewing the same submission says nothing new');
  assert.equal(first.message.digest_key, second.message.digest_key);
});

test('a digest folds the rest of the batch into one message', () => {
  const db = setup();
  const client = makeClient(db);
  const project = makeProject(db, client);
  approvedTemplate(db, { key: 'preview', trigger: TRIGGERS.PREVIEW_READY, body: 'A preview is ready for {{project_name}}.' });

  const now = Date.now();
  const first = messageTriggers.previewReady(db, GUILD, project, { taskId: 1, submissionId: 1, now });
  messageTriggers.previewReady(db, GUILD, project, { taskId: 2, submissionId: 2, now });
  messageTriggers.previewReady(db, GUILD, project, { taskId: 3, submissionId: 3, now });

  const digest = clientMessaging.digestFor(db, GUILD, first.message);
  assert.equal(digest.merged.length, 2);
  assert.match(digest.body, /covers 3 items/);
});

// ---------------------------------------------------------------------------
// The guard rails
// ---------------------------------------------------------------------------

test('promotional messages need an opt-in', () => {
  const db = setup();
  const client = makeClient(db);
  const project = makeProject(db, client);
  approvedTemplate(db, { key: 'repeat', trigger: TRIGGERS.REPEAT_ORDER, kind: KINDS.PROMOTIONAL, body: 'Hello {{client_name}}.' });

  const refused = clientMessaging.queueForTrigger(db, GUILD, TRIGGERS.REPEAT_ORDER, { project, dedupeSuffix: 'a' });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, clientMessaging.BLOCKED.NOT_OPTED_IN);

  clientsRepo.updateClient(db, GUILD, client.id, { promo_opt_in: 1 }, OWNER);
  assert.equal(clientMessaging.queueForTrigger(db, GUILD, TRIGGERS.REPEAT_ORDER, { project, dedupeSuffix: 'b' }).created, true);
});

test('a client who asked to stop is never sent promotional messages again', () => {
  const db = setup();
  const client = makeClient(db, {});
  const project = makeProject(db, client);
  approvedTemplate(db, { key: 'repeat', trigger: TRIGGERS.REPEAT_ORDER, kind: KINDS.PROMOTIONAL, body: 'Hello {{client_name}}.' });

  clientsRepo.updateClient(db, GUILD, client.id, { promo_opt_in: 1, promo_stopped_at: Date.now() }, OWNER);

  const refused = clientMessaging.queueForTrigger(db, GUILD, TRIGGERS.REPEAT_ORDER, { project, dedupeSuffix: 'a' });
  assert.equal(refused.reason, clientMessaging.BLOCKED.STOPPED,
    'having stopped beats an opt-in that is still on the record');
});

test('the promotional send limit counts what actually reached them', () => {
  const db = setup();
  const client = makeClient(db);
  clientsRepo.updateClient(db, GUILD, client.id, { promo_opt_in: 1 }, OWNER);
  const project = makeProject(db, client);
  approvedTemplate(db, { key: 'repeat', trigger: TRIGGERS.REPEAT_ORDER, kind: KINDS.PROMOTIONAL, body: 'Hello {{client_name}}.' });

  const queued = clientMessaging.queueForTrigger(db, GUILD, TRIGGERS.REPEAT_ORDER, { project, dedupeSuffix: 'one' });
  assert.equal(queued.created, true, 'queued messages do not count — only sent ones do');

  messagingRepo.markSent(db, queued.message.id, { channelId: 'channel-1', messageId: 'm1' });

  const refused = clientMessaging.queueForTrigger(db, GUILD, TRIGGERS.REPEAT_ORDER, { project, dedupeSuffix: 'two' });
  assert.equal(refused.reason, clientMessaging.BLOCKED.SEND_LIMIT);
});

test('an unresolved problem stops automated messages, transactional ones included', () => {
  const db = setup();
  const client = makeClient(db);
  const project = makeProject(db, client);
  approvedTemplate(db);

  clientsRepo.createRequest(db, GUILD, {
    clientId: client.id, projectId: project.id, kind: 'delivery_issue',
    body: 'The files do not open.', raisedBy: CLIENT_USER,
  });

  const refused = messageTriggers.orderConfirmed(db, GUILD, project);
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, clientMessaging.BLOCKED.OPEN_ISSUE);
});

test('a client writing in pauses the automation until somebody answers', () => {
  const db = setup();
  const client = makeClient(db);
  const project = makeProject(db, client);
  approvedTemplate(db);

  clientMessaging.recordClientReply(db, GUILD, {
    project, client, userId: CLIENT_USER, channelId: 'channel-1', messageId: 'm-1',
    content: 'Two of these still look wrong to me.',
  });

  assert.equal(messageTriggers.orderConfirmed(db, GUILD, project).reason, clientMessaging.BLOCKED.UNHANDLED_REPLY);

  const [reply] = messagingRepo.openReplies(db, GUILD);
  messagingRepo.markReplyHandled(db, GUILD, reply.id, OWNER);

  assert.equal(messageTriggers.orderConfirmed(db, GUILD, project).created, true, 'it resumes once a person has dealt with it');
});

test('a client writing in cancels promotional messages already queued', () => {
  const db = setup();
  const client = makeClient(db);
  clientsRepo.updateClient(db, GUILD, client.id, { promo_opt_in: 1 }, OWNER);
  const project = makeProject(db, client);
  approvedTemplate(db, { key: 'repeat', trigger: TRIGGERS.REPEAT_ORDER, kind: KINDS.PROMOTIONAL, body: 'Hello {{client_name}}.' });

  const queued = clientMessaging.queueForTrigger(db, GUILD, TRIGGERS.REPEAT_ORDER, { project, dedupeSuffix: 'a' });
  const result = clientMessaging.recordClientReply(db, GUILD, {
    project, client, userId: CLIENT_USER, channelId: 'channel-1', messageId: 'm-1', content: 'Hello?',
  });

  assert.equal(result.cancelledPromotional, 1);
  assert.equal(messagingRepo.getMessage(db, GUILD, queued.message.id).status, 'cancelled');
});

test('the same client message recorded twice is one reply', () => {
  const db = setup();
  const client = makeClient(db);
  const project = makeProject(db, client);

  clientMessaging.recordClientReply(db, GUILD, {
    project, client, userId: CLIENT_USER, channelId: 'channel-1', messageId: 'm-1', content: 'Hi',
  });
  clientMessaging.recordClientReply(db, GUILD, {
    project, client, userId: CLIENT_USER, channelId: 'channel-1', messageId: 'm-1', content: 'Hi',
  });

  assert.equal(messagingRepo.openReplies(db, GUILD).length, 1);
});

test('an explicit pause holds everything until it lapses', () => {
  const db = setup();
  const client = makeClient(db);
  const project = makeProject(db, client);
  approvedTemplate(db);

  messagingRepo.setPrefs(db, GUILD, client.id, {
    pausedUntil: Date.now() + 60_000, pausedReason: 'They are on holiday',
  }, OWNER);
  assert.equal(messageTriggers.orderConfirmed(db, GUILD, project).reason, clientMessaging.BLOCKED.PAUSED);

  messagingRepo.setPrefs(db, GUILD, client.id, { pausedUntil: Date.now() - 1000 }, OWNER);
  assert.equal(messageTriggers.orderConfirmed(db, GUILD, project).created, true);
});

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

function fakeDiscord(sent) {
  return {
    channels: {
      cache: new Map(),
      fetch: async (id) => ({
        id,
        send: async (payload) => {
          sent.push({ channelId: id, content: payload.content });
          return { id: `posted-${sent.length}` };
        },
      }),
    },
  };
}

test('sending posts once and records what was posted', async () => {
  const db = setup();
  const client = makeClient(db);
  const project = makeProject(db, client);
  approvedTemplate(db);
  messageTriggers.orderConfirmed(db, GUILD, project);

  const sent = [];
  const result = await clientMessaging.processQueue(fakeDiscord(sent), db, GUILD);

  assert.equal(result.sent, 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0].content, /Acme Games/);
  assert.equal(sent[0].channelId, 'channel-1');

  const [row] = messagingRepo.history(db, GUILD, { clientId: client.id });
  assert.equal(row.status, 'sent');
  assert.equal(row.message_id, 'posted-1');
});

test('a batch goes out as one message and every item is recorded as sent', async () => {
  const db = setup();
  const client = makeClient(db);
  const project = makeProject(db, client);
  approvedTemplate(db, { key: 'preview', trigger: TRIGGERS.PREVIEW_READY, body: 'A preview is ready for {{project_name}}.' });

  const now = Date.now();
  for (const n of [1, 2, 3]) {
    messageTriggers.previewReady(db, GUILD, project, { taskId: n, submissionId: n, now });
  }

  const sent = [];
  // Due only after the digest hold, which is what lets the batch gather.
  const later = now + clientMessaging.DEFAULT_DIGEST_MINUTES * 60 * 1000 + 1;
  const result = await clientMessaging.processQueue(fakeDiscord(sent), db, GUILD, { now: later });

  assert.equal(sent.length, 1, 'three items, one message');
  assert.match(sent[0].content, /covers 3 items/);
  assert.equal(result.sent + result.merged, 3);
  assert.equal(messagingRepo.history(db, GUILD, { clientId: client.id, status: 'sent' }).length, 3);
});

test('a guard that becomes true after queueing still stops the send', async () => {
  const db = setup();
  const client = makeClient(db);
  const project = makeProject(db, client);
  approvedTemplate(db);
  messageTriggers.orderConfirmed(db, GUILD, project);

  // The client complains between the message being queued and being due.
  clientsRepo.createRequest(db, GUILD, {
    clientId: client.id, projectId: project.id, kind: 'delivery_issue',
    body: 'Something is wrong.', raisedBy: CLIENT_USER,
  });

  const sent = [];
  const result = await clientMessaging.processQueue(fakeDiscord(sent), db, GUILD);

  assert.equal(sent.length, 0);
  assert.equal(result.blocked, 1);
  assert.equal(messagingRepo.history(db, GUILD, { clientId: client.id })[0].status, 'blocked');
});

test('a project with no client channel is held back rather than failing silently', async () => {
  const db = setup();
  const client = makeClient(db);
  const project = projectsRepo.createProject(db, GUILD, { name: 'No channel' }, OWNER);
  clientsRepo.linkProject(db, GUILD, project.id, client.id, OWNER, {});
  approvedTemplate(db);

  messageTriggers.orderConfirmed(db, GUILD, projectsRepo.getProject(db, GUILD, project.id));

  const sent = [];
  const result = await clientMessaging.processQueue(fakeDiscord(sent), db, GUILD);

  assert.equal(result.blocked, 1);
  assert.match(messagingRepo.history(db, GUILD, { clientId: client.id })[0].blocked_reason, /client channel/);
});

test('a failed send is recorded as failed, not quietly dropped', async () => {
  const db = setup();
  const client = makeClient(db);
  const project = makeProject(db, client);
  approvedTemplate(db);
  messageTriggers.orderConfirmed(db, GUILD, project);

  const brokenDiscord = {
    channels: { cache: new Map(), fetch: async () => ({ send: async () => { throw new Error('missing permissions'); } }) },
  };

  const result = await clientMessaging.processQueue(brokenDiscord, db, GUILD);
  assert.equal(result.failed, 1);

  const [row] = messagingRepo.history(db, GUILD, { clientId: client.id });
  assert.equal(row.status, 'failed');
  assert.match(row.failure_reason, /missing permissions/);
});

// ---------------------------------------------------------------------------
// Follow-up sweeps
// ---------------------------------------------------------------------------

test('a client is chased only after the silence, and only once a week', () => {
  const db = setup();
  const client = makeClient(db);
  const project = makeProject(db, client);
  approvedTemplate(db, {
    key: 'chase', trigger: TRIGGERS.AWAITING_CLIENT_CHASE,
    body: '{{client_name}}, {{items_awaiting_you}} item(s) are waiting on you.',
  });

  const task = tasksRepo.createTask(db, GUILD, {
    projectId: project.id, title: 'Crate',
    departmentId: configRepo.getDepartmentByKey(db, GUILD, 'modelling').id,
  }, OWNER);
  db.prepare("UPDATE tasks SET state = 'awaiting_client', updated_at = ? WHERE id = ?")
    .run(Date.now() - 1 * messageTriggers.DAY_MS, task.id);

  assert.equal(messageTriggers.chaseSilentClients(db, GUILD).length, 0, 'one day is not silence');

  db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?')
    .run(Date.now() - 5 * messageTriggers.DAY_MS, task.id);

  assert.equal(messageTriggers.chaseSilentClients(db, GUILD).length, 1);
  assert.equal(messageTriggers.chaseSilentClients(db, GUILD).length, 0, 'not again the same week');
});

test('the daily sweep only queues, and sends nothing by itself', () => {
  const db = setup();
  const client = makeClient(db);
  makeProject(db, client);
  approvedTemplate(db);

  const result = messageTriggers.sweep(db, GUILD);
  assert.deepEqual(Object.keys(result).sort(), ['chases', 'checkIns', 'repeats', 'reviews']);
  assert.equal(messagingRepo.history(db, GUILD, { status: 'sent' }).length, 0);
});
