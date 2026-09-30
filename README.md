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
DATABASE_FILE=                 # optional, defaults to ./data/setup.db
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

Run **`/setup setup`** as the server owner. (The server owner can always run
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
/setup sample action:Create sample project
```

This builds a demonstration project with six tasks, one sitting in each stage
of the workflow — unassigned, pay proposed, offered, in progress, awaiting
review, and fully finished and paid — so every view has real data in it. Sample
tasks are set up directly rather than by sending real offers, so nobody is DMed
about work that does not exist.

Remove it with `/setup sample action:Remove sample data`.

---

## Command reference

There are printable PDFs, one per person, each holding only what that person can
actually use — no permissions column, grouped by what you are trying to do, and
with a page on **where the bot's output actually lands** (which channel, which
board, what arrives by DM):

| Sheet | For | Length |
| --- | --- | --- |
| **[For the team](docs/COMMANDS-staff.pdf)** | Everyone on the team | 5 pages |
| **[For group leaders](docs/COMMANDS-leader.pdf)** | Running a department | 4 pages |
| **[For the owner](docs/COMMANDS-owner.pdf)** | Money, clients, setup — includes a suggested Discord channel layout | 11 pages |

[The full reference](docs/COMMANDS.pdf) has all 36 commands and 222 subcommands in
one place with the exact capability each needs — for looking something up, rather
than reading.

All four are generated from the command definitions themselves, so they cannot
drift from the bot: `npm run reference` rebuilds them, and the test suite fails if
a command is added that has no stated audience or lands on no sheet.

The tables below are the short version.

### Everyone

| Command | What it does |
| --- | --- |
| `/profile me` | Your profile panel: timezone, details, hours, availability |
| `/profile view member:` | Somebody's profile |
| `/profile timezone timezone:` | Set your timezone (with autocomplete) |
| `/profile availability status:` | Accepting / at capacity / away, with optional return date |
| `/time member:` | Somebody's current local date and time |
| `/time department:` | Local times across a department, sorted west to east |
| `/my-work progress task: note:` | Post a progress update |
| `/my-work submit task:` | Submit finished work (checklist, then links) |
| `/my-work history task:` | Submissions, reviews and client decisions on a task |
| **`/go`** | **Start here.** Everything waiting on you, with the command for each |
| `/desk web-link` | A one-time link to open your desk in a browser |
| `/my-work earnings` | Your own pay and payment history, private to you |
| `/bonuses mine` | Your progress towards milestone bonuses, and your awards |
| `/staff-rules list` / `read key:` | Studio procedures, and acknowledging them |
| `/team trial mine` / `submit code:` | Your trial briefs, if you are on trial |
| `/task mine` | Your offers and current assignments |
| **`/find query:`** | Search everything at once — work, orders, clients, people, files. Scoped to what you may see |

### Group leaders (in departments they lead)

| Command | What it does |
| --- | --- |
| `/task queue [department:]` | Unassigned work, with a button to choose an artist per task |
| `/task assign task:` | Pick the artist and send the offer |
| `/task pay task: amount:` | Propose a figure for the owner to approve |
| `/task helpers add task: person: responsibility:` | Put a second person on a task |
| `/task helpers pay task: person: amount:` | Propose what that person is paid |
| `/task helpers list task:` | Who is on a task and what each is owed |
| `/task edit task:` | Change title, brief, deadline, formats, deliverables, revisions |
| `/task withdraw task:` | Take back an unanswered offer |
| `/review queue` | Work awaiting your internal review |
| `/review decide task:` | Request changes, or mark ready for the client |
| `/review awaiting-client` | Work sent to clients with no decision recorded yet |
| `/change reassign task: artist: reason:` | Move work, keeping the original record |
| `/change hold task: reason:` / `/change resume task:` | Pause and unpause |
| `/team recommend new person: kind: note:` | Put somebody forward for a trial or promotion |
| `/who-is-free [days:] [group:]` | Who has room for more work, and who has not |

### Owner

| Command | What it does |
| --- | --- |
| `/orders create name: …` | Create a project (budget, deadline, manager, finder, mod, ticket link) |
| `/orders bulk project: spec:` | `"12 models, 4 vfx, 2 animations"` → 18 routed tasks |
| `/orders view` / `list` / `tasks` / `edit` | Project views and edits |
| `/task create` | A single task |
| `/task pay` / `/task approve-pay` | Set or approve agreed pay |
| `/review client task: decision:` | Record what the client decided |
| `/pay client-receipt project: amount:` | Record money received from a client |
| `/pay pay task: [person:]` | Record a payout to somebody who worked on the task |
| `/pay pay-split task: share:` | Record a finder / leader / mod / owner share |
| `/pay splits task:` | See how a task's pool divides |
| `/pay set-pool task: amount: currency:` | Enter the pool by hand when currencies differ |
| `/pay mark-payable task: reason:` | Make approved work payable before the client pays |
| `/pay ledger` / `outstanding` / `balance member:` | Money views |
| `/pay budget project:` | Committed pay against what the client pays |
| `/pay budget-override project: reason:` | Deliberately allow over-budget pay, on the record |
| `/pay budget-restore project:` | Put the guard back |
| `/pay approve-all [project:] [preview:]` | Approve every pay figure your leaders proposed, budget-checked one by one |
| `/pay confirm-received payment:` | They say the money actually reached them |
| `/pay mark-failed payment: reason:` | Sent and never arrived — they are owed it again |
| `/pay sent` | Payments sent that nobody has confirmed either way |
| `/money-in add project: label: amount:` | Split what a client owes into named parts |
| `/money-in list project:` | Which parts are covered, and what is still to come |
| `/money-in invoiced id:` / `waive id: reason:` / `remove id:` | Asked for, not charging, or entered by mistake |
| `/bonuses rule-set key: label: threshold: amount:` | A milestone rule, e.g. every 10 approved animations |
| `/bonuses pending` / `approve id:` / `decline id: reason:` / `pay id:` | Decide and record bonuses |
| `/change cancel task: reason:` | Cancel, preserving history |
| `/change compensate task: member: amount:` | Pay for work done on cancelled or moved work |
| `/change flags` | Everything waiting on a decision from you |
| `/reports now` / `post` / `schedule` / `run-reminders` | Management digest and reminder controls |
| `/team trial offer person: title: brief: terms:` | Send a paid trial brief |
| `/team trial decide code: outcome: feedback:` | Pass or fail a submitted trial |
| `/team recommend list` / `decide id:` | Recommendations from your leaders |
| `/team stand-in grant person: department: until:` | Temporary leadership cover |
| `/team offboard preview person:` / `start` | What somebody leaves behind |
| `/staff-rules set key: title: body:` | Write a procedure everyone acknowledges |
| `/staff-rules who key:` | Who has read the current version |
| `/messages template-set` / `template-approve` | Write and approve client message wording |
| `/messages queue` / `history client:` | What is waiting to send, and what was sent |
| `/messages prefs client:` | Opt-in, weekly limit, pause, follow-up owner |
| `/messages replies` / `handled id:` | Clients waiting on an answer |
| `/messages offer project:` | Queue the approved cross-service offer |
| `/clients add-requirement client:` | Something this client always asks for |
| `/reorder from project:` | Start a repeat order from a past one |
| `/reorder scope` / `price` / `deadline` / `create` | Confirm each term, then create it |
| `/reports overview` / `filter which:` | Nine filters phrased as plain questions |
| `/reports waiting project:` | Where an order's time actually went |
| `/reports person:` / `team` | A rounded picture of somebody's work — no score |
| `/reports payouts` / `attention` | Who is owed, and which orders have stalled |
| `/setup auto set` / `preview` / `on` / `off` | Rules that watch for something and tell somebody |
| `/setup backup now` / `verify` / `restore` | A copy you can restore from, and how to do it |
| `/setup backup export what:` | Readable CSV — explicitly not a backup |
| `/setup web identity` / `service` / `page` | What the public site says about the studio |
| `/setup web client-email` / `sign-in-link` | Let a client use the website without Discord |
| `/setup web status` | What the public site currently shows |
| `/proof add file: kind:` | Keep a screenshot as proof — the file itself, not a link to it |
| `/proof list` / `show id:` / `verify` | What is filed, get one back, check none have changed |
| `/proof record project:` | The whole record of an order, as a file, for a dispute |
| `/files roblox-id asset: id:` | Record the Roblox asset ID a file was uploaded as |
| `/files roblox-ids project:` | Every Roblox asset ID on an order |
| `/setup doctor` | Everything quietly misconfigured, worst first |
| `/setup …` | All configuration |

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

More than one person can work on a single deliverable. `/task helpers add` puts them
on the task with a stated responsibility, and each person's pay is agreed
**separately** — a leader proposes, you approve, exactly as for a sole artist.

Three things follow from that, deliberately:

- **Nobody is counted twice.** The moment a second person joins, the original
  artist is copied into a contributor row carrying their existing agreed figure.
  From then on the contributor rows are the truth, and the task's own pay column
  is no longer added on top of them.
- **Nobody sees anyone else's rate.** `/task helpers list` shows full figures to you
  and to the department's leader; everybody else sees their own figure and only
  "pay agreed" against their colleagues.
- **The task is paid when the last person is paid.** `/pay pay` asks which
  person the payout is for, and the task stays *partially paid* until everybody
  on it is settled.

Removing somebody with `/task helpers remove` stops them counting towards the task's
cost but keeps their record and any payments already made to them.

### The budget guard

Pay that would commit more than the client is paying for a project is
**refused**, not merely flagged. You have three honest ways past it:

1. lower the figure,
2. record more client money (`/pay client-receipt` and the project amount),
3. or decide deliberately to take the loss —
   `/pay budget-override project: reason:`, which is recorded against the
   project and shown wherever the budget is.

`/pay budget project:` shows committed pay against the client payment at any
time. Pay in a currency the client did not use is listed separately and **not**
measured against the budget, because there is no conversion rate to measure it
with.

### Bonus milestones

`/bonuses rule-set` creates a rule such as *every 10 approved animations earns
$20*, optionally limited to one department. Only client-approved work counts,
and a task counts once per person however they contributed to it.

When a milestone is reached the bot **flags it for you and stops**. Nothing is
owed until `/bonuses approve`, and nothing is recorded as paid until `/bonuses pay`.
Each milestone is indexed, so re-running the check — or two approvals landing at
the same moment — cannot award the same milestone twice.

### Reports, and two things they refuse to do

`/reports waiting project:<code>` splits an order's elapsed time into **time with
us** and **time with the client**, reconstructed from the audit trail. A report
that cannot tell those apart gets the wrong person blamed, so they are never
added together.

`/reports person:` and `/reports team` give a rounded picture — approved work, how
much is in hand, on-time record measured only against deadlines that were
actually agreed, revision rounds — and deliberately produce **no score**. There
is no single number here to sort by, the team list is in name order, and it says
so on the footer. A league table of task counts rewards whoever takes the small
jobs.

### Automation rules

`/setup auto set` builds a rule out of two closed lists: something to watch for,
and something to do. The action list is short on purpose — tell you, tell the
task's leader, tell one named person, or flag the task. **No rule can change
pay, approve work, offer a task or message a client.** A rule is not a script.

Every new or changed rule starts **switched off**, and `/setup auto preview`
shows exactly which tasks it would act on before you allow it. Each task is
acted on once per rule, ever, so a daily rule never becomes a daily nag about
the same thing.

### Backups versus exports

These are different things and the bot keeps saying so, because somebody who
keeps only spreadsheets finds out on the worst possible day that they cannot put
the studio back.

- `/setup backup now` takes a **consistent copy of the database** using SQLite's own
  online backup — not a file copy, which taken mid-write produces a file that
  looks fine and is not. It then opens the result and runs an integrity check,
  and tells you if that failed.
- `/setup backup verify` opens a backup file and checks it is really a database. A
  backup nobody has ever opened is a hope, not a backup.
- `/setup backup export what:` gives readable CSV for a person or a spreadsheet, and
  says on every single one that it is not a backup. **Payment references are
  left out** of the export: one of them could be a gift card code, and a gift
  card code in a spreadsheet is money lying in the open.
- `/setup backup restore` prints the steps, including the one that silently corrupts a
  restore if you miss it — moving the `-wal` file aside.

`/setup backup now` also copies the **filed proof** (see below) next to the database
backup, as `studio-<timestamp>-evidence/`. It has to: the database holds each
file's hash and path, not its bytes. A restored database without those files
comes back with a complete set of proof records that all read as missing, which
looks like the proof was deleted. **Copy the two together**, or you have kept the
index to evidence you no longer hold.

### Screenshots kept as proof

`/proof add file: kind:` files a screenshot or document against an order, a task
or a client. What it keeps is **the file itself, not a link to it** — because a
Discord attachment URL is signed, expires, and stops working for good once the
message is deleted. A stored link is not proof; it is a bet that Discord is still
holding something for you on the day somebody disputes an invoice.

Each file is hashed with SHA-256 when it is filed, and:

- **The same file filed twice is one record**, not two, since the hash is the
  same.
- `/proof show id:` **refuses** a file whose bytes no longer match the hash
  recorded when it was filed. A changed file is worse than a missing one, so it
  is never handed back as if it were fine.
- `/proof verify` checks every filed file at once and separates intact, missing
  from disk, and changed since filing.
- **Only images, PDFs and plain text are accepted**, up to 8 MB. An evidence
  store that takes executables is a way to pass malware around with the studio's
  name on it.

`/proof record project:` produces the whole record of one order as a text file:
what was agreed, every submission and when it was released to the client, every
client decision, money in and out, the filed proof with its hashes, and the audit
trail. Every timestamp in it was written when the thing happened, not when the
document was produced.

It also lists the **gaps**: "no record of anybody accepting the terms", "nothing
was ever released to the client to look at", "no screenshots have been filed".
A gap said out loud is worth more than one you discover mid-chargeback.

### Roblox asset IDs

`/files roblox-id asset: id:` records what a file was actually uploaded as. The
ID is what lasts — it is what goes in a script, and it stays findable when the
original file does not. Paste the ID or any link containing it; the digits are
kept, so a pasted store URL is not stored as if it were an ID. `/find` searches
them, which is the point of recording them.

### Who has room for more work

`/who-is-free [days:] [group:]` answers the question you ask before saying yes to a
client. It reads availability, recorded absences with their return dates, and
what each person is carrying — split into work due before the window (should be
finished), due inside it (competes with anything new), running past it, and
**work with no deadline at all**.

Two things it deliberately does not do:

- **It uses your cap, or none at all.** Where a department has a task cap set
  (`/setup department task_cap:`), that is the limit — the same figure the assign
  flow already warns you about, so the two cannot disagree. Where no cap is set it
  shows the load and names the departments it cannot measure, instead of inventing
  a threshold the studio never chose.
- **It does not assume undated work is finished.** Work with no deadline is
  counted as work and the count is stated, because assuming otherwise is exactly
  what overbooks people.

Leaders see the departments they lead; the owner sees the studio.

### Approving pay in bulk

`/pay approve-all` says yes to every figure your leaders have proposed. Work
cannot be offered until pay is decided, so on a busy week that queue is the
bottleneck.

It approves **only what somebody already proposed** — it never invents a figure,
so you are still the one deciding. Each one is budget-checked in turn, as if
approved on its own, which means approving five together can refuse the fifth for
exactly the reason approving it last would have. The rest still go through:
five good figures should not be thrown away because the sixth would blow the
budget. `preview:true` shows what would happen and changes nothing.

### Repeat orders

`/reorder from project:<code>` copies what a previous order **was** — its brief,
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
draft until `/messages template-approve`, and rewriting an approved one takes
the approval away again, so nothing goes out in words nobody signed off.

Templates are filled from a closed list of placeholders (`/messages
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

Everything sent, held back or failed is on the record — `/messages queue` and
`/messages history`. A send that fails is marked failed with the reason, never
silently dropped.

Noticing a client reply needs Discord's **Message Content** intent. Without it
the bot still knows somebody wrote and still pauses, it just cannot quote them.

### Procedures, trials and leaving

**Procedures** are text the studio expects staff to have read. Acknowledgement
is bound to a *version*: editing the text raises the version, which makes every
earlier acknowledgement stale rather than quietly carrying it forward. Agreeing
to version 1 is not agreeing to version 2, and the record says so. `/staff-rules
who` shows who has read the current version and who has not, counting only the
people it applies to.

**Trials** are paid briefs with the terms written down before the work starts.
The candidate accepts explicitly, and what they accepted is snapshotted, so a
later edit cannot rewrite the deal behind them. A trial cannot be submitted
before it is accepted, and cannot be decided before it is submitted. Trial pay
is owed whatever the outcome.

**Recommendations** (`/team recommend`) let a leader put somebody forward. That is
all they do: the bot never grants or removes a Discord role, so who actually
gets promoted stays a human decision made in Discord.

**Stand-in leaders** cover a department for a stated period. They get exactly a
leader's powers, in that department only. The window is re-checked every time
permissions are worked out, so the cover ends on time even if the bot was
offline when it lapsed and even though nothing is scheduled to take it away.

**Offboarding** reports rather than deletes. `/team offboard preview` shows
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

1. a pool you entered by hand (`/pay set-pool`)
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
  yourself with `/pay set-pool`, so the figure on record is one you chose.

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
Work becomes payable when it is client-approved **and** the client money already
received still covers what that task owes, after everything the order has
already paid out.

That last clause is the whole rule. A deposit funds work up to the value of the
deposit and no further: with $40 in and two $25 tasks approved, the first is
payable, and once it is actually paid the second drops back to pending, because
there is only $15 of headroom left. Nothing is ever payable out of money that
has not arrived.

Currencies never mix. Robux received does not make a dollar payout payable,
because there is no rate that would make that true — and the bot has no
conversion function anywhere, on purpose.

`/pay mark-payable` still overrides all of it, with your reason kept on the
record, for when you are paying somebody out of studio funds.

Recording more than is outstanding is refused, which catches a mistyped amount
before it becomes a wrong record. Repeat clicks cannot double-pay; a genuinely
separate instalment still can.

### Deposits, in named parts

`/money-in add project: label: amount:` splits what a client owes into parts you
name — "Deposit", "On delivery", "Rush fee". Receipts fill the parts in order:
there is no guessing which payment was meant for which part, because the client
sent money and it counts towards whatever they owe soonest.

```
/money-in add project:PRJ-0004 label:Deposit amount:40 due:before work starts
/money-in add project:PRJ-0004 label:On delivery amount:60
/money-in list project:PRJ-0004
```

Three things it refuses or reports rather than smoothing over:

- **A part in a second currency is refused.** With no rate between Robux and
  dollars, a part in the other currency could never be paid off — it would sit
  as a debt forever.
- **Money beyond the parts is reported, not absorbed.** More in than the parts
  add up to usually means a part is missing from the list or the client paid
  twice. Both are worth knowing.
- **Parts that do not add up to the order's price are flagged** when you add
  one, because that is a miscount you want to hear about now.

`/money-in waive id: reason:` stops charging a part — it stops counting as owed,
which can make more work payable. `/money-in invoiced id:` records that you asked
the client for it. A part already asked for cannot be deleted, only waived, so
the record of having asked survives.

The budget guard measures against the parts when an order is priced entirely
through them. Without that, an order with no single price would have no budget
at all and the guard would quietly stop guarding.

### Sent is not landed

A Robux group payout, a gift card, a bank transfer — each can be sent and still
not arrive, and "the studio says it paid, the artist says it never came" is a bad
place to end up. So the two are separate facts:

| Command | What it records |
| --- | --- |
| `/pay pay` | The studio sent it |
| `/pay confirm-received payment:` | They say it arrived |
| `/pay mark-failed payment: reason:` | It was sent and never arrived |
| `/pay sent` | Everything sent that nobody has confirmed either way |

A failed payment is **not deleted**. The attempt happened, and erasing it would
leave the ledger claiming money went out when it did not. It stops counting as
paid instead — so the artist is owed again, the work usually goes straight back
to payable, and the studio totals and their earnings both exclude it. The person
is told automatically, with the reason.

Confirming twice keeps the first timestamp, because that is when it actually
happened. A payment already confirmed cannot then be marked failed.

---

## When something is quietly wrong

`/setup doctor` looks for the failures that come with no error message:

- **no fallback channel** — offers go by DM, and anybody with DMs closed simply
  never gets them; nothing tells you it happened
- **staff with no timezone** — their deadlines are read as UTC, so the date
  looks right and lands hours out
- **a client with orders and no authorised account or email** — the dashboard
  posted in their channel opens for nobody
- **departments with no leader role** — every task in them waits on you
  personally
- **templates written but never approved** — nothing sends, by design
- pay waiting on your approval, and work nobody has picked up in a week

Findings are ordered by consequence: what will silently not work, what works
until it doesn't, and what is merely worth knowing. Every one says what to do
about it — a problem with no stated remedy is just an accusation. When there is
nothing to report it says so, rather than manufacturing advice.

---

## One command to remember

`/go` is the answer to "is anything waiting on me?". It reads what is recorded,
sorts by how pressing it is, and prints the command for each item so nothing has
to be recalled:

```
3 things waiting on you

💰 1 pay figure proposed and waiting on you — the work cannot be offered until you decide
┗ /task approve-pay

🔴 2 of your tasks are past the deadline: TSK-0012, TSK-0019
┗ /my-work progress to say where it stands, or /my-work blocked if something is in the way

💬 1 client has written in and nobody has answered — their automated messages are paused until somebody does
┗ /messages replies
```

Nothing appears there that you would then be refused: every item is gathered
under the same permission checks as the command it names. An artist never sees
the owner's decisions, and a leader sees their own department rather than the
studio. If nothing is waiting, it says so plainly rather than inventing
something to suggest.

---

## The website

Two ways to serve the same pages, because free static hosting is everywhere and
free Node hosting is not.

```bash
npm run site   # renders the public pages to files, for any static host
npm run web    # runs the live site, for the client and staff areas
```

**The public pages** — services, work, about, quote — are written by you with
`/setup web` and shown verbatim. Nothing about them is generated. The portfolio draws
only on work a client has explicitly permitted, and shows no client name, no
project code, no price and no dates: permission to show the work is not
permission to say who paid for it.

**The client area** needs the database, so it only runs under `npm run web`. A
client signs in with a one-time link — `/setup web sign-in-link` — which works once
and expires in 30 minutes. An order opens only if it belongs to the client the
session is for, so changing the number in the address bar gets a 404 rather than
somebody else's order.

**The staff area** is read-only, completely. `/desk web-link` gives you a link
to check your work from a phone. Every action in this studio is a decision with
a name attached, and the bot already records who made it; a web page that could
make those decisions would be a second, weaker door to the same thing.

Sessions and login links are stored hashed, so a copy of the database is not a
set of live logins. A client link cannot open the staff area and a staff link
cannot open a client's orders — the two routes read different columns, and the
database refuses a token that claims to be both.

### Hosting the two halves separately

The public pages are plain files with no scripts and one stylesheet, so they run
on any host that serves text — including free PHP hosts that cannot run Node:

```bash
WEB_GUILD_ID=<your server id> npm run site
# then upload the contents of data/site/ over FTP
```

Set `WEB_APP_URL` to wherever the live site runs and the static quote form will
post to it. Without that, the quote page tells visitors to get in touch instead
of showing a form that goes nowhere. Set `SITE_URL` to the public address and
the export also writes a `sitemap.xml` — without it there is no sitemap, because
a sitemap pointing at the wrong domain is worse than none.

### TLS and a real domain

`deploy/Caddyfile.example` is a working template. Caddy is the recommendation
because it obtains and renews the certificate itself — there is no renewal cron
to forget, which is how most hobby sites end up serving an expired certificate.

```bash
sudo apt install caddy
sudo cp deploy/Caddyfile.example /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile    # your hostname and email
sudo systemctl reload caddy
```

Two things it does beyond terminating TLS: it sets `X-Forwarded-For` (which is
what makes `TRUST_PROXY=1` correct — see below), and it strips the `token` query
parameter from its logs, because that parameter is a live sign-in link.

The website process should then listen on localhost only, so Caddy is the sole
thing reachable from outside.

### If you put a proxy in front

Set `TRUST_PROXY=1` **only** when something really does sit in front and set
`X-Forwarded-For` — Caddy, nginx, Cloudflare. Without a proxy, leave it unset:
anybody can send that header, and believing it lets one sender walk straight
past the rate limits by changing it on every request.

`/healthz` answers `ok` or `unhealthy` for an uptime monitor, and deliberately
says nothing else — a health check that leaks versions or row counts is free
reconnaissance.

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
/setup capability mode:Grant role:@Finance capability:finance.view_all
/setup capabilities          # see every grant
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

### One paste on a fresh Ubuntu box

```bash
git clone -b claude/vigilant-noether-0lxjky https://github.com/ayanchhatani06-wq/discord-bot-roblox.git
cd discord-bot-roblox
bash deploy/setup-ubuntu.sh
```

It adds swap if the box is small (a 1 GB shape runs out of memory compiling
`better-sqlite3`, and the failure looks like an unrelated compiler error), pins
**Node 22** (newer Node has no prebuilt binary for `better-sqlite3`), installs
the dependencies and writes systemd units for the bot and the website.

It deliberately does **not** write your `.env` or start anything. The token
should go straight from Discord into the file, and nothing should start before
you have looked at what it is about to run as. The script prints the three
remaining steps.

Running it twice is safe — every step checks before it acts.

### Backups that survive losing the box

`/setup backup now` writes a verified copy to `data/backups`, on the same disk as the
database it is protecting. That is a second copy of a file, not a backup.

```bash
BACKUP_DESTINATION=user@other-host:/backups deploy/backup-offsite.sh
```

Takes a fresh copy with SQLite's own backup, opens it and runs an integrity
check, copies it off the box, and only then prunes old local ones — so a failing
job can never delete your last good backup.

It also tars up the filed proof as `studio-<timestamp>-evidence.tar.gz` and sends
that too, then reads the archive back to check it is really an archive. Both files
go to the destination, because the database alone gives you proof records with
nothing behind them.

It needs the `sqlite3` command line tool on the box (`sudo apt install sqlite3`).
Put it in cron:

```
17 3 * * * /home/ubuntu/discord-bot-roblox/deploy/backup-offsite.sh >> ~/setup backup.log 2>&1
```

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
and every payment record — lives in one SQLite file (`data/setup.db` by
default). **Back it up.**

Because the bot runs in WAL mode, don't just copy the file while it's running.
Use SQLite's own backup:

```bash
sqlite3 data/setup.db ".backup '/path/to/backups/studio-$(date +%F).db'"
```

A daily cron job is enough:

```cron
15 3 * * * cd /home/youruser/discord-bot-roblox && sqlite3 data/setup.db ".backup '/home/youruser/backups/studio-$(date +\%F).db'"
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
| Two people on one task are paid in different currencies | The split pool is left uncomputed and says so, rather than converting; enter it by hand with `/pay set-pool` |
| The same bonus milestone is evaluated twice | The second award is rejected by a unique key on rule, person and milestone |

---

## Tests

```bash
npm test
```

451 tests covering money parsing and per-currency totals, split exactness
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
cannot become an order until scope, price and deadline are each confirmed,
waiting-time attribution, automation rules that act once per task, CSV quoting,
backups that are verified by opening them, that every value written into a web
page is escaped, that a client cannot open another client's order by changing
the address, that a staff link and a client link cannot open each other's area,
and that the static export never writes a client page.

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
