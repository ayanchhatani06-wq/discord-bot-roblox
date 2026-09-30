const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const COMMANDS_DIR = path.join(__dirname, '..', 'src', 'commands');
const INTERACTIONS_DIR = path.join(__dirname, '..', 'src', 'interactions');

function commandFiles() {
  return fs.readdirSync(COMMANDS_DIR).filter((file) => file.endsWith('.js'));
}

test('every command builds valid Discord application command JSON', () => {
  const files = commandFiles();
  assert.ok(files.length > 0, 'expected at least one command');

  for (const file of files) {
    const command = require(path.join(COMMANDS_DIR, file));
    assert.ok(command.data, `${file} exports no data`);
    assert.equal(typeof command.execute, 'function', `${file} has no execute`);

    const json = command.data.toJSON();
    assert.match(json.name, /^[a-z0-9_-]{1,32}$/, `${file}: bad command name "${json.name}"`);
    assert.ok(json.description.length > 0 && json.description.length <= 100, `${file}: description length`);

    for (const option of json.options || []) {
      assert.ok(option.description.length <= 100, `${file}: option ${option.name} description too long`);
      assert.match(option.name, /^[a-z0-9_-]{1,32}$/, `${file}: bad option name ${option.name}`);
      for (const child of option.options || []) {
        assert.ok(child.description.length <= 100, `${file}: ${option.name}.${child.name} description too long`);
        assert.match(child.name, /^[a-z0-9_-]{1,32}$/, `${file}: bad option name ${child.name}`);
      }
    }
  }
});

test('command names are unique', () => {
  const names = commandFiles().map((file) => require(path.join(COMMANDS_DIR, file)).data.toJSON().name);
  assert.equal(new Set(names).size, names.length, `duplicate command names in ${names.join(', ')}`);
});

test('commands offering autocomplete implement a handler', () => {
  for (const file of commandFiles()) {
    const command = require(path.join(COMMANDS_DIR, file));
    const json = command.data.toJSON();

    const hasAutocompleteOption = JSON.stringify(json).includes('"autocomplete":true');
    if (hasAutocompleteOption) {
      assert.equal(typeof command.autocomplete, 'function', `${file} declares autocomplete but exports no handler`);
    }
  }
});

test('subcommand counts stay within the Discord limit', () => {
  for (const file of commandFiles()) {
    const json = require(path.join(COMMANDS_DIR, file)).data.toJSON();
    const subcommands = (json.options || []).filter((option) => option.type === 1 || option.type === 2);
    assert.ok(subcommands.length <= 25, `${file} has ${subcommands.length} subcommands`);
  }
});

test('interaction modules register their namespaces exactly once', () => {
  const router = require('../src/interactions/router');

  for (const file of fs.readdirSync(INTERACTIONS_DIR).filter((f) => f.endsWith('.js') && f !== 'router.js')) {
    require(path.join(INTERACTIONS_DIR, file));
  }

  const namespaces = router.registeredNamespaces();
  assert.ok(namespaces.includes('profile'), `expected a profile namespace, got ${namespaces.join(', ')}`);
  assert.equal(new Set(namespaces).size, namespaces.length);

  // Registering the same namespace twice is a programming error, not silently
  // overwritten, so a stale duplicate handler cannot shadow the real one.
  assert.throws(() => router.register('profile', () => {}), /Duplicate interaction namespace/);
});

test('custom ids round-trip through the router helpers', () => {
  const router = require('../src/interactions/router');

  const id = router.customId('offer', 'accept', '42', 'artist-1');
  assert.equal(id, 'offer:accept:42:artist-1');
  assert.deepEqual(router.parse(id), { namespace: 'offer', action: 'accept', args: ['42', 'artist-1'] });
  assert.ok(id.length <= 100, 'Discord custom ids are limited to 100 characters');
});

test('the bot entry point loads without connecting', () => {
  // Requiring index.js would call client.login, so only its dependencies are
  // checked here: a syntax error or bad import in any of them fails this test.
  assert.doesNotThrow(() => {
    require('../src/services/actor');
    require('../src/services/staffBoard');
    require('../src/services/boardScheduler');
    require('../src/services/profileView');
    require('../src/db/repos/config');
    require('../src/db/repos/staff');
    require('../src/db/repos/core');
    require('../src/utils/reply');
  });
});

test('every command has a line in the command reference', () => {
  // The reference is generated, but who may run each command is written by hand
  // in docs/reference/gates.js because it lives in the command bodies. This
  // fails the moment somebody adds a command without saying who it is for,
  // rather than shipping a reference with a blank in that column — which a
  // reader would take to mean "anybody".
  const { readCommands, resolve } = require('../docs/reference/build');
  assert.doesNotThrow(() => resolve(readCommands()));
});

test('the command reference covers every subcommand', () => {
  const { readCommands, resolve } = require('../docs/reference/build');
  const commands = resolve(readCommands());

  for (const command of commands) {
    const expected = command.subs.length > 0 ? command.subs.length : 1;
    assert.equal(command.rows.length, expected, `/${command.name} lost a row`);
    for (const row of command.rows) {
      assert.ok(row.role.who && !row.role.who.startsWith('UNMAPPED'),
        `/${command.name}${row.name ? ` ${row.name}` : ''} has no plain-language role`);
      assert.ok(row.description, `/${command.name}${row.name ? ` ${row.name}` : ''} has no description`);
    }
  }
});
