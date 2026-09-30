const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const clientsRepo = require('../db/repos/clients');
const { contextFor } = require('../services/actor');
const nextActions = require('../services/nextActions');
const { CAPABILITIES, can } = require('../domain/permissions');
const { customId } = require('../interactions/router');
const { priv } = require('../utils/reply');

/**
 * One command to remember instead of thirty.
 *
 * `/go` answers the only question most people have most days: is anything
 * waiting on me? It reads what is recorded, sorts by how pressing it is, and
 * writes out the command for each thing so nothing has to be recalled.
 *
 * Nothing appears here that the person would then be refused, because every
 * item is gathered under the same permission checks as the command it names.
 */
module.exports = {
  data: new SlashCommandBuilder()
    .setName('go')
    .setDescription('What is waiting on you right now'),

  async execute(interaction) {
    const { db, guildId, actor } = contextFor(interaction);
    const userId = interaction.user.id;

    // A client account that is not staff gets the client answer, not a staff
    // to-do list they cannot act on.
    const clientProjects = clientsRepo.listProjectsForAccount(db, guildId, userId);
    const isStaff = actor.isOwner || actor.capabilities.size > 0 || actor.leadDepartmentIds.length > 0;

    if (clientProjects.length > 0 && !isStaff) {
      await interaction.reply(priv({
        embeds: [new EmbedBuilder()
          .setTitle('Your orders')
          .setColor(0x1abc9c)
          .setDescription(
            clientProjects.map((project) =>
              `**${project.name}**${project.client_channel_id ? ` — <#${project.client_channel_id}>` : ''}`
            ).join('\n')
          )
          .setFooter({ text: 'Everything about your order is on its dashboard.' })],
      }));
      return;
    }

    const { actions, total } = nextActions.forUser(db, guildId, userId, actor);

    if (actions.length === 0) {
      await interaction.reply(priv({
        embeds: [new EmbedBuilder()
          .setTitle('Nothing is waiting on you')
          .setColor(0x57f287)
          .setDescription(
            'No offers, nothing overdue, nothing needing a decision from you.\n\n' +
            'If you want to look around anyway: `/desk me` for your own work, `/help` for everything you can do.'
          )],
      }));
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle(`${total} thing${total === 1 ? '' : 's'} waiting on you`)
      .setColor(actions[0].urgency <= nextActions.URGENCY.OVERDUE ? 0xed4245 : 0xfaa61a)
      .setDescription(actions.map((action) =>
        `${action.icon} ${action.text}\n┗ ${action.command}`
      ).join('\n\n').slice(0, 4000));

    if (total > actions.length) {
      embed.setFooter({ text: `Showing the ${actions.length} most pressing of ${total}.` });
    }

    // The three or four buttons that cover most of what anybody does next.
    const buttons = [
      new ButtonBuilder().setCustomId(customId('go', 'desk')).setLabel('My desk').setStyle(ButtonStyle.Primary),
    ];

    if (actor.leadDepartmentIds.length > 0) {
      buttons.push(new ButtonBuilder().setCustomId(customId('go', 'group')).setLabel('My department').setStyle(ButtonStyle.Secondary));
    }
    if (can(actor, CAPABILITIES.TASK_PAY_APPROVE)) {
      buttons.push(new ButtonBuilder().setCustomId(customId('go', 'owner')).setLabel('Owner desk').setStyle(ButtonStyle.Secondary));
    }
    buttons.push(new ButtonBuilder().setCustomId(customId('go', 'help')).setLabel('What can I do?').setStyle(ButtonStyle.Secondary));

    await interaction.reply(priv({
      embeds: [embed],
      components: [new ActionRowBuilder().addComponents(...buttons.slice(0, 5))],
    }));
  },
};
