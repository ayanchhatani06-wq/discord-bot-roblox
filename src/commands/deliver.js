const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const tasksRepo = require('../db/repos/tasks');
const projectsRepo = require('../db/repos/projects');
const assetsRepo = require('../db/repos/assets');
const clientsRepo = require('../db/repos/clients');
const { contextFor } = require('../services/actor');
const delivery = require('../services/delivery');
const { notifyUser } = require('../services/notify');
const messageTriggers = require('../services/messageTriggers');
const { publishDashboard } = require('./clients');
const { CAPABILITIES, assertCan, can } = require('../domain/permissions');
const { stateLabel } = require('../domain/taskState');
const { discordTimestamp } = require('../utils/time');
const { priv } = require('../utils/reply');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('deliver')
    .setDescription('Release finished work to a client')
    .addSubcommand((sub) =>
      sub
        .setName('check')
        .setDescription('See whether an item is ready to release, and what is blocking it')
        .addStringOption((opt) => opt.setName('task').setDescription('Task code').setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('release')
        .setDescription('Authorize delivery of an item to the client')
        .addStringOption((opt) => opt.setName('task').setDescription('Task code').setRequired(true).setAutocomplete(true))
        .addStringOption((opt) => opt.setName('note').setDescription('Note kept on the delivery record').setRequired(false))
        .addBooleanOption((opt) =>
          opt.setName('override').setDescription('Release even though a condition is unmet (recorded)').setRequired(false)
        )
    )
    .addSubcommand((sub) => sub.setName('pending').setDescription('Approved work that has not been released yet'))
    .addSubcommand((sub) =>
      sub
        .setName('conditions')
        .setDescription('What must be true before work can be released')
        .addBooleanOption((opt) => opt.setName('require_client_approval').setDescription('Client must have approved').setRequired(false))
        .addBooleanOption((opt) => opt.setName('require_client_paid').setDescription('Client payment must be received in full').setRequired(false))
        .addBooleanOption((opt) => opt.setName('require_checklist_complete').setDescription('Deliverables checklist must be complete').setRequired(false))
    ),

  async autocomplete(interaction) {
    const { db, guildId } = contextFor(interaction);
    const query = String(interaction.options.getFocused() || '');
    const matches = tasksRepo.searchTasks(db, guildId, query, { limit: 25 });

    await interaction.respond(matches.map((task) => ({
      name: `${task.code} · ${task.title} · ${task.delivered_at ? 'delivered' : stateLabel(task.state)}`.slice(0, 100),
      value: task.code,
    })));
  },

  async execute(interaction) {
    const { db, guildId, config, actor } = contextFor(interaction);
    const sub = interaction.options.getSubcommand();
    const userId = interaction.user.id;

    if (sub === 'conditions') {
      assertCan(actor, CAPABILITIES.CONFIG_MANAGE);

      const patch = {};
      for (const key of ['require_client_approval', 'require_client_paid', 'require_checklist_complete']) {
        const value = interaction.options.getBoolean(key);
        if (value !== null) patch[key] = value;
      }

      const current = Object.keys(patch).length > 0
        ? delivery.setDeliveryConditions(db, guildId, patch, userId)
        : delivery.deliveryConditions(config);

      await interaction.reply(priv([
        Object.keys(patch).length > 0 ? '✅ Delivery conditions updated.' : 'Current delivery conditions:',
        `• Client approval required: **${current.require_client_approval ? 'yes' : 'no'}**`,
        `• Client payment received in full required: **${current.require_client_paid ? 'yes' : 'no'}**`,
        `• Deliverables checklist complete required: **${current.require_checklist_complete ? 'yes' : 'no'}**`,
        '',
        'These check that files exist and steps were completed. They cannot judge whether the work is good — ' +
        'that is what internal review and client approval are for.',
      ].join('\n')));
      return;
    }

    if (sub === 'pending') {
      assertCan(actor, CAPABILITIES.PROJECT_EDIT);

      const rows = delivery.undeliveredApproved(db, guildId);
      if (rows.length === 0) {
        await interaction.reply(priv('Nothing is approved and waiting to be released.'));
        return;
      }

      await interaction.reply(priv({
        embeds: [new EmbedBuilder()
          .setTitle('Approved, not yet released')
          .setColor(0x1abc9c)
          .setDescription(rows.slice(0, 20).map((task) => {
            const readiness = delivery.checkDeliveryReadiness(db, guildId, task);
            return `**${task.code}** ${task.title}` +
              `${task.completed_at ? ` · approved ${discordTimestamp(task.completed_at, 'R')}` : ''}\n` +
              `┗ ${readiness.ok ? '✅ ready to release' : `⚠️ ${readiness.blockers[0]}`}`;
          }).join('\n').slice(0, 4000))
          .setFooter({ text: 'Release with /deliver release task:<code>' })],
      }));
      return;
    }

    const code = interaction.options.getString('task', true);
    const task = tasksRepo.getTaskByCode(db, guildId, code);
    if (!task) {
      await interaction.reply(priv(`❌ No task with code \`${code}\`.`));
      return;
    }

    if (sub === 'check') {
      const mayView = actor.isOwner
        || can(actor, CAPABILITIES.PROJECT_EDIT)
        || can(actor, CAPABILITIES.REVIEW_INTERNAL, { departmentId: task.department_id });
      if (!mayView) assertCan(actor, CAPABILITIES.PROJECT_EDIT);

      const readiness = delivery.checkDeliveryReadiness(db, guildId, task);
      const approved = delivery.latestApprovedVersion(db, task.id);

      const embed = new EmbedBuilder()
        .setTitle(`Delivery check · ${task.code}`)
        .setColor(readiness.ok ? 0x57f287 : 0xfaa61a)
        .setDescription(readiness.alreadyDelivered
          ? `Already delivered ${discordTimestamp(task.delivered_at, 'F')} by <@${task.delivered_by}> (version ${task.delivered_version}).`
          : readiness.ok ? '✅ Ready to release.' : '⚠️ Not ready yet.')
        .addFields(
          {
            name: 'Blocking',
            value: readiness.blockers.length > 0 ? readiness.blockers.map((b) => `• ${b}`).join('\n') : '_nothing_',
            inline: false,
          },
          {
            name: 'Latest client-approved version',
            value: approved
              ? `v${approved.version ?? '?'} · approved ${discordTimestamp(approved.approvedAt, 'f')} · recorded by <@${approved.recordedBy}>`
              : '_none approved yet_',
            inline: false,
          },
          {
            name: 'Files to be released',
            value: readiness.deliverables?.length
              ? readiness.deliverables.map((asset) => `• ${asset.url}`).join('\n').slice(0, 1024)
              : '_none recorded_',
            inline: false,
          }
        );

      if (readiness.warnings.length > 0) {
        embed.addFields({ name: 'Worth knowing', value: readiness.warnings.map((w) => `• ${w}`).join('\n'), inline: false });
      }

      await interaction.reply(priv({ embeds: [embed] }));
      return;
    }

    if (sub === 'release') {
      // Releasing to a client is a commitment, so it sits with project
      // management rather than with whoever produced the work.
      assertCan(actor, CAPABILITIES.PROJECT_EDIT);

      const override = interaction.options.getBoolean('override') ?? false;
      if (override) assertCan(actor, CAPABILITIES.CLIENT_RECORD);

      const result = delivery.authorizeDelivery(db, guildId, task, {
        actorUserId: userId,
        note: interaction.options.getString('note'),
        override,
      });

      if (!result.ok) {
        const reasons = {
          already_delivered: `**${task.code}** was already delivered ${discordTimestamp(task.delivered_at, 'R')} by <@${task.delivered_by}>.`,
          nothing_to_deliver: `**${task.code}** has no final submission to release.`,
          conditions_not_met:
            `**${task.code}** is not ready:\n${result.readiness.blockers.map((b) => `• ${b}`).join('\n')}\n\n` +
            'Fix those, or release anyway with `override:true` — which is recorded against your name.',
        };
        await interaction.reply(priv(`❌ ${reasons[result.reason] || result.reason}`));
        return;
      }

      const project = projectsRepo.getProject(db, guildId, task.project_id);
      await interaction.reply(priv([
        `✅ **${task.code}** released to the client — version ${result.task.delivered_version}, ${result.readiness.deliverables.length} file(s).`,
        `Recorded against you at ${discordTimestamp(result.task.delivered_at, 'f')}.`,
        result.overridden
          ? `⚠️ Released despite: ${result.readiness.blockers.join(' ')} — that is on the record.`
          : null,
        project?.portfolio_staff_allowed === null || project?.portfolio_staff_allowed === undefined
          ? `\nNo portfolio permission is recorded for ${project?.code}. Until it is, nobody may show this work — \`/archive rights project:${project?.code}\`.`
          : null,
      ].filter(Boolean).join('\n')));

      // The client's dashboard reflects delivery without anybody reposting it.
      if (project?.client_id && project.client_channel_id) {
        publishDashboard(interaction, db, guildId, projectsRepo.getProject(db, guildId, project.id))
          .catch((error) => console.error('Dashboard refresh after delivery failed:', error));

        messageTriggers.delivered(db, guildId, project, {
          taskId: task.id,
          version: result.task.delivered_version,
          queuedBy: userId,
        });
      }

      for (const recipient of new Set([task.artist_user_id, task.leader_user_id].filter(Boolean))) {
        await notifyUser(interaction.client, db, guildId, recipient, {
          content: `📦 **${task.code} · ${task.title}** was delivered to the client (version ${result.task.delivered_version}).`,
        }).catch(() => null);
      }
    }
  },
};
