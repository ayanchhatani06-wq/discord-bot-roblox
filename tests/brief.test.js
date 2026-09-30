const test = require('node:test');
const assert = require('node:assert/strict');

const { brief, count, NAMESPACE } = require('../src/utils/brief');
const { registerView, getView, registeredViews } = require('../src/services/detailViews');

function rendered(body) {
  return {
    embeds: body.embeds.map((embed) => embed.toJSON()),
    components: body.components.map((row) => row.toJSON()),
    flags: body.flags,
  };
}

test('a brief answers in one line and keeps the rest behind a button', () => {
  const body = rendered(brief({
    title: 'Who has room',
    headline: '**4** of 7 could take something on.',
    viewId: 'who-is-free',
    args: [7, ''],
    buttonLabel: 'Who exactly',
  }));

  assert.equal(body.embeds[0].title, 'Who has room');
  assert.equal(body.embeds[0].description, '**4** of 7 could take something on.');
  assert.equal(body.components[0].components[0].label, 'Who exactly');
  assert.equal(body.components[0].components[0].custom_id, `${NAMESPACE}:who-is-free:7:`);
  assert.ok(body.flags, 'replies stay private to the caller');
});

test('a brief with nothing more to show has no button', () => {
  const body = rendered(brief({ headline: 'Nothing outstanding.' }));
  assert.equal(body.components.length, 0);
});

test('a colon in an argument cannot become another argument', () => {
  // Discord joins custom id parts with colons, so an argument carrying one
  // would be read as two and the view would get the wrong input.
  const body = rendered(brief({
    headline: 'x', viewId: 'who-is-free', args: ['a:b'],
  }));
  assert.equal(body.components[0].components[0].custom_id, `${NAMESPACE}:who-is-free:a_b`);
});

test('a custom id never exceeds what Discord accepts', () => {
  const body = rendered(brief({
    headline: 'x', viewId: 'who-is-free', args: ['x'.repeat(300)],
  }));
  assert.ok(body.components[0].components[0].custom_id.length <= 100);
});

test('counts read as an answer, including when the answer is none', () => {
  assert.equal(count(0, 'person', 'people'), 'No people');
  assert.equal(count(1, 'person', 'people'), '**1** person');
  assert.equal(count(3, 'person', 'people'), '**3** people');
  assert.equal(count(0, 'payment', 'payments', 'Everything is settled'), 'Everything is settled');
});

test('a view is registered once and found by name', () => {
  registerView('test.view', () => ({ content: 'hello' }));
  assert.equal(typeof getView('test.view'), 'function');
  assert.equal(getView('nope'), null);
  assert.ok(registeredViews().includes('test.view'));

  assert.throws(() => registerView('test.view', () => null), /Duplicate/);
});

test('a view id that would break a custom id is refused', () => {
  assert.throws(() => registerView('Bad Id', () => null), /Bad detail view id/);
  assert.throws(() => registerView('has:colon', () => null), /Bad detail view id/);
});

test('every command that offers a button has the view behind it registered', () => {
  // A button whose view was never registered is a dead end the user only finds
  // by pressing it.
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(__dirname, '..', 'src', 'commands');

  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const source = fs.readFileSync(path.join(dir, file), 'utf8');
    require(path.join(dir, file));
    for (const match of source.matchAll(/viewId:\s*'([a-z0-9.-]+)'/g)) {
      assert.ok(getView(match[1]), `${file} offers view "${match[1]}" but nothing registered it`);
    }
  }
});
