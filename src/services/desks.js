const { EmbedBuilder } = require('discord.js');
const tasksRepo = require('../db/repos/tasks');
const projectsRepo = require('../db/repos/projects');
const offersRepo = require('../db/repos/offers');
const staffRepo = require('../db/repos/staff');
const configRepo = require('../db/repos/config');
const submissionsRepo = require('../db/repos/submissions');
const clientsRepo = require('../db/repos/clients');
const enquiriesRepo = require('../db/repos/enquiries');
const escalationsRepo = require('../db/repos/escalations');
const planningRepo = require('../db/repos/planning');
const paymentsRepo = require('../db/repos/payments');
const paymentState = require('./paymentState');
const budget = require('./budget');
const allocationFlow = require('./allocationFlow');
const delivery = require('./delivery');
const { TASK_STATES, ACTIVE_STATES, stateLabel } = require('../domain/taskState');
const { formatAmount, formatTotals, totalsByCurrency } = require('../domain/money');
const { discordTimestamp, formatTimeInZone, DAY_MS } = require('../utils/time');

const EMPTY = '_nothing_';

function truncate(lines, limit = 1024) {
  const text = lines.join('\n');
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : (text || EMPTY);
}

/**
 * One artist's own work in one place, so nobody has to remember which of a
 * dozen commands shows what. Contains their own pay, so it is always private.
 */
function buildMyDesk(db, guildId, userId, { now = Date.now() } = {}) {
  const staff = staffRepo.getStaff(db, guildId, userId);
  const offers = offersRepo.listPendingForArtist(db, guildId, userId);
  const assigned = tasksRepo.listTasksForArtist(db, guildId, userId, { states: ACTIVE_STATES });

  const active = assigned.filter((task) => task.state !== TASK_STATES.OFFERED);
  const revisions = assigned.filter((task) => task.state === TASK_STATES.REVISION_NEEDED);
  const overdue = active.filter((task) => task.deadline_utc && task.deadline_utc < now);
  const dueSoon = active.filter((task) => task.deadline_utc && task.deadline_utc >= now && task.deadline_utc - now <= 3 * DAY_MS);

  const owed = [];
  const payable = [];
  for (const task of tasksRepo.listTasksForArtist(db, guildId, userId, {
    states: [TASK_STATES.CLIENT_APPROVED, TASK_STATES.AWAITING_CLIENT, ...ACTIVE_STATES],
  })) {
    // Their own agreed figure, which on a shared task is their contributor
    // line rather than the task total.
    const entry = paymentState.owedToContributor(db, task, userId);
    if (!entry) continue;
    if (entry.remainingMinor > 0) {
      owed.push({ minor: entry.remainingMinor, currency: entry.currency });
      if (task.payment_state === 'payable' || task.payment_state === 'partially_paid') {
        payable.push({ task, remaining: entry.remainingMinor, currency: entry.currency });
      }
    }
  }

  const paid = paymentsRepo.payoutTotalsForPayee(db, guildId, userId);
  const recent = submissionsRepo.listRecentByUser(db, guildId, userId, { limit: 5 });

  const embed = new EmbedBuilder()
    .setTitle('My Desk')
    .setColor(0x5865f2)
    .setDescription(
      staff
        ? `${staffRepo.AVAILABILITY_EMOJI[staff.availability]} ${staffRepo.AVAILABILITY_LABELS[staff.availability]}` +
          `${staff.timezone ? ` · ${formatTimeInZone(staff.timezone, new Date(now))} your time` : ' · _no timezone set_'}`
        : 'You have no studio profile yet — use the buttons below to create one.'
    );

  embed.addFields(
    {
      name: `📨 Offers waiting for you (${offers.length})`,
      value: truncate(offers.map((offer) => {
        const task = tasksRepo.getTask(db, guildId, offer.task_id);
        return `**${task.code}** ${task.title} · offered ${discordTimestamp(offer.offered_at, 'R')}`;
      })),
      inline: false,
    },
    {
      name: `🛠️ Current assignments (${active.length})`,
      value: truncate(active.map((task) =>
        `**${task.code}** ${task.title} · ${stateLabel(task.state)}` +
        `${task.deadline_utc ? ` · due ${discordTimestamp(task.deadline_utc, 'R')}` : ''}`
      )),
      inline: false,
    }
  );

  if (revisions.length > 0) {
    embed.addFields({
      name: `🔁 Changes requested (${revisions.length})`,
      value: truncate(revisions.map((task) => `**${task.code}** ${task.title} — resubmit with \`/work submit\``)),
      inline: false,
    });
  }

  const myBlockers = planningRepo.listOpenBlockers(db, guildId).filter((row) => row.raised_by === userId);
  if (myBlockers.length > 0) {
    embed.addFields({
      name: `🚧 Your open blockers (${myBlockers.length})`,
      value: truncate(myBlockers.map((row) =>
        `**${row.code}** ${row.title} — raised ${discordTimestamp(row.created_at, 'R')}\n┗ ${row.reason.slice(0, 120)}`
      )),
      inline: false,
    });
  }

  if (overdue.length > 0 || dueSoon.length > 0) {
    embed.addFields({
      name: '📅 Deadlines',
      value: truncate([
        ...overdue.map((task) => `🔴 **${task.code}** overdue since ${discordTimestamp(task.deadline_utc, 'R')}`),
        ...dueSoon.map((task) => `🟡 **${task.code}** due ${discordTimestamp(task.deadline_utc, 'R')}`),
      ]),
      inline: false,
    });
  }

  embed.addFields({
    name: '💰 Your pay',
    value: [
      `Owed to you: **${formatTotals(totalsByCurrency(owed))}**`,
      `Paid to date: ${formatTotals(paid)}`,
      payable.length > 0
        ? `${payable.length} task(s) are payable now: ${payable.map((entry) => entry.task.code).join(', ')}`
        : 'Nothing is payable yet — work becomes payable once the client has approved it and paid.',
    ].join('\n'),
    inline: false,
  });

  if (recent.length > 0) {
    embed.addFields({
      name: '📤 Your recent submissions',
      value: truncate(recent.map((row) =>
        `**${row.task_code}** v${row.version} ${row.kind} · ${discordTimestamp(row.submitted_at, 'R')}`
      )),
      inline: false,
    });
  }

  embed.setFooter({ text: 'Only you can see this. Pay figures are never shown to anyone else.' });
  return { embed, counts: { offers: offers.length, active: active.length, overdue: overdue.length } };
}

