const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const tasksRepo = require('../db/repos/tasks');
const projectsRepo = require('../db/repos/projects');
const paymentsRepo = require('../db/repos/payments');
const configRepo = require('../db/repos/config');
const { contextFor } = require('../services/actor');
const allocationFlow = require('../services/allocationFlow');
const paymentState = require('../services/paymentState');
const { notifyUser } = require('../services/notify');
const { CAPABILITIES, assertCan, can } = require('../domain/permissions');
const { RECIPIENT_KINDS } = require('../domain/allocations');
const { parseAmount, formatAmount, formatTotals, isSupportedCurrency, CURRENCIES } = require('../domain/money');
const { TASK_STATES } = require('../domain/taskState');
const { discordTimestamp } = require('../utils/time');
const { priv } = require('../utils/reply');

const CURRENCY_CHOICES = Object.keys(CURRENCIES).map((code) => ({ name: code, value: code }));

function methodChoices(config) {
  return configRepo.paymentMethods(config).slice(0, 25).map((label) => ({ name: label, value: label }));
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('finance')
    .setDescription('Client receipts, staff payouts and the studio ledger')
    .addSubcommand((sub) =>
      sub
        .setName('client-receipt')
        .setDescription("Record money received from a client")
        .addStringOption((opt) => opt.setName('project').setDescription('Project code').setRequired(true).setAutocomplete(true))
        .addStringOption((opt) => opt.setName('amount').setDescription('Amount received').setRequired(true))
        .addStringOption((opt) => opt.setName('currency').setDescription('Currency').addChoices(...CURRENCY_CHOICES).setRequired(false))
        .addStringOption((opt) => opt.setName('method').setDescription('How it was paid, e.g. PayPal or gift card').setRequired(false))
        .addStringOption((opt) => opt.setName('reference').setDescription('Non-sensitive reference (never a gift card code)').setRequired(false))
    )
    .addSubcommand((sub) =>
      sub
        .setName('pay')
        .setDescription("Record a payout to the task's artist")
        .addStringOption((opt) => opt.setName('task').setDescription('Task code').setRequired(true).setAutocomplete(true))
        .addStringOption((opt) => opt.setName('amount').setDescription('Amount paid (defaults to the whole outstanding balance)').setRequired(false))
        .addStringOption((opt) => opt.setName('method').setDescription('How it was paid').setRequired(false))
        .addStringOption((opt) => opt.setName('reference').setDescription('Non-sensitive reference (never a gift card code)').setRequired(false))
    )
    .addSubcommand((sub) =>
      sub
        .setName('pay-split')
        .setDescription('Record a payout of a finder, leader, mod or owner share')
        .addStringOption((opt) => opt.setName('task').setDescription('Task code').setRequired(true).setAutocomplete(true))
        .addStringOption((opt) =>
          opt.setName('share').setDescription('Which share').setRequired(true)
            .addChoices(...RECIPIENT_KINDS.map((kind) => ({ name: kind, value: kind })))
        )
        .addStringOption((opt) => opt.setName('amount').setDescription('Amount paid (defaults to the outstanding share)').setRequired(false))
        .addStringOption((opt) => opt.setName('method').setDescription('How it was paid').setRequired(false))
        .addStringOption((opt) => opt.setName('reference').setDescription('Non-sensitive reference').setRequired(false))
    )
    .addSubcommand((sub) =>
      sub
        .setName('splits')
        .setDescription('Show how a task\'s leftover pool divides')
        .addStringOption((opt) => opt.setName('task').setDescription('Task code').setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('set-pool')
        .setDescription('Enter the distributable pool by hand when currencies differ')
        .addStringOption((opt) => opt.setName('task').setDescription('Task code').setRequired(true).setAutocomplete(true))
        .addStringOption((opt) => opt.setName('amount').setDescription('Pool to divide').setRequired(true))
        .addStringOption((opt) => opt.setName('currency').setDescription('Currency of the pool').addChoices(...CURRENCY_CHOICES).setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('mark-payable')
        .setDescription('Make approved work payable before the client payment lands')
        .addStringOption((opt) => opt.setName('task').setDescription('Task code').setRequired(true).setAutocomplete(true))
        .addStringOption((opt) => opt.setName('reason').setDescription('Why, for the record').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('ledger')
        .setDescription('Money in and money out, per currency')
        .addStringOption((opt) => opt.setName('project').setDescription('Limit to one project').setRequired(false).setAutocomplete(true))
    )
    .addSubcommand((sub) => sub.setName('outstanding').setDescription('Approved work that still owes somebody money'))
    .addSubcommand((sub) =>
      sub
        .setName('balance')
        .setDescription('What a staff member is owed and has been paid')
        .addUserOption((opt) => opt.setName('member').setDescription('Staff member').setRequired(true))
    ),

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);
    const { db, guildId } = contextFor(interaction);
    const query = String(focused.value || '');

    if (focused.name === 'project') {
      const matches = query
        ? projectsRepo.searchProjects(db, guildId, query, 25)
        : projectsRepo.listProjects(db, guildId, { status: 'active', limit: 25 });
      await interaction.respond(matches.map((p) => ({ name: `${p.code} · ${p.name}`.slice(0, 100), value: p.code })));
      return;
    }

    if (focused.name === 'task') {
      const matches = tasksRepo.searchTasks(db, guildId, query, { limit: 25 });
      await interaction.respond(matches.map((task) => ({
        name: `${task.code} · ${task.title} · ${task.payment_state.replace(/_/g, ' ')}`.slice(0, 100),
        value: task.code,
      })));
    }
  },

  async execute(interaction) {
    const { db, guildId, config, actor } = contextFor(interaction);
    const sub = interaction.options.getSubcommand();
    const userId = interaction.user.id;

    if (sub === 'client-receipt') {
      assertCan(actor, CAPABILITIES.CLIENT_RECEIPT_RECORD);

      const project = projectsRepo.getProjectByCode(db, guildId, interaction.options.getString('project', true));
      if (!project) {
        await interaction.reply(priv('❌ No project with that code.'));
        return;
      }

      const currency = interaction.options.getString('currency') || project.client_currency || config.default_currency;
      if (!isSupportedCurrency(currency)) {
        await interaction.reply(priv(`❌ Unsupported currency \`${currency}\`.`));
        return;
      }

      const amountMinor = parseAmount(interaction.options.getString('amount', true), currency);
      const { created, payment } = paymentsRepo.recordPayment(db, guildId, {
        direction: paymentsRepo.DIRECTIONS.CLIENT_RECEIPT,
        projectId: project.id,
        amountMinor,
        currency,
        methodLabel: interaction.options.getString('method'),
        reference: interaction.options.getString('reference'),
        recordedBy: userId,
        idempotencyKey: `receipt:${project.id}:${interaction.id}`,
      });

      if (!created) {
        await interaction.reply(priv('That exact receipt was already recorded.'));
        return;
      }

      const received = projectsRepo.clientReceipts(db, project.id);
      const nowPaidInFull = projectsRepo.isClientPaidInFull(db, project);
      if (nowPaidInFull && !project.client_paid_in_full_at) {
        projectsRepo.markClientPaidInFull(db, guildId, project.id, userId);
      }

      // Receiving the client's money is what can turn approved work payable.
      const changed = paymentState.recomputeProjectPaymentStates(db, guildId, project.id, userId);

      const lines = [
        `✅ Recorded **${formatAmount(amountMinor, currency)}** received for **${project.code}**.`,
        `Received so far: ${formatTotals(received)}${project.client_amount_minor !== null ? ` of ${formatAmount(project.client_amount_minor, project.client_currency)} expected` : ''}.`,
      ];

      if (nowPaidInFull) {
        lines.push('This project is now recorded as paid in full by the client.');
      } else if (project.client_amount_minor !== null) {
        const outstanding = project.client_amount_minor - (received.get(project.client_currency) || 0);
        if (outstanding > 0) lines.push(`Still outstanding from the client: **${formatAmount(outstanding, project.client_currency)}**.`);
      }

      if (changed.length > 0) {
        lines.push(`\n💰 ${changed.length} task(s) became payable: ${changed.map((task) => task.code).join(', ')}.`);
      }
      lines.push('\n_Recorded only — the bot does not move money._');

      await interaction.reply(priv(lines.join('\n')));
      return;
    }

    if (sub === 'ledger') {
      assertCan(actor, CAPABILITIES.FINANCE_VIEW_ALL);

      const projectCode = interaction.options.getString('project');
      const project = projectCode ? projectsRepo.getProjectByCode(db, guildId, projectCode) : null;
      if (projectCode && !project) {
        await interaction.reply(priv('❌ No project with that code.'));
        return;
      }

      const totals = paymentsRepo.totalsByDirection(db, guildId, { projectId: project?.id ?? null });
      const pending = paymentState.pendingPayouts(db, guildId);

      const embed = new EmbedBuilder()
        .setTitle(project ? `Ledger · ${project.code}` : 'Studio ledger')
        .setColor(0x57f287)
        .addFields(
          { name: 'Received from clients', value: formatTotals(totals.received), inline: true },
          { name: 'Paid out to staff', value: formatTotals(totals.paidOut), inline: true },
          {
            name: 'Approved work not yet paid',
            value: `${pending.payable.length} payable · ${pending.awaitingClientMoney.length} waiting on client money`,
            inline: false,
          }
        )
        .setFooter({ text: 'Currencies are never combined: there is no conversion rate between them.' });

      if (project) {
        embed.addFields({
          name: 'Client payment',
          value: project.client_amount_minor === null
            ? '_not set_'
            : `${formatAmount(project.client_amount_minor, project.client_currency)} expected${project.client_paid_in_full_at ? ' · paid in full' : ''}`,
          inline: false,
        });
      }

      await interaction.reply(priv({ embeds: [embed] }));
      return;
    }

    if (sub === 'outstanding') {
      assertCan(actor, CAPABILITIES.FINANCE_VIEW_ALL);

      const pending = paymentState.pendingPayouts(db, guildId);
      const splits = allocationFlow.outstandingAllocations(db, guildId);

      const embed = new EmbedBuilder().setTitle('Outstanding payouts').setColor(0xfaa61a);

      embed.addFields({
        name: `Artist pay owed (${pending.payable.length})`,
        value: pending.payable.length === 0
          ? '_nothing payable right now_'
          : pending.payable.map((task) => {
              const remaining = paymentState.remainingForArtist(db, task);
              return `**${task.code}** <@${task.artist_user_id}> — ${formatAmount(remaining, task.artist_pay_currency)}${task.payment_state === 'partially_paid' ? ' (part paid)' : ''}`;
            }).join('\n').slice(0, 1024),
        inline: false,
      });

      if (pending.awaitingClientMoney.length > 0) {
        embed.addFields({
          name: `Approved but the client has not paid (${pending.awaitingClientMoney.length})`,
          value: pending.awaitingClientMoney.map((task) =>
            `**${task.code}** <@${task.artist_user_id}> — ${task.artist_pay_minor === null ? 'no pay set' : formatAmount(task.artist_pay_minor, task.artist_pay_currency)}`
          ).join('\n').slice(0, 1024),
          inline: false,
        });
      }

      if (splits.length > 0) {
        embed.addFields({
          name: `Shares owed (${splits.length})`,
          value: splits.map((row) =>
            `**${row.task_code}** ${row.recipient_kind} → <@${row.recipient_user_id}> — ${formatAmount(row.outstanding_minor, row.currency)}`
          ).join('\n').slice(0, 1024),
          inline: false,
        });
      }

      await interaction.reply(priv({ embeds: [embed] }));
      return;
    }

    if (sub === 'balance') {
      assertCan(actor, CAPABILITIES.FINANCE_VIEW_ALL);

      const member = interaction.options.getUser('member', true);
      const paid = paymentsRepo.payoutTotalsForPayee(db, guildId, member.id);
      const owedRows = paymentState.pendingPayouts(db, guildId).payable
        .filter((task) => task.artist_user_id === member.id);
      const owedSplits = allocationFlow.outstandingAllocations(db, guildId)
        .filter((row) => row.recipient_user_id === member.id);

      const owedAmounts = [
        ...owedRows.map((task) => ({ minor: paymentState.remainingForArtist(db, task), currency: task.artist_pay_currency })),
        ...owedSplits.map((row) => ({ minor: row.outstanding_minor, currency: row.currency })),
      ].filter((entry) => entry.minor > 0);

      const { totalsByCurrency } = require('../domain/money');
      const embed = new EmbedBuilder()
        .setTitle(`Balance · ${member.displayName || member.username}`)
        .setColor(0x5865f2)
        .addFields(
          { name: 'Paid to date', value: formatTotals(paid), inline: true },
          { name: 'Currently owed', value: formatTotals(totalsByCurrency(owedAmounts)), inline: true },
          {
            name: 'Made up of',
            value: [
              ...owedRows.map((task) => `**${task.code}** artist pay — ${formatAmount(paymentState.remainingForArtist(db, task), task.artist_pay_currency)}`),
              ...owedSplits.map((row) => `**${row.task_code}** ${row.recipient_kind} share — ${formatAmount(row.outstanding_minor, row.currency)}`),
            ].join('\n').slice(0, 1024) || '_nothing outstanding_',
            inline: false,
          }
        );

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

    if (sub === 'splits') {
      assertCan(actor, CAPABILITIES.FINANCE_VIEW_ALL);

      const computed = allocationFlow.computeForTask(db, guildId, task);
      if (!computed.ok) {
        await interaction.reply(priv(
          `❌ Cannot work out the split for **${task.code}**: ${computed.detail || computed.reason}.` +
          `${computed.reason === 'currency_mismatch' ? `\nEnter the pool yourself with \`/finance set-pool task:${task.code}\`.` : ''}` +
          `${computed.reason === 'negative_pool' ? `\nThe shortfall is ${formatAmount(computed.shortfallMinor, task.artist_pay_currency)} — this job is sold below cost.` : ''}`
        ));
        return;
      }

      const stored = allocationFlow.persistForTask(db, guildId, task, userId);
      const embed = new EmbedBuilder()
        .setTitle(`Split · ${task.code}`)
        .setColor(0x57f287)
        .setDescription(
          `Pool: **${formatAmount(computed.poolMinor, computed.currency)}**\n` +
          `Source: ${computed.poolSource.replace(/_/g, ' ')}` +
          `${task.artist_pay_minor !== null ? `\nArtist keeps ${formatAmount(task.artist_pay_minor, task.artist_pay_currency)} in full — the split is only what is left.` : ''}`
        )
        .addFields({
          name: 'Shares',
          value: computed.byKind.map((entry) => {
            const paidAlready = paymentsRepo.paidForAllocation(db, task.id, entry.kind, entry.userId, entry.currency);
            const status = paidAlready >= entry.amountMinor && entry.amountMinor > 0 ? ' ✅ paid' : paidAlready > 0 ? ' (part paid)' : '';
            return `${entry.kind} ${entry.percentBp / 100}% → <@${entry.userId}> · **${formatAmount(entry.amountMinor, entry.currency)}**${status}`;
          }).join('\n').slice(0, 1024),
          inline: false,
        });

      if (computed.unassignedKinds.length > 0) {
        embed.addFields({
          name: 'Fell to you',
          value: `No ${computed.unassignedKinds.join(' or ')} recorded on this project, so ${computed.unassignedKinds.length > 1 ? 'those shares' : 'that share'} went to you.`,
          inline: false,
        });
      }
      if (stored.frozenKinds?.length > 0) {
        embed.setFooter({ text: `${stored.frozenKinds.join(', ')} already paid and left unchanged.` });
      }

      await interaction.reply(priv({ embeds: [embed] }));
      return;
    }

    if (sub === 'set-pool') {
      assertCan(actor, CAPABILITIES.PAYMENT_RECORD);

      const currency = interaction.options.getString('currency', true);
      const amountMinor = parseAmount(interaction.options.getString('amount', true), currency);

      db.prepare('UPDATE tasks SET pool_override_minor = ?, pool_override_currency = ?, updated_at = ? WHERE id = ?')
        .run(amountMinor, currency, Date.now(), task.id);
      require('../db/repos/core').recordAudit(db, {
        guildId, actorUserId: userId, action: 'task.pool.override', entityType: 'task', entityId: task.id,
        after: { pool_override_minor: amountMinor, pool_override_currency: currency },
        detail: 'Pool entered by hand, no conversion rate applied',
      });

      const stored = allocationFlow.persistForTask(db, guildId, tasksRepo.getTask(db, guildId, task.id), userId);
      await interaction.reply(priv(
        `✅ Pool for **${task.code}** set to **${formatAmount(amountMinor, currency)}** by hand.\n` +
        (stored.ok
          ? stored.byKind.map((entry) => `${entry.kind}: <@${entry.userId}> ${formatAmount(entry.amountMinor, entry.currency)}`).join('\n')
          : `Split could not be computed: ${stored.detail || stored.reason}.`)
      ));
      return;
    }

    if (sub === 'mark-payable') {
      assertCan(actor, CAPABILITIES.PAYMENT_RECORD);

      if (task.state !== TASK_STATES.CLIENT_APPROVED) {
        await interaction.reply(priv(`❌ **${task.code}** is not client-approved yet, so there is nothing to pay.`));
        return;
      }

      const reason = interaction.options.getString('reason', true);
      tasksRepo.overridePayable(db, guildId, task.id, { actorUserId: userId, reason });
      await interaction.reply(priv(
        `✅ **${task.code}** is now payable despite the client payment not being recorded as received.\n` +
        `Reason recorded: ${reason}`
      ));
      return;
    }

    if (sub === 'pay') {
      assertCan(actor, CAPABILITIES.PAYMENT_RECORD);

      if (!task.artist_user_id || task.artist_pay_minor === null) {
        await interaction.reply(priv(`❌ **${task.code}** has no artist or no agreed pay.`));
        return;
      }

      const remaining = paymentState.remainingForArtist(db, task);
      if (remaining === 0) {
        await interaction.reply(priv(`**${task.code}** is already fully paid.`));
        return;
      }

      const amountText = interaction.options.getString('amount');
      const amountMinor = amountText ? parseAmount(amountText, task.artist_pay_currency) : remaining;

      // Refuses to record more than is owed, which catches a mistyped amount
      // before it becomes a wrong record.
      if (amountMinor > remaining) {
        await interaction.reply(priv(
          `❌ That is more than is outstanding on **${task.code}**.\n` +
          `Outstanding: **${formatAmount(remaining, task.artist_pay_currency)}**. ` +
          'Change the agreed pay first if the figure itself is wrong.'
        ));
        return;
      }

      if (task.payment_state === tasksRepo.PAYMENT_STATES.PENDING_CLIENT_PAYMENT) {
        await interaction.reply(priv(
          `❌ **${task.code}** is not payable yet: the client payment for ${project?.code} has not been recorded as received.\n` +
          `Record it with \`/finance client-receipt\`, or override with \`/finance mark-payable task:${task.code}\`.`
        ));
        return;
      }

      const { created, payment } = paymentsRepo.recordPayment(db, guildId, {
        direction: paymentsRepo.DIRECTIONS.PAYOUT,
        projectId: task.project_id,
        taskId: task.id,
        payeeUserId: task.artist_user_id,
        amountMinor,
        currency: task.artist_pay_currency,
        methodLabel: interaction.options.getString('method'),
        reference: interaction.options.getString('reference'),
        recordedBy: userId,
        idempotencyKey: `payout:${task.id}:${task.artist_user_id}:${interaction.id}`,
      });

      if (!created) {
        await interaction.reply(priv('That exact payment was already recorded.'));
        return;
      }

      const updated = paymentState.recomputeTaskPaymentState(db, guildId, task.id, userId, 'Payout recorded');
      const stillOwed = paymentState.remainingForArtist(db, updated);

      await interaction.reply(priv([
        `✅ Recorded **${formatAmount(amountMinor, task.artist_pay_currency)}** paid to <@${task.artist_user_id}> for **${task.code}**.`,
        stillOwed > 0
          ? `Still owed: **${formatAmount(stillOwed, task.artist_pay_currency)}** (marked ${updated.payment_state.replace(/_/g, ' ')}).`
          : 'That settles this task.',
        '_Recorded only — the bot does not move money._',
      ].join('\n')));

      await notifyUser(interaction.client, db, guildId, task.artist_user_id, {
        content:
          `💰 A payment of **${formatAmount(amountMinor, task.artist_pay_currency)}** for **${task.code} · ${task.title}** has been recorded.` +
          `${stillOwed > 0 ? `\nStill outstanding: ${formatAmount(stillOwed, task.artist_pay_currency)}.` : ''}` +
          '\nCheck your own record any time with `/work earnings`.',
      }).catch(() => null);
      return;
    }

    if (sub === 'pay-split') {
      assertCan(actor, CAPABILITIES.PAYMENT_RECORD);

      const kind = interaction.options.getString('share', true);
      let allocations = allocationFlow.listAllocations(db, task.id);
      if (allocations.length === 0) {
        const computed = allocationFlow.persistForTask(db, guildId, task, userId);
        if (!computed.ok) {
          await interaction.reply(priv(`❌ No split exists for **${task.code}**: ${computed.detail || computed.reason}.`));
          return;
        }
        allocations = allocationFlow.listAllocations(db, task.id);
      }

      const allocation = allocations.find((row) => row.recipient_kind === kind);
      if (!allocation) {
        await interaction.reply(priv(`❌ **${task.code}** has no ${kind} share.`));
        return;
      }

      const outstanding = allocationFlow.allocationOutstanding(db, task, allocation);
      if (outstanding === 0) {
        await interaction.reply(priv(`The ${kind} share on **${task.code}** is already paid.`));
        return;
      }

      const amountText = interaction.options.getString('amount');
      const amountMinor = amountText ? parseAmount(amountText, allocation.currency) : outstanding;
      if (amountMinor > outstanding) {
        await interaction.reply(priv(
          `❌ That is more than the ${kind} share still owes (**${formatAmount(outstanding, allocation.currency)}**).`
        ));
        return;
      }

      const { created } = paymentsRepo.recordPayment(db, guildId, {
        direction: paymentsRepo.DIRECTIONS.PAYOUT,
        projectId: task.project_id,
        taskId: task.id,
        payeeUserId: allocation.recipient_user_id,
        allocationKind: kind,
        amountMinor,
        currency: allocation.currency,
        methodLabel: interaction.options.getString('method'),
        reference: interaction.options.getString('reference'),
        recordedBy: userId,
        idempotencyKey: `split:${task.id}:${kind}:${interaction.id}`,
      });

      if (!created) {
        await interaction.reply(priv('That exact payment was already recorded.'));
        return;
      }

      const nowOutstanding = allocationFlow.allocationOutstanding(db, task, allocation);
      if (nowOutstanding === 0) allocationFlow.freezeAllocation(db, task.id, kind);

      await interaction.reply(priv(
        `✅ Recorded **${formatAmount(amountMinor, allocation.currency)}** paid to <@${allocation.recipient_user_id}> ` +
        `as the ${kind} share of **${task.code}**.` +
        `${nowOutstanding > 0 ? `\nStill owed on this share: ${formatAmount(nowOutstanding, allocation.currency)}.` : '\nThis share is settled and is now frozen against recalculation.'}`
      ));
    }
  },
};
