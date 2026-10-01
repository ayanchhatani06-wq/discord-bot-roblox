const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

/**
 * Every module must actually load.
 *
 * This exists because it did not, and nothing noticed. The six files under
 * `src/commands/parts/` were moved into that folder without their relative
 * requires being moved with them, so each one threw `Cannot find module` the
 * moment it was loaded. Because they are required lazily — inside `execute`,
 * not at the top of the file — the bot started cleanly, registered all its
 * commands, and only failed when somebody actually ran `/setup backup now` or
 * `/setup web`. Every other test passed throughout: they exercise the services
 * and repositories directly and never load the command layer.
 *
 * A test suite that cannot catch a broken import is missing a cheap test, so
 * here it is. It loads everything the bot can reach and asserts the shape of
 * the command modules while it is there.
 */

const SRC = path.join(__dirname, '..', 'src');

// index.js connects to Discord and exits without a token; deploy-commands.js
// registers against the live API. Neither can be loaded for inspection.
const SIDE_EFFECTS = new Set(['index.js', 'deploy-commands.js']);

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    if (!entry.name.endsWith('.js')) return [];
    if (dir === SRC && SIDE_EFFECTS.has(entry.name)) return [];
    return [full];
  });
}

test('every module under src/ loads', () => {
  const broken = [];

  for (const file of walk(SRC)) {
    try {
      require(file);
    } catch (error) {
      broken.push(`${path.relative(SRC, file)}: ${error.message}`);
    }
  }

  assert.deepEqual(broken, [], `modules failed to load:\n${broken.join('\n')}`);
});

test('every command exposes a builder and a handler', () => {
  const dir = path.join(SRC, 'commands');
  const files = fs.readdirSync(dir).filter((name) => name.endsWith('.js'));
  assert.ok(files.length > 0, 'no command files found');

  for (const name of files) {
    const command = require(path.join(dir, name));
    assert.ok(command.data, `${name} has no builder`);
    assert.equal(typeof command.execute, 'function', `${name} has no execute`);
    assert.ok(command.data.toJSON().name, `${name} builds without a name`);
  }
});

test('every delegated part exposes a handler', () => {
  // These are reached only through a lazy require inside another command's
  // execute, which is precisely why a broken one stayed invisible.
  const dir = path.join(SRC, 'commands', 'parts');
  const files = fs.readdirSync(dir).filter((name) => name.endsWith('.js'));
  assert.ok(files.length > 0, 'no part files found');

  for (const name of files) {
    const part = require(path.join(dir, name));
    assert.equal(typeof part.execute, 'function', `parts/${name} has no execute`);
  }
});

test('every command a part is delegated to can reach that part', () => {
  // Catches the other half: a delegation pointing at a file that is not there.
  const dir = path.join(SRC, 'commands');
  const delegations = [];

  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const source = fs.readFileSync(path.join(dir, name), 'utf8');
    for (const match of source.matchAll(/require\('(\.\/parts\/[a-z-]+)'\)/g)) {
      delegations.push({ from: name, target: match[1] });
    }
  }

  assert.ok(delegations.length > 0, 'expected at least one delegated part');

  for (const { from, target } of delegations) {
    const resolved = path.join(dir, `${target.replace('./', '')}.js`);
    assert.ok(fs.existsSync(resolved), `${from} delegates to ${target}, which does not exist`);
    assert.equal(typeof require(resolved).execute, 'function', `${from} delegates to ${target}, which has no execute`);
  }
});

test('every path built from __dirname lands in the project data directory', () => {
  // The sibling of the require-depth bug: moving a file into a subfolder breaks
  // path.join(__dirname, '..', ...) exactly as it breaks require('../..'), but
  // silently — the code runs and writes to the wrong place. It put backups in
  // src/data/backups, which deploy/backup-offsite.sh does not collect and
  // .gitignore does not cover, so client payment records sat outside both.
  const ROOT = path.join(__dirname, '..');
  const wrong = [];

  const scan = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { scan(full); continue; }
      if (!entry.name.endsWith('.js')) continue;

      const source = fs.readFileSync(full, 'utf8');
      const pattern = /path\.join\(__dirname,\s*((?:'\.\.',\s*)+)'(data)'/g;

      for (const match of source.matchAll(pattern)) {
        const ups = match[1].match(/'\.\.'/g).length;
        const resolved = path.join(path.dirname(full), ...Array(ups).fill('..'), 'data');
        if (resolved !== path.join(ROOT, 'data')) {
          wrong.push(`${path.relative(ROOT, full)}: ${ups} level(s) up reaches ${path.relative(ROOT, resolved)}`);
        }
      }
    }
  };

  scan(SRC);
  assert.deepEqual(wrong, [], `paths that miss the data directory:\n${wrong.join('\n')}`);
});

test('every command the doctor tells you to run actually exists', () => {
  // It pointed at /setup department-roles, which is not a subcommand. A fix
  // hint naming a command that does not exist is worse than no hint: the
  // person types it, Discord shows nothing, and they conclude the bot is
  // broken rather than that the advice was.
  const source = fs.readFileSync(path.join(SRC, 'services', 'doctor.js'), 'utf8');
  const commands = new Map();

  for (const name of fs.readdirSync(path.join(SRC, 'commands')).filter((f) => f.endsWith('.js'))) {
    const built = require(path.join(SRC, 'commands', name)).data.toJSON();
    commands.set(built.name, new Set((built.options || []).map((o) => o.name)));
  }

  const unknown = [];
  for (const match of source.matchAll(/`\/([a-z-]+)(?:\s+([a-z-]+))?/g)) {
    const [, command, sub] = match;
    if (!commands.has(command)) { unknown.push(`/${command}`); continue; }
    if (sub && !commands.get(command).has(sub)) unknown.push(`/${command} ${sub}`);
  }

  assert.deepEqual([...new Set(unknown)], [], 'doctor names commands that do not exist');
});
