const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const tasksRepo = require('../db/repos/tasks');
const projectsRepo = require('../db/repos/projects');
const configRepo = require('../db/repos/config');
const staffRepo = require('../db/repos/staff');
const offersRepo = require('../db/repos/offers');
const paymentsRepo = require('../db/repos/payments');
const remindersRepo = require('../db/repos/reminders');
const { contextFor } = require('../services/actor');
const { candidateWarnings, sendOffer, withdrawOffer } = require('../services/offerFlow');
const { contributionSummary } = require('../services/absence');
const { notifyUser } = require('../services/notify');
const { CAPABILITIES, assertCan } = require('../domain/permissions');
const { TASK_STATES, stateLabel } = require('../domain/taskState');
const { parseAmount, formatAmount, isSupportedCurrency, CURRENCIES } = require('../domain/money');
const { discordTimestamp } = require('../utils/time');
const { priv } = require('../utils/reply');

const CURRENCY_CHOICES = Object.keys(CURRENCIES).map((code) => ({ name: code, value: code }));
const REASSIGNABLE = [TASK_STATES.OFFERED, TASK_STATES.IN_PROGRESS, TASK_STATES.INTERNAL_REVIEW, TASK_STATES.REVISION_NEEDED, TASK_STATES.ON_HOLD];

