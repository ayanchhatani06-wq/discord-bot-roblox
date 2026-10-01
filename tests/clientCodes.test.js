const test = require('node:test');
const assert = require('node:assert/strict');

const { openDatabase } = require('../src/db');
const configRepo = require('../src/db/repos/config');
const clientsRepo = require('../src/db/repos/clients');
const projectsRepo = require('../src/db/repos/projects');
const webRepo = require('../src/db/repos/web');
const codes = require('../src/services/clientCodes');

const GUILD = 'guild-1';
const OWNER = 'owner-1';

function setup() {
  const db = openDatabase({ file: ':memory:' });
  configRepo.ensureConfig(db, GUILD);
  configRepo.updateConfig(db, GUILD, { owner_user_id: OWNER, studio_name: 'Cylops Studio' }, OWNER);
  return db;
}

function makeClient(db, name = 'Acme Games') {
  return clientsRepo.createClient(db, GUILD, { displayName: name }, OWNER);
}

function makeActiveOrder(db, client, name = 'Lobby pack') {
  const project = projectsRepo.createProject(db, GUILD, { name }, OWNER);
  clientsRepo.linkProject(db, GUILD, project.id, client.id, OWNER, {});
  return project;
}

function withEmail(db, client, email = 'buyer@acme.test') {
  webRepo.addClientEmail(db, GUILD, client.id, { email }, OWNER);
  return email;
}

// ---------------------------------------------------------------- the code itself

test('a code reads back the way it was printed', () => {
  const code = codes.generate('Cylops Studio');
  assert.match(code, /^CYL-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
});

test('a studio with a short name still gets a usable prefix', () => {
  assert.equal(codes.prefixFor('Oy'), 'CLI');
  assert.equal(codes.prefixFor(''), 'CLI');
  assert.equal(codes.prefixFor(null), 'CLI');
  assert.equal(codes.prefixFor('3D Art Co'), 'DAR');
});

test('no character that gets misread is ever used', () => {
  // The whole point of the alphabet: nobody should mistype a code read aloud.
  for (const banned of ['0', '1', 'O', 'I', 'L', 'S', 'U', 'V']) {
    assert.ok(!codes.ALPHABET.includes(banned), `${banned} should not be in the alphabet`);
  }
  for (let i = 0; i < 200; i += 1) {
    const body = codes.normalise(codes.generate('Cylops')).slice(3);
    for (const char of body) assert.ok(codes.ALPHABET.includes(char), `${char} leaked into a code`);
  }
});

test('spacing, case and hyphens do not change which code it is', () => {
  assert.equal(codes.normalise('cyl-7k4p-r2m9'), 'CYL7K4PR2M9');
  assert.equal(codes.normalise('CYL 7K4P R2M9'), 'CYL7K4PR2M9');
  assert.equal(codes.hash('cyl 7k4p r2m9'), codes.hash('CYL-7K4P-R2M9'));
});

test('two codes in a row are not the same', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i += 1) seen.add(codes.generate('Cylops'));
  assert.equal(seen.size, 500);
});

// ---------------------------------------------------------------- issuing

test('the plaintext code is never written to the database', () => {
  const db = setup();
  const client = makeClient(db);
  const { code } = codes.issue(db, GUILD, { clientId: client.id, studioName: 'Cylops Studio', issuedBy: OWNER });

  const row = db.prepare('SELECT * FROM client_access_codes WHERE client_id = ?').get(client.id);
  assert.notEqual(row.code_hash, codes.normalise(code));
  assert.equal(row.code_hash, codes.hash(code));
  // Only the tail is kept, and it cannot be signed in with.
  assert.equal(row.display_hint, codes.normalise(code).slice(-4));
  assert.equal(row.display_hint.length, 4);
});

test('issuing a new code retires the old one', () => {
  const db = setup();
  const client = makeClient(db);
  const first = codes.issue(db, GUILD, { clientId: client.id, issuedBy: OWNER });
  const second = codes.issue(db, GUILD, { clientId: client.id, issuedBy: OWNER });

  assert.equal(codes.verify(db, GUILD, { code: first.code, config: { client_code_require_email: 0 } }).ok, false);
  assert.equal(codes.verify(db, GUILD, { code: second.code, config: { client_code_require_email: 0 } }).ok, true);

  // Exactly one live code per client, always.
  assert.ok(codes.activeFor(db, client.id));
  assert.equal(db.prepare(
    'SELECT COUNT(*) c FROM client_access_codes WHERE client_id = ? AND revoked_at IS NULL'
  ).get(client.id).c, 1);
});

