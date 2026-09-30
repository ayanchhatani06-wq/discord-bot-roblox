const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const configRepo = require('../db/repos/config');
const capacity = require('../services/capacity');
const { contextFor } = require('../services/actor');
const { CAPABILITIES, can, PermissionError } = require('../domain/permissions');
const { discordTimestamp } = require('../utils/time');
const { priv } = require('../utils/reply');
const { brief } = require('../utils/brief');
const { registerView } = require('../services/detailViews');

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
    .setName('who-is-free')
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
    const context = contextFor(interaction);
    const days = interaction.options.getInteger('days') ?? 7;
    const groupKey = interaction.options.getString('group');

    const result = forecastFor(context, { days, groupKey });
    if (result.error) {
      await interaction.reply(priv(result.error));
      return;
    }

    const counts = result.counts;
    const roomy = (counts.free || 0) + (counts.finishing || 0);

    // The answer is how many people have room. The list is a button away,
    // because most of the time the number is what you came for.
    await interaction.reply(brief({
      title: `Who has room · next ${days} day${days === 1 ? '' : 's'}`,
      tone: roomy > 0 ? 'good' : 'warn',
      headline:
        (roomy > 0
          ? `**${roomy}** of ${result.people.length} could take something on.`
          : `**Nobody** is free — all ${result.people.length} are loaded, full or away.`) +
        `\n\n${describeCounts(counts)}`,
      viewId: 'who-is-free',
      args: [days, groupKey || ''],
      buttonLabel: 'Who exactly',
      emoji: '👥',
      footer: result.withoutCap.length > 0
        ? 'Some departments have no task cap set, so their load is shown without a limit to judge it against.'
        : null,
    }));
  },
};

/** The counts line, leaving out anything that is zero. */
function describeCounts(counts) {
  return Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([outlook, n]) => `${capacity.OUTLOOK_EMOJI[outlook]} ${n} ${capacity.OUTLOOK_LABELS[outlook].toLowerCase()}`)
    .join(' · ');
}

/**
 * The forecast, scoped to what the caller may see.
 *
 * Shared by the command and its button on purpose: a button that skipped this
 * would be a way to read another leader's department by pressing something.
 */
function forecastFor({ db, guildId, actor }, { days, groupKey }) {
  const seesEverybody = actor.isOwner || can(actor, CAPABILITIES.SUMMARY_VIEW);
  if (!seesEverybody && actor.leadDepartmentIds.length === 0) {
    throw new PermissionError(
      CAPABILITIES.SUMMARY_VIEW,
      'Seeing what the whole team is carrying is for group leaders and the owner. ' +
      'Your own work is on `/go`.'
    );
  }

  let departmentId;
  if (groupKey) {
    const department = configRepo.listDepartments(db, guildId).find((dept) => dept.key === groupKey);
    if (!department) return { error: '❌ No group with that name.' };
    if (!seesEverybody && !actor.leadDepartmentIds.includes(department.id)) {
      throw new PermissionError(
        CAPABILITIES.SUMMARY_VIEW,
        `You do not lead ${department.name}, so its workload is not yours to see.`
      );
    }
    departmentId = department.id;
  } else if (!seesEverybody) {
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
    return {
      error: 'Nobody to report on' + (groupKey ? ' in that group' : '') + '. ' +
        'People appear here once they are on the team — `/profile me`.',
    };
  }

  return result;
}

// The long version, rebuilt when somebody presses the button rather than stored,
// so it shows what is true now and not what was true when the summary was sent.
registerView('who-is-free', (context, [rawDays, groupKey]) => {
  const days = Number(rawDays) || 7;
  const result = forecastFor(context, { days, groupKey: groupKey || null });
  if (result.error) return { content: result.error };

  const embed = new EmbedBuilder()
    .setTitle(`Who has room · next ${days} day${days === 1 ? '' : 's'}`)
    .setColor(result.counts.free > 0 ? 0x57f287 : 0xfee75c)
    .setDescription(
      `Up to ${discordTimestamp(result.until, 'D')}.\n\n` +
      result.people.slice(0, 20).map(capacity.describePerson).join('\n\n').slice(0, 3800)
    );

  const away = result.people.filter((person) => person.outlook === capacity.OUTLOOK.AWAY);
  if (away.length > 0) {
    embed.addFields({
      name: 'Away',
      value: away.map((person) =>
        `${person.member.display_name || person.member.user_id}` +
        `${person.returnsAt ? ` — back ${discordTimestamp(person.returnsAt, 'D')}` : ' — no return date recorded'}`
      ).join('\n').slice(0, 1024),
    });
  }

  const caveats = [];
  if (result.withoutCap.length > 0) {
    caveats.push(
      `No task cap is set for ${result.withoutCap.slice(0, 4).join(', ')}` +
      `${result.withoutCap.length > 4 ? ` and ${result.withoutCap.length - 4} more` : ''}. ` +
      'Set one with `/setup department task_cap:`.'
    );
  }
  if (result.unknownDeadlines > 0) {
    caveats.push(
      `${result.unknownDeadlines} task(s) have no deadline, so there is no telling whether they land in this ` +
      'window. They are counted as work, not assumed finished.'
    );
  }
  if (caveats.length > 0) {
    embed.addFields({ name: 'What this cannot know', value: caveats.join('\n\n').slice(0, 1024) });
  }

  if (result.people.length > 20) {
    embed.setFooter({ text: `Showing 20 of ${result.people.length}. Narrow it with the "group" option.` });
  }

  return { embeds: [embed] };
});
