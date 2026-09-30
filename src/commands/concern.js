const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const escalationsRepo = require('../db/repos/escalations');
const configRepo = require('../db/repos/config');
const tasksRepo = require('../db/repos/tasks');
const { contextFor } = require('../services/actor');
const { notifyUser } = require('../services/notify');
const { CAPABILITIES, assertCan, can } = require('../domain/permissions');
const { discordTimestamp } = require('../utils/time');
const { priv } = require('../utils/reply');

const { CATEGORIES, CATEGORY_LABELS } = escalationsRepo;

module.exports = {
  data: new SlashCommandBuilder()
    .setName('concern')
    .setDescription('Raise a concern privately, or handle raised concerns')
    .addSubcommand((sub) =>
      sub
        .setName('raise')
        .setDescription('Raise a concern about an assignment, your pay or your workload')
        .addStringOption((opt) =>
          opt.setName('category').setDescription('What it is about').setRequired(true).addChoices(
            ...Object.entries(CATEGORY_LABELS).map(([value, name]) => ({ name, value }))
          )
        )
        .addStringOption((opt) => opt.setName('subject').setDescription('One line summary').setRequired(true))
        .addStringOption((opt) => opt.setName('details').setDescription('What happened, and what you would like done').setRequired(true))
        .addStringOption((opt) => opt.setName('task').setDescription('Related task code, if any').setRequired(false).setAutocomplete(true))
    )
    .addSubcommand((sub) => sub.setName('mine').setDescription('Concerns you have raised and where they stand'))
    .addSubcommand((sub) =>
      sub
        .setName('list')
        .setDescription('Concerns raised by staff (owner only)')
        .addStringOption((opt) =>
          opt.setName('status').setDescription('Which').setRequired(false).addChoices(
            { name: 'Open', value: 'open' },
            { name: 'Acknowledged', value: 'acknowledged' },
            { name: 'Resolved', value: 'resolved' },
            { name: 'All', value: 'all' }
          )
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('respond')
        .setDescription('Acknowledge or resolve a raised concern (owner only)')
        .addIntegerOption((opt) => opt.setName('id').setDescription('Concern id').setRequired(true))
        .addStringOption((opt) =>
          opt.setName('action').setDescription('What you are doing').setRequired(true).addChoices(
            { name: 'Acknowledge — tell them I have seen it', value: 'acknowledge' },
            { name: 'Resolve — with an outcome', value: 'resolve' },
            { name: 'Close without action', value: 'close' }
          )
        )
        .addStringOption((opt) => opt.setName('note').setDescription('What you want them told').setRequired(false))
    ),

  async autocomplete(interaction) {
    const { db, guildId } = contextFor(interaction);
    const query = String(interaction.options.getFocused() || '');
    // Only their own work, since this is about their own assignments.
    const mine = tasksRepo.searchTasks(db, guildId, query, { limit: 25 })
      .filter((task) => task.artist_user_id === interaction.user.id || task.leader_user_id === interaction.user.id);

    await interaction.respond(mine.slice(0, 25).map((task) => ({
      name: `${task.code} · ${task.title}`.slice(0, 100),
      value: task.code,
    })));
  },

  async execute(interaction) {
    const { db, guildId, config, actor } = contextFor(interaction);
    const sub = interaction.options.getSubcommand();
    const userId = interaction.user.id;

    if (sub === 'raise') {
      const category = interaction.options.getString('category', true);
      const taskCode = interaction.options.getString('task');
      const task = taskCode ? tasksRepo.getTaskByCode(db, guildId, taskCode) : null;

      const escalation = escalationsRepo.raise(db, guildId, {
        raisedBy: userId,
        category,
        subject: interaction.options.getString('subject', true),
        body: interaction.options.getString('details', true),
        taskId: task?.id ?? null,
      });

      await interaction.reply(priv([
        `✅ Raised privately as concern **#${escalation.id}**.`,
        'It went to the studio owner only.',
        // Said plainly, because the value of this route is that it does not
        // go through the person it might be about.
        'Your group leader has **not** been told, and the details are not in the shared audit trail.',
        'Track it with `/concern mine`.',
      ].join('\n')));

      if (config.owner_user_id) {
        await notifyUser(interaction.client, db, guildId, config.owner_user_id, {
          embeds: [new EmbedBuilder()
            .setTitle(`Staff concern #${escalation.id}: ${escalation.subject}`)
            .setColor(0xed4245)
            .setDescription(escalation.body.slice(0, 2000))
            .addFields(
              { name: 'Category', value: CATEGORY_LABELS[category], inline: true },
              { name: 'Raised by', value: `<@${userId}>`, inline: true },
              ...(task ? [{ name: 'Task', value: `${task.code} · ${task.title}`, inline: true }] : [])
            )
            .setFooter({ text: `Reply with /concern respond id:${escalation.id}` })],
        }).catch(() => null);
      }
      return;
    }

    if (sub === 'mine') {
      const mine = escalationsRepo.listForRaiser(db, guildId, userId);
      if (mine.length === 0) {
        await interaction.reply(priv('You have not raised any concerns.'));
        return;
      }

      await interaction.reply(priv({
        embeds: [new EmbedBuilder()
          .setTitle('Concerns you have raised')
          .setColor(0x5865f2)
          .setDescription(mine.map((row) =>
            `**#${row.id}** ${row.subject} · ${CATEGORY_LABELS[row.category]} · ${row.status}` +
            `\n┗ raised ${discordTimestamp(row.created_at, 'R')}` +
            `${row.resolution ? `\n┗ outcome: ${row.resolution.slice(0, 200)}` : ''}`
          ).join('\n').slice(0, 4000))],
      }));
      return;
    }

    // Only the owner reads or answers other people's concerns.
    assertCan(actor, CAPABILITIES.CONFIG_MANAGE);

    if (sub === 'list') {
      const status = interaction.options.getString('status') || 'open';
      const rows = escalationsRepo.list(db, guildId, { status, limit: 25 });

      if (rows.length === 0) {
        await interaction.reply(priv(`No ${status === 'all' ? '' : `${status} `}staff concerns.`));
        return;
      }

      await interaction.reply(priv({
        embeds: [new EmbedBuilder()
          .setTitle('Staff concerns')
          .setColor(0xed4245)
          .setDescription(rows.map((row) => {
            const task = row.task_id ? tasksRepo.getTask(db, guildId, row.task_id) : null;
            return `**#${row.id}** ${row.subject}\n` +
              `┗ ${CATEGORY_LABELS[row.category]} · <@${row.raised_by}>${task ? ` · ${task.code}` : ''} · ${row.status} · ${discordTimestamp(row.created_at, 'R')}`;
          }).join('\n').slice(0, 4000))
          .setFooter({ text: 'Full text with /concern respond, or read it in the DM I sent you.' })],
      }));
      return;
    }

    if (sub === 'respond') {
      const id = interaction.options.getInteger('id', true);
      const escalation = escalationsRepo.get(db, guildId, id);
      if (!escalation) {
        await interaction.reply(priv(`❌ No concern with id ${id}.`));
        return;
      }

      const action = interaction.options.getString('action', true);
      const note = interaction.options.getString('note');

      if (action === 'acknowledge') {
        escalationsRepo.acknowledge(db, guildId, id, userId);
      } else {
        escalationsRepo.resolve(db, guildId, id, {
          status: action === 'resolve' ? 'resolved' : 'closed',
          resolution: note,
          actorUserId: userId,
        });
      }

      await interaction.reply(priv(
        `✅ Concern #${id} marked **${action === 'acknowledge' ? 'acknowledged' : action === 'resolve' ? 'resolved' : 'closed'}**.` +
        `${note ? `\nThey have been told: ${note}` : '\nNo note was sent to them.'}`
      ));

      await notifyUser(interaction.client, db, guildId, escalation.raised_by, {
        content:
          `Your concern **#${id}: ${escalation.subject}** has been ` +
          `${action === 'acknowledge' ? 'seen by the studio owner' : action === 'resolve' ? 'resolved' : 'closed'}.` +
          `${note ? `\n> ${note}` : ''}`,
      }).catch(() => null);
    }
  },
};