test('a code lasts the number of days the studio set', () => {
  const db = setup();
  const client = makeClient(db);
  const now = Date.now();
  const { expiresAt } = codes.issue(db, GUILD, { clientId: client.id, days: 7, now });
  assert.equal(expiresAt, now + 7 * codes.DAY_MS);

  const fortnight = codes.issue(db, GUILD, { clientId: client.id, days: 14, now });
  assert.equal(fortnight.expiresAt, now + 14 * codes.DAY_MS);
});

test('a nonsense day count falls back to a week rather than expiring instantly', () => {
  const db = setup();
  const client = makeClient(db);
  const now = Date.now();
  for (const bad of [0, -3, null, undefined, 'soon']) {
    const result = codes.issue(db, GUILD, { clientId: client.id, days: bad, now });
    assert.equal(result.expiresAt, now + 7 * codes.DAY_MS, `days: ${bad}`);
  }
});

// ---------------------------------------------------------------- signing in

test('the code alone is not enough when an email is required', () => {
  const db = setup();
  const client = makeClient(db);
  withEmail(db, client);
  const { code } = codes.issue(db, GUILD, { clientId: client.id });

  assert.deepEqual(
    codes.verify(db, GUILD, { code, email: null, config: {} }),
    { ok: false, reason: 'email_required' }
  );
  assert.equal(codes.verify(db, GUILD, { code, email: 'buyer@acme.test', config: {} }).ok, true);
});

test('a real code with somebody else’s email does not sign them in', () => {
  const db = setup();
  const acme = makeClient(db, 'Acme Games');
  const other = makeClient(db, 'Other Studio');
  withEmail(db, acme, 'buyer@acme.test');
  withEmail(db, other, 'someone@other.test');

  const { code } = codes.issue(db, GUILD, { clientId: acme.id });
  assert.deepEqual(
    codes.verify(db, GUILD, { code, email: 'someone@other.test', config: {} }),
    { ok: false, reason: 'email_mismatch' }
  );
});

test('an email the studio revoked stops working immediately', () => {
  const db = setup();
  const client = makeClient(db);
  const email = withEmail(db, client);
  const { code } = codes.issue(db, GUILD, { clientId: client.id });

  assert.equal(codes.verify(db, GUILD, { code, email, config: {} }).ok, true);
  webRepo.revokeClientEmail(db, GUILD, client.id, email, OWNER);
  assert.equal(codes.verify(db, GUILD, { code, email, config: {} }).reason, 'email_mismatch');
});

test('the studio can relax the email requirement', () => {
  const db = setup();
  const client = makeClient(db);
  const { code } = codes.issue(db, GUILD, { clientId: client.id });

  const relaxed = { client_code_require_email: 0 };
  const result = codes.verify(db, GUILD, { code, email: null, config: relaxed });
  assert.equal(result.ok, true);
  assert.equal(result.clientId, client.id);
});

test('an expired code is refused', () => {
  const db = setup();
  const client = makeClient(db);
  const now = Date.now();
  const { code } = codes.issue(db, GUILD, { clientId: client.id, days: 7, now });

  const config = { client_code_require_email: 0 };
  assert.equal(codes.verify(db, GUILD, { code, config, now: now + 6 * codes.DAY_MS }).ok, true);
  assert.deepEqual(
    codes.verify(db, GUILD, { code, config, now: now + 8 * codes.DAY_MS }),
    { ok: false, reason: 'expired' }
  );
});

test('revoking cuts access off at once', () => {
  const db = setup();
  const client = makeClient(db);
  const { code } = codes.issue(db, GUILD, { clientId: client.id });
  const config = { client_code_require_email: 0 };

  assert.equal(codes.verify(db, GUILD, { code, config }).ok, true);
  assert.equal(codes.revokeFor(db, client.id, { by: OWNER }), 1);
  assert.deepEqual(codes.verify(db, GUILD, { code, config }), { ok: false, reason: 'revoked' });
});

test('a code from another server is not accepted here', () => {
  const db = setup();
  configRepo.ensureConfig(db, 'guild-2');
  const client = makeClient(db);
  const { code } = codes.issue(db, GUILD, { clientId: client.id });

  assert.deepEqual(
    codes.verify(db, 'guild-2', { code, config: { client_code_require_email: 0 } }),
    { ok: false, reason: 'unknown' }
  );
});

