const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const search = require('../services/search');
const { contextFor } = require('../services/actor');
const { priv } = require('../utils/reply');

const KIND_ORDER = [
  search.KINDS.TASK,
  search.KINDS.PROJECT,
  search.KINDS.CLIENT,
  search.KINDS.STAFF,
  search.KINDS.ASSET,
  search.KINDS.ENQUIRY,
  search.KINDS.EVIDENCE,
];

const KIND_HEADINGS = Object.freeze({
  task: 'Work',
  project: 'Orders',
  client: 'Clients',
  staff: 'People',
  asset: 'Files',
  enquiry: 'Enquiries',
  evidence: 'Proof on file',
});

/**
 * One place to look for anything.
 *
 * The studio has a lot of commands. Somebody who half-remembers a client's name
 * or a bit of a task title should not have to work out which of them to reach
 * for — they type what they remember and get the answer plus the command that
 * shows more.
 *
 * Results are filtered by what the caller may see. Nothing appears here that
 * they would be refused if they ran the command it points at.
 */
module.exports = {
  data: new SlashCommandBuilder()
    .setName('find')
    .setDescription('Search everything at once — work, orders, clients, people, files')
    .addStringOption((opt) =>
      opt.setName('query').setDescription('Any part of a name, code or title').setRequired(true).setMinLength(2))
    .addStringOption((opt) =>
      opt.setName('only').setDescription('Narrow to one kind').setRequired(false).addChoices(
        ...KIND_ORDER.map((kind) => ({ name: KIND_HEADINGS[kind], value: kind }))
      )),

  async execute(interaction) {
    const { db, guildId, actor } = contextFor(interaction);
    const query = interaction.options.getString('query', true);
    const only = interaction.options.getString('only');

    const found = search.everything(db, guildId, query, actor, { limit: 40 });

    if (!found.ok) {
      await interaction.reply(priv(
        found.reason === 'too_short'
          ? '❌ Give me at least two characters. One character matches nearly everything and helps nobody.'
          : `❌ ${found.reason}`
      ));
      return;
    }

    const results = only ? found.results.filter((row) => row.kind === only) : found.results;

    if (results.length === 0) {
      await interaction.reply(priv({
        embeds: [new EmbedBuilder()
          .setTitle(`Nothing found for “${query}”`)
          .setColor(0x99aab5)
          .setDescription(
            'Nothing matching that, at least nothing you can see.\n\n' +
            '_Search only shows what you have access to, so a thing can exist and still not appear here._'
          )],
      }));
      return;
    }

    const sections = KIND_ORDER
      .map((kind) => ({ kind, rows: results.filter((row) => row.kind === kind) }))
      .filter((section) => section.rows.length > 0);

    const embed = new EmbedBuilder()
      .setTitle(`${results.length} result${results.length === 1 ? '' : 's'} for “${query}”`)
      .setColor(0x5865f2);

    let budget = 5500;
    for (const section of sections) {
      const body = section.rows.map((row) =>
        `${search.KIND_ICONS[row.kind]} **${row.title}**` +
        `${row.subtitle ? `\n┗ ${row.subtitle}` : ''}` +
        `${row.command ? `\n┗ \`${row.command}\`` : ''}`
      ).join('\n\n').slice(0, 1024);

      // Discord caps an embed at 6000 characters across all its fields. Stopping
      // early and saying so beats a rejected message.
      if (budget - body.length < 0) {
        embed.setFooter({ text: 'More matched than fits in one message — narrow it with the "only" option.' });
        break;
      }
      budget -= body.length;
      embed.addFields({ name: KIND_HEADINGS[section.kind], value: body });
    }

    await interaction.reply(priv({ embeds: [embed] }));
  },
};