module.exports = {
  data: new SlashCommandBuilder()
    .setName('manage')
    .setDescription('Reassign, hold, cancel and compensate')
    .addSubcommand((sub) =>
      sub
        .setName('reassign')
        .setDescription('Move a task to a different artist, keeping the original record')
        .addStringOption((opt) => opt.setName('task').setDescription('Task code').setRequired(true).setAutocomplete(true))
        .addUserOption((opt) => opt.setName('artist').setDescription('Who takes it over').setRequired(true))
        .addStringOption((opt) => opt.setName('reason').setDescription('Why it is moving').setRequired(true))
        .addStringOption((opt) => opt.setName('handoff').setDescription('Handover notes for the new artist').setRequired(false))
    )
    .addSubcommand((sub) =>
      sub
        .setName('hold')
        .setDescription('Put a task on hold')
        .addStringOption((opt) => opt.setName('task').setDescription('Task code').setRequired(true).setAutocomplete(true))
        .addStringOption((opt) => opt.setName('reason').setDescription('Why').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('resume')
        .setDescription('Take a task off hold')
        .addStringOption((opt) => opt.setName('task').setDescription('Task code').setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('cancel')
        .setDescription('Cancel a task, preserving its history')
        .addStringOption((opt) => opt.setName('task').setDescription('Task code').setRequired(true).setAutocomplete(true))
        .addStringOption((opt) => opt.setName('reason').setDescription('Why it is being cancelled').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('compensate')
        .setDescription('Record a payment for work done on a cancelled or reassigned task')
        .addStringOption((opt) => opt.setName('task').setDescription('Task code').setRequired(true).setAutocomplete(true))
        .addUserOption((opt) => opt.setName('member').setDescription('Who is being compensated').setRequired(true))
        .addStringOption((opt) => opt.setName('amount').setDescription('Amount').setRequired(true))
        .addStringOption((opt) => opt.setName('currency').setDescription('Currency').addChoices(...CURRENCY_CHOICES).setRequired(false))
        .addStringOption((opt) => opt.setName('reason').setDescription('What it is for').setRequired(false))
        .addStringOption((opt) => opt.setName('method').setDescription('How it was paid').setRequired(false))
    )
    .addSubcommand((sub) => sub.setName('flags').setDescription('Tasks waiting on a decision from you')),

  async autocomplete(interaction) {
    const { db, guildId, actor } = contextFor(interaction);
    const query = String(interaction.options.getFocused() || '');
    const departmentId = actor.isOwner || actor.leadDepartmentIds.length === 0 ? null : actor.leadDepartmentIds[0];
    const matches = tasksRepo.searchTasks(db, guildId, query, { departmentId, limit: 25 });

    await interaction.respond(matches.map((task) => ({
      name: `${task.code} · ${task.title} · ${stateLabel(task.state)}`.slice(0, 100),
      value: task.code,
    })));
  },

  async execute(interaction) {
    const { db, guildId, config, actor } = contextFor(interaction);
    const sub = interaction.options.getSubcommand();
    const userId = interaction.user.id;

    if (sub === 'flags') {
      assertCan(actor, CAPABILITIES.SUMMARY_VIEW);

      const flagged = db.prepare(`
        SELECT * FROM tasks WHERE guild_id = ? AND (scope_review_flag = 1 OR compensation_review_flag = 1)
        ORDER BY updated_at DESC LIMIT 25
      `).all(guildId);

      if (flagged.length === 0) {
        await interaction.reply(priv('Nothing is waiting on a decision from you.'));
        return;
      }

      await interaction.reply(priv({
        embeds: [new EmbedBuilder()
          .setTitle('Waiting on your decision')
          .setColor(0xfaa61a)
          .setDescription(flagged.map((task) => {
            const reasons = [];
            if (task.scope_review_flag) reasons.push('client asked for work beyond the agreed scope');
            if (task.compensation_review_flag) reasons.push('work was done before this task moved or stopped');
            return `**${task.code}** ${task.title} · ${stateLabel(task.state)}\n┗ ${reasons.join('; ')}`;
          }).join('\n').slice(0, 4000))
          .setFooter({ text: 'Settle pay with /manage compensate, or adjust the task and clear it with /manage flags.' })],
      }));
      return;
    }

    const code = interaction.options.getString('task', true);
    const task = tasksRepo.getTaskByCode(db, guildId, code);
    if (!task) {
      await interaction.reply(priv(`❌ No task with code \`${code}\`.`));
      return;
    }
    const project = projectsRepo.getProject(db, guildId, task.project_id);

    if (sub === 'reassign') {
      assertCan(actor, CAPABILITIES.TASK_REASSIGN, { departmentId: task.department_id });

      if (!REASSIGNABLE.includes(task.state)) {
        await interaction.reply(priv(`❌ **${task.code}** is ${stateLabel(task.state)} and cannot be reassigned.`));
        return;
      }

      const newArtist = interaction.options.getUser('artist', true);
      if (newArtist.id === task.artist_user_id) {
        await interaction.reply(priv(`**${task.code}** is already assigned to <@${newArtist.id}>.`));
        return;
      }

      const previousArtist = task.artist_user_id;
      const reason = interaction.options.getString('reason', true);
      const handoff = interaction.options.getString('handoff');
      const contribution = contributionSummary(db, task.id);
      const department = configRepo.getDepartment(db, guildId, task.department_id);

      // Any live offer to the previous artist is closed first, so they are not
      // left holding a button for work that has moved on.
      if (task.state === TASK_STATES.OFFERED) {
        await withdrawOffer(interaction.client, db, {
          guildId, taskId: task.id, actorUserId: userId, reason: `Reassigned: ${reason}`,
        });
      }

      const moved = db.transaction(() => {
        const updated = tasksRepo.applyTransition(db, guildId, task.id, 'reassign', {
          actorUserId: userId,
          patch: { artist_user_id: newArtist.id, accepted_at: null, accepted_terms_json: null },
          detail: `From ${previousArtist || 'nobody'} to ${newArtist.id}: ${reason}${handoff ? ` · handoff: ${handoff}` : ''}`,
        });

        // Work already done is never deleted; it is flagged so the owner can
        // decide what the original artist is owed.
        if (contribution.hasWork && previousArtist) {
          tasksRepo.setFlag(db, guildId, task.id, 'compensation', true, userId,
            `${previousArtist} submitted ${contribution.submissionCount} time(s) before this moved`);
        }
        return updated;
      })();

      remindersRepo.clearForEntity(db, guildId, 'task', task.id);

      const result = await sendOffer(interaction.client, db, {
        guildId,
        task: tasksRepo.getTask(db, guildId, task.id),
        artistUserId: newArtist.id,
        offeredBy: userId,
        guildName: interaction.guild?.name ?? null,
      });

      const warnings = candidateWarnings(db, guildId, {
        staff: staffRepo.getStaff(db, guildId, newArtist.id),
        department,
      });

      await interaction.reply(priv([
        `✅ **${task.code}** reassigned${previousArtist ? ` from <@${previousArtist}>` : ''} to <@${newArtist.id}>.`,
        `Reason recorded: ${reason}`,
        result.ok
          ? `They have been sent the offer${result.delivery.delivered ? '' : ' — but I could not reach them, so tell them directly'}. Nothing starts until they accept.`
          : `⚠️ The offer could not be sent: ${result.reason === 'pay_not_approved' ? 'the pay is not approved' : result.reason}.`,
        contribution.hasWork && previousArtist
          ? `⚠️ <@${previousArtist}> had already submitted ${contribution.submissionCount} time(s). Their work is kept and the task is flagged for you to decide what they are owed — \`/manage compensate task:${task.code}\`.`
          : null,
        warnings.length > 0 ? `\nWorth knowing: ${warnings.join(' ')}` : null,
      ].filter((line) => line !== null).join('\n')));

      if (previousArtist) {
        await notifyUser(interaction.client, db, guildId, previousArtist, {
          content:
            `**${task.code} · ${task.title}** has been reassigned.\nReason: ${reason}\n` +
            `${contribution.hasWork ? 'Your submissions are kept on the record and the owner has been asked to decide on compensation for them.' : ''}`,
        }).catch(() => null);
      }
      if (handoff) {
        await notifyUser(interaction.client, db, guildId, newArtist.id, {
          content: `📋 Handover notes for **${task.code} · ${task.title}**:\n> ${handoff}`,
        }).catch(() => null);
      }
      return;
    }

    if (sub === 'hold') {
      assertCan(actor, CAPABILITIES.TASK_HOLD, { departmentId: task.department_id });

      const reason = interaction.options.getString('reason', true);
      const updated = tasksRepo.applyTransition(db, guildId, task.id, 'hold', {
        actorUserId: userId,
        detail: reason,
      });
      remindersRepo.clearForEntity(db, guildId, 'task', task.id);

      await interaction.reply(priv(`✅ **${updated.code}** is on hold. Reason recorded: ${reason}\nReminders for it are paused.`));

      if (updated.artist_user_id) {
        await notifyUser(interaction.client, db, guildId, updated.artist_user_id, {
          content: `⏸️ **${updated.code} · ${updated.title}** has been put on hold.\nReason: ${reason}\nPause work until it resumes.`,
        }).catch(() => null);
      }
      return;
    }

    if (sub === 'resume') {
      assertCan(actor, CAPABILITIES.TASK_HOLD, { departmentId: task.department_id });

      const action = task.artist_user_id ? 'resume' : 'resume_unassigned';
      const updated = tasksRepo.applyTransition(db, guildId, task.id, action, { actorUserId: userId });

      await interaction.reply(priv(
        `✅ **${updated.code}** is ${updated.artist_user_id ? `back with <@${updated.artist_user_id}>` : 'back in the unassigned queue'}.`
      ));

      if (updated.artist_user_id) {
        await notifyUser(interaction.client, db, guildId, updated.artist_user_id, {
          content: `▶️ **${updated.code} · ${updated.title}** is off hold and back with you.`,
        }).catch(() => null);
      }
      return;
    }

    if (sub === 'cancel') {
      assertCan(actor, CAPABILITIES.TASK_CANCEL);

      if (task.state === TASK_STATES.CANCELLED) {
        await interaction.reply(priv(`**${task.code}** is already cancelled.`));
        return;
      }

      const reason = interaction.options.getString('reason', true);
      const contribution = contributionSummary(db, task.id);
      const previousArtist = task.artist_user_id;

      if (task.state === TASK_STATES.OFFERED) {
        await withdrawOffer(interaction.client, db, {
          guildId, taskId: task.id, actorUserId: userId, reason: `Cancelled: ${reason}`,
        });
      }

      const cancelled = db.transaction(() => {
        const updated = tasksRepo.applyTransition(db, guildId, tasksRepo.getTask(db, guildId, task.id).id, 'cancel', {
          actorUserId: userId,
          patch: { cancel_reason: reason },
          detail: reason,
        });
        if (contribution.hasWork && previousArtist) {
          tasksRepo.setFlag(db, guildId, task.id, 'compensation', true, userId,
            `${previousArtist} submitted ${contribution.submissionCount} time(s) before cancellation`);
        }
        return updated;
      })();

      remindersRepo.clearForEntity(db, guildId, 'task', task.id);

      await interaction.reply(priv([
        `✅ **${cancelled.code}** cancelled. Reason recorded: ${reason}`,
        'Its history, submissions and any payments are kept.',
        contribution.hasWork && previousArtist
          ? `⚠️ <@${previousArtist}> had submitted ${contribution.submissionCount} time(s). Record what they are owed with \`/manage compensate task:${cancelled.code} member:@them\`.`
          : null,
      ].filter((line) => line !== null).join('\n')));

      if (previousArtist) {
        await notifyUser(interaction.client, db, guildId, previousArtist, {
          content:
            `❌ **${cancelled.code} · ${cancelled.title}** has been cancelled.\nReason: ${reason}\n` +
            `${contribution.hasWork ? 'Your work is kept on the record and the owner has been asked to decide on compensation.' : ''}`,
        }).catch(() => null);
      }
      return;
    }

    if (sub === 'compensate') {
      assertCan(actor, CAPABILITIES.PAYMENT_RECORD);

      const member = interaction.options.getUser('member', true);
      const currency = interaction.options.getString('currency') || task.artist_pay_currency || config.default_currency;
      if (!isSupportedCurrency(currency)) {
        await interaction.reply(priv(`❌ Unsupported currency \`${currency}\`.`));
        return;
      }

      const amountMinor = parseAmount(interaction.options.getString('amount', true), currency);
      const reason = interaction.options.getString('reason') || 'Compensation for work done';

      // Recorded as compensation rather than artist pay, so it does not change
      // the task's own payment progress or look like the agreed fee.
      const { created } = paymentsRepo.recordPayment(db, guildId, {
        direction: paymentsRepo.DIRECTIONS.PAYOUT,
        projectId: task.project_id,
        taskId: task.id,
        payeeUserId: member.id,
        allocationKind: 'compensation',
        amountMinor,
        currency,
        methodLabel: interaction.options.getString('method'),
        note: reason,
        recordedBy: userId,
        idempotencyKey: `compensation:${task.id}:${member.id}:${interaction.id}`,
      });

      if (!created) {
        await interaction.reply(priv('That exact compensation payment was already recorded.'));
        return;
      }

      tasksRepo.setFlag(db, guildId, task.id, 'compensation', false, userId, `Settled with ${formatAmount(amountMinor, currency)}`);

      await interaction.reply(priv(
        `✅ Recorded **${formatAmount(amountMinor, currency)}** compensation to <@${member.id}> for **${task.code}**.\n` +
        `Reason: ${reason}\nThe compensation flag on this task is cleared.\n_Recorded only — the bot does not move money._`
      ));

      await notifyUser(interaction.client, db, guildId, member.id, {
        content:
          `💰 Compensation of **${formatAmount(amountMinor, currency)}** for **${task.code} · ${task.title}** has been recorded.\n` +
          `Reason: ${reason}`,
      }).catch(() => null);
    }
  },
};