test('an unknown or empty code is refused without saying why', () => {
  const db = setup();
  assert.deepEqual(codes.verify(db, GUILD, { code: 'CYL-AAAA-BBBB', config: {} }), { ok: false, reason: 'unknown' });
  assert.deepEqual(codes.verify(db, GUILD, { code: '', config: {} }), { ok: false, reason: 'empty' });
  assert.deepEqual(codes.verify(db, GUILD, { code: '   ', config: {} }), { ok: false, reason: 'empty' });
  assert.deepEqual(codes.verify(db, GUILD, { code: null, config: {} }), { ok: false, reason: 'empty' });
});

test('use is recorded, so a shared code is visible after the fact', () => {
  const db = setup();
  const client = makeClient(db);
  const email = withEmail(db, client);
  const { code } = codes.issue(db, GUILD, { clientId: client.id });

  codes.verify(db, GUILD, { code, email, config: {} });
  codes.verify(db, GUILD, { code, email, config: {} });

  const row = codes.activeFor(db, client.id);
  assert.equal(row.use_count, 2);
  assert.ok(row.last_used_at);
});

test('a failed attempt is not counted as a use', () => {
  const db = setup();
  const client = makeClient(db);
  withEmail(db, client);
  const { code } = codes.issue(db, GUILD, { clientId: client.id });

  codes.verify(db, GUILD, { code, email: 'wrong@nope.test', config: {} });
  assert.equal(codes.activeFor(db, client.id).use_count, 0);
});

// ---------------------------------------------------------------- the weekly mint

test('the weekly rotation only covers clients with work in flight', () => {
  const db = setup();
  const busy = makeClient(db, 'Acme Games');
  makeClient(db, 'Dormant Co');
  makeActiveOrder(db, busy);

  const result = codes.rotateWeekly(db, GUILD, { studioName: 'Cylops Studio' });
  assert.equal(result.issued.length, 1);
  assert.equal(result.issued[0].name, 'Acme Games');
});

test('rotating twice in a day does not invalidate a code just sent out', () => {
  const db = setup();
  const client = makeClient(db);
  makeActiveOrder(db, client);
  const now = Date.now();

  const first = codes.rotateWeekly(db, GUILD, { now });
  const again = codes.rotateWeekly(db, GUILD, { now: now + codes.DAY_MS });

  assert.equal(again.issued.length, 0);
  assert.equal(again.kept.length, 1);
  assert.equal(codes.verify(db, GUILD, {
    code: first.issued[0].code, config: { client_code_require_email: 0 }, now: now + codes.DAY_MS,
  }).ok, true);
});

test('a code near the end of its life is replaced on the next rotation', () => {
  const db = setup();
  const client = makeClient(db);
  makeActiveOrder(db, client);
  const now = Date.now();

  codes.rotateWeekly(db, GUILD, { now });
  const later = codes.rotateWeekly(db, GUILD, { now: now + 5 * codes.DAY_MS });
  assert.equal(later.issued.length, 1);
});

test('one client with two orders still gets one code', () => {
  const db = setup();
  const client = makeClient(db);
  makeActiveOrder(db, client, 'Lobby pack');
  makeActiveOrder(db, client, 'Map pack');

  const result = codes.rotateWeekly(db, GUILD);
  assert.equal(result.issued.length, 1);
});

test('housekeeping keeps recent history and drops the rest', () => {
  const db = setup();
  const client = makeClient(db);
  const now = Date.now();
  codes.issue(db, GUILD, { clientId: client.id, days: 7, now: now - 60 * codes.DAY_MS });

  assert.equal(codes.pruneExpired(db, { now, keepMs: 30 * codes.DAY_MS }), 1);
  assert.equal(codes.pruneExpired(db, { now, keepMs: 30 * codes.DAY_MS }), 0);
});

test('settings fall back to the safe reading when nothing is configured', () => {
  assert.deepEqual(codes.settingsFor({}), { requireEmail: true, rotateWeekly: true, days: 7 });
  assert.deepEqual(
    codes.settingsFor({ client_code_require_email: 0, client_code_rotate_weekly: 0, client_code_days: 14 }),
    { requireEmail: false, rotateWeekly: false, days: 14 }
  );
});

// ---------------------------------------------------------------- through the real server

const { createServer, SESSION_COOKIE } = require('../web/server');

