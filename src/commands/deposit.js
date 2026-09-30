const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const projectsRepo = require('../db/repos/projects');
const configRepo = require('../db/repos/config');
const paymentSchedule = require('../services/paymentSchedule');
const paymentState = require('../services/paymentState');
const { contextFor } = require('../services/actor');
const { CAPABILITIES, assertCan } = require('../domain/permissions');
const { parseAmount, formatAmount, isSupportedCurrency, CURRENCIES } = require('../domain/money');
const { discordTimestamp } = require('../utils/time');
const { priv } = require('../utils/reply');

const CURRENCY_CHOICES = Object.keys(CURRENCIES).map((code) => ({ name: code, value: code }));

/**
 * What a client owes, in named parts.
 *
 * Half up front and half on delivery is ordinary for commissions, and without
 * this the studio had two bad options: record a deposit as payment in full,
 * which breaks the rule that nothing is paid out before money arrives, or leave
 * artists unpayable on work the client has already funded.
 *
 * Nothing here pays anybody. It only records what is owed and what has arrived.
 * Whether an artist is payable is still worked out from the ledger.
 */
module.exports = {
  data: new SlashCommandBuilder()
    .setName('deposit')
    .setDescription('Split what a client owes into named parts, and see what has arrived')
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('Add a part of what the client owes, e.g. "Deposit" or "On delivery"')
        .addStringOption((opt) => opt.setName('project').setDescription('Which order').setRequired(true).setAutocomplete(true))
        .addStringOption((opt) => opt.setName('label').setDescription('What to call it, e.g. Deposit').setRequired(true).setMaxLength(60))
        .addStringOption((opt) => opt.setName('amount').setDescription('How much of the total this part is').setRequired(true))
        .addStringOption((opt) => opt.setName('currency').setDescription('Currency').setRequired(false).addChoices(...CURRENCY_CHOICES))
        .addStringOption((opt) => opt.setName('due').setDescription('When it is due, in words — e.g. before work starts').setRequired(false).setMaxLength(120))
    )
    .addSubcommand((sub) =>
      sub
        .setName('list')
        .setDescription('The parts on an order, and which are covered')
        .addStringOption((opt) => opt.setName('project').setDescription('Which order').setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('invoiced')
        .setDescription('Record that you have asked the client for this part')
        .addIntegerOption((opt) => opt.setName('id').setDescription('Number from /deposit list').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('waive')
        .setDescription('Decide not to charge a part — it stops counting as owed')
        .addIntegerOption((opt) => opt.setName('id').setDescription('Number from /deposit list').setRequired(true))
        .addStringOption((opt) => opt.setName('reason').setDescription('Why, for the record').setRequired(true).setMaxLength(200))
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('Delete a part that was entered by mistake')
        .addIntegerOption((opt) => opt.setName('id').setDescription('Number from /deposit list').setRequired(true))
    ),

  async autocomplete(interaction) {
    const { db, guildId } = contextFor(interaction);
    const query = String(interaction.options.getFocused() || '');
    const matches = query
      ? projectsRepo.searchProjects(db, guildId, query, 25)
      : projectsRepo.listProjects(db, guildId, { status: 'active', limit: 25 });
    await interaction.respond(matches.map((p) => ({ name: `${p.code} · ${p.name}`.slice(0, 100), value: p.code })));
  },

  async execute(interaction) {
    const { db, guildId, actor, config } = contextFor(interaction);
    const sub = interaction.options.getSubcommand();
    const userId = interaction.user.id;

    // Deciding what a client owes is the owner's call, same as setting a price.
    if (sub === 'list') assertCan(actor, CAPABILITIES.FINANCE_VIEW_ALL);
    else assertCan(actor, CAPABILITIES.CLIENT_RECEIPT_RECORD);

    if (sub === 'add') {
      const project = projectsRepo.getProjectByCode(db, guildId, interaction.options.getString('project', true));
      if (!project) {
        await interaction.reply(priv('❌ No order with that code.'));
        return;
      }

      const currency = interaction.options.getString('currency') || project.client_currency || config.default_currency;
      if (!isSupportedCurrency(currency)) {
        await interaction.reply(priv(`❌ Unsupported currency \`${currency}\`.`));
        return;
      }

      let amountMinor;
      try {
        amountMinor = parseAmount(interaction.options.getString('amount', true), currency);
      } catch (error) {
        await interaction.reply(priv(`❌ ${error.message}`));
        return;
      }

      const added = paymentSchedule.addMilestone(db, guildId, project.id, {
        label: interaction.options.getString('label', true),
        amountMinor,
        currency,
        dueNote: interaction.options.getString('due'),
      }, userId);

      if (!added.ok) {
        const reasons = {
          currency_mismatch:
            `❌ The parts on this order are in **${added.expected}**. Every part has to be in the same currency — ` +
            'the studio has no rate between Robux and dollars, so a part in another currency could never be paid off.',
          bad_amount: '❌ That amount is not a positive number.',
        };
        await interaction.reply(priv(reasons[added.reason] || `❌ ${added.reason}`));
        return;
      }

      const schedule = paymentSchedule.scheduleFor(db, guildId, project);
      const lines = [
        `✅ Added **${added.milestone.label}** — ${formatAmount(amountMinor, currency)} on **${project.code}**.`,
        `The order now has ${schedule.milestones.length} part(s) totalling ${formatAmount(schedule.totalMinor, schedule.currency)}.`,
      ];

      // Said plainly, because it is the difference between an order that adds up
      // and one where somebody has miscounted.
      if (project.client_amount_minor !== null && project.client_currency === currency
          && schedule.totalMinor !== project.client_amount_minor) {
        const difference = schedule.totalMinor - project.client_amount_minor;
        lines.push(
          `\n⚠️ The parts add up to ${formatAmount(schedule.totalMinor, currency)} but the order's price is ` +
          `${formatAmount(project.client_amount_minor, project.client_currency)} — ` +
          `${difference > 0 ? `${formatAmount(difference, currency)} more` : `${formatAmount(-difference, currency)} less`}.`
        );
      }

      lines.push(`\n${paymentSchedule.describe(schedule)}`);
      await interaction.reply(priv(lines.join('\n')));
      return;
    }

    if (sub === 'list') {
      const project = projectsRepo.getProjectByCode(db, guildId, interaction.options.getString('project', true));
      if (!project) {
        await interaction.reply(priv('❌ No order with that code.'));
        return;
      }

      const schedule = paymentSchedule.scheduleFor(db, guildId, project);

      if (!schedule.hasSchedule) {
        await interaction.reply(priv({
          embeds: [new EmbedBuilder()
            .setTitle(`${project.code} · one payment`)
            .setColor(0x99aab5)
            .setDescription(
              `${paymentSchedule.describe(schedule)}\n\n` +
              '_No parts set on this order, so it is treated as one payment. ' +
              'Split it with `/deposit add` if the client is paying in stages._'
            )],
        }));
        return;
      }

      const body = schedule.milestones.map((line) => {
        const mark = line.waived ? '➖' : line.covered ? '✅' : line.coveredMinor > 0 ? '🟡' : '⬜';
        return `${mark} **#${line.milestone.id} ${line.milestone.label}** — ${formatAmount(line.milestone.amount_minor, line.milestone.currency)}\n` +
          (line.waived
            ? `┗ waived: ${line.milestone.waived_reason || 'no reason recorded'}`
            : line.covered
              ? '┗ covered'
              : `┗ ${formatAmount(line.outstandingMinor, line.milestone.currency)} still to come`) +
          (line.milestone.due_note ? `\n┗ due: ${line.milestone.due_note}` : '') +
          (line.milestone.invoiced_at ? `\n┗ asked for ${discordTimestamp(line.milestone.invoiced_at, 'R')}` : '');
      }).join('\n\n');

      const embed = new EmbedBuilder()
        .setTitle(`${project.code} · what the client owes`)
        .setColor(schedule.fullyPaid ? 0x57f287 : 0xfee75c)
        .setDescription(body.slice(0, 4000))
        .addFields(
          { name: 'Received', value: formatAmount(schedule.receivedMinor, schedule.currency), inline: true },
          { name: 'Owed in total', value: formatAmount(schedule.totalMinor, schedule.currency), inline: true },
          { name: 'Outstanding', value: formatAmount(schedule.outstandingMinor, schedule.currency), inline: true },
        );

      if (schedule.overpaidMinor > 0) {
        embed.addFields({
          name: '⚠️ More has arrived than is owed',
          value:
            `${formatAmount(schedule.overpaidMinor, schedule.currency)} beyond the parts listed. ` +
            'That usually means a part is missing from the list, or the client paid twice. ' +
            'It is shown rather than quietly absorbed.',
        });
      }

      await interaction.reply(priv({ embeds: [embed] }));
      return;
    }

    const id = interaction.options.getInteger('id', true);
    const milestone = paymentSchedule.getMilestone(db, guildId, id);
    if (!milestone) {
      await interaction.reply(priv('❌ No part with that number. Check `/deposit list`.'));
      return;
    }

    if (sub === 'invoiced') {
      const updated = paymentSchedule.markInvoiced(db, guildId, id, userId);
      await interaction.reply(priv(
        updated
          ? `✅ Recorded that you asked the client for **${milestone.label}** ` +
            `(${formatAmount(milestone.amount_minor, milestone.currency)}).\n` +
            '_Recorded only — the bot does not send invoices or move money._'
          : `That part was already recorded as asked for ${discordTimestamp(milestone.invoiced_at, 'R')}.`
      ));
      return;
    }

    if (sub === 'waive') {
      const reason = interaction.options.getString('reason', true);
      const updated = paymentSchedule.waiveMilestone(db, guildId, id, { reason, actorUserId: userId });

      if (!updated) {
        await interaction.reply(priv('That part was already waived.'));
        return;
      }

      // Waiving changes what the client owes, which can change who is payable:
      // less owed means the money already in covers more of the work.
      const project = projectsRepo.getProject(db, guildId, milestone.project_id);
      const changed = project ? paymentState.recomputeProjectPaymentStates(db, guildId, project.id, userId) : [];

      await interaction.reply(priv(
        `➖ Waived **${milestone.label}** (${formatAmount(milestone.amount_minor, milestone.currency)}). ` +
        'It no longer counts as owed.\n' +
        `Reason on record: ${reason}` +
        (changed.length > 0
          ? `\n\n💰 ${changed.length} task(s) changed payment state: ${changed.map((task) => task.code).join(', ')}.`
          : '')
      ));
      return;
    }

    if (sub === 'remove') {
      if (milestone.invoiced_at) {
        await interaction.reply(priv(
          `❌ **${milestone.label}** has already been asked for, so it is not a mistake to delete — ` +
          'waive it with `/deposit waive` instead, which keeps the record of what happened.'
        ));
        return;
      }

      paymentSchedule.removeMilestone(db, guildId, id, userId);
      await interaction.reply(priv(`🗑️ Deleted **${milestone.label}**. Nothing else on the order changed.`));
    }
  },
};
