const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const clientsRepo = require('../db/repos/clients');
const projectsRepo = require('../db/repos/projects');
const tasksRepo = require('../db/repos/tasks');
const configRepo = require('../db/repos/config');
const { contextFor } = require('../services/actor');
const { notifyUser } = require('../services/notify');
const { CAPABILITIES, assertCan, can, PermissionError } = require('../domain/permissions');
const { TASK_STATES, stateLabel } = require('../domain/taskState');
const { discordTimestamp } = require('../utils/time');
const { priv } = require('../utils/reply');

const { ISSUE_DECISIONS } = clientsRepo;

const DECISION_LABELS = {
  in_scope: 'a correction we owe them',
  additional_work: 'work beyond what was agreed',
  no_fault: 'nothing to correct',
};

module.exports = {
  data: new SlashCommandBuilder()
    .setName('issues')
    .setDescription('Problems reported by clients')
    .addSubcommand((sub) =>
      sub
        .setName('list')
        .setDescription('Reported problems')
        .addStringOption((opt) =>
          opt.setName('status').setDescription('Which').setRequired(false).addChoices(
            { name: 'Open', value: 'open' },
            { name: 'In progress', value: 'in_progress' },
            { name: 'Resolved', value: 'resolved' },
            { name: 'All', value: 'all' }
          )
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('view')
        .setDescription('One reported problem in full')
        .addIntegerOption((opt) => opt.setName('id').setDescription('Issue id').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('decide')
        .setDescription('Judge whether a reported problem is in scope or extra work')
        .addIntegerOption((opt) => opt.setName('id').setDescription('Issue id').setRequired(true))
        .addStringOption((opt) =>
          opt.setName('decision').setDescription('What it is').setRequired(true).addChoices(
            { name: 'In scope — we correct it at no charge', value: 'in_scope' },
            { name: 'Additional work — needs a quote (owner only)', value: 'additional_work' },
            { name: 'Nothing to correct', value: 'no_fault' }
          )
        )
        .addStringOption((opt) => opt.setName('note').setDescription('Reasoning, recorded on the issue').setRequired(true))
        .addBooleanOption((opt) => opt.setName('tell_client').setDescription('Send the note to the client channel').setRequired(false))
    )
    .addSubcommand((sub) =>
      sub
        .setName('close')
        .setDescription('Close a reported problem')
        .addIntegerOption((opt) => opt.setName('id').setDescription('Issue id').setRequired(true))
        .addStringOption((opt) => opt.setName('note').setDescription('What was done').setRequired(true))
        .addBooleanOption((opt) => opt.setName('tell_client').setDescription('Send the note to the client channel').setRequired(false))
    ),

  async execute(interaction) {
    const { db, guildId, actor } = contextFor(interaction);
    const sub = interaction.options.getSubcommand();
    const userId = interaction.user.id;

    // Issues are triaged by whoever runs projects; leaders can see and judge
    // ones in their own department.
    const isManager = actor.isOwner || can(actor, CAPABILITIES.PROJECT_EDIT);

    if (sub === 'list') {
      const status = interaction.options.getString('status') || 'open';
      const all = clientsRepo.listRequests(db, guildId, { status, limit: 50 })
        .filter((request) => request.kind === 'delivery_issue');

      const visible = isManager
        ? all
        : all.filter((request) => {
            if (!request.task_id) return false;
            const task = tasksRepo.getTask(db, guildId, request.task_id);
            return task && actor.leadDepartmentIds.includes(task.department_id);
          });

      if (visible.length === 0) {
        await interaction.reply(priv(`No ${status === 'all' ? '' : `${status} `}problems reported.`));
        return;
      }

      await interaction.reply(priv({
        embeds: [new EmbedBuilder()
          .setTitle('Reported problems')
          .setColor(0xed4245)
          .setDescription(visible.slice(0, 20).map((request) => {
            const task = request.task_id ? tasksRepo.getTask(db, guildId, request.task_id) : null;
            return `**#${request.id}** ${task ? `${task.code} · ${task.title}` : 'no item'} · ${discordTimestamp(request.created_at, 'R')}` +
              `${request.decision ? ` · judged **${DECISION_LABELS[request.decision]}**` : ' · **not yet judged**'}\n` +
              `┗ ${request.body.slice(0, 180)}`;
          }).join('\n').slice(0, 4000))
          .setFooter({ text: 'Judge one with /issues decide id:<number>' })],
      }));
      return;
    }

    const id = interaction.options.getInteger('id', true);
    const request = clientsRepo.getRequest(db, guildId, id);
    if (!request || request.kind !== 'delivery_issue') {
      await interaction.reply(priv(`❌ No reported problem with id ${id}.`));
      return;
    }

    const task = request.task_id ? tasksRepo.getTask(db, guildId, request.task_id) : null;
    const project = request.project_id ? projectsRepo.getProject(db, guildId, request.project_id) : null;

    if (!isManager) {
      const leadsIt = task && actor.leadDepartmentIds.includes(task.department_id);
      if (!leadsIt) {
        throw new PermissionError('issues.view', 'You can only handle problems reported against your own department.');
      }
    }

    if (sub === 'view') {
      const embed = new EmbedBuilder()
        .setTitle(`Issue #${request.id}`)
        .setColor(0xed4245)
        .setDescription(request.body.slice(0, 4000))
        .addFields(
          { name: 'Item', value: task ? `${task.code} · ${task.title} (${stateLabel(task.state)})` : '_none_', inline: true },
          { name: 'Order', value: project ? `${project.code} · ${project.name}` : '_none_', inline: true },
          { name: 'Reported', value: discordTimestamp(request.created_at, 'F'), inline: true },
          { name: 'Status', value: request.status.replace(/_/g, ' '), inline: true },
          {
            name: 'Judgement',
            value: request.decision
              ? `${DECISION_LABELS[request.decision]} — by <@${request.decided_by}> ${discordTimestamp(request.decided_at, 'R')}`
              : '_not yet judged_',
            inline: false,
          }
        );

      if (request.attachments) embed.addFields({ name: 'References', value: request.attachments.slice(0, 1024), inline: false });
      if (request.resolution) embed.addFields({ name: 'Resolution', value: request.resolution.slice(0, 1024), inline: false });

      await interaction.reply(priv({ embeds: [embed] }));
      return;
    }

    if (sub === 'decide') {
      const decision = interaction.options.getString('decision', true);
      const note = interaction.options.getString('note', true);

      // Extra work means somebody will be charged, and only the owner may
      // agree to that.
      if (decision === ISSUE_DECISIONS.ADDITIONAL_WORK) {
        assertCan(actor, CAPABILITIES.TASK_PAY_APPROVE);
      } else if (!isManager) {
        assertCan(actor, CAPABILITIES.REVIEW_INTERNAL, { departmentId: task?.department_id ?? null });
      }

      if (request.decision) {
        await interaction.reply(priv(
          `Issue #${id} was already judged **${DECISION_LABELS[request.decision]}** by <@${request.decided_by}>. ` +
          'Close it with `/issues close` instead.'
        ));
        return;
      }

      let reopened = null;
      db.transaction(() => {
        clientsRepo.decideIssue(db, guildId, id, {
          decision,
          actorUserId: userId,
          chargeApprovedBy: decision === ISSUE_DECISIONS.ADDITIONAL_WORK ? userId : null,
          note,
        });

        // An in-scope correction puts the original task back with the artist.
        if (decision === ISSUE_DECISIONS.IN_SCOPE && task) {
          if (task.state === TASK_STATES.CLIENT_APPROVED) {
            reopened = tasksRepo.applyTransition(db, guildId, task.id, 'client_reopen', {
              actorUserId: userId,
              detail: `Issue #${id} judged in scope: ${note}`,
            });
          } else if (task.state === TASK_STATES.AWAITING_CLIENT) {
            reopened = tasksRepo.applyTransition(db, guildId, task.id, 'client_request_revisions', {
              actorUserId: userId,
              detail: `Issue #${id} judged in scope: ${note}`,
            });
          }
        }

        // Extra work is flagged for a quote rather than quietly absorbed.
        if (decision === ISSUE_DECISIONS.ADDITIONAL_WORK && task) {
          tasksRepo.setFlag(db, guildId, task.id, 'scope', true, userId,
            `Issue #${id} judged as work beyond the agreement`);
        }
      })();

      const lines = [
        `✅ Issue #${id} judged **${DECISION_LABELS[decision]}**.`,
        `Recorded against ${task ? `**${task.code}**` : 'the order'} with your reasoning.`,
      ];

      if (decision === ISSUE_DECISIONS.IN_SCOPE) {
        lines.push(reopened
          ? `**${task.code}** is back with the artist as ${stateLabel(reopened.state)} — no charge to the client.`
          : 'No task state change was needed.');
      }
      if (decision === ISSUE_DECISIONS.ADDITIONAL_WORK) {
        lines.push(
          'Flagged as chargeable. Nothing has been quoted or promised to the client — ' +
          'agree a price with them, then add it as a new task with `/task create`.'
        );
      }
      if (decision === ISSUE_DECISIONS.NO_FAULT) {
        lines.push('The issue is closed and promotional messages for this client are no longer paused by it.');
      }

      await interaction.reply(priv(lines.join('\n')));

      if (reopened) {
        for (const recipient of new Set([reopened.artist_user_id, reopened.leader_user_id].filter(Boolean))) {
          await notifyUser(interaction.client, db, guildId, recipient, {
            content:
              `🔁 A client problem on **${reopened.code} · ${reopened.title}** was judged a correction we owe them:\n` +
              `> ${request.body.slice(0, 600)}\n` +
              `Decision note: ${note}\nResubmit with \`/work submit task:${reopened.code}\`.`,
          }).catch(() => null);
        }
      }

      if (interaction.options.getBoolean('tell_client') && project?.client_channel_id) {
        const channel = await interaction.guild.channels.fetch(project.client_channel_id).catch(() => null);
        if (channel?.isTextBased?.()) {
          await channel.send({
            content: `<@${request.raised_by}> regarding the problem you reported: ${note}`,
            allowedMentions: { users: [request.raised_by] },
          }).catch(() => null);
        }
      }
      return;
    }

    if (sub === 'close') {
      const note = interaction.options.getString('note', true);
      clientsRepo.resolveRequest(db, guildId, id, { status: 'resolved', resolution: note, actorUserId: userId });

      await interaction.reply(priv(
        `✅ Issue #${id} closed.\nRecorded: ${note}\n` +
        (clientsRepo.hasOpenIssue(db, guildId, request.client_id)
          ? 'This client still has other open issues, so promotional messages stay paused.'
          : 'No open issues remain for this client.')
      ));

      if (interaction.options.getBoolean('tell_client') && project?.client_channel_id) {
        const channel = await interaction.guild.channels.fetch(project.client_channel_id).catch(() => null);
        if (channel?.isTextBased?.()) {
          await channel.send({
            content: `<@${request.raised_by}> your reported problem has been closed: ${note}`,
            allowedMentions: { users: [request.raised_by] },
          }).catch(() => null);
        }
      }
    }
  },
};