/** The real HTTP server on an ephemeral port, same helper the website tests use. */
async function withServer(db, run) {
  const server = createServer({ db, guildId: GUILD });
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run({
      get: (route) => fetch(base + route, { redirect: 'manual' }),
      post: (route, form) => fetch(base + route, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form).toString(),
        redirect: 'manual',
      }),
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('the sign-in page offers the code form', async () => {
  const db = setup();
  await withServer(db, async ({ get }) => {
    const page = await (await get('/client/sign-in')).text();
    assert.match(page, /action="\/client\/code"/);
    assert.match(page, /name="code"/);
  });
});

test('a good code and email signs the client in', async () => {
  const db = setup();
  const client = makeClient(db);
  const email = withEmail(db, client);
  const { code } = codes.issue(db, GUILD, { clientId: client.id, studioName: 'Cylops Studio' });

  await withServer(db, async ({ post }) => {
    const response = await post('/client/code', { code, email });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/client');
    assert.match(response.headers.get('set-cookie') || '', new RegExp(SESSION_COOKIE));
  });
});

test('the code still works when typed in lower case with spaces', async () => {
  const db = setup();
  const client = makeClient(db);
  const email = withEmail(db, client);
  const { code } = codes.issue(db, GUILD, { clientId: client.id });
  const sloppy = code.toLowerCase().replace(/-/g, ' ');

  await withServer(db, async ({ post }) => {
    assert.equal((await post('/client/code', { code: sloppy, email })).status, 302);
  });
});

test('a wrong code and a wrong email are refused identically', async () => {
  const db = setup();
  const client = makeClient(db);
  const email = withEmail(db, client);
  const { code } = codes.issue(db, GUILD, { clientId: client.id });

  await withServer(db, async ({ post }) => {
    const wrongCode = await post('/client/code', { code: 'CYL-AAAA-BBBB', email });
    const wrongEmail = await post('/client/code', { code, email: 'nobody@nowhere.test' });

    assert.equal(wrongCode.status, 401);
    assert.equal(wrongEmail.status, 401);
    // Telling the two apart turns a guessed code into a confirmed one.
    assert.equal(await wrongCode.text(), await wrongEmail.text());
  });
});

test('an expired code does not sign anybody in', async () => {
  const db = setup();
  const client = makeClient(db);
  const email = withEmail(db, client);
  const { code } = codes.issue(db, GUILD, {
    clientId: client.id, days: 7, now: Date.now() - 8 * codes.DAY_MS,
  });

  await withServer(db, async ({ post }) => {
    const response = await post('/client/code', { code, email });
    assert.equal(response.status, 401);
    assert.doesNotMatch(response.headers.get('set-cookie') || '', new RegExp(SESSION_COOKIE));
  });
});

test('guessing at codes is rate limited', async () => {
  const db = setup();
  await withServer(db, async ({ post }) => {
    let limited = false;
    for (let attempt = 0; attempt < 40 && !limited; attempt += 1) {
      const response = await post('/client/code', { code: `CYL-AAAA-${String(attempt).padStart(4, '0')}`, email: 'a@b.test' });
      if (response.status === 429) limited = true;
    }
    assert.ok(limited, 'the code form should stop answering a grinder');
  });
});

// ---------------------------------------------------------------- the fallback refusal

const notify = require('../src/services/notify');

/** A client stub whose DMs always fail, with a fallback channel that records sends. */
function clientWithClosedDms(posted) {
  return {
    users: { fetch: async () => ({ send: async () => null }) },
    guilds: {
      cache: new Map([[GUILD, {
        channels: { cache: new Map([['fallback-1', {
          isTextBased: () => true,
          permissionsFor: () => ({ has: () => true }),
          send: async (body) => { posted.push(body); return {}; },
        }]]) },
        members: { me: {} },
      }]]),
    },
  };
}

test('an ordinary notification still falls back to the staff channel', async () => {
  const db = setup();
  configRepo.updateConfig(db, GUILD, { fallback_channel_id: 'fallback-1' }, OWNER);
  const posted = [];

  const result = await notify.notifyUser(
    clientWithClosedDms(posted), db, GUILD, OWNER, { content: 'Your task is due tomorrow.' }
  );

  assert.equal(result.delivered, true);
  assert.equal(result.via, 'fallback');
  assert.equal(posted.length, 1);
});

test('a message carrying codes is never posted to a channel instead', async () => {
  const db = setup();
  configRepo.updateConfig(db, GUILD, { fallback_channel_id: 'fallback-1' }, OWNER);
  const posted = [];

  const result = await notify.notifyUser(
    clientWithClosedDms(posted), db, GUILD, OWNER,
    { content: 'CYL-7K4P-R2M9' },
    { allowFallback: false }
  );

  assert.equal(result.delivered, false);
  assert.equal(result.reason, 'dms_closed_and_fallback_refused');
  // The whole point: a readable staff channel must not receive a credential.
  assert.deepEqual(posted, []);
});
