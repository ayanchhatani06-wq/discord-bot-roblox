const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const tasksRepo = require('../db/repos/tasks');
const projectsRepo = require('../db/repos/projects');
const paymentsRepo = require('../db/repos/payments');
const configRepo = require('../db/repos/config');
const { contextFor } = require('../services/actor');
const allocationFlow = require('../services/allocationFlow');
const budget = require('../services/budget');
const paymentState = require('../services/paymentState');
const paymentSchedule = require('../services/paymentSchedule');
const bulkPay = require('../services/bulkPay');
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
        .setDescription("Record a payout to someone who worked on the task")
        .addStringOption((opt) => opt.setName('task').setDescription('Task code').setRequired(true).setAutocomplete(true))
        .addUserOption((opt) => opt.setName('person').setDescription('Who was paid (needed when several people share the task)').setRequired(false))
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
    )
    .addSubcommand((sub) =>
      sub
        .setName('budget')
        .setDescription('What a project has committed in pay against what the client pays')
        .addStringOption((opt) => opt.setName('project').setDescription('Project code').setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('budget-override')
        .setDescription('Deliberately allow pay above the recorded client payment on a project')
        .addStringOption((opt) => opt.setName('project').setDescription('Project code').setRequired(true).setAutocomplete(true))
        .addStringOption((opt) => opt.setName('reason').setDescription('Why, for the record').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('budget-restore')
        .setDescription('Put the budget guard back on a project')
        .addStringOption((opt) => opt.setName('project').setDescription('Project code').setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('confirm-received')
        .setDescription('The person says the money actually reached them')
        .addIntegerOption((opt) => opt.setName('payment').setDescription('Payment number from /finance sent').setRequired(true))
        .addStringOption((opt) => opt.setName('note').setDescription('Anything worth recording').setRequired(false).setMaxLength(200))
    )
    .addSubcommand((sub) =>
      sub
        .setName('mark-failed')
        .setDescription('A payment was sent and did not arrive — they are owed it again')
        .addIntegerOption((opt) => opt.setName('payment').setDescription('Payment number from /finance sent').setRequired(true))
        .addStringOption((opt) => opt.setName('reason').setDescription('What went wrong').setRequired(true).setMaxLength(200))
    )
    .addSubcommand((sub) =>
      sub.setName('sent').setDescription('Payments sent that nobody has confirmed arrived')
    )
    .addSubcommand((sub) =>
      sub
        .setName('approve-all')
        .setDescription('Approve every pay figure your leaders have proposed')
        .addStringOption((opt) => opt.setName('project').setDescription('Only one order').setRequired(false).setAutocomplete(true))
        .addBooleanOption((opt) => opt.setName('preview').setDescription('Show what would happen without doing it').setRequired(false))
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

    if (sub === 'budget' || sub === 'budget-override' || sub === 'budget-restore') {
      // Budget is a money decision, so it sits behind the same capability as
      // the ledger rather than behind project editing.
      assertCan(actor, CAPABILITIES.FINANCE_VIEW_ALL);

      const project = projectsRepo.getProjectByCode(db, guildId, interaction.options.getString('project', true));
      if (!project) {
        await interaction.reply(priv('❌ No project with that code.'));
        return;
      }

      if (sub === 'budget-override') {
        assertCan(actor, CAPABILITIES.PAYMENT_RECORD);
        const reason = interaction.options.getString('reason', true);
        budget.setBudgetOverride(db, guildId, project.id, { actorUserId: userId, reason });
        await interaction.reply(priv(
          `✅ Pay on **${project.code}** may now exceed the recorded client payment.\n` +
          `Reason recorded: ${reason}\n` +
          `Put the guard back with \`/finance budget-restore project:${project.code}\`.`
        ));
        return;
      }

      if (sub === 'budget-restore') {
        assertCan(actor, CAPABILITIES.PAYMENT_RECORD);
        budget.clearBudgetOverride(db, guildId, project.id, userId);
        await interaction.reply(priv(`✅ The budget guard is back on **${project.code}**.`));
        return;
      }

      const committed = budget.committedByCurrency(db, guildId, project.id);
      const lines = [];

      if (project.client_amount_minor === null || !project.client_currency) {
        lines.push('_No client amount is recorded on this project, so there is nothing to measure against._');
      } else {
        const inBudgetCurrency = committed.get(project.client_currency) || 0;
        const remaining = project.client_amount_minor - inBudgetCurrency;
        lines.push(
          `Client pays: **${formatAmount(project.client_amount_minor, project.client_currency)}**`,
          `Committed in pay: **${formatAmount(inBudgetCurrency, project.client_currency)}**`,
          remaining >= 0
            ? `Left to allocate: **${formatAmount(remaining, project.client_currency)}**`
            : `⚠️ Over by **${formatAmount(-remaining, project.client_currency)}**`
        );
      }

      // Commitments in another currency are listed, never converted.
      const others = [...committed.entries()].filter(([code]) => code !== project.client_currency);
      if (others.length > 0) {
        lines.push(
          '',
          `Also committed, and not measured against that budget because there is no conversion rate:`,
          ...others.map(([code, minor]) => `• ${formatAmount(minor, code)}`)
        );
      }

      if (project.budget_override_by) {
        lines.push('', `⚠️ The guard is off: <@${project.budget_override_by}> allowed over-budget pay — ${project.budget_override_reason || 'no reason recorded'}.`);
      }

      await interaction.reply(priv({
        embeds: [new EmbedBuilder().setTitle(`Budget · ${project.code}`).setColor(0xfaa61a).setDescription(lines.join('\n'))],
      }));
      return;
    }

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

      const schedule = paymentSchedule.scheduleFor(db, guildId, project);
      const lines = [
        `✅ Recorded **${formatAmount(amountMinor, currency)}** received for **${project.code}**.`,
        `Received so far: ${formatTotals(received)}${project.client_amount_minor !== null ? ` of ${formatAmount(project.client_amount_minor, project.client_currency)} expected` : ''}.`,
      ];

      // On an order split into named parts, say which part this covers — that is
      // the whole reason for splitting it.
      if (schedule.hasSchedule) {
        const covered = schedule.milestones.filter((line) => line.covered && !line.waived);
        lines.push(
          `\nParts covered: **${covered.length} of ${schedule.milestones.filter((line) => !line.waived).length}**` +
          `${schedule.nextDue
            ? ` — next is **${schedule.nextDue.milestone.label}**, ` +
              `${formatAmount(schedule.nextDue.outstandingMinor, schedule.currency)} still to come.`
            : ' — nothing outstanding.'}`
        );
        if (schedule.overpaidMinor > 0) {
          lines.push(
            `⚠️ ${formatAmount(schedule.overpaidMinor, schedule.currency)} more has arrived than the parts add up to. ` +
            'Either a part is missing from the list or the client has paid twice.'
          );
        }
      }

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
          : pending.payable.flatMap((task) =>
              paymentState.owedOnTask(db, task)
                .filter((entry) => entry.remainingMinor > 0)
                .map((entry) =>
                  `**${task.code}** <@${entry.userId}> — ${formatAmount(entry.remainingMinor, entry.currency)}${entry.paidMinor > 0 ? ' (part paid)' : ''}`)
            ).join('\n').slice(0, 1024) || '_nothing payable right now_',
        inline: false,
      });

      if (pending.awaitingClientMoney.length > 0) {
        embed.addFields({
          name: `Approved but the client has not paid (${pending.awaitingClientMoney.length})`,
          value: pending.awaitingClientMoney.map((task) => {
            const owed = paymentState.owedOnTask(db, task);
            return owed.length === 0
              ? `**${task.code}** — no pay set`
              : `**${task.code}** ${owed.map((entry) => `<@${entry.userId}> ${formatAmount(entry.agreedMinor, entry.currency)}`).join(', ')}`;
          }).join('\n').slice(0, 1024),
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
      // Their own line on each task, whether they are the sole artist or one
      // of several contributors.
      const owedRows = paymentState.pendingPayouts(db, guildId).payable
        .map((task) => ({ task, owed: paymentState.owedToContributor(db, task, member.id) }))
        .filter((row) => row.owed && row.owed.remainingMinor > 0);
      const owedSplits = allocationFlow.outstandingAllocations(db, guildId)
        .filter((row) => row.recipient_user_id === member.id);

      const owedAmounts = [
        ...owedRows.map((row) => ({ minor: row.owed.remainingMinor, currency: row.owed.currency })),
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
              ...owedRows.map((row) => `**${row.task.code}** work pay — ${formatAmount(row.owed.remainingMinor, row.owed.currency)}`),
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

      // One task can now carry several people on their own terms, so the
      // payout is always against one person's figure, never the task's.
      const owed = paymentState.owedOnTask(db, task);
      if (owed.length === 0) {
        await interaction.reply(priv(`❌ **${task.code}** has nobody with agreed pay on it.`));
        return;
      }

      const requested = interaction.options.getUser('person');
      if (!requested && owed.length > 1) {
        await interaction.reply(priv([
          `**${task.code}** has ${owed.length} people on it, so name who was paid:`,
          ...owed.map((entry) => `• <@${entry.userId}> — outstanding ${formatAmount(entry.remainingMinor, entry.currency)}`),
          '',
          `Run it again as \`/finance pay task:${task.code} person:@them\`.`,
        ].join('\n')));
        return;
      }

      const payeeUserId = requested ? requested.id : owed[0].userId;
      const entry = owed.find((row) => row.userId === payeeUserId);
      if (!entry) {
        await interaction.reply(priv(`❌ <@${payeeUserId}> has no agreed pay on **${task.code}**.`));
        return;
      }

      const remaining = entry.remainingMinor;
      if (remaining === 0) {
        await interaction.reply(priv(`<@${payeeUserId}> is already fully paid on **${task.code}**.`));
        return;
      }

      const amountText = interaction.options.getString('amount');
      const amountMinor = amountText ? parseAmount(amountText, entry.currency) : remaining;

      // Refuses to record more than is owed, which catches a mistyped amount
      // before it becomes a wrong record.
      if (amountMinor > remaining) {
        await interaction.reply(priv(
          `❌ That is more than is outstanding to <@${payeeUserId}> on **${task.code}**.\n` +
          `Outstanding: **${formatAmount(remaining, entry.currency)}**. ` +
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

      const { created } = paymentsRepo.recordPayment(db, guildId, {
        direction: paymentsRepo.DIRECTIONS.PAYOUT,
        projectId: task.project_id,
        taskId: task.id,
        payeeUserId,
        amountMinor,
        currency: entry.currency,
        methodLabel: interaction.options.getString('method'),
        reference: interaction.options.getString('reference'),
        recordedBy: userId,
        idempotencyKey: `payout:${task.id}:${payeeUserId}:${interaction.id}`,
      });

      if (!created) {
        await interaction.reply(priv('That exact payment was already recorded.'));
        return;
      }

      const updated = paymentState.recomputeTaskPaymentState(db, guildId, task.id, userId, 'Payout recorded');
      const stillOwed = paymentState.owedToContributor(db, updated, payeeUserId).remainingMinor;
      const taskOutstanding = paymentState.settlementOf(db, updated).outstanding;

      await interaction.reply(priv([
        `✅ Recorded **${formatAmount(amountMinor, entry.currency)}** paid to <@${payeeUserId}> for **${task.code}**.`,
        stillOwed > 0
          ? `Still owed to them: **${formatAmount(stillOwed, entry.currency)}** (task marked ${updated.payment_state.replace(/_/g, ' ')}).`
          : (taskOutstanding > 0
            ? 'They are settled; others on this task are still owed.'
            : 'That settles this task.'),
        '_Recorded only — the bot does not move money._',
      ].join('\n')));

      await notifyUser(interaction.client, db, guildId, payeeUserId, {
        content:
          `💰 A payment of **${formatAmount(amountMinor, entry.currency)}** for **${task.code} · ${task.title}** has been recorded.` +
          `${stillOwed > 0 ? `\nStill outstanding: ${formatAmount(stillOwed, entry.currency)}.` : ''}` +
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
      return;
    }

    if (sub === 'sent') {
      assertCan(actor, CAPABILITIES.FINANCE_VIEW_ALL);

      const waiting = paymentsRepo.unconfirmedPayouts(db, guildId, { limit: 25 });

      await interaction.reply(priv({
        embeds: [new EmbedBuilder()
          .setTitle('Sent, not yet confirmed as arrived')
          .setColor(waiting.length === 0 ? 0x57f287 : 0xfee75c)
          .setDescription(
            waiting.length === 0
              ? 'Every payment recorded as sent has been confirmed as arrived.'
              : waiting.map((payment) =>
                `**#${payment.id}** ${formatAmount(payment.amount_minor, payment.currency)} to <@${payment.payee_user_id}>\n` +
                `┗ ${payment.task_code ? `${payment.task_code} · ` : ''}sent ${discordTimestamp(payment.recorded_at, 'R')}` +
                `${payment.method_label ? ` via ${payment.method_label}` : ''}`
              ).join('\n\n').slice(0, 4000)
          )
          .setFooter({ text:
            'Sending is not arriving. Confirm with /finance confirm-received, or ' +
            '/finance mark-failed if it never landed.' })],
      }));
      return;
    }

    if (sub === 'confirm-received' || sub === 'mark-failed') {
      assertCan(actor, CAPABILITIES.PAYMENT_RECORD);

      const paymentId = interaction.options.getInteger('payment', true);
      const result = sub === 'confirm-received'
        ? paymentsRepo.confirmReceived(db, guildId, paymentId, {
          confirmedBy: userId, note: interaction.options.getString('note'),
        })
        : paymentsRepo.markFailed(db, guildId, paymentId, {
          failedBy: userId, reason: interaction.options.getString('reason', true),
        });

      if (!result.ok) {
        const reasons = {
          not_found: '❌ No payment with that number. Check `/finance sent`.',
          not_a_payout: '❌ That is money the client sent in, not a payment out. Only payments out are confirmed this way.',
          already_failed: '❌ That payment is already recorded as having failed. Record a fresh payment for the new attempt.',
          already_confirmed: '❌ That payment is already confirmed as arrived, so it cannot be marked failed. ' +
            'If the confirmation was wrong, say so in the audit trail rather than rewriting it.',
        };
        await interaction.reply(priv(reasons[result.reason] || `❌ ${result.reason}`));
        return;
      }

      const payment = result.payment;

      if (!result.changed) {
        await interaction.reply(priv(
          sub === 'confirm-received'
            ? `That payment was already confirmed as arrived ${discordTimestamp(payment.confirmed_at, 'R')}.`
            : `That payment was already marked failed ${discordTimestamp(payment.failed_at, 'R')}.`
        ));
        return;
      }

      if (sub === 'confirm-received') {
        await interaction.reply(priv(
          `✅ **${formatAmount(payment.amount_minor, payment.currency)}** to <@${payment.payee_user_id}> ` +
          'is confirmed as having arrived.\n' +
          '_Sent and arrived are kept as two separate facts, so neither side has to take the other\u2019s word for it._'
        ));
        return;
      }

      // A failed payment stops counting as paid, so the artist is owed again.
      const task = payment.task_id ? tasksRepo.getTask(db, guildId, payment.task_id) : null;
      if (task) paymentState.recomputeTaskPaymentState(db, guildId, task.id, userId, 'A payment failed');

      await interaction.reply(priv(
        `⚠️ **${formatAmount(payment.amount_minor, payment.currency)}** to <@${payment.payee_user_id}> ` +
        'is recorded as sent and never arrived.\n' +
        `Reason on record: ${payment.failure_note}\n\n` +
        'The record is kept rather than deleted — the attempt happened. It no longer counts as paid, ' +
        `so ${payment.payee_user_id ? `<@${payment.payee_user_id}> is` : 'they are'} owed it again.`
      ));

      if (payment.payee_user_id) {
        await notifyUser(interaction.client, db, guildId, payment.payee_user_id, {
          content:
            `⚠️ A payment of **${formatAmount(payment.amount_minor, payment.currency)}** to you has been recorded ` +
            `as failed: ${payment.failure_note}\n` +
            'You are owed it again. Nothing is lost — it is still on the record.',
        }).catch(() => null);
      }
      return;
    }

    if (sub === 'approve-all') {
      assertCan(actor, CAPABILITIES.TASK_PAY_APPROVE);

      const projectCode = interaction.options.getString('project');
      const project = projectCode ? projectsRepo.getProjectByCode(db, guildId, projectCode) : null;
      if (projectCode && !project) {
        await interaction.reply(priv('❌ No order with that code.'));
        return;
      }

      const preview = interaction.options.getBoolean('preview') === true;
      const result = bulkPay.approveAll(db, guildId, {
        actorUserId: userId, projectId: project?.id ?? null, dryRun: preview,
      });

      if (result.considered === 0) {
        await interaction.reply(priv(
          `Nothing waiting${project ? ` on **${project.code}**` : ''}. ` +
          'Your leaders have no pay figures proposed for you to decide.'
        ));
        return;
      }

      const embed = new EmbedBuilder()
        .setTitle(preview
          ? `Preview · ${result.considered} figure(s) proposed`
          : `${result.approved.length} of ${result.considered} figure(s) approved`)
        .setColor(result.refused.length === 0 ? 0x57f287 : 0xfee75c);

      if (result.approved.length > 0) {
        embed.addFields({
          name: preview ? `Would be approved — ${bulkPay.totals(result.approved)}` : `Approved — ${bulkPay.totals(result.approved)}`,
          value: result.approved.map(bulkPay.describe).join('\n').slice(0, 1024),
        });
      }

      if (result.refused.length > 0) {
        embed.addFields({
          name: `Refused — ${result.refused.length}`,
          value: result.refused.map((entry) =>
            `${bulkPay.describe(entry)}\n┗ ${entry.reason === 'over_budget'
              ? `${formatAmount(entry.check.excessMinor, entry.check.currency)} over what the client is paying`
              : 'could not be applied'}`
          ).join('\n').slice(0, 1024),
        });
        embed.setFooter({ text:
          'Each figure was checked as if approved on its own, in order — so a refusal here is ' +
          'the same refusal you would get approving it last.' });
      }

      if (preview) {
        embed.setDescription('_Nothing has been approved. Run it again without `preview` to decide._');
      }

      await interaction.reply(priv({ embeds: [embed] }));

      // Telling people is the point of approving; a figure nobody hears about
      // cannot be disagreed with.
      if (!preview) {
        for (const entry of result.approved) {
          if (!entry.userId) continue;
          await notifyUser(interaction.client, db, guildId, entry.userId, {
            content:
              `💰 Your pay for **${entry.task.code} · ${entry.task.title}** is ` +
              `**${formatAmount(entry.amountMinor, entry.currency)}**.` +
              (entry.requiresAcknowledgement
                ? '\n⚠️ You had already accepted a different figure, so please acknowledge this change.'
                : ''),
          }).catch(() => null);
        }
      }
    }
  },
};
