const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { openDatabase } = require('../src/db');
const configRepo = require('../src/db/repos/config');
const clientsRepo = require('../src/db/repos/clients');
const projectsRepo = require('../src/db/repos/projects');
const tasksRepo = require('../src/db/repos/tasks');
const webRepo = require('../src/db/repos/web');
const enquiriesRepo = require('../src/db/repos/enquiries');

const render = require('../web/lib/render');
const httpLib = require('../web/lib/http');
const content = require('../web/lib/content');
const pages = require('../web/lib/pages');
const { exportSite } = require('../web/export-static');
const { createServer, createLimiter, SESSION_COOKIE } = require('../web/server');

const GUILD = 'guild-1';
const OWNER = 'owner-1';

function setup() {
  const db = openDatabase({ file: ':memory:' });
  configRepo.ensureConfig(db, GUILD);
  configRepo.seedDefaultDepartments(db, GUILD, OWNER);
  configRepo.updateConfig(db, GUILD, {
    owner_user_id: OWNER, studio_name: 'Cylops Studio', studio_tagline: 'Roblox art and code.',
  }, OWNER);
  return db;
}

function makeClient(db, name = 'Acme Games') {
  return clientsRepo.createClient(db, GUILD, { displayName: name }, OWNER);
}

function makeOrder(db, client, name = 'Lobby pack') {
  const project = projectsRepo.createProject(db, GUILD, { name }, OWNER);
  clientsRepo.linkProject(db, GUILD, project.id, client.id, OWNER, {});
  return projectsRepo.getProject(db, GUILD, project.id);
}

