const { EmbedBuilder, PermissionsBitField } = require('discord.js');
const configRepo = require('../db/repos/config');
const tasksRepo = require('../db/repos/tasks');
const staffRepo = require('../db/repos/staff');
const paymentsRepo = require('../db/repos/payments');
const paymentState = require('./paymentState');
const allocationFlow = require('./allocationFlow');
const { TASK_STATES, ACTIVE_STATES } = require('../domain/taskState');
const { formatTotals, formatAmount, totalsByCurrency } = require('../domain/money');
const { discordTimestamp, DAY_MS } = require('../utils/time');

/**
 * A private management view: what got done, what is stuck, and what is owed.
 * Deliberately not posted anywhere staff-wide, because it carries pay figures.
 */
function buildWeeklySummary(db, guildId, { now = Date.now(), windowMs = 7 * DAY_MS } = {}) {
  const since = now - windowMs;
  const departments = configRepo.listDepartments(db, guildId);
  const departmentName = new Map(departments.map((dept) => [dept.id, dept.name]));

  const approved = db.prepare(`
    SELECT * FROM tasks WHERE guild_id = ? AND state = ? AND completed_at IS NOT NULL AND completed_at >= ?
    ORDER BY completed_at DESC
  `).all(guildId, TASK_STATES.CLIENT_APPROVED, since);

  const active = tasksRepo.listTasksInStates(db, guildId, ACTIVE_STATES);
  const overdue = active.filter((task) => task.deadline_utc && task.deadline_utc < now);
  const onHold = tasksRepo.listTasksInStates(db, guildId, [TASK_STATES.ON_HOLD]);
  const awaitingReview = tasksRepo.listTasksInStates(db, guildId, [TASK_STATES.INTERNAL_REVIEW]);
  const awaitingClient = tasksRepo.listTasksInStates(db, guildId, [TASK_STATES.AWAITING_CLIENT]);
  const unassigned = tasksRepo.listTasksInStates(db, guildId, [TASK_STATES.UNASSIGNED]);
  const flagged = active.concat(onHold).filter((task) => task.scope_review_flag || task.compensation_review_flag);

  const pending = paymentState.pendingPayouts(db, guildId);
  const owedAmounts = pending.payable
    .flatMap((task) => paymentState.owedOnTask(db, task))
    .map((entry) => ({ minor: entry.remainingMinor, currency: entry.currency }))
    .filter((entry) => entry.minor > 0 && entry.currency);
  const owedShares = allocationFlow.outstandingAllocations(db, guildId)
    .map((row) => ({ minor: row.outstanding_minor, currency: row.currency }));

  // Workload per department, counting live work only.
  const workload = new Map();
  for (const task of active) {
    const name = departmentName.get(task.department_id) || 'Unknown';
    if (!workload.has(name)) workload.set(name, { active: 0, unassigned: 0 });
    workload.get(name).active += 1;
  }
  for (const task of unassigned) {
    const name = departmentName.get(task.department_id) || 'Unknown';
    if (!workload.has(name)) workload.set(name, { active: 0, unassigned: 0 });
    workload.get(name).unassigned += 1;
  }

  const embed = new EmbedBuilder()
    .setTitle('Weekly studio summary')
    .setColor(0x5865f2)
    .setDescription(`Covering the last 7 days, to ${discordTimestamp(now, 'F')}.`)
    .addFields(
      {
        name: `✅ Client-approved this week (${approved.length})`,
        value: approved.length === 0
          ? '_none_'
          : approved.slice(0, 10).map((task) => `**${task.code}** ${task.title}${task.artist_user_id ? ` · <@${task.artist_user_id}>` : ''}`).join('\n').slice(0, 1024),
        inline: false,
      },
      {
        name: `🔴 Overdue (${overdue.length})`,
        value: overdue.length === 0
          ? '_nothing overdue_'
          : overdue.slice(0, 10).map((task) =>
              `**${task.code}** ${task.title} · ${task.artist_user_id ? `<@${task.artist_user_id}>` : 'unassigned'} · due ${discordTimestamp(task.deadline_utc, 'R')}`
            ).join('\n').slice(0, 1024),
        inline: false,
      },
      {
        name: `🔍 Waiting on the studio (${awaitingReview.length + unassigned.length})`,
        value: [
          `${awaitingReview.length} awaiting internal review`,
          `${unassigned.length} unassigned`,
          `${onHold.length} on hold`,
        ].join(' · '),
        inline: false,
      },
      {
        name: `📤 Waiting on clients (${awaitingClient.length})`,
        value: awaitingClient.length === 0
          ? '_none_'
          : awaitingClient.slice(0, 10).map((task) => `**${task.code}** ${task.title} · since ${discordTimestamp(task.updated_at, 'R')}`).join('\n').slice(0, 1024),
        inline: false,
      },
      {
        name: 'Department workload',
        value: workload.size === 0
          ? '_no live work_'
          : [...workload.entries()].map(([name, counts]) => `**${name}** — ${counts.active} active, ${counts.unassigned} unassigned`).join('\n').slice(0, 1024),
        inline: false,
      },
      {
        name: '💰 Payouts outstanding',
        value: [
          `Artist pay owed: ${formatTotals(totalsByCurrency(owedAmounts))}`,
          `Shares owed: ${formatTotals(totalsByCurrency(owedShares))}`,
          `Approved but waiting on client money: ${pending.awaitingClientMoney.length} task(s)`,
        ].join('\n'),
        inline: false,
      }
    );

  if (flagged.length > 0) {
    embed.addFields({
      name: `⚠️ Needs your decision (${flagged.length})`,
      value: flagged.slice(0, 10).map((task) =>
        `**${task.code}** ${task.scope_review_flag ? 'out-of-scope request' : ''}${task.scope_review_flag && task.compensation_review_flag ? ' and ' : ''}${task.compensation_review_flag ? 'compensation for work already done' : ''}`
      ).join('\n').slice(0, 1024),
      inline: false,
    });
  }

  const money = paymentsRepo.totalsByDirection(db, guildId);
  embed.setFooter({
    text: `Lifetime: ${formatTotals(money.received)} received · ${formatTotals(money.paidOut)} paid out. Currencies are never combined.`.slice(0, 2048),
  });

  return embed;
}

/**
 * Posts to the configured summary channel, or DMs the owner if none is set, so
 * the summary is never silently lost.
 */
async function postWeeklySummary(client, db, guildId, { now = Date.now() } = {}) {
  const config = configRepo.getConfig(db, guildId);
  if (!config) return { delivered: false, reason: 'no_config' };

  const embed = buildWeeklySummary(db, guildId, { now });
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return { delivered: false, reason: 'guild_unavailable' };

  if (config.summary_channel_id) {
    const channel = guild.channels.cache.get(config.summary_channel_id)
      || await guild.channels.fetch(config.summary_channel_id).catch(() => null);

    if (channel?.isTextBased?.()) {
      const perms = channel.permissionsFor(guild.members.me);
      if (perms?.has(PermissionsBitField.Flags.SendMessages) && perms?.has(PermissionsBitField.Flags.EmbedLinks)) {
        const sent = await channel.send({ embeds: [embed] }).catch(() => null);
        if (sent) return { delivered: true, via: 'channel' };
      }
    }
  }

  if (config.owner_user_id) {
    const { notifyUser } = require('./notify');
    const result = await notifyUser(client, db, guildId, config.owner_user_id, { embeds: [embed] });
    if (result.delivered) return { delivered: true, via: result.via };
  }

  return { delivered: false, reason: 'no_destination' };
}

module.exports = { buildWeeklySummary, postWeeklySummary };
