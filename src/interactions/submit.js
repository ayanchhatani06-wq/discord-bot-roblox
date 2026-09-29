const {
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} = require('discord.js');
const tasksRepo = require('../db/repos/tasks');
const submissionsRepo = require('../db/repos/submissions');
const configRepo = require('../db/repos/config');
const assetsRepo = require('../db/repos/assets');
const { contextFor } = require('../services/actor');
const { notifyUser } = require('../services/notify');
const { register, customId } = require('./router');
const { isAssignedArtist, PermissionError } = require('../domain/permissions');
const { TASK_STATES, stateLabel } = require('../domain/taskState');
const { priv } = require('../utils/reply');

const NAMESPACE = 'submit';
const SUBMITTABLE_STATES = [TASK_STATES.IN_PROGRESS, TASK_STATES.REVISION_NEEDED];

function extractLinks(text) {
  return String(text || '')
    .split(/[\n,\s]+/)
    .map((part) => part.trim())
    .filter((part) => /^https?:\/\//i.test(part));
}

/**
 * Ticked checklist indices ride along in the custom id, which avoids keeping
 * half-finished submissions in the database while the modal is open.
 */
function submissionModal(taskId, indices) {
  return new ModalBuilder()
    .setCustomId(customId(NAMESPACE, 'modal', taskId, indices.join('.')))
    .setTitle('Submit finished work')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('links')
          .setLabel('Links to your files (one per line)')
          .setPlaceholder('https://drive.google.com/...')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(1500)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('internal')
          .setLabel('Source / working files (never sent to client)')
          .setPlaceholder('Your .blend, .psd, project files — kept internal.')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(800)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('notes')
          .setLabel('Notes for your group leader (optional)')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(1000)
      )
    );
}

register(NAMESPACE, async (interaction, { action, args }) => {
  const { db, guildId, actor } = contextFor(interaction);
  const taskId = Number(args[0]);
  const task = tasksRepo.getTask(db, guildId, taskId);

  if (!task) {
    await interaction.reply(priv('❌ That task no longer exists.'));
    return;
  }
  if (!isAssignedArtist(actor, task)) {
    throw new PermissionError('task.submit', 'That task is not assigned to you.');
  }
  if (!SUBMITTABLE_STATES.includes(task.state)) {
    await interaction.reply(priv(`❌ **${task.code}** is ${stateLabel(task.state)} and cannot be submitted right now.`));
    return;
  }

  const deliverables = tasksRepo.deliverables(task);

  if (action === 'checklist') {
    const ticked = interaction.values.map(Number).sort((a, b) => a - b);
    const missing = deliverables.filter((_, index) => !ticked.includes(index));

    if (missing.length > 0) {
      // A final submission has to be complete, so this blocks and explains.
      // Answered with a fresh reply rather than an update, which leaves the
      // original select menu in place for them to try again.
      await interaction.reply(priv(
        `**${task.code}** — still missing: ${missing.map((item) => `\`${item}\``).join(', ')}.\n` +
        'Tick everything to continue, or ask your leader to change the deliverables list if one does not apply.'
      ));
      return;
    }

    await interaction.update({
      content: `All ${deliverables.length} deliverables ticked for **${task.code}**. Add your links to finish.`,
      embeds: [],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(customId(NAMESPACE, 'open', task.id, ticked.join('.')))
          .setLabel('Add links and submit')
          .setStyle(ButtonStyle.Success)
      )],
    });
    return;
  }

  if (action === 'open') {
    const indices = args[1] ? args[1].split('.').map(Number) : deliverables.map((_, index) => index);
    await interaction.showModal(submissionModal(task.id, indices));
    return;
  }

  if (action === 'modal') {
    const indices = args[1] ? args[1].split('.').filter((part) => part !== '').map(Number) : [];
    const links = extractLinks(interaction.fields.getTextInputValue('links'));
    const internalLinks = extractLinks(interaction.fields.getTextInputValue('internal'));
    const notes = interaction.fields.getTextInputValue('notes').trim() || null;

    if (links.length === 0) {
      await interaction.reply(priv(
        '❌ No usable links found. Each link must start with `http://` or `https://`. ' +
        'Put one per line and submit again.'
      ));
      return;
    }

    const checklist = deliverables.map((item, index) => ({
      item,
      included: indices.length === 0 ? true : indices.includes(index),
    }));

    const department = configRepo.getDepartment(db, guildId, task.department_id);

    const result = db.transaction(() => {
      const submission = submissionsRepo.addSubmission(db, guildId, task.id, {
        kind: 'final',
        notes,
        links,
        internalLinks,
        checklist,
        submittedBy: interaction.user.id,
      });

      // Each link becomes an archive asset, with source files marked as such so
      // they can never be released to a client by accident.
      assetsRepo.recordSubmissionAssets(db, guildId, {
        submission,
        task,
        deliverableLinks: links,
        internalLinks,
        assetType: department?.key ?? null,
      });

      const updated = tasksRepo.applyTransition(db, guildId, task.id, 'submit_final', {
        actorUserId: interaction.user.id,
        patch: { last_progress_at: Date.now() },
        guardKey: `submit:${task.id}:v${submission.version}`,
        detail: `Submission v${submission.version} with ${links.length} deliverable link(s) and ${internalLinks.length} source file(s)`,
      });

      return { submission, updated };
    })();

    await interaction.reply(priv(
      `✅ Submitted **${task.code}** for internal review (version ${result.submission.version}).\n` +
      `${links.length} link(s) recorded. Your group leader reviews it next — client approval comes after that.`
    ));

    if (task.leader_user_id) {
      await notifyUser(interaction.client, db, guildId, task.leader_user_id, {
        embeds: [new EmbedBuilder()
          .setTitle(`Ready for review: ${task.code} · ${task.title}`)
          .setColor(0x9b59b6)
          .setDescription(
            `<@${interaction.user.id}> submitted version ${result.submission.version}` +
            `${department ? ` in ${department.name}` : ''}.`
          )
          .addFields(
            { name: 'Links', value: links.map((link) => `• ${link}`).join('\n').slice(0, 1024), inline: false },
            { name: 'Checklist', value: checklist.map((entry) => `${entry.included ? '✅' : '⬜'} ${entry.item}`).join('\n').slice(0, 1024) || '_none_', inline: false },
            ...(notes ? [{ name: 'Notes', value: notes.slice(0, 1024), inline: false }] : [])
          )
          .setFooter({ text: `Review it with /review decide task:${task.code}` })],
      }).catch(() => null);
    }
    return;
  }

  await interaction.reply(priv('❌ Unknown submission action.'));
});

module.exports = { NAMESPACE };
