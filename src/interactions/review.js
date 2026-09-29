const {
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
} = require('discord.js');
const tasksRepo = require('../db/repos/tasks');
const submissionsRepo = require('../db/repos/submissions');
const configRepo = require('../db/repos/config');
const { contextFor } = require('../services/actor');
const { notifyUser } = require('../services/notify');
const { reviewPanel } = require('../commands/review');
const { register, customId } = require('./router');
const { CAPABILITIES, assertCan } = require('../domain/permissions');
const { TASK_STATES, stateLabel } = require('../domain/taskState');
const { priv } = require('../utils/reply');

const NAMESPACE = 'review';

function changesModal(taskId) {
  return new ModalBuilder()
    .setCustomId(customId(NAMESPACE, 'changesModal', taskId))
    .setTitle('Request changes')
    .addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('notes')
        .setLabel('What needs changing?')
        .setPlaceholder('Be specific: the artist works from this note.')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(1000)
    ));
}

register(NAMESPACE, async (interaction, { action, args }) => {
  const { db, guildId, actor } = contextFor(interaction);
  const taskId = Number(args[0]);
  const task = tasksRepo.getTask(db, guildId, taskId);

  if (!task) {
    await interaction.reply(priv('❌ That task no longer exists.'));
    return;
  }

  assertCan(actor, CAPABILITIES.REVIEW_INTERNAL, { departmentId: task.department_id });

  if (action === 'open') {
    const panel = reviewPanel(db, guildId, task);
    await interaction.reply(priv({ embeds: [panel.embed], components: panel.components }));
    return;
  }

  if (task.state !== TASK_STATES.INTERNAL_REVIEW) {
    await interaction.reply(priv(
      `❌ **${task.code}** is ${stateLabel(task.state)} — somebody may have reviewed it already.`
    ));
    return;
  }

  if (action === 'changes') {
    await interaction.showModal(changesModal(taskId));
    return;
  }

  if (action === 'ready') {
    const submission = submissionsRepo.latestSubmission(db, task.id, { kind: 'final' });

    const updated = db.transaction(() => {
      submissionsRepo.addReview(db, guildId, task.id, {
        submissionId: submission?.id ?? null,
        reviewerUserId: interaction.user.id,
        decision: 'ready_for_client',
      });
      return tasksRepo.applyTransition(db, guildId, task.id, 'review_ready_for_client', {
        actorUserId: interaction.user.id,
        guardKey: `review-ready:${task.id}:${submission?.id ?? 'none'}`,
        detail: 'Passed internal review',
      });
    })();

    await interaction.update({
      content:
        `✅ **${updated.code}** passed internal review and is now awaiting client approval.\n` +
        'This is **not** client approval: send it to the client, then record their answer with ' +
        `\`/review client task:${updated.code}\`.`,
      embeds: [],
      components: [],
    });

    const config = configRepo.getConfig(db, guildId);
    if (config?.owner_user_id) {
      await notifyUser(interaction.client, db, guildId, config.owner_user_id, {
        content:
          `📤 **${updated.code} · ${updated.title}** passed internal review by <@${interaction.user.id}> ` +
          `and is ready to go to the client.\nRecord their decision with \`/review client task:${updated.code}\`.`,
      }).catch(() => null);
    }

    if (updated.artist_user_id) {
      await notifyUser(interaction.client, db, guildId, updated.artist_user_id, {
        content: `✅ Your submission for **${updated.code} · ${updated.title}** passed internal review and is going to the client.`,
      }).catch(() => null);
    }
    return;
  }

  if (action === 'changesModal') {
    const notes = interaction.fields.getTextInputValue('notes').trim();
    const submission = submissionsRepo.latestSubmission(db, task.id, { kind: 'final' });

    const updated = db.transaction(() => {
      submissionsRepo.addReview(db, guildId, task.id, {
        submissionId: submission?.id ?? null,
        reviewerUserId: interaction.user.id,
        decision: 'changes_requested',
        notes,
      });
      return tasksRepo.applyTransition(db, guildId, task.id, 'review_request_changes', {
        actorUserId: interaction.user.id,
        detail: notes,
      });
    })();

    await interaction.reply(priv(
      `🔁 Changes requested on **${updated.code}**. The artist has been told and the task is back with them.`
    ));

    if (updated.artist_user_id) {
      await notifyUser(interaction.client, db, guildId, updated.artist_user_id, {
        content:
          `🔁 <@${interaction.user.id}> asked for changes on **${updated.code} · ${updated.title}** before it goes to the client:\n` +
          `> ${notes.slice(0, 1000)}\n\nSubmit again with \`/work submit task:${updated.code}\`.`,
      }).catch(() => null);
    }

    // The original panel keeps its buttons otherwise, inviting a second review.
    await interaction.message?.edit({
      content: `🔁 Changes requested on **${updated.code}** by <@${interaction.user.id}>.`,
      embeds: [],
      components: [],
    }).catch(() => null);
    return;
  }

  await interaction.reply(priv('❌ Unknown review action.'));
});

module.exports = { NAMESPACE };