/**
 * A leader's view of their own department: what needs a decision from them,
 * and the facts they need to make it.
 */
function buildGroupDesk(db, guildId, department, { now = Date.now() } = {}) {
  const queue = tasksRepo.listQueue(db, guildId, department.id);
  const blockedByPay = queue.filter((task) => !tasksRepo.isPayApproved(task));

  const inDepartment = (task) => task.department_id === department.id;
  const offered = tasksRepo.listTasksInStates(db, guildId, [TASK_STATES.OFFERED]).filter(inDepartment);
  const inReview = tasksRepo.listTasksInStates(db, guildId, [TASK_STATES.INTERNAL_REVIEW]).filter(inDepartment);
  const awaitingClient = tasksRepo.listTasksInStates(db, guildId, [TASK_STATES.AWAITING_CLIENT]).filter(inDepartment);
  const live = tasksRepo.listTasksInStates(db, guildId, ACTIVE_STATES).filter(inDepartment);

  const overdue = live.filter((task) => task.deadline_utc && task.deadline_utc < now);
  const dueSoon = live.filter((task) => task.deadline_utc && task.deadline_utc >= now && task.deadline_utc - now <= 3 * DAY_MS);

  const staffRows = staffRepo.listStaff(db, guildId, { departmentId: department.id });
  const counts = staffRepo.activeTaskCounts(db, guildId);

  const embed = new EmbedBuilder()
    .setTitle(`Group Desk · ${department.name}`)
    .setColor(0x9b59b6)
    .setDescription(`${staffRows.length} staff · ${live.length} live task(s) · ${queue.length} waiting for an artist`);

  embed.addFields(
    {
      name: `📥 Unassigned (${queue.length})`,
      value: truncate(queue.slice(0, 8).map((task) =>
        `**${task.code}** ${task.title}` +
        `${task.deadline_utc ? ` · due ${discordTimestamp(task.deadline_utc, 'R')}` : ''}` +
        `${tasksRepo.isPayApproved(task) ? '' : ' · ⚠️ pay not approved'}`
      )),
      inline: false,
    },
    {
      name: `⏳ Offered, not answered (${offered.length})`,
      value: truncate(offered.map((task) =>
        `**${task.code}** ${task.title} → <@${task.artist_user_id}>` +
        `${task.updated_at ? ` · ${discordTimestamp(task.updated_at, 'R')}` : ''}`
      )),
      inline: false,
    },
    {
      name: `🔍 Waiting for your review (${inReview.length})`,
      value: truncate(inReview.map((task) => `**${task.code}** ${task.title} · from <@${task.artist_user_id}>`)),
      inline: false,
    },
    {
      name: `📤 With the client (${awaitingClient.length})`,
      value: truncate(awaitingClient.map((task) => `**${task.code}** ${task.title} · since ${discordTimestamp(task.updated_at, 'R')}`)),
      inline: false,
    }
  );

  if (overdue.length > 0 || dueSoon.length > 0) {
    embed.addFields({
      name: '🔴 Deadline risk',
      value: truncate([
        ...overdue.map((task) =>
          `🔴 **${task.code}** ${task.title} — overdue ${discordTimestamp(task.deadline_utc, 'R')} · ` +
          `${task.artist_user_id ? `<@${task.artist_user_id}>` : 'unassigned'}`
        ),
        ...dueSoon.map((task) => `🟡 **${task.code}** ${task.title} — due ${discordTimestamp(task.deadline_utc, 'R')}`),
      ]),
      inline: false,
    });
  }

  const blockers = planningRepo.listOpenBlockers(db, guildId, { departmentId: department.id });
  const extensions = planningRepo.listDeadlineRequests(db, guildId, { status: 'pending', departmentId: department.id });

  if (blockers.length > 0 || extensions.length > 0) {
    embed.addFields({
      name: `🚧 Blocked and waiting on you (${blockers.length + extensions.length})`,
      value: truncate([
        ...blockers.map((row) => `🚧 **${row.code}** <@${row.raised_by}> — ${row.reason.slice(0, 100)}`),
        ...extensions.map((row) =>
          `📅 **${row.code}** <@${row.requested_by}> asks for ${discordTimestamp(row.requested_deadline, 'd')} (#${row.id})`
        ),
      ]),
      inline: false,
    });
  }

  embed.addFields({
    name: '👥 Capacity',
    value: truncate(staffRows.slice(0, 12).map((staff) => {
      const load = counts.get(staff.user_id) || 0;
      const cap = department.task_cap ? `/${department.task_cap}` : '';
      return `${staffRepo.AVAILABILITY_EMOJI[staff.availability]} <@${staff.user_id}> — ${load}${cap} active` +
        `${staff.timezone ? ` · ${formatTimeInZone(staff.timezone, new Date(now))}` : ''}`;
    })),
    inline: false,
  });

  if (blockedByPay.length > 0) {
    embed.setFooter({ text: `${blockedByPay.length} task(s) cannot be offered until the owner approves their pay.` });
  }

  return { embed, counts: { queue: queue.length, inReview: inReview.length, overdue: overdue.length } };
}

