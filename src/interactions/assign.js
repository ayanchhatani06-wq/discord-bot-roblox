const {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} = require('discord.js');
const tasksRepo = require('../db/repos/tasks');
const staffRepo = require('../db/repos/staff');
const configRepo = require('../db/repos/config');
const { contextFor } = require('../services/actor');
const { candidateWarnings, sendOffer } = require('../services/offerFlow');
const { checkTaskReadiness, describeReadiness } = require('../services/readiness');
const { candidateDescription, formatPay } = require('../services/taskView');
const { register, customId } = require('./router');
const { CAPABILITIES, assertCan } = require('../domain/permissions');
const { TASK_STATES, stateLabel } = require('../domain/taskState');
const { formatTimeInZone } = require('../utils/time');
const { priv } = require('../utils/reply');

const NAMESPACE = 'assign';
const MAX_OPTIONS = 25;

/**
 * The leader's shortlist: their department's staff with the facts needed to
 * choose — availability, current load, local time and specialties. Nothing is
 * auto-assigned and nobody is filtered out for being busy; that is the
 * leader's judgement call.
 */
function buildCandidateMenu(db, guildId, task, department) {
  const now = new Date();
  const staffRows = staffRepo.listStaff(db, guildId, { departmentId: task.department_id });
  const activeCounts = staffRepo.activeTaskCounts(db, guildId);

  const ordered = [...staffRows].sort((a, b) => {
    const order = { accepting: 0, at_capacity: 1, away: 2 };
    const byAvailability = (order[a.availability] ?? 3) - (order[b.availability] ?? 3);
    if (byAvailability !== 0) return byAvailability;
    return (activeCounts.get(a.user_id) || 0) - (activeCounts.get(b.user_id) || 0);
  });

  const options = ordered.slice(0, MAX_OPTIONS).map((staff) => ({
    label: (staff.display_name || staff.user_id).slice(0, 100),
    value: staff.user_id,
    description: candidateDescription({
      staff,
      activeCount: activeCounts.get(staff.user_id) || 0,
      localTime: staff.timezone ? formatTimeInZone(staff.timezone, now) : 'no timezone',
      taskCap: department?.task_cap,
    }),
    emoji: staffRepo.AVAILABILITY_EMOJI[staff.availability] || '⚪',
  }));

  return { options, total: staffRows.length };
}

register(NAMESPACE, async (interaction, { action, args }) => {
  const { db, guildId, actor } = contextFor(interaction);
  const taskId = Number(args[0]);
  const task = tasksRepo.getTask(db, guildId, taskId);

  if (!task) {
    await interaction.reply(priv('❌ That task no longer exists.'));
    return;
  }

  assertCan(actor, CAPABILITIES.TASK_OFFER, { departmentId: task.department_id });
  const department = configRepo.getDepartment(db, guildId, task.department_id);

  if (action === 'pick') {
    if (task.state !== TASK_STATES.UNASSIGNED) {
      await interaction.reply(priv(`❌ **${task.code}** is ${stateLabel(task.state)} and is not waiting for an artist.`));
      return;
    }
    // Checked before anyone is picked, so an incomplete task is caught before
    // an artist is asked to accept terms that do not exist yet.
    const readiness = checkTaskReadiness(db, guildId, task);
    if (!readiness.ok) {
      await interaction.reply(priv(
        `❌ **${task.code}** is not ready to offer.\n${describeReadiness(readiness)}`
      ));
      return;
    }

    const { options, total } = buildCandidateMenu(db, guildId, task, department);
    if (options.length === 0) {
      await interaction.reply(priv(
        `Nobody is filed under **${department?.name}** yet. Ask them to run \`/profile me\`, ` +
        'or file them with `/profile assign`.'
      ));
      return;
    }

    await interaction.reply(priv({
      content:
        `**${task.code} · ${task.title}** — pay ${formatPay(task)}.\n` +
        `Pick the artist${total > options.length ? ` (showing ${options.length} of ${total})` : ''}:`,
      components: [new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(customId(NAMESPACE, 'choose', task.id))
          .setPlaceholder('Choose an artist')
          .addOptions(options)
      )],
    }));
    return;
  }

  if (action === 'choose' || action === 'confirm') {
    const artistUserId = action === 'choose' ? interaction.values[0] : args[1];
    const staff = staffRepo.getStaff(db, guildId, artistUserId);

    if (action === 'choose') {
      const readiness = checkTaskReadiness(db, guildId, task);
      const warnings = [
        ...candidateWarnings(db, guildId, { staff, department }),
        ...readiness.warnings,
      ];
      if (warnings.length > 0) {
        // Warn and require a second, explicit click rather than blocking.
        await interaction.update({
          content: null,
          embeds: [new EmbedBuilder()
            .setTitle('Check before offering')
            .setColor(0xfaa61a)
            .setDescription(
              `You are about to offer **${task.code} · ${task.title}** to <@${artistUserId}>.\n\n` +
              warnings.map((warning) => `⚠️ ${warning}`).join('\n') +
              '\n\nYou can still go ahead — this is your call.'
            )],
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(customId(NAMESPACE, 'confirm', task.id, artistUserId))
              .setLabel('Offer anyway')
              .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
              .setCustomId(customId(NAMESPACE, 'pick', task.id))
              .setLabel('Pick someone else')
              .setStyle(ButtonStyle.Secondary)
          )],
        });
        return;
      }
    }

    await interaction.deferUpdate();

    const result = await sendOffer(interaction.client, db, {
      guildId,
      task,
      artistUserId,
      offeredBy: interaction.user.id,
      guildName: interaction.guild?.name ?? null,
    });

    if (!result.ok) {
      await interaction.editReply({
        content: result.reason === 'pay_not_approved'
          ? `❌ **${task.code}** cannot be offered until the owner approves the pay.`
          : '❌ Could not send that offer.',
        embeds: [],
        components: [],
      });
      return;
    }

    const delivery = result.delivery.delivered
      ? result.delivery.via === 'dm'
        ? 'They have been sent a DM.'
        : 'Their DMs were closed, so it went to the fallback channel.'
      : '⚠️ I could not reach them by DM and there is no working fallback channel — tell them directly, ' +
        'or set one with `/setup channel purpose:DM fallback`.';

    await interaction.editReply({
      content:
        `✅ Offered **${task.code} · ${task.title}** to <@${artistUserId}> at ${formatPay(result.task)}.\n${delivery}\n` +
        'Nothing starts until they accept.',
      embeds: [],
      components: [],
    });
    return;
  }

  await interaction.reply(priv('❌ Unknown assignment action.'));
});

module.exports = { NAMESPACE, buildCandidateMenu };
