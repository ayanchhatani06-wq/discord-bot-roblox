const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const tasksRepo = require('../db/repos/tasks');
const contributorsRepo = require('../db/repos/contributors');
const { contextFor } = require('../services/actor');
const budget = require('../services/budget');
const paymentState = require('../services/paymentState');
const { notifyUser } = require('../services/notify');
const { CAPABILITIES, can, assertCan, PermissionError } = require('../domain/permissions');
const { parseAmount, formatAmount, isSupportedCurrency, CURRENCIES } = require('../domain/money');
const { priv } = require('../utils/reply');

const CURRENCY_CHOICES = Object.keys(CURRENCIES).map((code) => ({ name: code, value: code }));

/**
 * Shared work: more than one person on a single task, each on their own terms.
 *
 * Everyone's pay is agreed and recorded separately, so nobody's figure is
 * implied by anybody else's and nobody is paid twice for the same task.
 */
module.exports = {
  data: new SlashCommandBuilder()
    .setName('contrib')
    .setDescription('People sharing one task, and what each of them is paid')
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('Add somebody to a task alongside the main artist')
        .addStringOption((opt) => opt.setName('task').setDescription('Task code').setRequired(true).setAutocomplete(true))
        .addUserOption((opt) => opt.setName('person').setDescription('Who is helping').setRequired(true))
        .addStringOption((opt) => opt.setName('responsibility').setDescription('What they are doing on it').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('Take somebody off a task (their record and any payments stay)')
        .addStringOption((opt) => opt.setName('task').setDescription('Task code').setRequired(true).setAutocomplete(true))
        .addUserOption((opt) => opt.setName('person').setDescription('Who to remove').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('pay')
        .setDescription("Set one contributor's pay (owner) or propose it (group leader)")
        .addStringOption((opt) => opt.setName('task').setDescription('Task code').setRequired(true).setAutocomplete(true))
        .addUserOption((opt) => opt.setName('person').setDescription('Who it is for').setRequired(true))
        .addStringOption((opt) => opt.setName('amount').setDescription('Amount for their part').setRequired(true))
        .addStringOption((opt) => opt.setName('currency').setDescription('Currency').addChoices(...CURRENCY_CHOICES).setRequired(false))
    )
    .addSubcommand((sub) =>
      sub
        .setName('list')
        .setDescription('Who is on a task, and what each is owed')
        .addStringOption((opt) => opt.setName('task').setDescription('Task code').setRequired(true).setAutocomplete(true))
    ),

  async autocomplete(interaction) {
    const { db, guildId } = contextFor(interaction);
    const query = String(interaction.options.getFocused() || '');
    const matches = tasksRepo.searchTasks(db, guildId, query, { limit: 25 });
    await interaction.respond(matches.map((task) => ({
      name: `${task.code} · ${task.title}`.slice(0, 100),
      value: task.code,
    })));
  },

  async execute(interaction) {
    const { db, guildId, config, actor } = contextFor(interaction);
    const sub = interaction.options.getSubcommand();
    const userId = interaction.user.id;

    const task = tasksRepo.getTaskByCode(db, guildId, interaction.options.getString('task', true));
    if (!task) {
      await interaction.reply(priv('❌ No task with that code.'));
      return;
    }

    if (sub === 'list') {
      const owed = paymentState.owedOnTask(db, task);
      const contributors = contributorsRepo.listForTask(db, task.id);
      const canSeeAll = can(actor, CAPABILITIES.FINANCE_VIEW_ALL)
        || can(actor, CAPABILITIES.TASK_PAY_PROPOSE, { departmentId: task.department_id });

      const rows = contributors.length > 0
        ? contributors
        : (task.artist_user_id
          ? [{ user_id: task.artist_user_id, responsibility: 'Main work', is_primary: 1 }]
          : []);

      const lines = rows.map((row) => {
        const entry = owed.find((o) => o.userId === row.user_id);
        // Somebody without finance sight sees only their own figure: shared
        // work must not become a way to read a colleague's rate.
        const showMoney = canSeeAll || row.user_id === userId;
        const money = !entry
          ? 'no pay agreed yet'
          : (showMoney
            ? `${formatAmount(entry.agreedMinor, entry.currency)}${entry.remainingMinor > 0 ? ` · ${formatAmount(entry.remainingMinor, entry.currency)} outstanding` : ' · settled'}`
            : 'pay agreed');
        return `<@${row.user_id}>${row.is_primary ? ' *(main)*' : ''} — ${row.responsibility}\n┗ ${money}`;
      });

      await interaction.reply(priv({
        embeds: [new EmbedBuilder()
          .setTitle(`People on ${task.code}`)
          .setColor(0x5865f2)
          .setDescription(lines.join('\n') || '_Nobody is assigned to this task yet._')],
      }));
      return;
    }

    if (sub === 'add' || sub === 'remove') {
      assertCan(actor, CAPABILITIES.TASK_EDIT, { departmentId: task.department_id });
      const person = interaction.options.getUser('person', true);

      if (sub === 'remove') {
        const result = contributorsRepo.removeContributor(db, guildId, task.id, person.id, userId);
        if (!result.ok) {
          await interaction.reply(priv(result.reason === 'primary_contributor'
            ? `❌ <@${person.id}> holds **${task.code}** itself. Move the task with \`/manage reassign\` instead.`
            : `❌ <@${person.id}> is not on **${task.code}**.`));
          return;
        }
        await interaction.reply(priv(
          `✅ <@${person.id}> is off **${task.code}**.\n` +
          '_Their record and any payments already made stay, so history is unchanged._'
        ));
        return;
      }

      if (!task.artist_user_id) {
        await interaction.reply(priv(
          `❌ **${task.code}** has no main artist yet. Assign it with \`/task assign\` first, then add helpers.`
        ));
        return;
      }

      const responsibility = interaction.options.getString('responsibility', true);
      const result = contributorsRepo.addContributor(db, guildId, task, {
        userId: person.id, responsibility, actorUserId: userId,
      });

      if (!result.ok) {
        await interaction.reply(priv(`❌ <@${person.id}> is already on **${task.code}**.`));
        return;
      }

      await interaction.reply(priv(
        `✅ <@${person.id}> is on **${task.code}** for: ${responsibility}\n` +
        `Their pay is separate and not set yet — \`/contrib pay task:${task.code} person:@them amount:...\`.`
      ));

      await notifyUser(interaction.client, db, guildId, person.id, {
        content:
          `🤝 You have been added to **${task.code} · ${task.title}** for: ${responsibility}\n` +
          'Your pay for this is agreed separately and you will be told the figure before it is final.',
      }).catch(() => null);
      return;
    }

    if (sub === 'pay') {
      const mayApprove = can(actor, CAPABILITIES.TASK_PAY_APPROVE);
      const mayPropose = can(actor, CAPABILITIES.TASK_PAY_PROPOSE, { departmentId: task.department_id });
      if (!mayApprove && !mayPropose) {
        throw new PermissionError(CAPABILITIES.TASK_PAY_PROPOSE, 'You cannot set or propose pay for this task.');
      }

      const person = interaction.options.getUser('person', true);
      const existing = contributorsRepo.getContributor(db, task.id, person.id);
      if ((!existing || existing.removed_at) && task.artist_user_id !== person.id) {
        await interaction.reply(priv(`❌ <@${person.id}> is not on **${task.code}**. Add them first with \`/contrib add\`.`));
        return;
      }

      // Setting a contributor's pay converts the task, so the original
      // artist's own terms are preserved as a contributor row first.
      contributorsRepo.ensurePrimaryContributor(db, guildId, task, userId);

      const currency = interaction.options.getString('currency')
        || existing?.pay_currency
        || task.artist_pay_currency
        || config.default_currency;
      if (!isSupportedCurrency(currency)) {
        await interaction.reply(priv(`❌ Unsupported currency \`${currency}\`.`));
        return;
      }
      const amountMinor = parseAmount(interaction.options.getString('amount', true), currency);

      if (!mayApprove) {
        contributorsRepo.proposePay(db, guildId, task.id, person.id, { amountMinor, currency, actorUserId: userId });
        await interaction.reply(priv(
          `✅ Proposed **${formatAmount(amountMinor, currency)}** for <@${person.id}> on **${task.code}**. ` +
          'The owner must approve it.'
        ));

        if (config.owner_user_id) {
          await notifyUser(interaction.client, db, guildId, config.owner_user_id, {
            content:
              `💰 <@${userId}> proposed **${formatAmount(amountMinor, currency)}** for <@${person.id}> on **${task.code} · ${task.title}**.\n` +
              `Approve with \`/contrib pay task:${task.code} person:@them amount:...\`.`,
          }).catch(() => null);
        }
        return;
      }

      const check = budget.checkBudget(db, guildId, task, { amountMinor, currency, userId: person.id });
      if (!check.ok) {
        await interaction.reply(priv(
          `❌ ${budget.describeBudgetFailure(check)}\n\n` +
          'Lower the figure, raise the recorded client payment, or allow it deliberately with ' +
          `\`/finance budget-override project:${check.project.code} reason:...\`.`
        ));
        return;
      }

      const result = contributorsRepo.approvePay(db, guildId, task.id, person.id, {
        amountMinor, currency, actorUserId: userId,
      });
      if (!result) {
        await interaction.reply(priv(`❌ <@${person.id}> is not on **${task.code}**.`));
        return;
      }

      paymentState.recomputeTaskPaymentState(db, guildId, task.id, userId, 'Contributor pay agreed');

      await interaction.reply(priv(
        `✅ <@${person.id}> is paid **${formatAmount(amountMinor, currency)}** for their part of **${task.code}**.` +
        `${result.requiresAcknowledgement ? '\n⚠️ They had already accepted a different figure, so they have been asked to acknowledge the change.' : ''}` +
        `${check.reason === 'different_currency' ? `\n_Not measured against the ${check.budgetCurrency} client payment — there is no conversion rate._` : ''}` +
        `${check.reason === 'override_in_place' ? '\n_The budget guard is off on this project._' : ''}`
      ));

      await notifyUser(interaction.client, db, guildId, person.id, {
        content:
          `💰 Your pay for **${task.code} · ${task.title}** is **${formatAmount(amountMinor, currency)}**.\n` +
          'This covers your part of the task only. See it any time with `/work earnings`.',
      }).catch(() => null);
    }
  },
};
