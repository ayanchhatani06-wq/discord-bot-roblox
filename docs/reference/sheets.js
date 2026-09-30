const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { readCommands, resolve } = require('./build');
const { GROUPS, COMMAND_GROUPS, PLACES, SERVER_LAYOUT } = require('./groups');

/**
 * Three short sheets, one per person, instead of one long reference.
 *
 * The full reference lists every command with a "who can use it" column. That is
 * the right shape for looking something up and the wrong shape for reading: the
 * column is noise to somebody who only wants the part that applies to them, and
 * 36 commands in alphabetical order hides the thing you are hunting for.
 *
 * So each sheet drops the permission column entirely — the cover answers it,
 * because everything on the sheet is something that reader can run — and groups
 * commands by what you are trying to do rather than by name. Each one also says
 * where the bot's output actually lands, which no command list ever tells you.
 */

const ROOT = path.join(__dirname, '..', '..');

const SHEETS = [
  {
    key: 'staff',
    file: 'COMMANDS-staff.pdf',
    title: 'For the team',
    subtitle: 'Everything you can do, and where to look for it',
    tiers: ['anyone', 'artist'],
    accent: '#1f6d8c',
    opening:
      'This is everything on the bot that is yours to use. If a command is not on this sheet, ' +
      'it is somebody else’s job — you will not be missing anything by not knowing it.',
    startHere: [
      ['/go', 'What is waiting on you right now. Run it first.'],
      ['/go', 'Your work, deadlines and pay in one place.'],
      ['/find', 'When you half-remember a name or a code and cannot recall the command.'],
    ],
    closing: [
      ['Open your DMs to this server', 'Task offers arrive by DM. With DMs closed they go to the private staff channel instead, which is slower and easier to miss.'],
      ['Set your timezone once', '`/profile timezone`. Without it your deadlines are read as UTC and land hours out.'],
      ['Say when you are away', '`/profile availability` with a return date. It stops work being offered to you while you are gone.'],
    ],
  },
  {
    key: 'leader',
    file: 'COMMANDS-leader.pdf',
    title: 'For group leaders',
    subtitle: 'Running your department',
    tiers: ['leader'],
    accent: '#6b4fbf',
    opening:
      'These work inside the departments you lead, and are refused elsewhere — the same command in ' +
      'somebody else’s department will tell you no. You can also use everything on the team sheet.',
    startHere: [
      ['/go', 'Your queue, who is loaded, what needs reviewing, what is at risk.'],
      ['/task queue', 'Unassigned work, each with a button to pick an artist.'],
      ['/who-is-free', 'Who has room before you promise anything.'],
    ],
    closing: [
      ['You propose pay, the owner approves it', 'Nothing can be offered until they decide, so propose early.'],
      ['A blocker is not a delay', 'Raise it. It is how the owner sees an order has stopped, and by what.'],
      ['Standing in for another leader', 'Ask the owner for `/team stand-in grant`. It expires on a date by itself.'],
    ],
  },
  {
    key: 'owner',
    file: 'COMMANDS-owner.pdf',
    title: 'For the owner',
    subtitle: 'Money, clients and running the studio',
    tiers: ['manager', 'owner'],
    accent: '#a63347',
    opening:
      'You hold every permission, so you can run anything on the other two sheets as well. ' +
      'This one is the part nobody else can do.',
    startHere: [
      ['/go', 'Everything waiting on a decision from you.'],
      ['/go', 'The same thing, shorter, with the command for each.'],
      ['/setup doctor', 'What is quietly misconfigured, worst first. Run it after any setup change.'],
    ],
    closing: [
      ['The bot records money, it never moves it', 'And it never asks for a payment password, card number or wallet phrase. If anything ever does, it is not this bot.'],
      ['Nothing is payable before the money is in', 'Unless you say so with `/pay mark-payable`, with your reason kept on the record.'],
      ['Back up somewhere else', '`/setup backup now` writes to the same disk as the database. That is a second copy, not a backup — see the hosting notes for the offsite job.'],
    ],
    layout: SERVER_LAYOUT,
  },
];

