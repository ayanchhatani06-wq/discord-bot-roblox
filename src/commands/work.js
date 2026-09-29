const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} = require('discord.js');
const tasksRepo = require('../db/repos/tasks');
const projectsRepo = require('../db/repos/projects');
const configRepo = require('../db/repos/config');
const submissionsRepo = require('../db/repos/submissions');
const planningRepo = require('../db/repos/planning');
const { contextFor } = require('../services/actor');
const { taskEmbed } = require('../services/taskView');
const { notifyUser } = require('../services/notify');
const { CAPABILITIES, can, canViewTaskFinance, isAssignedArtist, PermissionError } = require('../domain/permissions');
const { TASK_STATES, ACTIVE_STATES, stateLabel } = require('../domain/taskState');
const { formatAmount } = require('../domain/money');
const { discordTimestamp } = require('../utils/time');
const { customId } = require('../interactions/router');
const { priv } = require('../utils/reply');

const SUBMITTABLE_STATES = [TASK_STATES.IN_PROGRESS, TASK_STATES.REVISION_NEEDED];

function extractLinks(text) {
  return String(text || '')
    .split(/[\n,\s]+/)
    .map((part) => part.trim())
    .filter((part) => /^https?:\/\//i.test(part));
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('work')
    .setDescription('Post progress and submit finished work')
    .addSubcommand((sub) =>
      sub
        .setName('progress')
        .setDescription('Post a progress update on a task you hold')
        .addStringOption((opt) => opt.setName('task').setDescription('Task code').setRequired(true).setAutocomplete(true))
        .addStringOption((opt) => opt.setName('note').setDescription('What you have done').setRequired(true))
        .addStringOption((opt) => opt.setName('links').setDescription('Preview links, separated by spaces').setRequired(false))
    )
    .addSubcommand((sub) =>
      sub
        .setName('submit')
        .setDescription('Submit finished work for internal review')
        .addStringOption((opt) => opt.setName('task').setDescription('Task code').setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('history')
        .setDescription('Submissions, reviews and client decisions on a task')
        .addStringOption((opt) => opt.setName('task').setDescription('Task code').setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('blocked')
        .setDescription("Say you cannot continue, and why")
        .addStringOption((opt) => opt.setName('task').setDescription('Task code').setRequired(true).setAutocomplete(true))
        .addStringOption((opt) => opt.setName('reason').setDescription('What is stopping you').setRequired(true))
        .addStringOption((opt) => opt.setName('link').setDescription('Screenshot or file showing the problem').setRequired(false))
    )
    .addSubcommand((sub) =>
      sub
        .setName('unblock')
        .setDescription('Say a blocker you raised is resolved')
        .addStringOption((opt) => opt.setName('task').setDescription('Task code').setRequired(true).setAutocomplete(true))
        .addStringOption((opt) => opt.setName('note').setDescription('How it was resolved').setRequired(false))
    )
    .addSubcommand((sub) => sub.setName('earnings').setDescription('Your own pay and payment history (private)')),

  async autocomplete(interaction) {
    const { db, guildId } = contextFor(interaction);
    const query = String(interaction.options.getFocused() || '');

    // Artists only ever autocomplete their own work.
    const mine = tasksRepo.listTasksForArtist(db, guildId, interaction.user.id, {
      states: [...ACTIVE_STATES, TASK_STATES.AWAITING_CLIENT, TASK_STATES.CLIENT_APPROVED],
    });
    const lower = query.toLowerCase();
    const matches = mine
      .filter((task) => !lower || task.code.toLowerCase().includes(lower) || task.title.toLowerCase().includes(lower))
      .slice(0, 25);

    await interaction.respond(matches.map((task) => ({
      name: `${task.code} · ${task.title} · ${stateLabel(task.state)}`.slice(0, 100),
      value: task.code,
    })));
  },

  async execute(interaction) {
    const { db, guildId, actor } = contextFor(interaction);
    const sub = interaction.options.getSubcommand();
    const userId = interaction.user.id;

    if (sub === 'earnings') {
      const rows = db.prepare(`
        SELECT t.code, t.title, t.artist_pay_minor, t.artist_pay_currency, t.payment_state, t.state
        FROM tasks t
        WHERE t.guild_id = ? AND t.artist_user_id = ? AND t.artist_pay_minor IS NOT NULL
        ORDER BY t.created_at DESC LIMIT 25
      `).all(guildId, userId);

      const payments = db.prepare(`
        SELECT p.amount_minor, p.currency, p.method_label, p.recorded_at, t.code
        FROM payments p LEFT JOIN tasks t ON t.id = p.task_id
        WHERE p.guild_id = ? AND p.payee_user_id = ? AND p.direction = 'payout'
        ORDER BY p.recorded_at DESC LIMIT 25
      `).all(guildId, userId);

      const embed = new EmbedBuilder()
        .setTitle('Your pay')
        .setColor(0x5865f2)
        .setDescription(
          rows.length === 0
            ? 'No tasks with agreed pay yet.'
            : rows.map((row) =>
                `**${row.code}** ${row.title}\n┗ ${formatAmount(row.artist_pay_minor, row.artist_pay_currency)} · ${row.payment_state.replace(/_/g, ' ')}`
              ).join('\n').slice(0, 2000)
        );

      if (payments.length > 0) {
        embed.addFields({
          name: 'Payments received',
          value: payments.map((row) =>
            `${formatAmount(row.amount_minor, row.currency)} · ${row.code || 'unlinked'} · ${row.method_label || 'method not noted'} · ${discordTimestamp(row.recorded_at, 'd')}`
          ).join('\n').slice(0, 1024),
          inline: false,
        });
      }

      embed.setFooter({ text: 'Only you can see this. Amounts are shown per currency and never combined.' });
      await interaction.reply(priv({ embeds: [embed] }));
      return;
    }

    const code = interaction.options.getString('task', true);
    const task = tasksRepo.getTaskByCode(db, guildId, code);
    if (!task) {
      await interaction.reply(priv(`❌ No task with code \`${code}\`.`));
      return;
    }

    const project = projectsRepo.getProject(db, guildId, task.project_id);
    const department = configRepo.getDepartment(db, guildId, task.department_id);

    if (sub === 'history') {
      const mayView = actor.isOwner
        || isAssignedArtist(actor, task)
        || can(actor, CAPABILITIES.REVIEW_INTERNAL, { departmentId: task.department_id });
      if (!mayView) {
        throw new PermissionError('task.history', 'You can only see the history of your own work, or work in a department you lead.');
      }

      const history = submissionsRepo.fullHistory(db, task.id);
      const embed = new EmbedBuilder()
        .setTitle(`${task.code} · history`)
        .setColor(0x5865f2)
        .setDescription(`Status: **${stateLabel(task.state)}**`);

      if (history.submissions.length > 0) {
        embed.addFields({
          name: `Submissions (${history.submissions.length})`,
          value: history.submissions.map((submission) => {
            const linkList = submissionsRepo.links(submission);
            return `**v${submission.version}** ${submission.kind} · <@${submission.submitted_by}> · ${discordTimestamp(submission.submitted_at, 'd')}` +
              `${submission.notes ? `\n┗ ${submission.notes.slice(0, 200)}` : ''}` +
              `${linkList.length > 0 ? `\n┗ ${linkList.length} link(s)` : ''}`;
          }).join('\n').slice(0, 1024),
          inline: false,
        });
      }

      if (history.reviews.length > 0) {
        embed.addFields({
          name: `Internal reviews (${history.reviews.length})`,
          value: history.reviews.map((review) =>
            `${review.decision === 'ready_for_client' ? '✅ ready for client' : '🔁 changes requested'} · <@${review.reviewer_user_id}> · ${discordTimestamp(review.created_at, 'd')}` +
            `${review.notes ? `\n┗ ${review.notes.slice(0, 200)}` : ''}`
          ).join('\n').slice(0, 1024),
          inline: false,
        });
      }

      if (history.clientDecisions.length > 0) {
        embed.addFields({
          name: `Client decisions (${history.clientDecisions.length})`,
          value: history.clientDecisions.map((decision) =>
            `${decision.decision === 'approved' ? '✅ approved' : '🔁 revisions requested'} · recorded by <@${decision.recorded_by}> · ${discordTimestamp(decision.recorded_at, 'd')}` +
            `${decision.feedback ? `\n┗ ${decision.feedback.slice(0, 200)}` : ''}` +
            `${decision.reference_url ? `\n┗ [reference](${decision.reference_url})` : ''}` +
            `${decision.out_of_scope ? '\n┗ ⚠️ flagged as outside the agreed scope' : ''}`
          ).join('\n').slice(0, 1024),
          inline: false,
        });
      }

      if (history.submissions.length === 0 && history.reviews.length === 0 && history.clientDecisions.length === 0) {
        embed.addFields({ name: 'Nothing yet', value: 'No submissions, reviews or client decisions recorded.', inline: false });
      }

      await interaction.reply(priv({ embeds: [embed] }));
      return;
    }

    // progress and submit are the artist's own actions on their own task.
    if (!isAssignedArtist(actor, task)) {
      throw new PermissionError('task.submit', `**${task.code}** is not assigned to you.`);
    }

    if (sub === 'blocked') {
      const reason = interaction.options.getString('reason', true);
      const link = interaction.options.getString('link');

      const existing = planningRepo.openBlockersForTask(db, task.id)
        .filter((row) => row.raised_by === userId);
      if (existing.length > 0) {
        await interaction.reply(priv(
          `You already have an open blocker on **${task.code}** (#${existing[0].id}).\n` +
          `> ${existing[0].reason.slice(0, 200)}\nClear it with \`/work unblock\` before raising another.`
        ));
        return;
      }

      const blocker = planningRepo.raiseBlocker(db, guildId, {
        taskId: task.id, raisedBy: userId, reason, attachment: link,
      });

      await interaction.reply(priv(
        `✅ Recorded blocker #${blocker.id} on **${task.code}**. Your leader has been told.\n` +
        'The task is unchanged and still yours — this flags that you are stuck, it does not hand the work back.'
      ));

      for (const recipient of new Set([task.leader_user_id, configRepo.getConfig(db, guildId)?.owner_user_id].filter(Boolean))) {
        await notifyUser(interaction.client, db, guildId, recipient, {
          content:
            `🚧 <@${userId}> is blocked on **${task.code} · ${task.title}**:\n> ${reason.slice(0, 600)}` +
            `${link ? `\n${link}` : ''}\nClear it with \`/plan clear-blocker id:${blocker.id}\`.`,
        }).catch(() => null);
      }
      return;
    }

    if (sub === 'unblock') {
      const mine = planningRepo.openBlockersForTask(db, task.id).filter((row) => row.raised_by === userId);
      if (mine.length === 0) {
        await interaction.reply(priv(`You have no open blocker on **${task.code}**.`));
        return;
      }

      planningRepo.clearBlocker(db, guildId, mine[0].id, {
        actorUserId: userId, resolution: interaction.options.getString('note'),
      });

      await interaction.reply(priv(`✅ Blocker #${mine[0].id} on **${task.code}** cleared.`));

      if (task.leader_user_id) {
        await notifyUser(interaction.client, db, guildId, task.leader_user_id, {
          content: `✅ <@${userId}> cleared their blocker on **${task.code} · ${task.title}**.`,
        }).catch(() => null);
      }
      return;
    }

    if (sub === 'progress') {
      if (![...SUBMITTABLE_STATES, TASK_STATES.INTERNAL_REVIEW].includes(task.state)) {
        await interaction.reply(priv(`❌ **${task.code}** is ${stateLabel(task.state)}; progress notes are for work in progress.`));
        return;
      }

      const note = interaction.options.getString('note', true);
      const links = extractLinks(interaction.options.getString('links'));

      submissionsRepo.addSubmission(db, guildId, task.id, {
        kind: 'progress',
        notes: note,
        links,
        submittedBy: userId,
      });
      tasksRepo.touchProgress(db, task.id);

      await interaction.reply(priv(
        `✅ Progress recorded on **${task.code}**.${links.length > 0 ? ` ${links.length} link(s) attached.` : ''}\n` +
        'This resets the stale-progress reminder for this task.'
      ));

      if (task.leader_user_id && task.leader_user_id !== userId) {
        await notifyUser(interaction.client, db, guildId, task.leader_user_id, {
          content: `📝 <@${userId}> posted progress on **${task.code} · ${task.title}**:\n> ${note.slice(0, 500)}${links.length > 0 ? `\n${links.join('\n')}` : ''}`,
        }).catch(() => null);
      }
      return;
    }

    if (sub === 'submit') {
      if (!SUBMITTABLE_STATES.includes(task.state)) {
        await interaction.reply(priv(
          `❌ **${task.code}** is ${stateLabel(task.state)}.` +
          `${task.state === TASK_STATES.INTERNAL_REVIEW ? ' It is already with your group leader for review.' : ''}`
        ));
        return;
      }

      const deliverables = tasksRepo.deliverables(task);

      // With no checklist to tick, go straight to the links and notes.
      if (deliverables.length === 0) {
        await interaction.reply(priv({
          content: `**${task.code} · ${task.title}** has no deliverables checklist. Add your links and notes:`,
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(customId('submit', 'open', task.id))
              .setLabel('Add links and submit')
              .setStyle(ButtonStyle.Success)
          )],
        }));
        return;
      }

      const options = deliverables.slice(0, 25).map((item, index) => ({
        label: String(item).slice(0, 100),
        value: String(index),
      }));

      await interaction.reply(priv({
        content:
          `**${task.code} · ${task.title}**\n` +
          'Tick every deliverable you are including, then continue. ' +
          'If something genuinely does not apply, ask your leader to change the deliverables list first.',
        embeds: [taskEmbed({ task, project, department, actor, includeFinance: canViewTaskFinance(actor, task) })],
        components: [new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(customId('submit', 'checklist', task.id))
            .setPlaceholder('Select the deliverables you are submitting')
            .setMinValues(1)
            .setMaxValues(options.length)
            .addOptions(options)
        )],
      }));
    }
  },
};
