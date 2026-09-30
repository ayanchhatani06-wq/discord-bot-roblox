const test = require('node:test');
const assert = require('node:assert/strict');

const { openDatabase } = require('../src/db');
const configRepo = require('../src/db/repos/config');
const enquiriesRepo = require('../src/db/repos/enquiries');
const enquiryAlerts = require('../src/services/enquiryAlerts');

const GUILD = 'guild-1';
const OWNER = 'owner-1';

function setup() {
  const db = openDatabase({ file: ':memory:' });
  configRepo.ensureConfig(db, GUILD);
  configRepo.updateConfig(db, GUILD, { owner_user_id: OWNER }, OWNER);
  return db;
}

function webEnquiry(db, request = 'A lobby, stylised, 2 weeks') {
  return enquiriesRepo.createEnquiry(db, GUILD, {
    source: 'web', serviceRequest: request, contactRef: 'someone@example.invalid',
  }, null);
}

/** A Discord channel, enough of one for this. */
function fakeChannel({ canPost = true, fails = false } = {}) {
  const sent = [];
  return {
    id: 'channel-1',
    sent,
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => canPost }),
    send: async (body) => {
      if (fails) return null;
      sent.push(body);
      return { id: `message-${sent.length}` };
    },
  };
}

function fakeClient(channel) {
  return {
    user: { id: 'bot-1' },
    guilds: {
      cache: new Map([[GUILD, {
        channels: { cache: new Map([['channel-1', channel]]), fetch: async () => channel },
      }]]),
      fetch: async () => null,
    },
  };
}

test('a website quote request is waiting to be announced', () => {
  const db = setup();
  webEnquiry(db);
  assert.equal(enquiryAlerts.pending(db, GUILD).length, 1);
  db.close();
});

test('it is announced once, and then not again', async () => {
  const db = setup();
  configRepo.updateConfig(db, GUILD, { enquiry_channel_id: 'channel-1' }, OWNER);
  webEnquiry(db);

  const channel = fakeChannel();
  const first = await enquiryAlerts.announcePending(fakeClient(channel), db, GUILD);
  assert.equal(first.posted, 1);
  assert.equal(channel.sent.length, 1);

  const second = await enquiryAlerts.announcePending(fakeClient(channel), db, GUILD);
  assert.equal(second.posted, 0, 'a restart must not re-announce a week of enquiries');
  assert.equal(channel.sent.length, 1);
  db.close();
});

test('with no channel set they are kept, not lost', async () => {
  const db = setup();
  webEnquiry(db);

  const result = await enquiryAlerts.announcePending(fakeClient(fakeChannel()), db, GUILD);
  assert.equal(result.posted, 0);
  assert.equal(result.reason, 'no_channel');
  assert.equal(
    enquiryAlerts.pending(db, GUILD).length, 1,
    'still waiting, so they are announced once a channel is set rather than lost because none was'
  );
  db.close();
});

test('a message that does not send is not marked as announced', async () => {
  const db = setup();
  configRepo.updateConfig(db, GUILD, { enquiry_channel_id: 'channel-1' }, OWNER);
  webEnquiry(db);

  const result = await enquiryAlerts.announcePending(fakeClient(fakeChannel({ fails: true })), db, GUILD);
  assert.equal(result.posted, 0);
  assert.equal(
    enquiryAlerts.pending(db, GUILD).length, 1,
    'marked-but-never-posted is worse than posted twice: one is noise, the other is a client nobody answers'
  );
  db.close();
});

test('it says so rather than failing silently when it cannot post', async () => {
  const db = setup();
  configRepo.updateConfig(db, GUILD, { enquiry_channel_id: 'channel-1' }, OWNER);
  webEnquiry(db);

  const result = await enquiryAlerts.announcePending(fakeClient(fakeChannel({ canPost: false })), db, GUILD);
  assert.equal(result.reason, 'no_permission');
  assert.equal(enquiryAlerts.pending(db, GUILD).length, 1);
  db.close();
});

test('several waiting are all announced, oldest first', async () => {
  const db = setup();
  configRepo.updateConfig(db, GUILD, { enquiry_channel_id: 'channel-1' }, OWNER);
  const first = webEnquiry(db, 'First in');
  const second = webEnquiry(db, 'Second in');

  const channel = fakeChannel();
  const result = await enquiryAlerts.announcePending(fakeClient(channel), db, GUILD);

  assert.equal(result.posted, 2);
  assert.equal(channel.sent[0].embeds[0].toJSON().title, `New quote request · ${first.code}`);
  assert.equal(channel.sent[1].embeds[0].toJSON().title, `New quote request · ${second.code}`);
  db.close();
});

test('the message carries what you need to answer it', () => {
  const db = setup();
  const enquiry = webEnquiry(db, 'A lobby, stylised');
  const embed = enquiryAlerts.embedFor(enquiry).toJSON();

  assert.ok(embed.description.includes('A lobby, stylised'));
  assert.ok(embed.fields.some((field) => field.value.includes(`/quotes view code:${enquiry.code}`)),
    'says what to run next');
  assert.ok(embed.footer.text.includes('website'));
  db.close();
});