/**
 * Everything waiting on the owner, gathered rather than scattered. This is the
 * only desk that shows studio-wide money.
 */
function buildOwnerDesk(db, guildId, { now = Date.now() } = {}) {
  const projects = projectsRepo.listProjects(db, guildId, { status: 'active', limit: 50 });
  const departments = configRepo.listDepartments(db, guildId);

  const payProposals = db.prepare(`
    SELECT * FROM tasks WHERE guild_id = ? AND pay_state = 'proposed' ORDER BY pay_proposed_at
  `).all(guildId);

  const flagged = db.prepare(`
    SELECT * FROM tasks WHERE guild_id = ? AND (scope_review_flag = 1 OR compensation_review_flag = 1)
    ORDER BY updated_at DESC
  `).all(guildId);

  const draftQuotes = db.prepare(`
    SELECT q.*, e.code AS enquiry_code FROM quotes q
    JOIN enquiries e ON e.id = q.enquiry_id
    WHERE q.guild_id = ? AND q.status = 'draft' ORDER BY q.prepared_at
  `).all(guildId);

  const undecidedIssues = clientsRepo.listRequests(db, guildId, { status: 'open', limit: 50 })
    .filter((request) => request.kind === 'delivery_issue' && !request.decision);
  const openBlockers = planningRepo.listOpenBlockers(db, guildId);
  const deadlineRequests = planningRepo.listDeadlineRequests(db, guildId, { status: 'pending' });
  const atRisk = planningRepo.downstreamAtRisk(db, guildId);
  const openEscalations = escalationsRepo.list(db, guildId, { status: 'open', limit: 25 });
  const awaitingClient = tasksRepo.listTasksInStates(db, guildId, [TASK_STATES.AWAITING_CLIENT]);
  const pendingDelivery = delivery.undeliveredApproved(db, guildId);

  const pending = paymentState.pendingPayouts(db, guildId);
  const owedArtists = pending.payable
    .flatMap((task) => paymentState.owedOnTask(db, task))
    .map((entry) => ({ minor: entry.remainingMinor, currency: entry.currency }))
    .filter((entry) => entry.minor > 0 && entry.currency);
  const owedShares = allocationFlow.outstandingAllocations(db, guildId)
    .map((row) => ({ minor: row.outstanding_minor, currency: row.currency }));
  const money = paymentsRepo.totalsByDirection(db, guildId);

  // A job is a budget exception when what the artists are paid meets or beats
  // what the client pays, in the same currency.
  const budgetExceptions = budget.projectsOverBudget(db, guildId);

  const workload = new Map();
  for (const task of tasksRepo.listTasksInStates(db, guildId, ACTIVE_STATES)) {
    const name = departments.find((dept) => dept.id === task.department_id)?.name || 'Unknown';
    workload.set(name, (workload.get(name) || 0) + 1);
  }

  const decisions = [
    payProposals.length > 0 ? `${payProposals.length} pay proposal(s) — \`/task approve-pay\`` : null,
    draftQuotes.length > 0 ? `${draftQuotes.length} draft quote(s) awaiting your approval — \`/enquiry approve-quote\`` : null,
    undecidedIssues.length > 0 ? `${undecidedIssues.length} client problem(s) not yet judged — \`/issues list\`` : null,
    flagged.length > 0 ? `${flagged.length} task(s) flagged for scope or compensation — \`/manage flags\`` : null,
    openEscalations.length > 0 ? `${openEscalations.length} staff concern(s) — \`/escalate list\`` : null,
    pendingDelivery.length > 0 ? `${pendingDelivery.length} approved item(s) not yet released — \`/deliver pending\`` : null,
    openBlockers.length > 0 ? `${openBlockers.length} blocker(s) stopping work — \`/plan blockers\`` : null,
    deadlineRequests.length > 0 ? `${deadlineRequests.length} deadline request(s) — \`/plan extensions\`` : null,
  ].filter(Boolean);

  const embed = new EmbedBuilder()
    .setTitle('Owner Desk')
    .setColor(0x57f287)
    .setDescription(decisions.length > 0
      ? `**${decisions.length} thing(s) need you:**\n${decisions.map((line) => `• ${line}`).join('\n')}`
      : '✅ Nothing is waiting on a decision from you.');

  embed.addFields(
    {
      name: `📁 Active projects (${projects.length})`,
      value: truncate(projects.slice(0, 8).map((project) => {
        const progress = projectsRepo.projectProgress(db, project.id);
        const done = progress.counts.client_approved || 0;
        return `**${project.code}** ${project.name} — ${done}/${progress.total} approved` +
          `${project.deadline_utc ? ` · due ${discordTimestamp(project.deadline_utc, 'R')}` : ''}`;
      })),
      inline: false,
    },
    {
      name: '🏗️ Department workload',
      value: workload.size === 0 ? EMPTY : truncate([...workload.entries()].map(([name, count]) => `${name}: ${count} live`)),
      inline: false,
    },
    {
      name: '💵 Money',
      value: [
        `Received from clients: ${formatTotals(money.received)}`,
        `Paid out: ${formatTotals(money.paidOut)}`,
        `Artist pay owed now: **${formatTotals(totalsByCurrency(owedArtists))}**`,
        `Shares owed: ${formatTotals(totalsByCurrency(owedShares))}`,
        `Approved but client has not paid: ${pending.awaitingClientMoney.length} task(s)`,
      ].join('\n'),
      inline: false,
    }
  );

  if (draftQuotes.length > 0) {
    embed.addFields({
      name: `📝 Quotes awaiting your approval (${draftQuotes.length})`,
      value: truncate(draftQuotes.map((quote) =>
        `**${quote.enquiry_code}** v${quote.version} · ${formatAmount(quote.total_minor, quote.currency)} · by <@${quote.prepared_by}>`
      )),
      inline: false,
    });
  }

  if (budgetExceptions.length > 0) {
    embed.addFields({
      name: `⚠️ Budget exceptions (${budgetExceptions.length})`,
      value: truncate(budgetExceptions.map((entry) =>
        `**${entry.project.code}** — committed ${formatAmount(entry.committed, entry.project.client_currency)} ` +
        `against a client payment of ${formatAmount(entry.project.client_amount_minor, entry.project.client_currency)}` +
        // A decision you already made is shown, not re-asked.
        `${entry.project.budget_override_by ? ' _(you allowed this)_' : ''}`
      )),
      inline: false,
    });
  }

  if (awaitingClient.length > 0) {
    embed.addFields({
      name: `📤 Waiting on clients (${awaitingClient.length})`,
      value: truncate(awaitingClient.slice(0, 6).map((task) =>
        `**${task.code}** ${task.title} · since ${discordTimestamp(task.updated_at, 'R')}`
      )),
      inline: false,
    });
  }

  if (atRisk.length > 0) {
    embed.addFields({
      name: `🔗 Waiting on late work (${atRisk.length})`,
      value: truncate(atRisk.slice(0, 6).map((row) =>
        `**${row.down_code}** ${row.down_title} waits on **${row.up_code}** (${stateLabel(row.up_state)})`
      )),
      inline: false,
    });
  }

  const pipeline = enquiriesRepo.pipelineCounts(db, guildId);
  embed.setFooter({
    text: `Enquiries: ${pipeline.new} new · ${pipeline.quote_sent} quoted · ${pipeline.accepted} won · ${pipeline.declined} lost`,
  });

  return { embed, counts: { decisions: decisions.length, projects: projects.length } };
}

module.exports = { buildMyDesk, buildGroupDesk, buildOwnerDesk };
