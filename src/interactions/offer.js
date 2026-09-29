const {
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  EmbedBuilder,
} = require('discord.js');
const { getDatabase } = require('../db');
const offersRepo = require('../db/repos/offers');
const tasksRepo = require('../db/repos/tasks');
const projectsRepo = require('../db/repos/projects');
const configRepo = require('../db/repos/config');
const { acceptOffer, declineOffer, describeTerms } = require('../services/offerFlow');
const messageTriggers = require('../services/messageTriggers');
const { register, customId } = require('./router');
const { discordTimestamp } = require('../utils/time');
const { priv } = require('../utils/reply');

const NAMESPACE = 'offer';

const FAILURE_MESSAGES = {
  offer_not_found: 'That offer no longer exists.',
  not_your_offer: 'That offer was not made to you.',
  already_answered: 'That offer has already been answered.',
  task_not_found: 'The task behind that offer no longer exists.',
};

/**
 * Offer buttons are clicked in DMs, so there is no guild on the interaction.
 * Everything is resolved from the offer id instead.
 */
function loadOffer(offerId) {
  const db = getDatabase();
  const guildId = offersRepo.guildIdForOffer(db, offerId);
  if (!guildId) return { db, guildId: null, offer: null };
  return { db, guildId, offer: offersRepo.getOffer(db, offerId) };
}

function declineModal(offerId) {
  return new ModalBuilder()
    .setCustomId(customId(NAMESPACE, 'declineModal', offerId))
    .setTitle('Decline this task')
    .addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('reason')
        .setLabel('Why are you declining?')
        .setPlaceholder('Too busy this week / not my specialty / deadline too tight')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(300)
    ));
}

/**
 * Removes the buttons from the original offer message so it cannot be answered
 * twice from the same message, and leaves a record of what was decided.
 */
async function settleMessage(interaction, { task, decision, detail }) {
  const embed = new EmbedBuilder()
    .setTitle(`${decision === 'accepted' ? '✅ Accepted' : '✖️ Declined'}: ${task.code} · ${task.title}`)
    .setColor(decision === 'accepted' ? 0x57f287 : 0xed4245)
    .setDescription(detail);

  const payload = { embeds: [embed], components: [] };
  if (interaction.isModalSubmit()) {
    // Modal submits from a DM cannot update the original message directly.
    await interaction.message?.edit(payload).catch(() => null);
    return;
  }
  await interaction.update(payload).catch(() => null);
}

register(NAMESPACE, async (interaction, { action, args }) => {
  const offerId = Number(args[0]);
  const { db, guildId, offer } = loadOffer(offerId);

  if (!guildId || !offer) {
    await interaction.reply(priv(`❌ ${FAILURE_MESSAGES.offer_not_found}`));
    return;
  }
  if (offer.artist_user_id !== interaction.user.id) {
    await interaction.reply(priv(`❌ ${FAILURE_MESSAGES.not_your_offer}`));
    return;
  }

  if (action === 'decline') {
    if (offer.state !== offersRepo.OFFER_STATES.PENDING) {
      await interaction.reply(priv(`❌ ${FAILURE_MESSAGES.already_answered}`));
      return;
    }
    await interaction.showModal(declineModal(offerId));
    return;
  }

  if (action === 'accept') {
    const result = await acceptOffer(interaction.client, db, {
      guildId,
      offerId,
      actorUserId: interaction.user.id,
    });

    if (!result.ok) {
      await interaction.reply(priv(`❌ ${FAILURE_MESSAGES[result.reason] || 'Could not accept that offer.'}`));
      return;
    }

    const task = result.task;
    const project = projectsRepo.getProject(db, guildId, task.project_id);
    const department = configRepo.getDepartment(db, guildId, task.department_id);

    // Somebody accepting the first task is the moment work actually starts on
    // the order. Deduplicated per project, so later acceptances say nothing.
    if (project?.client_id) {
      messageTriggers.productionStarted(db, guildId, project, { queuedBy: interaction.user.id });
    }
    const terms = offersRepo.terms(result.offer);

    await settleMessage(interaction, {
      task,
      decision: 'accepted',
      detail: [
        `You accepted this on ${discordTimestamp(task.accepted_at, 'F')}.`,
        '',
        '**Agreed terms**',
        describeTerms(terms) || '_no terms recorded_',
        '',
        `Department: ${department?.name || '—'}${project ? ` · Project: ${project.code}` : ''}`,
        '',
        'Post updates with `/work progress` and submit with `/work submit` in the server.',
      ].join('\n'),
    });
    return;
  }

  if (action === 'declineModal') {
    const reason = interaction.fields.getTextInputValue('reason').trim();

    const result = await declineOffer(interaction.client, db, {
      guildId,
      offerId,
      actorUserId: interaction.user.id,
      reason,
    });

    if (!result.ok) {
      await interaction.reply(priv(`❌ ${FAILURE_MESSAGES[result.reason] || 'Could not decline that offer.'}`));
      return;
    }

    await interaction.reply(priv(
      `✅ Declined **${result.task.code}**. Your group leader has been told why, and the task went back to their queue.`
    ));
    await settleMessage(interaction, {
      task: result.task,
      decision: 'declined',
      detail: `You declined this offer.\nReason given: ${reason}`,
    });
    return;
  }

  await interaction.reply(priv('❌ Unknown offer action.'));
});

module.exports = { NAMESPACE };
