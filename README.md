# Studio Operations Bot

A Discord bot for running a creative production studio: staff directory and
timezones, client projects broken into departmental tasks, leader-driven
assignment, submissions and internal review, recorded client decisions, and
payment tracking with configurable splits.

It is built to sit alongside Dyno, Bloxlink, Carl, Ticket Tool and a word
filter — it does not moderate, verify Roblox accounts, or manage tickets. It
records studio operations.

---

## Contents

- [What it does](#what-it-does)
- [Installation](#installation)
- [First-run setup](#first-run-setup)
- [Command reference](#command-reference)
- [How the money rules work](#how-the-money-rules-work)
- [Permissions](#permissions)
- [Hosting](#hosting)
- [Backups](#backups)
- [When things go wrong](#when-things-go-wrong)
- [Tests](#tests)
- [Project layout](#project-layout)
- [Deliberate limits](#deliberate-limits)

---

## What it does

**Staff directory.** Everyone fills in their own profile from one panel:
timezone, specialties, software, portfolio, Roblox name, usual working hours
and quiet hours. Availability is declared explicitly — *accepting tasks*, *at
capacity*, or *away* — and is never inferred from whether someone is online in
Discord. Per-department board messages in a staff channel are refreshed on a
schedule and show current local times with a visible "updated" stamp.

**Projects and tasks.** A client order becomes one project with many tasks.
`12 models, 4 vfx, 2 animations` expands into 18 separate tasks, each routed to
the right department and pre-filled with that department's deliverables
checklist.

**Assignment by leaders.** New tasks land in their department's unassigned
queue. The leader sees a shortlist of their artists with availability, current
workload, local time and specialties, and chooses. Nothing is auto-assigned.
Offering work to somebody away or at capacity warns and asks for a second
click rather than refusing — the choice stays the leader's.

**Pay you control.** A group leader can *propose* a figure; only the owner
approves it, and a task cannot be offered until that approval exists. Changes
to pay, deadline or scope after acceptance are recorded for the artist to
acknowledge rather than silently replacing what they agreed to.

**Offers, work, review.** Offers go by DM (with a fallback channel if DMs are
closed) showing the brief, deliverables, deadline, revision scope and pay, with
Accept and Decline buttons. Declining needs a reason and returns the task to
the queue. Final submissions require every deliverable ticked and at least one
link. The group leader reviews internally, then — separately — the owner
records what the client decided.

**Client approval is a record, not a bot action.** The bot never talks to
clients. After the client replies through your normal channel, the owner
records the decision, the feedback, a supporting message link, and the bot
stores who wrote it down and when.

**Money.** Payment status is tracked separately from production status.
Approved work can sit unpaid. Splits of the leftover pool go to the client
finder, the department leader who did the work, a mod, and you. Pay that would
commit more than the client is paying is refused rather than warned about; you
can override it deliberately, and the override is recorded.

**Shared work.** Several people can work on one deliverable, each with a stated
responsibility and their own separately agreed pay. Nobody is counted twice,
nobody sees a colleague's rate, and the task is only settled once everybody on
it has been paid.

**Bonus milestones.** Rules such as *every 10 approved animations* are counted
from client-approved work only. A reached milestone is flagged for your
approval and never becomes owed by itself.

**Chasing.** Configurable reminders for unanswered offers, upcoming and overdue
deadlines, work with no recent progress, submissions awaiting review, work
awaiting a client, and approved work with payouts outstanding. The artist is
chased first, then their leader. Reminders respect each person's quiet hours
and arrive batched, one message per person.

**Weekly summary.** A private management digest: what was approved, what is
overdue or blocked, what is awaiting review or a client, department workloads,
and what is owed.

---

## Installation

### 1. Create the Discord application

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**.
2. **Bot** tab → **Reset Token** → copy it. This is your `DISCORD_TOKEN`; treat it like a password.
3. **Bot** tab → **Privileged Gateway Intents** → enable **Server Members Intent**,
   and **Message Content Intent** if you want the bot to quote client replies.
   Without Message Content everything still works: the bot knows a client wrote
   and pauses their automated messages, it just cannot include what they said.
   This is required: a staff directory has to know when somebody leaves the
   server, otherwise the boards keep listing people who are gone.
   *Presence* and *Message Content* are **not** needed.
4. **General Information** → copy the **Application ID**. This is your `CLIENT_ID`.

### 2. Invite it

**OAuth2 → URL Generator**:

- Scopes: `bot`, `applications.commands`
- Bot permissions: **View Channels**, **Send Messages**, **Embed Links**,
  **Read Message History**, and optionally **Manage Messages** (so it can pin
  its own board messages)

Open the generated URL and add it to your server.

### 3. Install and run

Requires **Node.js 18 or newer**.

```bash
git clone <your-repo-url>
cd discord-bot-roblox
npm install
cp .env.example .env
```

Fill in `.env`:

```
DISCORD_TOKEN=your-bot-token
CLIENT_ID=your-application-id
GUILD_ID=your-server-id        # optional, registers commands instantly
DATABASE_FILE=                 # optional, defaults to ./data/studio.db
```

To find your server ID: Discord → Settings → Advanced → enable **Developer
Mode**, then right-click the server icon → **Copy Server ID**.

```bash
npm run deploy   # register the slash commands
npm start        # run the bot
```

Everything else — departments, role mappings, channels, reminder timings, quiet
hours, split percentages — is configured inside Discord and stored in the
database, not in `.env`.

---

## First-run setup

Run **`/studio setup`** as the server owner. (The server owner can always run
it, which is what prevents a locked-out first install.)

It records you as the studio owner, creates the eight default departments
(modelling, building, animation, VFX, UI, GFX, scripting, SFX) with starter
deliverable checklists, and shows a checklist panel with controls for the rest:

1. **Staff info board channel** — where the directory lives. Make it staff-only.
2. **DM fallback channel** — a private staff channel used when someone's DMs are
   closed. Without this, a closed DM means a lost notification.
3. **Weekly summary channel** — private; carries pay figures. Optional (the
   summary is DMed to you if unset).
4. **Owner role** — optional; anyone with it has full owner authority.
5. **Map department roles** — for each department, the group leader role and the
   artist role. *The leader role is what grants the right to assign and review
   work in that department.*
6. **Pool split** — defaults to finder 20 / leader 20 / mod 10 / owner 50.

Then ask staff to run **`/profile me`** and fill in their timezone and details.

### Try it before using it for real

```
/studio sample action:Create sample project
```

This builds a demonstration project with six tasks, one sitting in each stage
of the workflow — unassigned, pay proposed, offered, in progress, awaiting
review, and fully finished and paid — so every view has real data in it. Sample
tasks are set up directly rather than by sending real offers, so nobody is DMed
about work that does not exist.

Remove it with `/studio sample action:Remove sample data`.

---

## Command reference

### Everyone

| Command | What it does |
| --- | --- |
| `/profile me` | Your profile panel: timezone, details, hours, availability |
| `/profile view member:` | Somebody's profile |
| `/profile timezone timezone:` | Set your timezone (with autocomplete) |
| `/profile availability status:` | Accepting / at capacity / away, with optional return date |
| `/time member:` | Somebody's current local date and time |
| `/time department:` | Local times across a department, sorted west to east |
| `/work progress task: note:` | Post a progress update |
| `/work submit task:` | Submit finished work (checklist, then links) |
| `/work history task:` | Submissions, reviews and client decisions on a task |
| `/work earnings` | Your own pay and payment history, private to you |
| `/bonus mine` | Your progress towards milestone bonuses, and your awards |
| `/procedure list` / `read key:` | Studio procedures, and acknowledging them |
| `/trial mine` / `submit code:` | Your trial briefs, if you are on trial |
| `/task mine` | Your offers and current assignments |

### Group leaders (in departments they lead)

| Command | What it does |
| --- | --- |
| `/task queue [department:]` | Unassigned work, with a button to choose an artist per task |
| `/task assign task:` | Pick the artist and send the offer |
| `/task pay task: amount:` | Propose a figure for the owner to approve |
| `/contrib add task: person: responsibility:` | Put a second person on a task |
| `/contrib pay task: person: amount:` | Propose what that person is paid |
| `/contrib list task:` | Who is on a task and what each is owed |
| `/task edit task:` | Change title, brief, deadline, formats, deliverables, revisions |
| `/task withdraw task:` | Take back an unanswered offer |
| `/review queue` | Work awaiting your internal review |
| `/review decide task:` | Request changes, or mark ready for the client |
| `/review awaiting-client` | Work sent to clients with no decision recorded yet |
| `/manage reassign task: artist: reason:` | Move work, keeping the original record |
| `/manage hold task: reason:` / `/manage resume task:` | Pause and unpause |
| `/recommend new person: kind: note:` | Put somebody forward for a trial or promotion |

### Owner

| Command | What it does |
| --- | --- |
| `/project create name: …` | Create a project (budget, deadline, manager, finder, mod, ticket link) |
| `/project bulk project: spec:` | `"12 models, 4 vfx, 2 animations"` → 18 routed tasks |
| `/project view` / `list` / `tasks` / `edit` | Project views and edits |
| `/task create` | A single task |
| `/task pay` / `/task approve-pay` | Set or approve agreed pay |
| `/review client task: decision:` | Record what the client decided |
| `/finance client-receipt project: amount:` | Record money received from a client |
| `/finance pay task: [person:]` | Record a payout to somebody who worked on the task |
| `/finance pay-split task: share:` | Record a finder / leader / mod / owner share |
| `/finance splits task:` | See how a task's pool divides |
| `/finance set-pool task: amount: currency:` | Enter the pool by hand when currencies differ |
| `/finance mark-payable task: reason:` | Make approved work payable before the client pays |
| `/finance ledger` / `outstanding` / `balance member:` | Money views |
| `/finance budget project:` | Committed pay against what the client pays |
| `/finance budget-override project: reason:` | Deliberately allow over-budget pay, on the record |
| `/finance budget-restore project:` | Put the guard back |
| `/bonus rule-set key: label: threshold: amount:` | A milestone rule, e.g. every 10 approved animations |
| `/bonus pending` / `approve id:` / `decline id: reason:` / `pay id:` | Decide and record bonuses |
| `/manage cancel task: reason:` | Cancel, preserving history |
| `/manage compensate task: member: amount:` | Pay for work done on cancelled or moved work |
| `/manage flags` | Everything waiting on a decision from you |
| `/summary now` / `post` / `schedule` / `run-reminders` | Management digest and reminder controls |
| `/trial offer person: title: brief: terms:` | Send a paid trial brief |
| `/trial decide code: outcome: feedback:` | Pass or fail a submitted trial |
| `/recommend list` / `decide id:` | Recommendations from your leaders |
| `/people stand-in grant person: department: until:` | Temporary leadership cover |
| `/people offboard preview person:` / `start` | What somebody leaves behind |
| `/procedure set key: title: body:` | Write a procedure everyone acknowledges |
| `/procedure who key:` | Who has read the current version |
| `/outreach template-set` / `template-approve` | Write and approve client message wording |
| `/outreach queue` / `history client:` | What is waiting to send, and what was sent |
| `/outreach prefs client:` | Opt-in, weekly limit, pause, follow-up owner |
| `/outreach replies` / `handled id:` | Clients waiting on an answer |
| `/outreach offer project:` | Queue the approved cross-service offer |
| `/clients add-requirement client:` | Something this client always asks for |
| `/repeat from project:` | Start a repeat order from a past one |
| `/repeat scope` / `price` / `deadline` / `create` | Confirm each term, then create it |
| `/studio …` | All configuration |

---

## How the money rules work

### The pool

The artist's agreed pay is never reduced by a split. What gets divided is what
is **left over** on that task:

```
pool = the task's share of the client payment  −  what everyone on that task is paid
```

Then the pool divides by your configured percentages — by default finder 20%,
the department leader who did the work 20%, mod 10%, you 50%.

**Worked example.** A client pays $40 and the artist's agreed pay is $25:

| Share | % of pool | Amount |
| --- | --- | --- |
| Client finder | 20% | $3.00 |
| Group leader (the department that did it) | 20% | $3.00 |
| Mod | 10% | $1.50 |
| You | 50% | $7.50 |

The artist still receives their full $25.

### Shared work

More than one person can work on a single deliverable. `/contrib add` puts them
on the task with a stated responsibility, and each person's pay is agreed
**separately** — a leader proposes, you approve, exactly as for a sole artist.

Three things follow from that, deliberately:

- **Nobody is counted twice.** The moment a second person joins, the original
  artist is copied into a contributor row carrying their existing agreed figure.
  From then on the contributor rows are the truth, and the task's own pay column
  is no longer added on top of them.
- **Nobody sees anyone else's rate.** `/contrib list` shows full figures to you
  and to the department's leader; everybody else sees their own figure and only
  "pay agreed" against their colleagues.
- **The task is paid when the last person is paid.** `/finance pay` asks which
  person the payout is for, and the task stays *partially paid* until everybody
  on it is settled.

Removing somebody with `/contrib remove` stops them counting towards the task's
cost but keeps their record and any payments already made to them.

### The budget guard

Pay that would commit more than the client is paying for a project is
**refused**, not merely flagged. You have three honest ways past it:

1. lower the figure,
2. record more client money (`/finance client-receipt` and the project amount),
3. or decide deliberately to take the loss —
   `/finance budget-override project: reason:`, which is recorded against the
   project and shown wherever the budget is.

`/finance budget project:` shows committed pay against the client payment at any
time. Pay in a currency the client did not use is listed separately and **not**
measured against the budget, because there is no conversion rate to measure it
with.

### Bonus milestones

`/bonus rule-set` creates a rule such as *every 10 approved animations earns
$20*, optionally limited to one department. Only client-approved work counts,
and a task counts once per person however they contributed to it.

When a milestone is reached the bot **flags it for you and stops**. Nothing is
owed until `/bonus approve`, and nothing is recorded as paid until `/bonus pay`.
Each milestone is indexed, so re-running the check — or two approvals landing at
the same moment — cannot award the same milestone twice.

### Repeat orders

`/repeat from project:<code>` copies what a previous order **was** — its brief,
its references, its list of items — and deliberately **not** what it cost or
when it was due. Carrying last time's price silently into a new job is how a
studio ends up honouring a figure it never agreed to.

Scope, price and deadline are then confirmed one at a time, each stamped with
who confirmed it, and the draft cannot become an order until all three are done.
A draft lives in its own table rather than as a project with a flag, so nothing
— queues, boards, the ledger, the client's dashboard — can see it by accident.

When it is created, the relationship carries across (who found the client, who
moderates them, who manages the work) but no pay is set on any task: that is
still yours to agree per item.

A client's **standing requirements** (`/clients add-requirement`) are recorded
once and shown on the task and on the offer, where the artist actually looks,
rather than sitting in the client record where nobody would find them. A
requirement can be scoped to one department, so "always 4K textures" reaches the
modellers without becoming noise for everybody else.

### Talking to clients

The bot sends clients only wording **you wrote and approved**. A template is a
draft until `/outreach template-approve`, and rewriting an approved one takes
the approval away again, so nothing goes out in words nobody signed off.

Templates are filled from a closed list of placeholders (`/outreach
placeholders`) read straight from records. An invented placeholder is refused
when you write the template; a placeholder with nothing recorded behind it stops
the message entirely rather than sending a sentence with a gap in it.

Messages are raised by things that actually happened — an order linked to a
client, the first task accepted, a preview passing internal review, work
released, a client silent for days, an order delivered a week ago. Each is
deduplicated by the event rather than by when the sweep ran, so re-reviewing the
same submission says nothing new. Previews and deliveries are held for an hour
and folded into one message, so an 18-item bulk order does not become 18 pings.

Before anything sends, and **again at the moment of sending**, the bot checks:

| Rule | Effect |
| --- | --- |
| An unresolved problem is open | Nothing automated goes out, transactional included — they should hear from a person |
| The client wrote in and nobody has answered | Everything pauses, and queued promotional messages are cancelled |
| Promotional, and they never opted in | Refused |
| Promotional, and they asked to stop | Refused, whatever the opt-in flag still says |
| Promotional, and the weekly limit is reached | Refused, counting what actually arrived, not what was queued |
| Explicitly paused | Refused until it lapses |

The guards run twice on purpose: a client can complain between a chase being
scheduled and it falling due, and the later fact is the one that should win.

Everything sent, held back or failed is on the record — `/outreach queue` and
`/outreach history`. A send that fails is marked failed with the reason, never
silently dropped.

Noticing a client reply needs Discord's **Message Content** intent. Without it
the bot still knows somebody wrote and still pauses, it just cannot quote them.

### Procedures, trials and leaving

**Procedures** are text the studio expects staff to have read. Acknowledgement
is bound to a *version*: editing the text raises the version, which makes every
earlier acknowledgement stale rather than quietly carrying it forward. Agreeing
to version 1 is not agreeing to version 2, and the record says so. `/procedure
who` shows who has read the current version and who has not, counting only the
people it applies to.

**Trials** are paid briefs with the terms written down before the work starts.
The candidate accepts explicitly, and what they accepted is snapshotted, so a
later edit cannot rewrite the deal behind them. A trial cannot be submitted
before it is accepted, and cannot be decided before it is submitted. Trial pay
is owed whatever the outcome.

**Recommendations** (`/recommend`) let a leader put somebody forward. That is
all they do: the bot never grants or removes a Discord role, so who actually
gets promoted stays a human decision made in Discord.

**Stand-in leaders** cover a department for a stated period. They get exactly a
leader's powers, in that department only. The window is re-checked every time
permissions are worked out, so the cover ends on time even if the bot was
offline when it lapsed and even though nothing is scheduled to take it away.

**Offboarding** reports rather than deletes. `/people offboard preview` shows
unfinished work, unanswered offers, approved work with no files recorded, open
trials and stand-in grants, and money still owed — including money owed to
somebody who only helped on another person's task. Starting an offboarding
flags the profile, takes them off the boards, withdraws their unanswered offers
and ends their stand-in cover. It does not touch their submissions, approvals or
payment history, because those are exactly what the studio still needs.

### Multi-department projects

Each task gets its own pool, so the **leader share always follows the
department that actually did that task** — never split between leaders.

A task's share of the client payment comes from one of three places, in order:

1. a pool you entered by hand (`/finance set-pool`)
2. an explicit per-task client price
3. otherwise, a pro-rata slice of the project's client payment, weighted by
   artist pay — so you don't have to price all 18 tasks of a bulk order

Rounding uses the largest-remainder method, so each task's pool is allocated to
the last cent with nothing lost. Note that because rounding happens per task,
aggregate shares across many tasks can land a cent or two off the headline
percentage; every individual pool still adds up exactly.

### Unassigned shares

A share with nobody attached falls to you. No mod recorded on the project means
that 10% stays with you; if you found the client yourself, the finder's 20%
stacks onto your 50% for 70%.

### Currencies

USD and Robux are supported. **There is no conversion anywhere** — no DevEx
rate, no implicit rate. Consequences:

- Totals are always reported per currency and never summed across them.
- Client receipts and staff payouts are separate ledgers.
- If a client pays USD and the artist is paid Robux, the pool **cannot** be
  computed. The bot says so and asks you to enter the distributable pool
  yourself with `/finance set-pool`, so the figure on record is one you chose.

### Gift cards

A gift card is a payment **method**, not a currency — a $25 Roblox gift card is
USD 25 paid by gift card. **The bot never stores gift card codes.** A code is a
bearer instrument: anyone who can read it can spend it, and a database or a
Discord embed is the wrong place for one. Record the method and, if you want, a
non-sensitive reference only.

The bot records that payments happened. It never moves money, and it will never
ask for account passwords, card details or wallet seed phrases.

### When work becomes payable

Payment state runs *pending client payment → payable → partially paid → paid*.
Work becomes payable only when it is **both** client-approved **and** the
client's payment for that project is recorded as received. For deposit
situations, `/finance mark-payable` overrides that with your reason kept on the
record.

Recording more than is outstanding is refused, which catches a mistyped amount
before it becomes a wrong record. Repeat clicks cannot double-pay; a genuinely
separate instalment still can.

---

## Permissions

Discord roles are mapped to capabilities in configuration, so you can
restructure roles without touching code.

**Defaults, as configured for this studio:**

- **You (owner)** — everything. Pay approval, payments, the full ledger and
  client decisions are owner-only.
- **Group leaders** — run their own department: offer work, reassign, hold,
  propose pay, review internally. They **cannot** change agreed pay, record
  payments, or record client decisions. A leader acting on a department they do
  not lead is refused even though they hold the capability in general.
- **Artists** — manage their own profile, post progress, submit work, and see
  their own pay. They cannot approve their own submissions or mark anything
  paid.

Grant anything to any role explicitly:

```
/studio capability mode:Grant role:@Finance capability:finance.view_all
/studio capabilities          # see every grant
```

Every change to assignments, scope, deadlines, pay, client approval and
payments is written to an audit log with the actor, the before and after
values, and a timestamp.

---

## Hosting

The bot is a single long-running Node process with a SQLite database on local
disk. It needs an always-on machine with a **persistent filesystem** — a host
with an ephemeral disk will destroy the database on restart.

Suitable: your own machine, a Raspberry Pi, a small VPS, or an Oracle Cloud
Always Free ARM instance. Not suitable without moving to Postgres: hosts whose
filesystem resets, or free web-service tiers that sleep when idle.

### Keeping it running with pm2

```bash
npm install -g pm2
pm2 start src/index.js --name studio-bot
pm2 save
pm2 startup          # follow the printed instruction so it survives reboots
pm2 logs studio-bot
```

### Or with systemd

`/etc/systemd/system/studio-bot.service`:

```ini
[Unit]
Description=Studio Operations Bot
After=network-online.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/home/youruser/discord-bot-roblox
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now studio-bot
journalctl -u studio-bot -f
```

### Upgrading

```bash
git pull
npm install
npm run deploy      # only needed if commands changed
pm2 restart studio-bot
```

Migrations run automatically at start-up and are applied once each, inside a
transaction, so a crash part-way cannot leave a half-applied schema marked as
done.

---

## Backups

Everything — profiles, projects, tasks, submissions, approvals, the audit log
and every payment record — lives in one SQLite file (`data/studio.db` by
default). **Back it up.**

Because the bot runs in WAL mode, don't just copy the file while it's running.
Use SQLite's own backup:

```bash
sqlite3 data/studio.db ".backup '/path/to/backups/studio-$(date +%F).db'"
```

A daily cron job is enough:

```cron
15 3 * * * cd /home/youruser/discord-bot-roblox && sqlite3 data/studio.db ".backup '/home/youruser/backups/studio-$(date +\%F).db'"
```

Keep backups off the machine as well. Payment records are the kind of thing you
only discover you needed after losing them.

---

## When things go wrong

| Situation | What happens |
| --- | --- |
| Somebody deletes a board message | It is re-posted on the next refresh; stale extra pages are cleaned up |
| A staff member's DMs are closed | Delivery falls back to the private staff channel; if that fails too, the sender is told rather than the notification vanishing |
| A reminder can't be delivered | It is left unmarked and retried on the next sweep |
| A reminder lands in quiet hours | It is deferred until they end, not dropped |
| A staff member leaves the server | Their profile is flagged, not deleted; submissions, approvals and payments survive, and they drop off the boards |
| A button is clicked twice | Rejected three independent ways: the state machine re-checks inside the transaction, offers resolve only from pending, and a guard key claims each action once |
| The bot loses permission to a channel | That board or notification is skipped and logged; nothing else stops |
| A deadline is typed in a DST gap | Refused with an explanation instead of being silently shifted |
| A task changes hands mid-work | The original artist's submissions are kept and the task is flagged for a compensation decision |
| A procedure is edited after people acknowledged it | Its version rises, earlier acknowledgements are kept but no longer count, and the acknowledge button for the old version is refused |
| A stand-in's cover lapses while the bot is offline | Nothing is needed: the window is checked at every permission lookup, so the powers were already gone |
| Somebody leaves owed money | It is reported and kept. Leaving does not cancel it, and nothing about their history is deleted |
| A second person joins a task that already has agreed pay | The first artist is copied into a contributor row on their existing terms, so the two records can never both be counted |
| Two people on one task are paid in different currencies | The split pool is left uncomputed and says so, rather than converting; enter it by hand with `/finance set-pool` |
| The same bonus milestone is evaluated twice | The second award is rejected by a unique key on rule, person and milestone |

---

## Tests

```bash
npm test
```

366 tests covering money parsing and per-currency totals, split exactness
(including the worked $40/$25 example, the mixed-currency refusal and
below-cost jobs), every legal and illegal task transition, repeat-click
rejection, permission scoping, DST and quiet-hours edge cases, reminder
escalation order, persistence across restarts, duplicate payment prevention,
client access boundaries, portfolio rights, task dependencies, shared work
(no double counting when a task gains a second person), the budget refusal and
its override, bonus milestones that cannot be awarded twice, version-bound procedure
acknowledgements, trial state rules, stand-in leadership windows, and
offboarding reports, template approval and placeholder safety, message
deduplication and digesting, and every client-messaging guard including the
re-check at send time, standing requirements, and repeat-order drafts that
cannot become an order until scope, price and deadline are each confirmed.

---

## Project layout

```
src/
  index.js              bot start-up and interaction routing
  deploy-commands.js    slash command registration
  commands/             one file per slash command
  interactions/         button, select menu and modal handlers
  db/
    index.js            connection and migration runner
    migrations/         schema, applied in order
    repos/              all database access
  domain/               money, allocations, task states, permissions, bulk parsing
  services/             boards, offers, reminders, summary, notifications, sample data
  utils/                timezones and reply helpers
tests/                  node:test suites
```

`db/repos` and `domain` contain no Discord code, which is what would let a web
dashboard reuse them later without a rewrite.

---

## Deliberate limits

Things this bot does **not** do, by design:

- It does not write its own words to clients. It sends only wording you wrote
  and approved, filled from records — there is no model behind it, so it cannot
  invent a date, a price or a promise. A template with a value missing does not
  send at all.
- It does not decide for clients. Approvals come from the client's own dashboard
  buttons or are recorded by staff; the bot never marks work approved itself.
- It does not read your server. The only messages it looks at are ones written
  by an authorised client account in that client's own project channel, and it
  keeps a short excerpt rather than the conversation.
- It does not move money. It records payments that happened elsewhere.
- It does not convert between currencies.
- It does not auto-assign work, and it does not stop a leader from choosing
  somebody who is busy — it warns and lets them decide.
- It does not read Ticket Tool's data. You link a ticket URL; the bot keeps its
  own records.
- It does not change anyone's availability for them, including when an away date
  passes — it asks.
