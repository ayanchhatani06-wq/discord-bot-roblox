const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const configRepo = require('../db/repos/config');
const capacity = require('../services/capacity');
const { contextFor } = require('../services/actor');
const { CAPABILITIES, can, PermissionError } = require('../domain/permissions');
const { discordTimestamp } = require('../utils/time');
const { priv } = require('../utils/reply');

/**
 * Who is likely to be free, before you promise a client anything.
 *
 * One command with one question. A leader sees their own departments; the owner
 * sees the studio. Nobody sees a number this cannot actually support: no maximum
 * workload is recorded for anybody, so it shows what each person is carrying
 * rather than inventing a limit and declaring people over it.
 */
module.exports = {
  data: new SlashCommandBuilder()
    .setName('free')
    .setDescription('Who has room for more work, and who has not')
    .addIntegerOption((opt) =>
      opt.setName('days').setDescription('How far ahead to look (default 7)').setRequired(false).setMinValue(1).setMaxValue(90))
    .addStringOption((opt) =>
      opt.setName('group').setDescription('One department only').setRequired(false).setAutocomplete(true)),

  async autocomplete(interaction) {
    const { db, guildId } = contextFor(interaction);
    const query = String(interaction.options.getFocused() || '').toLowerCase();
    const matches = configRepo.listDepartments(db, guildId)
      .filter((dept) => dept.name.toLowerCase().includes(query) || dept.key.includes(query))
      .slice(0, 25);
    await interaction.respond(matches.map((dept) => ({ name: dept.name, value: dept.key })));
  },

  async execute(interaction) {
    const { db, guildId, actor } = contextFor(interaction);
    const days = interaction.options.getInteger('days') ?? 7;
    const groupKey = interaction.options.getString('group');

    const seesEverybody = actor.isOwner || can(actor, CAPABILITIES.SUMMARY_VIEW);
    if (!seesEverybody && actor.leadDepartmentIds.length === 0) {
      throw new PermissionError(
        CAPABILITIES.SUMMARY_VIEW,
        'Seeing what the whole team is carrying is for group leaders and the owner. ' +
        'Your own work is on `/desk me`.'
      );
    }

    let departmentId;
    if (groupKey) {
      const department = configRepo.listDepartments(db, guildId).find((dept) => dept.key === groupKey);
      if (!department) {
        await interaction.reply(priv('❌ No group with that name.'));
        return;
      }
      if (!seesEverybody && !actor.leadDepartmentIds.includes(department.id)) {
        throw new PermissionError(
          CAPABILITIES.SUMMARY_VIEW,
          `You do not lead ${department.name}, so its workload is not yours to see.`
        );
      }
      departmentId = department.id;
    } else if (!seesEverybody) {
      // A leader with one department gets it directly. With several, the
      // forecast is built per department and merged below.
      departmentId = actor.leadDepartmentIds.length === 1 ? actor.leadDepartmentIds[0] : undefined;
    }

    let result = capacity.forecast(db, guildId, { days, departmentId });

    // A leader of several departments sees exactly those, not the studio.
    if (!seesEverybody && departmentId === undefined) {
      result = {
        ...result,
        people: result.people.filter((person) => actor.leadDepartmentIds.includes(person.department?.id)),
      };
      result.counts = Object.keys(capacity.OUTLOOK_LABELS).reduce((out, outlook) => {
        out[outlook] = result.people.filter((person) => person.outlook === outlook).length;
        return out;
      }, {});
    }

    if (result.people.length === 0) {
      await interaction.reply(priv(
        'Nobody to report on' + (groupKey ? ' in that group' : '') + '. ' +
        'People appear here once they are on the team — `/profile setup`.'
      ));
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle(`Who has room · next ${days} day${days === 1 ? '' : 's'}`)
      .setColor(result.counts.free > 0 ? 0x57f287 : 0xfee75c)
      .setDescription(
        `Up to ${discordTimestamp(result.until, 'D')}.\n\n` +
        result.people.slice(0, 20).map(capacity.describePerson).join('\n\n').slice(0, 3800)
      );

    const summary = Object.entries(result.counts)
      .filter(([, count]) => count > 0)
      .map(([outlook, count]) => `${capacity.OUTLOOK_EMOJI[outlook]} ${count} ${capacity.OUTLOOK_LABELS[outlook].toLowerCase()}`)
      .join('\n');
    if (summary) embed.addFields({ name: 'In short', value: summary });

    const awayPeople = result.people.filter((person) => person.outlook === capacity.OUTLOOK.AWAY);
    if (awayPeople.length > 0) {
      embed.addFields({
        name: 'Away',
        value: awayPeople.map((person) =>
          `${person.member.display_name || person.member.user_id}` +
          `${person.returnsAt ? ` — back ${discordTimestamp(person.returnsAt, 'D')}` : ' — no return date recorded'}`
        ).join('\n').slice(0, 1024),
      });
    }

    // Said out loud, because it is the difference between a forecast you can act
    // on and one that quietly overbooks people.
    const caveats = [];
    if (result.withoutCap.length > 0) {
      caveats.push(
        `No task cap is set for ${result.withoutCap.slice(0, 4).join(', ')}` +
        `${result.withoutCap.length > 4 ? ` and ${result.withoutCap.length - 4} more` : ''}, ` +
        'so for those this shows the load without judging anybody over a limit. ' +
        'Set one with `/studio department task_cap:`.'
      );
    }
    if (result.unknownDeadlines > 0) {
      caveats.push(
        `${result.unknownDeadlines} task(s) have no deadline, so there is no telling whether they land in this window. ` +
        'They are counted as work, not assumed finished.'
      );
    }
    if (caveats.length > 0) {
      embed.addFields({ name: 'What this cannot know', value: caveats.join('\n\n').slice(0, 1024) });
    }

    if (result.people.length > 20) {
      embed.setFooter({ text: `Showing 20 of ${result.people.length}. Narrow it with the "group" option.` });
    }

    await interaction.reply(priv({ embeds: [embed] }));
  },
};
