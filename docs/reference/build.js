const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const gates = require('./gates');
const { TIER_LABELS, describe } = require('./roles');

/**
 * Builds docs/COMMANDS.pdf: every command, who may run it, and what it does.
 *
 * Read out of the command builders rather than written by hand, so the reference
 * cannot drift from the bot. The descriptions are the same ones Discord shows in
 * its own command picker, which is the point — the paper and the screen say the
 * same thing.
 *
 * Refuses to build if a command or subcommand has no line in gates.js. A
 * reference with a blank in the "who can use it" column is worse than no
 * reference, because somebody will read the blank as "anybody".
 */

const ROOT = path.join(__dirname, '..', '..');
const COMMANDS_DIR = path.join(ROOT, 'src', 'commands');
const OUT_HTML = path.join(__dirname, 'commands.html');
const OUT_PDF = path.join(ROOT, 'docs', 'COMMANDS.pdf');

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/opt/pw-browsers/chromium/chrome-linux/chrome',
  '/opt/pw-browsers/chromium',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

function escape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Every command, with its subcommands flattened out of any groups. */
function readCommands() {
  return fs.readdirSync(COMMANDS_DIR)
    .filter((file) => file.endsWith('.js'))
    .map((file) => {
      const command = require(path.join(COMMANDS_DIR, file));
      const json = command.data.toJSON();
      const subs = [];

      for (const option of json.options || []) {
        if (option.type === 1) {
          subs.push({ name: option.name, description: option.description, options: option.options || [] });
        } else if (option.type === 2) {
          // A subcommand group reads as "group child" the way it is typed.
          for (const child of option.options || []) {
            subs.push({ name: `${option.name} ${child.name}`, description: child.description, options: child.options || [] });
          }
        }
      }

      return {
        file,
        name: json.name,
        description: json.description,
        subs,
        options: (json.options || []).filter((option) => option.type !== 1 && option.type !== 2),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Pairs each command with its gate, and refuses on anything unmapped.
 *
 * The check runs before a single page is written, so a command added without a
 * gate line fails the build instead of shipping a hole.
 */
function resolve(commands) {
  const problems = [];

  const resolved = commands.map((command) => {
    const entry = gates[command.name];
    if (!entry) {
      problems.push(`/${command.name} (${command.file}) has no entry in docs/reference/gates.js`);
      return null;
    }

    for (const name of Object.keys(entry.subs || {})) {
      if (!command.subs.some((sub) => sub.name === name)) {
        problems.push(`/${command.name} ${name} is in gates.js but not in the command`);
      }
    }

    const rows = (command.subs.length > 0 ? command.subs : [{
      name: null, description: command.description, options: command.options,
    }]).map((sub) => {
      const token = (sub.name && entry.subs?.[sub.name]) || entry.default;
      const role = describe(token);
      if (role.who.startsWith('UNMAPPED')) {
        problems.push(`/${command.name}${sub.name ? ` ${sub.name}` : ''} uses unmapped gate "${token}"`);
      }
      return { ...sub, token, role };
    });

    // A command whose subcommands span several tiers says so in its heading.
    // Showing only the easiest way in would read as "anyone can do all of this",
    // which is the opposite of true for /task, /pay and most of the rest.
    const order = ['anyone', 'artist', 'leader', 'manager', 'owner'];
    const present = [...new Set(rows.map((row) => row.role.tier))]
      .sort((a, b) => order.indexOf(a) - order.indexOf(b));

    return {
      ...command,
      rows,
      tier: present[0],
      highestTier: present[present.length - 1],
      mixed: present.length > 1,
    };
  });

  if (problems.length > 0) {
    throw new Error(`The command reference is out of date:\n  - ${problems.join('\n  - ')}`);
  }

  return resolved;
}

function optionSummary(options) {
  const required = options.filter((option) => option.required).map((option) => option.name);
  const optional = options.filter((option) => !option.required).map((option) => option.name);
  const parts = [...required.map((name) => `${name}:`), ...optional.map((name) => `[${name}:]`)];
  return parts.join(' ');
}

function renderRow(command, row) {
  const usage = `/${command.name}${row.name ? ` ${row.name}` : ''}`;
  const options = optionSummary(row.options);

  return `
    <tr>
      <td class="cmd">
        <code>${escape(usage)}</code>
        ${options ? `<span class="opts">${escape(options)}</span>` : ''}
      </td>
      <td class="who">
        <span class="badge ${row.role.tier}">${escape(row.role.who)}</span>
        ${row.role.capabilities.length > 0
          ? `<span class="cap">${row.role.capabilities.map((c) => escape(c)).join(' + ')}</span>`
          : ''}
      </td>
      <td class="does">
        ${escape(row.description)}
        ${row.role.why ? `<span class="why">${escape(row.role.why)}</span>` : ''}
      </td>
    </tr>`;
}

function renderCommand(command) {
  return `
  <section class="command">
    <h2><code>/${escape(command.name)}</code> ${
      command.mixed
        ? `<span class="tag ${command.tier}">${escape(TIER_LABELS[command.tier])}</span>` +
          `<span class="tag-arrow">&ndash;</span>` +
          `<span class="tag ${command.highestTier}">${escape(TIER_LABELS[command.highestTier])}</span>`
        : `<span class="tag ${command.tier}">${escape(TIER_LABELS[command.tier])}</span>`
    }</h2>
    <p class="lede">${escape(command.description)}</p>
    <table>
      <thead>
        <tr><th>Command</th><th>Who can use it</th><th>What it does</th></tr>
      </thead>
      <tbody>${command.rows.map((row) => renderRow(command, row)).join('')}</tbody>
    </table>
  </section>`;
}

function renderIndex(commands) {
  const groups = ['anyone', 'artist', 'leader', 'manager', 'owner'];
  return groups.map((tier) => {
    const named = commands.filter((command) => command.tier === tier);
    if (named.length === 0) return '';
    return `
      <div class="index-group">
        <h3><span class="dot ${tier}"></span>${escape(TIER_LABELS[tier])} can use at least part of these</h3>
        <p>${named.map((command) =>
          `<code${command.mixed ? ' class="mixed"' : ''}>/${escape(command.name)}</code>`).join(' ')}</p>
      </div>`;
  }).join('');
}

function renderHtml(commands) {
  const subcommandCount = commands.reduce((total, command) => total + command.subs.length, 0);
  const plainCount = commands.filter((command) => command.subs.length === 0).length;
  const plainTierCount = commands.filter((command) => !command.mixed).length;
  const built = new Date().toISOString().slice(0, 10);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Cylops Studio — Command Reference</title>
<style>
  @page { size: A4; margin: 16mm 14mm 18mm; }

  :root {
    --ink: #17181c;
    --soft: #5b6070;
    --line: #dfe2ea;
    --rule: #c8ccd8;
    --anyone: #2f7d4f;
    --artist: #1f6d8c;
    --leader: #6b4fbf;
    --manager: #9a5b1f;
    --owner: #a63347;
    --wash: #f6f7fa;
  }

  * { box-sizing: border-box; }

  html { font-size: 10.5pt; }
  body {
    margin: 0; color: var(--ink);
    font-family: "Charter", "Georgia", "Iowan Old Style", serif;
    line-height: 1.42; -webkit-font-smoothing: antialiased;
  }

  code, .cap, .opts { font-family: "SF Mono", "DejaVu Sans Mono", "Menlo", monospace; }

  /* ---------- cover ---------- */
  .cover { page-break-after: always; padding-top: 14mm; }
  .cover h1 { font-size: 27pt; margin: 0 0 2mm; letter-spacing: -0.4pt; }
  .cover .sub { font-size: 12.5pt; color: var(--soft); margin: 0 0 9mm; }
  .cover .meta { font-size: 9pt; color: var(--soft); border-top: 1px solid var(--line); padding-top: 3mm; }

  .note {
    background: var(--wash); border: 1px solid var(--line);
    border-left: 3px solid var(--rule);
    padding: 4mm 5mm; margin: 0 0 7mm; font-size: 9.5pt;
  }
  .note h4 { margin: 0 0 2mm; font-size: 10pt; }
  .note p { margin: 0 0 2.5mm; }
  .note p:last-child { margin-bottom: 0; }

  .index-group { margin-bottom: 4.5mm; }
  .index-group h3 { font-size: 10pt; margin: 0 0 1.5mm; font-weight: 600; }
  .index-group p { margin: 0; font-size: 9.5pt; line-height: 1.9; }
  .index-group code {
    background: var(--wash); border: 1px solid var(--line);
    padding: 0.4mm 1.4mm; border-radius: 2px; font-size: 8.5pt;
  }

  .dot {
    display: inline-block; width: 7px; height: 7px; border-radius: 50%;
    margin-right: 2.2mm; vertical-align: 1px;
  }
  .dot.anyone { background: var(--anyone); }
  .dot.artist { background: var(--artist); }
  .dot.leader { background: var(--leader); }
  .dot.manager { background: var(--manager); }
  .dot.owner { background: var(--owner); }

  /* ---------- one command ---------- */
  /* A long command is allowed to run over a page break rather than jumping to
     the next page whole and leaving half a page blank. What must not split is a
     heading from its first rows, or a row down the middle. */
  .command { margin-bottom: 7mm; }
  .command h2 {
    font-size: 14pt; margin: 0 0 1mm;
    border-bottom: 1.5px solid var(--ink); padding-bottom: 1.6mm;
    page-break-after: avoid; break-after: avoid;
  }
  .command h2 code { font-size: 14pt; }
  .command .lede {
    margin: 0 0 2.5mm; color: var(--soft); font-size: 9.5pt;
    page-break-after: avoid; break-after: avoid;
  }

  table { width: 100%; border-collapse: collapse; font-size: 9pt; }
  thead { display: table-header-group; }
  th {
    text-align: left; font-size: 7.5pt; text-transform: uppercase;
    letter-spacing: 0.6pt; color: var(--soft); font-weight: 600;
    padding: 0 2mm 1.2mm 0; border-bottom: 1px solid var(--line);
  }
  td { padding: 1.7mm 2mm 1.7mm 0; border-bottom: 1px solid var(--line); vertical-align: top; }
  tr { page-break-inside: avoid; break-inside: avoid; }
  tbody tr:first-child { page-break-before: avoid; break-before: avoid; }

  .cmd { width: 33%; }
  .cmd code { font-size: 8.5pt; font-weight: 600; }
  .opts { display: block; font-size: 7.5pt; color: var(--soft); margin-top: 0.7mm; }

  .who { width: 24%; }
  .does { width: 43%; }

  .badge {
    display: inline-block; font-size: 7.5pt; font-weight: 600;
    padding: 0.5mm 1.6mm; border-radius: 2px; color: #fff;
    font-family: inherit; line-height: 1.3;
  }
  .badge.anyone { background: var(--anyone); }
  .badge.artist { background: var(--artist); }
  .badge.leader { background: var(--leader); }
  .badge.manager { background: var(--manager); }
  .badge.owner { background: var(--owner); }

  .cap { display: block; font-size: 7pt; color: var(--soft); margin-top: 0.8mm; }
  .why { display: block; font-size: 8pt; color: var(--soft); font-style: italic; margin-top: 0.8mm; }

  .tag {
    font-size: 7.5pt; font-weight: 600; color: #fff;
    padding: 0.5mm 1.8mm; border-radius: 2px; vertical-align: 2.5px;
    font-family: inherit;
  }
  .tag.anyone { background: var(--anyone); }
  .tag.artist { background: var(--artist); }
  .tag.leader { background: var(--leader); }
  .tag.manager { background: var(--manager); }
  .tag.owner { background: var(--owner); }
  .tag-arrow { font-size: 7.5pt; color: var(--soft); margin: 0 1mm; vertical-align: 2.5px; }

  /* A command whose subcommands span tiers is marked, so the glance list is not
     read as "anyone can do all of this". Dashed and starred, because a colour
     difference alone disappears on a photocopier. */
  .index-group code.mixed { border: 1px dashed var(--rule); }
  .index-group code.mixed::after { content: "\\2009*"; color: var(--soft); }

  .glance-note { font-size: 8.5pt; color: var(--soft); margin: -2mm 0 4mm; }
  .glance-note code.mixed {
    background: var(--wash); border: 1px dashed var(--rule);
    padding: 0.3mm 1.2mm; border-radius: 2px; font-size: 8pt;
  }
  .glance-note code.mixed::after { content: "\\2009*"; }

  h2.section {
    font-size: 12pt; margin: 0 0 4mm; padding-bottom: 1.5mm;
    border-bottom: 2px solid var(--ink);
  }
</style>
</head>
<body>

<div class="cover">
  <h1>Command Reference</h1>
  <p class="sub">Cylops Studio operations bot — every command, who can use it, and what it does</p>

  <div class="note">
    <h4>How to read the "who can use it" column</h4>
    <p>The badge is the plain-language answer. The grey text under it, where there is
    any, is the exact capability the code checks — the same name you would type into
    <code>/studio capability</code>.</p>
    <p><strong>These are defaults, not fixed rules.</strong> Nothing in the bot checks
    Discord roles directly. Roles are mapped to capabilities in configuration, so the
    studio can restructure its roles without a code change. If you grant
    <code>payment.record</code> to a leader role, that leader can record payments and
    this page's "Owner" badge no longer describes your studio.</p>
    <p>The owner always holds every capability. A group leader holds their leader
    capabilities <em>only inside a department they lead</em> — the same command refuses
    them in somebody else's department. Someone standing in for a leader gets the same
    powers, in that department, until the stand-in date passes.</p>
  </div>

  <div class="note">
    <h4>Two things worth knowing before you read on</h4>
    <p>Commands you cannot use are not listed in <code>/help</code>, and most replies
    are private to you. Where a command shows money, it shows it only to people who
    could already see it.</p>
    <p>The bot records that money moved. <strong>It never moves money</strong>, and it
    never asks for a payment password, card number or wallet phrase.</p>
  </div>

  <h2 class="section">Commands at a glance</h2>
  <p class="glance-note">Grouped by the easiest way in. A <code class="mixed">starred</code>
  command has subcommands above that level too — its own heading gives the range, and
  the table gives each subcommand exactly. The other ${plainTierCount} are the same
  the whole way through.</p>
  ${renderIndex(commands)}

  <p class="meta">
    ${commands.length} commands · ${subcommandCount} subcommands · ${plainCount} commands that take no subcommand · generated ${escape(built)}
    from the command definitions in <code>src/commands</code>.
    Rebuild with <code>npm run reference</code>.
  </p>
</div>

${commands.map(renderCommand).join('')}

</body>
</html>`;
}

function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    if (fs.existsSync(candidate)) {
      const stat = fs.statSync(candidate);
      if (stat.isDirectory()) {
        const inside = path.join(candidate, 'chrome-linux', 'chrome');
        if (fs.existsSync(inside)) return inside;
        continue;
      }
      return candidate;
    }
  }
  return null;
}

function main() {
  const commands = resolve(readCommands());
  fs.writeFileSync(OUT_HTML, renderHtml(commands), 'utf8');
  console.log(`Wrote ${path.relative(ROOT, OUT_HTML)}`);

  const chrome = findChrome();
  if (!chrome) {
    console.error(
      'No Chrome or Chromium found, so the PDF was not built. The HTML above is complete —\n' +
      'open it and print to PDF, or set CHROME_PATH to a browser binary and run this again.'
    );
    process.exitCode = 1;
    return;
  }

  execFileSync(chrome, [
    '--headless',
    '--disable-gpu',
    '--no-sandbox',
    '--no-pdf-header-footer',
    `--print-to-pdf=${OUT_PDF}`,
    `file://${OUT_HTML}`,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  const { size } = fs.statSync(OUT_PDF);
  console.log(`Wrote ${path.relative(ROOT, OUT_PDF)} (${Math.round(size / 1024)} KB)`);
}

if (require.main === module) main();

module.exports = { readCommands, resolve, renderHtml };
