const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const configRepo = require('../db/repos/config');
const staffRepo = require('../db/repos/staff');
const projectsRepo = require('../db/repos/projects');
const { contextFor } = require('../services/actor');
const reports = require('../services/reports');
const { CAPABILITIES, assertCan, can } = require('../domain/permissions');
const { formatAmount, formatTotals, totalsByCurrency } = require('../domain/money');
const { discordTimestamp } = require('../utils/time');
const { priv } = require('../utils/reply');

const FILTER_CHOICES = Object.entries(reports.FILTER_LABELS)
  .map(([value, name]) => ({ name: name.slice(0, 100), value }));

const DAY_MS = reports.DAY_MS;

function days(ms) {
  if (ms <= 0) return '0d';
  const whole = ms / DAY_MS;
  return whole < 1 ? `${Math.round(ms / (60 * 60 * 1000))}h` : `${whole.toFixed(1)}d`;
}

/**
 * Reports over what the studio actually recorded.
 *
 * The one that matters most is `waiting`: it separates time a job spent with
 * the client from time it spent with the studio, because a report that cannot
 * tell those apart will get the wrong person blamed.
 */
module.exports = {
  data: new SlashCommandBuilder()
    .setName('reports')
    .setDescription('Filters and reports over the studio\'s own records')
    .addSubcommand((sub) =>
      sub
        .setName('filter')
        .setDescription('Work matching one plain question')
        .addStringOption((opt) => opt.setName('which').setDescription('What to look for').setRequired(true).addChoices(...FILTER_CHOICES))
        .addStringOption((opt) => opt.setName('department').setDescription('Limit to one department').setRequired(false).setAutocomplete(true))
    )
    .addSubcommand((sub) => sub.setName('overview').setDescription('How many tasks match each filter right now'))
    .addSubcommand((sub) =>
      sub
        .setName('waiting')
        .setDescription('Where an order\'s time has gone — with the studio, or with the client')
        .addStringOption((opt) => opt.setName('project').setDescription('Project code').setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('person')
        .setDescription('A rounded picture of one person\'s work — not a score')
        .addUserOption((opt) => opt.setName('member').setDescription('Who').setRequired(true))
        .addIntegerOption((opt) => opt.setName('days').setDescription('How far back to look (default: everything)').setRequired(false).setMinValue(1).setMaxValue(3650))
    )
    .addSubcommand((sub) => sub.setName('team').setDescription('Everybody\'s picture, in name order'))
    .addSubcommand((sub) => sub.setName('payouts').setDescription('Everyone owed money on approved work'))
    .addSubcommand((sub) => sub.setName('attention').setDescription('Orders that are overdue or have stalled with us')),

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);
    const { db, guildId } = contextFor(interaction);

    if (focused.name === 'department') {
      await interaction.respond(configRepo.listDepartments(db, guildId).slice(0, 25)
        .map((dept) => ({ name: dept.name.slice(0, 100), value: String(dept.id) })));
      return;
    }

    const query = String(focused.value || '');
    const matches = query
      ? projectsRepo.searchProjects(db, guildId, query, 25)
      : projectsRepo.listProjects(db, guildId, { status: 'active', limit: 25 });
    await interaction.respond(matches.map((p) => ({ name: `${p.code} · ${p.name}`.slice(0, 100), value: p.code })));
  },

  async execute(interaction) {
    const { db, guildId, departments, actor } = contextFor(interaction);
    const sub = interaction.options.getSubcommand();

    assertCan(actor, CAPABILITIES.SUMMARY_VIEW);
    const departmentName = new Map(departments.map((dept) => [dept.id, dept.name]));

    if (sub === 'overview') {
      const counts = reports.filterCounts(db, guildId);
      await interaction.reply(priv({
        embeds: [new EmbedBuilder()
          .setTitle('Where things stand')
          .setColor(0x5865f2)
          .setDescription(Object.entries(counts)
            .map(([filter, count]) => `${count > 0 ? '•' : '·'} **${count}** — ${reports.FILTER_LABELS[filter]}`)
            .join('\n'))
          .setFooter({ text: 'Open any of these with /reports filter which:<one>' })],
      }));
      return;
    }

    if (sub === 'filter') {
      const filter = interaction.options.getString('which', true);
      const departmentRaw = interaction.options.getString('department');
      const departmentId = departmentRaw ? Number(departmentRaw) : null;

      // A leader who is not the owner sees their own departments, because the
      // filters carry deadlines and workload for people they do not manage.
      const scoped = !actor.isOwner && !can(actor, CAPABILITIES.FINANCE_VIEW_ALL);
      const tasks = reports.filterTasks(db, guildId, filter, { departmentId })
        .filter((task) => !scoped || actor.leadDepartmentIds.includes(task.department_id));

      await interaction.reply(priv({
        embeds: [new EmbedBuilder()
          .setTitle(reports.FILTER_LABELS[filter])
          .setColor(tasks.length > 0 ? 0xfaa61a : 0x57f287)
          .setDescription(tasks.slice(0, 40).map((task) =>
            `**${task.code}** ${task.title} · ${departmentName.get(task.department_id) || '—'}` +
            `${task.artist_user_id ? ` · <@${task.artist_user_id}>` : ''}` +
            `${task.deadline_utc ? ` · ${discordTimestamp(task.deadline_utc, 'R')}` : ''}`
          ).join('\n').slice(0, 4000) || '_Nothing matches. That is good news._')
          .setFooter(tasks.length > 40 ? { text: `Showing 40 of ${tasks.length}.` } : null)],
      }));
      return;
    }

    if (sub === 'waiting') {
      const project = projectsRepo.getProjectByCode(db, guildId, interaction.options.getString('project', true));
      if (!project) {
        await interaction.reply(priv('❌ No project with that code.'));
        return;
      }

      const waiting = reports.projectWaiting(db, guildId, project.id);
      const total = waiting.studio + waiting.client + waiting.hold;
      const share = (value) => (total === 0 ? '0%' : `${Math.round((value / total) * 100)}%`);

      await interaction.reply(priv({
        embeds: [new EmbedBuilder()
          .setTitle(`Where the time went · ${project.code}`)
          .setColor(0x5865f2)
          .setDescription(
            `Across ${waiting.tasks} live item(s), counted from the audit trail.\n\n` +
            `**With us:** ${days(waiting.studio)} (${share(waiting.studio)})\n` +
            `**With the client:** ${days(waiting.client)} (${share(waiting.client)})\n` +
            `**On hold:** ${days(waiting.hold)} (${share(waiting.hold)})`
          )
          .setFooter({
            text: 'Time a job spends waiting on a client is not the artist\'s delay. ' +
              'These are kept apart on purpose.',
          })],
      }));
      return;
    }

    if (sub === 'payouts') {
      assertCan(actor, CAPABILITIES.FINANCE_VIEW_ALL);
      const rows = reports.payoutsOutstanding(db, guildId);

      await interaction.reply(priv({
        embeds: [new EmbedBuilder()
          .setTitle('Everyone owed money on approved work')
          .setColor(rows.length > 0 ? 0xfaa61a : 0x57f287)
          .setDescription(rows.map((row) =>
            `**${row.task.code}** <@${row.userId}> — ${formatAmount(row.remainingMinor, row.currency)}`
          ).join('\n').slice(0, 4000) || '_Nobody is owed anything on approved work._')
          .addFields({
            name: 'Total',
            value: formatTotals(totalsByCurrency(rows.map((row) => ({ minor: row.remainingMinor, currency: row.currency })))),
            inline: false,
          })],
      }));
      return;
    }

    if (sub === 'attention') {
      const rows = reports.projectsNeedingAttention(db, guildId);
      await interaction.reply(priv({
        embeds: [new EmbedBuilder()
          .setTitle('Orders needing attention')
          .setColor(rows.length > 0 ? 0xed4245 : 0x57f287)
          .setDescription(rows.map((row) =>
            `**${row.project.code}** ${row.project.name}\n` +
            `┗ ${[
              row.overdue ? `overdue since ${discordTimestamp(row.project.deadline_utc, 'R')}` : null,
              row.stalled ? `${days(row.waiting.studio)} of our time across ${row.waiting.tasks} item(s)` : null,
            ].filter(Boolean).join(' · ')}`
          ).join('\n').slice(0, 4000) || '_Nothing is overdue or stalled._')
          .setFooter({ text: 'Stalled counts our time only, so an order waiting on a client is not listed here.' })],
      }));
      return;
    }

    if (sub === 'person' || sub === 'team') {
      const lookback = interaction.options.getInteger?.('days') ?? null;
      const since = lookback ? Date.now() - lookback * DAY_MS : 0;

      const describe = (picture) => [
        `<@${picture.userId}>`,
        `┗ ${picture.approved} approved · ${picture.active} in hand` +
        `${picture.measuredForTimeliness > 0
          ? ` · on time ${picture.onTime}/${picture.measuredForTimeliness}`
          : ' · no deadlines to measure against'}` +
        `${picture.medianStudioDays !== null ? ` · about ${picture.medianStudioDays}d of our time each` : ''}` +
        `${picture.revisionRounds > 0 ? ` · ${picture.revisionRounds} revision round(s)` : ''}`,
      ].join('\n');

      if (sub === 'person') {
        const member = interaction.options.getUser('member', true);
        const picture = reports.personPicture(db, guildId, member.id, { since });

        await interaction.reply(priv({
          embeds: [new EmbedBuilder()
            .setTitle(`${member.displayName || member.username}`)
            .setColor(0x5865f2)
            .setDescription(describe(picture))
            .setFooter({ text: reports.NO_RANKING_NOTE })],
        }));
        return;
      }

      const userIds = staffRepo.listStaff(db, guildId).map((member) => member.user_id);
      const pictures = reports.peoplePictures(db, guildId, userIds, { since });

      await interaction.reply(priv({
        embeds: [new EmbedBuilder()
          .setTitle('The team')
          .setColor(0x5865f2)
          .setDescription(pictures.map(describe).join('\n').slice(0, 4000) || '_No staff recorded._')
          // The order is deliberate and is stated, so nobody reads the top of
          // the list as "best".
          .setFooter({ text: `In name order, not ranked. ${reports.NO_RANKING_NOTE}` })],
      }));
    }
  },
};