function escape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Turns `backtick` spans in hand-written copy into code, after escaping. */
function rich(value) {
  return escape(value).replace(/`([^`]+)`/g, '<code>$1</code>');
}

/** The rows of one sheet, grouped by what the reader is trying to do. */
function sectionsFor(commands, sheet) {
  return GROUPS.map((group) => {
    const entries = [];

    for (const command of commands) {
      if (COMMAND_GROUPS[command.name] !== group.key) continue;

      const rows = command.rows.filter((row) => sheet.tiers.includes(row.role.tier));
      if (rows.length === 0) continue;

      entries.push({ command, rows });
    }

    return { ...group, entries };
  }).filter((group) => group.entries.length > 0);
}

function renderRow(command, row) {
  const required = row.options.filter((option) => option.required).map((option) => option.name);

  return `
    <tr>
      <td class="cmd">
        <code>/${escape(command.name)}${row.name ? ` ${escape(row.name)}` : ''}</code>
        ${required.length > 0 ? `<span class="needs">needs ${escape(required.join(', '))}</span>` : ''}
      </td>
      <td class="does">${escape(row.description)}</td>
    </tr>`;
}

function renderSheet(sheet, sections, stats) {
  const rowCount = sections.reduce((total, group) =>
    total + group.entries.reduce((n, entry) => n + entry.rows.length, 0), 0);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Cylops Studio — ${escape(sheet.title)}</title>
<style>
  @page { size: A4; margin: 15mm 14mm 16mm; }
  :root {
    --ink: #17181c; --soft: #5f6473; --line: #e2e5ec; --wash: #f7f8fb;
    --accent: ${sheet.accent};
  }
  * { box-sizing: border-box; }
  html { font-size: 11pt; }
  body {
    margin: 0; color: var(--ink); line-height: 1.45;
    font-family: "Charter", "Georgia", serif; -webkit-font-smoothing: antialiased;
  }
  code { font-family: "SF Mono", "DejaVu Sans Mono", Menlo, monospace; }

  /* ---------- opening ---------- */
  header { border-bottom: 3px solid var(--accent); padding-bottom: 4mm; margin-bottom: 6mm; }
  h1 { font-size: 25pt; margin: 0 0 1mm; letter-spacing: -0.3pt; }
  .subtitle { font-size: 12pt; color: var(--soft); margin: 0; }
  .opening { font-size: 10.5pt; margin: 4mm 0 0; }

  .start {
    background: var(--wash); border-left: 3px solid var(--accent);
    padding: 4mm 5mm; margin: 0 0 7mm;
  }
  .start h2 { font-size: 11pt; margin: 0 0 2.5mm; }
  .start dl { margin: 0; }
  .start dt { font-family: "SF Mono", "DejaVu Sans Mono", Menlo, monospace; font-size: 10pt; font-weight: 600; }
  .start dd { margin: 0 0 2.5mm; font-size: 10pt; color: var(--soft); }
  .start dd:last-child { margin-bottom: 0; }

  /* ---------- the commands ---------- */
  h2.group {
    font-size: 13pt; margin: 0 0 3mm; padding-bottom: 1.5mm;
    border-bottom: 1.5px solid var(--ink);
    page-break-after: avoid; break-after: avoid;
  }
  .block { margin-bottom: 5mm; }
  .block h3 {
    font-size: 10pt; margin: 0 0 1mm; color: var(--accent);
    page-break-after: avoid; break-after: avoid;
  }
  .block h3 span { color: var(--soft); font-weight: 400; font-size: 9pt; }

  table { width: 100%; border-collapse: collapse; font-size: 9.5pt; }
  td { padding: 1.6mm 2mm 1.6mm 0; border-bottom: 1px solid var(--line); vertical-align: top; }
  tr { page-break-inside: avoid; break-inside: avoid; }
  .cmd { width: 38%; }
  .cmd code { font-size: 9pt; font-weight: 600; }
  .needs { display: block; font-size: 7.5pt; color: var(--soft); margin-top: 0.6mm; font-style: italic; }
  .does { width: 62%; }

  section.group { margin-bottom: 7mm; }

  /* ---------- where things show up ---------- */
  .places { page-break-before: always; }
  .place { margin-bottom: 4.5mm; page-break-inside: avoid; break-inside: avoid; }
  .place h3 { font-size: 10.5pt; margin: 0 0 1mm; }
  .place p { margin: 0; font-size: 10pt; }
  .place .note { color: var(--soft); font-size: 9.5pt; margin-top: 1mm; font-style: italic; }

  .layout { margin-top: 7mm; }
  .layout .cat {
    font-family: "SF Mono", "DejaVu Sans Mono", Menlo, monospace;
    background: var(--wash); border: 1px solid var(--line);
    padding: 3mm 4mm; margin: 3mm 0; font-size: 9.5pt;
  }
  .layout .cat b { display: block; margin-bottom: 1.5mm; }
  .layout .cat span { display: block; padding-left: 4mm; }
  .layout .cat span em { color: var(--soft); font-style: normal; }

  /* ---------- closing ---------- */
  .closing { margin-top: 6mm; padding-top: 4mm; border-top: 1.5px solid var(--ink); }
  .closing h2 { font-size: 12pt; margin: 0 0 3mm; }
  .closing .item { margin-bottom: 3mm; page-break-inside: avoid; }
  .closing .item b { font-size: 10pt; }
  .closing .item p { margin: 0.5mm 0 0; font-size: 9.5pt; color: var(--soft); }

  footer {
    margin-top: 7mm; padding-top: 3mm; border-top: 1px solid var(--line);
    font-size: 8pt; color: var(--soft);
  }
  footer code { font-size: 7.5pt; }
</style>
</head>
<body>

<header>
  <h1>${escape(sheet.title)}</h1>
  <p class="subtitle">${escape(sheet.subtitle)}</p>
  <p class="opening">${rich(sheet.opening)}</p>
</header>

<div class="start">
  <h2>If you only remember three</h2>
  <dl>
    ${sheet.startHere.map(([command, what]) =>
      `<dt>${escape(command)}</dt><dd>${escape(what)}</dd>`).join('\n    ')}
  </dl>
</div>

${sections.map((group) => `
<section class="group">
  <h2 class="group">${escape(group.title)}</h2>
  ${group.entries.map((entry) => {
    // A command that takes no subcommand is one line, not a heading followed by
    // a row saying the same thing.
    const bare = entry.rows.length === 1 && !entry.rows[0].name;
    return `
  <div class="block">
    ${bare ? '' : `<h3><code>/${escape(entry.command.name)}</code> <span>— ${escape(entry.command.description)}</span></h3>`}
    <table><tbody>${entry.rows.map((row) => renderRow(entry.command, row)).join('')}</tbody></table>
  </div>`;
  }).join('')}