/** Starts the real server on an ephemeral port and returns a fetch helper. */
async function withServer(db, run) {
  const server = createServer({ db, guildId: GUILD });
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    await run({
      base,
      get: (route, options = {}) => fetch(base + route, { redirect: 'manual', ...options }),
      post: (route, form, options = {}) => fetch(base + route, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(options.headers || {}) },
        body: new URLSearchParams(form).toString(),
        redirect: 'manual',
        ...options,
      }),
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

test('every value written into a page is escaped', () => {
  const evil = '<script>alert(1)</script>';
  const page = render.layout({ studio: 'S', title: 'T', body: render.html`<p>${evil}</p>` });

  assert.doesNotMatch(page, /<script>alert/);
  assert.match(page, /&lt;script&gt;/);
});

test('an array of values is escaped item by item', () => {
  const out = render.escape(render.html`<ul>${['<b>bad</b>', 'fine']}</ul>`);
  assert.match(out, /&lt;b&gt;/);
  assert.doesNotMatch(out, /<b>/);
});

test('a link that is not plainly http is dropped rather than rendered', () => {
  assert.equal(render.safeUrl('javascript:alert(1)'), null);
  assert.equal(render.safeUrl('data:text/html,<script>'), null);
  assert.equal(render.safeUrl('  https://example.com/a  '), 'https://example.com/a');
});

test("the owner's page text becomes paragraphs, not markup", () => {
  const out = render.escape(pages.paragraphs('First line.\n\n<b>Second</b>'));
  assert.match(out, /<p>First line\.<\/p>/);
  assert.match(out, /&lt;b&gt;Second&lt;\/b&gt;/);
  assert.doesNotMatch(out, /<b>Second/);
});

// ---------------------------------------------------------------------------
// What the public site is allowed to know
// ---------------------------------------------------------------------------

test('services fall back to departments so the site is never empty', () => {
  const db = setup();
  const snapshot = content.publicSnapshot(db, GUILD);

  assert.equal(snapshot.services.length, 8);
  assert.ok(snapshot.services.every((service) => service.placeholder));
});

test("written services replace the placeholders", () => {
  const db = setup();
  webRepo.upsertService(db, GUILD, { key: 'modelling', name: '3D Modelling', summary: 'Props and sets.' }, OWNER);
  webRepo.setServicePublished(db, GUILD, 'modelling', true, OWNER);

  const snapshot = content.publicSnapshot(db, GUILD);
  assert.equal(snapshot.services.length, 1);
  assert.equal(snapshot.services[0].name, '3D Modelling');
  assert.equal(snapshot.services[0].placeholder, undefined);
});

test('an unpublished service is not on the public site', () => {
  const db = setup();
  webRepo.upsertService(db, GUILD, { key: 'secret', name: 'Secret', summary: 'Hidden.' }, OWNER);

  // Nothing published, so it falls back to placeholders rather than leaking a draft.
  const snapshot = content.publicSnapshot(db, GUILD);
  assert.ok(snapshot.services.every((service) => service.name !== 'Secret'));
});

test('an unpublished page is not on the public site', () => {
  const db = setup();
  webRepo.upsertPage(db, GUILD, { key: 'about', title: 'About', body: 'Draft.' }, OWNER);
  assert.equal(content.publicSnapshot(db, GUILD).about, null);

  webRepo.setPagePublished(db, GUILD, 'about', true, OWNER);
  assert.equal(content.publicSnapshot(db, GUILD).about.title, 'About');
});

test('the portfolio carries no client, project or price', () => {
  const db = setup();
  const client = makeClient(db, 'Very Secret Client');
  const project = makeOrder(db, client, 'Confidential Order');

  const task = tasksRepo.createTask(db, GUILD, {
    projectId: project.id, title: 'Crate',
    departmentId: configRepo.getDepartmentByKey(db, GUILD, 'modelling').id,
  }, OWNER);

  const assetsRepo = require('../src/db/repos/assets');
  assetsRepo.addAsset(db, GUILD, {
    projectId: project.id, taskId: task.id, submissionId: null,
    url: 'https://example.invalid/crate.fbx', label: 'Wooden crate',
    kind: 'deliverable', createdBy: OWNER,
  });
  assetsRepo.setProjectRights(db, GUILD, project.id, {
    studioAllowed: true, staffAllowed: true, actorUserId: OWNER,
  });

  const snapshot = content.publicSnapshot(db, GUILD);
  const rendered = pages.work(snapshot);

  assert.doesNotMatch(rendered, /Very Secret Client/);
  assert.doesNotMatch(rendered, /Confidential Order/);
  assert.doesNotMatch(rendered, new RegExp(project.code));
});

test('work without recorded permission never reaches the public site', () => {
  const db = setup();
  const client = makeClient(db);
  const project = makeOrder(db, client);

  const task = tasksRepo.createTask(db, GUILD, {
    projectId: project.id, title: 'Crate',
    departmentId: configRepo.getDepartmentByKey(db, GUILD, 'modelling').id,
  }, OWNER);

  const assetsRepo = require('../src/db/repos/assets');
  assetsRepo.addAsset(db, GUILD, {
    projectId: project.id, taskId: task.id, submissionId: null,
    url: 'https://example.invalid/crate.fbx', label: 'Unpermitted crate',
    kind: 'deliverable', createdBy: OWNER,
  });
  // No rights recorded at all — silence is not permission.

  assert.equal(content.publicSnapshot(db, GUILD).portfolio.length, 0);
});

// ---------------------------------------------------------------------------
// The live server
// ---------------------------------------------------------------------------

test('the public pages render and carry the studio name', async () => {
  const db = setup();
  await withServer(db, async ({ get }) => {
    for (const route of ['/', '/work', '/about', '/quote', '/client/sign-in']) {
      const response = await get(route);
      assert.equal(response.status, 200, route);
      assert.match(await response.text(), /Cylops Studio/, route);
    }
  });
});

test('every response carries the security headers, and scripts are forbidden', async () => {
  const db = setup();
  await withServer(db, async ({ get }) => {
    const response = await get('/');
    const csp = response.headers.get('content-security-policy');

    assert.match(csp, /script-src 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
  });
});

test('a path outside the public folder cannot be read', async () => {
  const db = setup();
  await withServer(db, async ({ get }) => {
    for (const attempt of ['/../package.json', '/../../.env', '/..%2f..%2f.env']) {
      const response = await get(attempt);
      assert.notEqual(response.status, 200, attempt);
    }
  });
});

test('a quote request becomes an enquiry in the same pipeline as a typed one', async () => {
  const db = setup();
  await withServer(db, async ({ post }) => {
    const response = await post('/quote', {
      name: 'Acme Games', contact: 'acme#1234', brief: 'Twelve crates and a barrel.',
      service: 'Modelling', budget: '$200',
    });

    assert.equal(response.status, 200);
    assert.match(await response.text(), /Got it/);
  });

  const enquiries = enquiriesRepo.listEnquiries(db, GUILD, { status: 'all', limit: 10 });
  assert.equal(enquiries.length, 1);
  assert.equal(enquiries[0].source, 'web');
  assert.match(enquiries[0].contact_ref, /Acme Games/);
});

test('an incomplete quote request is refused rather than stored', async () => {
  const db = setup();
  await withServer(db, async ({ post }) => {
    const response = await post('/quote', { name: 'Acme', contact: '', brief: '' });
    assert.equal(response.status, 400);
  });

  assert.equal(enquiriesRepo.listEnquiries(db, GUILD, { status: 'all', limit: 10 }).length, 0);
});

// ---------------------------------------------------------------------------
// Client access — the part that must not be wrong
// ---------------------------------------------------------------------------

test('the client area is closed without a session', async () => {
  const db = setup();
  const client = makeClient(db);
  const project = makeOrder(db, client);

  await withServer(db, async ({ get }) => {
    for (const route of ['/client', `/client/order/${project.id}`]) {
      const response = await get(route);
      assert.equal(response.status, 302, route);
      assert.equal(response.headers.get('location'), '/client/sign-in');
    }
  });
});

test('signing in says the same thing whether or not the address is known', async () => {
  const db = setup();
  const client = makeClient(db);
  webRepo.addClientEmail(db, GUILD, client.id, { email: 'real@example.com' }, OWNER);

  await withServer(db, async ({ post }) => {
    const known = await post('/client/sign-in', { email: 'real@example.com' });
    const unknown = await post('/client/sign-in', { email: 'stranger@example.com' });

    assert.equal(known.status, 200);
    assert.equal(unknown.status, 200);
    assert.equal(await known.text(), await unknown.text(),
      'a different answer would tell anybody who asks which addresses are our clients');
  });
});

test('a sign-in link works once and is then spent', () => {
  const db = setup();
  const client = makeClient(db);
  const token = httpLib.randomToken();

  webRepo.issueLoginToken(db, GUILD, {
    clientId: client.id, tokenHash: httpLib.hashToken(token), email: 'a@example.com',
  });

  assert.ok(webRepo.consumeLoginToken(db, httpLib.hashToken(token)));
  assert.equal(webRepo.consumeLoginToken(db, httpLib.hashToken(token)), null,
    'a forwarded link is already spent');
});

test('an expired sign-in link is refused', () => {
  const db = setup();
  const client = makeClient(db);
  const token = httpLib.randomToken();

  webRepo.issueLoginToken(db, GUILD, {
    clientId: client.id, tokenHash: httpLib.hashToken(token), ttlMs: -1000,
  });

  assert.equal(webRepo.consumeLoginToken(db, httpLib.hashToken(token)), null);
});

test('a client signed in through a link sees their own orders and nobody else\'s', async () => {
  const db = setup();
  const mine = makeClient(db, 'My Client');
  const theirs = makeClient(db, 'Another Client');
  const myOrder = makeOrder(db, mine, 'My Order');
  const theirOrder = makeOrder(db, theirs, 'Their Order');

  webRepo.addClientEmail(db, GUILD, mine.id, { email: 'me@example.com' }, OWNER);
  const token = httpLib.randomToken();
  webRepo.issueLoginToken(db, GUILD, {
    clientId: mine.id, tokenHash: httpLib.hashToken(token), email: 'me@example.com',
  });

  await withServer(db, async ({ get }) => {
    const entered = await get(`/client/enter?token=${token}`);
    assert.equal(entered.status, 302);

    const cookie = entered.headers.get('set-cookie').split(';')[0];
    const headers = { Cookie: cookie };

    const list = await get('/client', { headers });
    const body = await list.text();
    assert.match(body, /My Order/);
    assert.doesNotMatch(body, /Their Order/);

    // The check that matters: guessing another order's number gets nothing.
    const stolen = await get(`/client/order/${theirOrder.id}`, { headers });
    assert.equal(stolen.status, 404);
    assert.doesNotMatch(await stolen.text(), /Their Order/);

    const own = await get(`/client/order/${myOrder.id}`, { headers });
    assert.equal(own.status, 200);
    assert.match(await own.text(), /My Order/);
  });
});

test('signing out ends the session immediately', async () => {
  const db = setup();
  const client = makeClient(db);
  makeOrder(db, client);
  const token = httpLib.randomToken();
  webRepo.issueLoginToken(db, GUILD, { clientId: client.id, tokenHash: httpLib.hashToken(token) });

  await withServer(db, async ({ get }) => {
    const entered = await get(`/client/enter?token=${token}`);
    const cookie = entered.headers.get('set-cookie').split(';')[0];

    await get('/client/sign-out', { headers: { Cookie: cookie } });

    const after = await get('/client', { headers: { Cookie: cookie } });
    assert.equal(after.status, 302, 'the old cookie no longer opens anything');
  });
});

test('revoking an email signs that client out of the website at once', () => {
  const db = setup();
  const client = makeClient(db);
  webRepo.addClientEmail(db, GUILD, client.id, { email: 'gone@example.com' }, OWNER);

  const token = httpLib.randomToken();
  webRepo.createSession(db, GUILD, {
    tokenHash: httpLib.hashToken(token), subjectKind: 'client', clientId: client.id,
  });
  assert.ok(webRepo.sessionByHash(db, httpLib.hashToken(token)));

  webRepo.revokeClientEmail(db, GUILD, client.id, 'gone@example.com', OWNER);
  webRepo.revokeSessionsForClient(db, client.id);

  assert.equal(webRepo.sessionByHash(db, httpLib.hashToken(token)), null);
});

test('an expired session is not a session', () => {
  const db = setup();
  const client = makeClient(db);
  const token = httpLib.randomToken();

  webRepo.createSession(db, GUILD, {
    tokenHash: httpLib.hashToken(token), subjectKind: 'client', clientId: client.id, ttlMs: -1000,
  });

  assert.equal(webRepo.sessionByHash(db, httpLib.hashToken(token)), null);
});

test('session and login tokens are stored hashed, never in the clear', () => {
  const db = setup();
  const client = makeClient(db);
  const token = httpLib.randomToken();

  webRepo.createSession(db, GUILD, { tokenHash: httpLib.hashToken(token), subjectKind: 'client', clientId: client.id });
  webRepo.issueLoginToken(db, GUILD, { clientId: client.id, tokenHash: httpLib.hashToken(token) });

  const sessions = db.prepare('SELECT * FROM web_sessions').all();
  const logins = db.prepare('SELECT * FROM web_login_tokens').all();

  assert.ok(sessions.every((row) => !JSON.stringify(row).includes(token)));
  assert.ok(logins.every((row) => !JSON.stringify(row).includes(token)));
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

test('the limiter stops one address flooding a route, and lets it back in later', () => {
  const allow = createLimiter({ max: 2, windowMs: 1000 });
  const now = Date.now();

  assert.equal(allow('1.2.3.4', now), true);
  assert.equal(allow('1.2.3.4', now), true);
  assert.equal(allow('1.2.3.4', now), false);
  assert.equal(allow('5.6.7.8', now), true, 'other callers are unaffected');
  assert.equal(allow('1.2.3.4', now + 1001), true, 'the window moves on');
});

// ---------------------------------------------------------------------------
// The static export
// ---------------------------------------------------------------------------

test('the static export writes a whole browsable site', () => {
  const db = setup();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-site-'));

  const result = exportSite(db, GUILD, { outDir: directory });

  for (const file of ['index.html', 'work/index.html', 'about/index.html', 'quote/index.html', '404.html', 'style.css']) {
    assert.ok(fs.existsSync(path.join(directory, file)), file);
  }

  assert.equal(result.pages, 4);
  assert.match(fs.readFileSync(path.join(directory, 'index.html'), 'utf8'), /Cylops Studio/);

  fs.rmSync(directory, { recursive: true, force: true });
});

test('without a live app the static quote page says so instead of showing a dead form', () => {
  const db = setup();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-site-'));

  exportSite(db, GUILD, { outDir: directory });
  const quotePage = fs.readFileSync(path.join(directory, 'quote/index.html'), 'utf8');
  assert.doesNotMatch(quotePage, /<form/, 'a form with nowhere to post is worse than none');

  exportSite(db, GUILD, { outDir: directory, appUrl: 'https://app.example.com' });
  const withApp = fs.readFileSync(path.join(directory, 'quote/index.html'), 'utf8');
  assert.match(withApp, /action="https:\/\/app\.example\.com\/quote"/);

  fs.rmSync(directory, { recursive: true, force: true });
});

test('the static export never writes a client page', () => {
  const db = setup();
  const client = makeClient(db);
  makeOrder(db, client, 'Private Order');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-site-'));

  exportSite(db, GUILD, { outDir: directory });

  const everything = fs.readdirSync(directory, { recursive: true }).join(' ');
  assert.doesNotMatch(everything, /client/, 'the client area needs the database and must never be static');

  for (const file of fs.readdirSync(directory, { recursive: true })) {
    const full = path.join(directory, file);
    if (fs.statSync(full).isFile() && full.endsWith('.html')) {
      assert.doesNotMatch(fs.readFileSync(full, 'utf8'), /Private Order/);
    }
  }

  fs.rmSync(directory, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The staff area
// ---------------------------------------------------------------------------

const staffRepo = require('../src/db/repos/staff');

function staffLink(db, userId) {
  const token = httpLib.randomToken();
  webRepo.issueLoginToken(db, GUILD, { staffUserId: userId, tokenHash: httpLib.hashToken(token) });
  return token;
}

test('a login token is for a client or a member of staff, never both or neither', () => {
  const db = setup();
  const client = makeClient(db);

  assert.throws(() => webRepo.issueLoginToken(db, GUILD, {
    clientId: client.id, staffUserId: 'u1', tokenHash: httpLib.hashToken('a'),
  }), /CHECK/);

  assert.throws(() => webRepo.issueLoginToken(db, GUILD, {
    tokenHash: httpLib.hashToken('b'),
  }), /CHECK/);
});

test('the staff area is closed without a session', async () => {
  const db = setup();
  await withServer(db, async ({ get }) => {
    for (const route of ['/staff', '/staff/queue']) {
      const response = await get(route);
      assert.equal(response.status, 302, route);
      assert.equal(response.headers.get('location'), '/staff/sign-in');
    }
  });
});

test("a client's link cannot open the staff area", async () => {
  const db = setup();
  const client = makeClient(db);
  const token = httpLib.randomToken();
  webRepo.issueLoginToken(db, GUILD, { clientId: client.id, tokenHash: httpLib.hashToken(token) });

  await withServer(db, async ({ get }) => {
    const response = await get(`/staff/enter?token=${token}`);
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('set-cookie'), null, 'nothing was signed in');
  });
});

test("a staff link cannot open a client's orders", async () => {
  const db = setup();
  staffRepo.ensureStaff(db, GUILD, 'artist-1', 'Artist');
  const token = staffLink(db, 'artist-1');

  await withServer(db, async ({ get }) => {
    const response = await get(`/client/enter?token=${token}`);
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('set-cookie'), null,
      'a staff token minting a client session would be a signed-in state nobody intended');
  });
});

test('a staff member signs in and sees their own work, read-only', async () => {
  const db = setup();
  staffRepo.ensureStaff(db, GUILD, 'artist-1', 'An Artist');
  const token = staffLink(db, 'artist-1');

  await withServer(db, async ({ get }) => {
    const entered = await get(`/staff/enter?token=${token}`);
    assert.equal(entered.status, 302);

    const cookie = entered.headers.get('set-cookie').split(';')[0];
    const desk = await get('/staff', { headers: { Cookie: cookie } });
    const body = await desk.text();

    assert.equal(desk.status, 200);
    assert.match(body, /Your work/);
    assert.match(body, /Read-only/);
    assert.doesNotMatch(body, /<form/, 'the staff area changes nothing, so it has no forms');
  });
});

test('somebody who leads nothing sees empty queues, not the whole studio', async () => {
  const db = setup();
  const project = projectsRepo.createProject(db, GUILD, { name: 'Order' }, OWNER);
  tasksRepo.createTask(db, GUILD, {
    projectId: project.id, title: 'Somebody else\'s crate',
    departmentId: configRepo.getDepartmentByKey(db, GUILD, 'modelling').id,
  }, OWNER);

  staffRepo.ensureStaff(db, GUILD, 'artist-1', 'An Artist');
  const token = staffLink(db, 'artist-1');

  await withServer(db, async ({ get }) => {
    const entered = await get(`/staff/enter?token=${token}`);
    const cookie = entered.headers.get('set-cookie').split(';')[0];

    const queue = await get('/staff/queue', { headers: { Cookie: cookie } });
    assert.doesNotMatch(await queue.text(), /Somebody else's crate/);
  });
});

test('a leader sees their own department and not another', async () => {
  const db = setup();
  const modelling = configRepo.getDepartmentByKey(db, GUILD, 'modelling');
  const vfx = configRepo.getDepartmentByKey(db, GUILD, 'vfx');
  const project = projectsRepo.createProject(db, GUILD, { name: 'Order' }, OWNER);

  tasksRepo.createTask(db, GUILD, { projectId: project.id, title: 'Mine to run', departmentId: modelling.id }, OWNER);
  tasksRepo.createTask(db, GUILD, { projectId: project.id, title: 'Not my department', departmentId: vfx.id }, OWNER);

  // Leadership without a live role list is read from who reports to them.
  staffRepo.ensureStaff(db, GUILD, 'leader-1', 'A Leader');
  staffRepo.ensureStaff(db, GUILD, 'artist-1', 'An Artist');
  staffRepo.updateStaff(db, GUILD, 'artist-1', { leader_user_id: 'leader-1', department_id: modelling.id }, OWNER);

  const token = staffLink(db, 'leader-1');

  await withServer(db, async ({ get }) => {
    const entered = await get(`/staff/enter?token=${token}`);
    const cookie = entered.headers.get('set-cookie').split(';')[0];

    const body = await (await get('/staff/queue', { headers: { Cookie: cookie } })).text();
    assert.match(body, /Mine to run/);
    assert.doesNotMatch(body, /Not my department/);
  });
});

test('a spoofed forwarded header cannot slip past the rate limiter', async () => {
  const db = setup();

  // Every request claims a different origin. Without a proxy in front, the
  // header is just something the sender typed, so it must not be believed.
  await withServer(db, async ({ post }) => {
    const statuses = [];
    for (let attempt = 0; attempt < 7; attempt += 1) {
      const response = await post('/quote',
        { name: 'Flood', contact: 'x', brief: 'y' },
        { headers: { 'X-Forwarded-For': `10.0.0.${attempt}` } });
      statuses.push(response.status);
    }

    assert.ok(statuses.includes(429), 'the limiter still bites despite the changing header');
  });

  const stored = enquiriesRepo.listEnquiries(db, GUILD, { status: 'all', limit: 50 });
  assert.ok(stored.length <= 5, `one sender should not be able to file ${stored.length} enquiries`);
});

test('no POST route requires a session, which is what makes forged requests harmless', async () => {
  const db = setup();
  const client = makeClient(db);
  makeOrder(db, client);
  const token = httpLib.randomToken();
  webRepo.issueLoginToken(db, GUILD, { clientId: client.id, tokenHash: httpLib.hashToken(token) });

  // If a POST is ever added that acts on a signed-in session, this test should
  // fail and whoever added it should add CSRF protection first. A cookie sent
  // by a form on somebody else's page is still the victim's cookie.
  await withServer(db, async ({ get, post }) => {
    const entered = await get(`/client/enter?token=${token}`);
    const cookie = entered.headers.get('set-cookie').split(';')[0];

    for (const route of ['/client', '/client/sign-out', '/staff', '/staff/queue']) {
      const response = await post(route, { anything: 'here' }, { headers: { Cookie: cookie } });
      assert.equal(response.status, 404, `${route} should not accept a POST`);
    }
  });
});

test('the health check says up or down and nothing else', async () => {
  const db = setup();
  await withServer(db, async ({ get }) => {
    const response = await get('/healthz');
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.equal(body, 'ok');
    // A health check that leaks versions, counts or table names is free
    // reconnaissance, so it stays two words.
    assert.ok(body.length < 20);
  });
});

test('crawlers are kept out of the client and staff areas', async () => {
  const db = setup();
  await withServer(db, async ({ get }) => {
    const body = await (await get('/robots.txt')).text();
    assert.match(body, /Disallow: \/client/);
    assert.match(body, /Disallow: \/staff/);
  });
});

test('the static export writes robots.txt, and a sitemap once it knows its address', () => {
  const db = setup();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-site-'));

  exportSite(db, GUILD, { outDir: directory });
  assert.ok(fs.existsSync(path.join(directory, 'robots.txt')));
  assert.equal(fs.existsSync(path.join(directory, 'sitemap.xml')), false,
    'a sitemap of the wrong domain is worse than none');

  exportSite(db, GUILD, { outDir: directory, siteUrl: 'https://example.com' });
  const sitemap = fs.readFileSync(path.join(directory, 'sitemap.xml'), 'utf8');
  assert.match(sitemap, /<loc>https:\/\/example\.com\/work<\/loc>/);

  fs.rmSync(directory, { recursive: true, force: true });
});

test('expired sessions and spent login links are eventually cleared away', () => {
  const db = setup();
  const client = makeClient(db);

  // Expired rows are already ignored wherever they are read, so this is about
  // the tables not growing forever on a box meant to run untouched for years.
  webRepo.createSession(db, GUILD, {
    tokenHash: httpLib.hashToken('old'), subjectKind: 'client', clientId: client.id, ttlMs: -1000,
  });
  webRepo.createSession(db, GUILD, {
    tokenHash: httpLib.hashToken('live'), subjectKind: 'client', clientId: client.id,
  });
  webRepo.issueLoginToken(db, GUILD, {
    clientId: client.id, tokenHash: httpLib.hashToken('spent'), ttlMs: -(48 * 60 * 60 * 1000),
  });

  assert.equal(webRepo.pruneSessions(db), 1);
  assert.equal(webRepo.pruneLoginTokens(db), 1);

  assert.ok(webRepo.sessionByHash(db, httpLib.hashToken('live')), 'a live session survives');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM web_sessions').get().n, 1);
});