</section>`).join('')}

<section class="places">
  <h2 class="group">Where things show up</h2>
  ${PLACES[sheet.key].map((place) => `
  <div class="place">
    <h3>${escape(place.where)}</h3>
    <p>${escape(place.what)}</p>
    ${place.note ? `<p class="note">${escape(place.note)}</p>` : ''}
  </div>`).join('')}

  ${sheet.layout ? `
  <div class="layout">
    <h2 class="group">Setting the channels up</h2>
    <p style="font-size:10pt;margin:0 0 2mm">${escape(sheet.layout.intro)}</p>
    <div class="cat">
      <b>${escape(sheet.layout.category)}</b>
      ${sheet.layout.channels.map((channel) =>
        `<span>${escape(channel.name)} <em>— ${escape(channel.purpose)}</em></span>`).join('\n      ')}
    </div>
    ${sheet.layout.channels.map((channel) => `
    <div class="place">
      <h3>${escape(channel.name)}</h3>
      <p>${escape(channel.what)}</p>
      <p class="note">${escape(channel.who)} · Point the bot at it with <code>/setup channel purpose:${escape(channel.purpose)}</code></p>
    </div>`).join('')}
    <div class="place">
      <h3>Client channels</h3>
      <p>${escape(sheet.layout.clients)}</p>
    </div>
  </div>` : ''}
</section>

<section class="closing">
  <h2>Worth knowing</h2>
  ${sheet.closing.map(([title, body]) => `
  <div class="item"><b>${escape(title)}</b><p>${rich(body)}</p></div>`).join('')}
</section>

<footer>
  ${rowCount} commands on this sheet, of ${stats.total} the bot has.
  The rest are on the other sheets — the full reference is <code>docs/COMMANDS.pdf</code>.
  Generated ${escape(new Date().toISOString().slice(0, 10))} from the bot itself; rebuild with <code>npm run reference</code>.
</footer>

</body>
</html>`;
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/opt/pw-browsers/chromium',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const stat = fs.statSync(candidate);
    if (stat.isFile()) return candidate;
    const inside = path.join(candidate, 'chrome-linux', 'chrome');
    if (fs.existsSync(inside)) return inside;
  }
  return null;
}

function build() {
  const commands = resolve(readCommands());
  const total = commands.reduce((sum, command) => sum + command.rows.length, 0);
  const chrome = findChrome();
  const covered = new Set();
  const written = [];

  for (const sheet of SHEETS) {
    const sections = sectionsFor(commands, sheet);
    for (const group of sections) {
      for (const entry of group.entries) {
        for (const row of entry.rows) covered.add(`${entry.command.name}:${row.name ?? ''}`);
      }
    }

    const htmlPath = path.join(__dirname, `sheet-${sheet.key}.html`);
    fs.writeFileSync(htmlPath, renderSheet(sheet, sections, { total }), 'utf8');

    if (chrome) {
      const pdfPath = path.join(ROOT, 'docs', sheet.file);
      execFileSync(chrome, [
        '--headless', '--disable-gpu', '--no-sandbox', '--no-pdf-header-footer',
        `--print-to-pdf=${pdfPath}`, `file://${htmlPath}`,
      ], { stdio: ['ignore', 'ignore', 'pipe'] });
      written.push({ sheet, pdfPath, bytes: fs.statSync(pdfPath).size });
    }
  }

  // Every command must land on at least one sheet, or somebody's job is missing
  // from the only page they will ever read.
  const missing = [];
  for (const command of commands) {
    for (const row of command.rows) {
      if (!covered.has(`${command.name}:${row.name ?? ''}`)) {
        missing.push(`/${command.name}${row.name ? ` ${row.name}` : ''} (${row.role.tier})`);
      }
    }
  }
  if (missing.length > 0) {
    throw new Error(`These are on no sheet at all:\n  - ${missing.join('\n  - ')}`);
  }

  if (!chrome) {
    console.error('No Chrome or Chromium found; the HTML sheets were written but no PDF was made.');
    process.exitCode = 1;
    return;
  }

  for (const { sheet, pdfPath, bytes } of written) {
    console.log(`Wrote ${path.relative(ROOT, pdfPath)} — ${sheet.title} (${Math.round(bytes / 1024)} KB)`);
  }
}

if (require.main === module) build();

module.exports = { SHEETS, sectionsFor, build };
