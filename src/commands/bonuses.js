const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const configRepo = require('../db/repos/config');
const paymentsRepo = require('../db/repos/payments');
const { contextFor } = require('../services/actor');
const bonusFlow = require('../services/bonusFlow');
const { notifyUser } = require('../services/notify');
const { CAPABILITIES, assertCan } = require('../domain/permissions');
const { parseAmount, formatAmount, isSupportedCurrency, CURRENCIES } = require('../domain/money');
const { discordTimestamp } = require('../utils/time');
const { priv } = require('../utils/reply');

const CURRENCY_CHOICES = Object.keys(CURRENCIES).map((code) => ({ name: code, value: code }));

/**
 * Milestone bonuses, such as "every 10 approved animations".
 *
 * The bot only ever flags a milestone as reached. Nothing is owed until the
 * owner approves it, and nothing is paid until it is recorded as paid, so an
 * automatic rule can never commit the studio to money by itself.
 */
module.exports = {
  data: new SlashCommandBuilder()
    .setName('bonuses')
    .setDescription('Milestone bonuses: rules, what has been earned, and approvals')
    .addSubcommand((sub) =>
      sub
        .setName('rule-set')
        .setDescription('Create or change a bonus rule')
        .addStringOption((opt) => opt.setName('key').setDescription('Short id, e.g. anim-10').setRequired(true))
        .addStringOption((opt) => opt.setName('label').setDescription('How it reads, e.g. Every 10 approved animations').setRequired(true))
        .addIntegerOption((opt) => opt.setName('threshold').setDescription('How many approved tasks earn it').setRequired(true).setMinValue(1))
        .addStringOption((opt) => opt.setName('amount').setDescription('Bonus amount').setRequired(true))
        .addStringOption((opt) => opt.setName('currency').setDescription('Currency').addChoices(...CURRENCY_CHOICES).setRequired(false))
        .addStringOption((opt) => opt.setName('department').setDescription('Limit to one department').setRequired(false).setAutocomplete(true))
    )
    .addSubcommand((sub) => sub.setName('rules').setDescription('Every bonus rule in the studio'))
    .addSubcommand((sub) =>
      sub
        .setName('rule-off')
        .setDescription('Stop a rule earning anything further (past awards are kept)')
        .addStringOption((opt) => opt.setName('key').setDescription('Rule id').setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('rule-on')
        .setDescription('Put a rule back into use')
        .addStringOption((opt) => opt.setName('key').setDescription('Rule id').setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((sub) => sub.setName('pending').setDescription('Milestones reached and waiting on you'))
    .addSubcommand((sub) =>
      sub
        .setName('approve')
        .setDescription('Agree a bonus is owed')
        .addIntegerOption((opt) => opt.setName('id').setDescription('Award number from /bonuses pending').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('decline')
        .setDescription('Decide a bonus is not owed, with a reason')
        .addIntegerOption((opt) => opt.setName('id').setDescription('Award number from /bonuses pending').setRequired(true))
        .addStringOption((opt) => opt.setName('reason').setDescription('Why, for the record').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('pay')
        .setDescription('Record an approved bonus as paid')
        .addIntegerOption((opt) => opt.setName('id').setDescription('Award number').setRequired(true))
        .addStringOption((opt) => opt.setName('method').setDescription('How it was paid').setRequired(false))
        .addStringOption((opt) => opt.setName('reference').setDescription('Non-sensitive reference').setRequired(false))
    )
    .addSubcommand((sub) => sub.setName('mine').setDescription('Your own bonus progress and awards')),

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);
    const { db, guildId } = contextFor(interaction);

    if (focused.name === 'key') {
      await interaction.respond(bonusFlow.listRules(db, guildId).slice(0, 25).map((rule) => ({
        name: `${rule.key} · ${rule.label}`.slice(0, 100),
        value: rule.key,
      })));
      return;
    }

    if (focused.name === 'department') {
      await interaction.respond(configRepo.listDepartments(db, guildId).slice(0, 25).map((dept) => ({
        name: dept.name.slice(0, 100),
        value: String(dept.id),
      })));
    }
  },

  async execute(interaction) {
    const { db, guildId, config, actor } = contextFor(interaction);
    const sub = interaction.options.getSubcommand();
    const userId = interaction.user.id;

    if (sub === 'mine') {
      const rules = bonusFlow.listRules(db, guildId, { activeOnly: true });
      const departmentName = new Map(configRepo.listDepartments(db, guildId).map((dept) => [dept.id, dept.name]));

      const progress = rules.map((rule) => {
        const count = bonusFlow.qualifyingCount(db, guildId, rule, userId);
        const towards = count % rule.threshold;
        return (
          `**${rule.label}**${rule.department_id ? ` _(${departmentName.get(rule.department_id) || 'department'})_` : ''}\n` +
          `┗ ${count} approved · ${towards}/${rule.threshold} towards the next ${formatAmount(rule.amount_minor, rule.currency)}`
        );
      });

      const mine = bonusFlow.listAwards(db, guildId, { status: 'all', userId, limit: 15 });

      const embed = new EmbedBuilder()
        .setTitle('Your bonuses')
        .setColor(0x57f287)
        .setDescription(progress.join('\n') || '_No bonus rules are running right now._');

      if (mine.length > 0) {
        embed.addFields({
          name: 'Your awards',
          value: mine.map((award) =>
            `#${award.id} ${award.rule_label} — ${formatAmount(award.amount_minor, award.currency)} · ${award.status}`
          ).join('\n').slice(0, 1024),
          inline: false,
        });
      }

      embed.setFooter({ text: 'A milestone reached is not yet money owed — the owner approves each one.' });
      await interaction.reply(priv({ embeds: [embed] }));
      return;
    }

    if (sub === 'rules') {
      assertCan(actor, CAPABILITIES.SUMMARY_VIEW);
      const rules = bonusFlow.listRules(db, guildId);
      const departmentName = new Map(configRepo.listDepartments(db, guildId).map((dept) => [dept.id, dept.name]));

      await interaction.reply(priv({
        embeds: [new EmbedBuilder()
          .setTitle('Bonus rules')
          .setColor(0x5865f2)
          .setDescription(rules.map((rule) =>
            `${rule.active ? '🟢' : '⚪'} **${rule.key}** — ${rule.label}\n` +
            `┗ every ${rule.threshold} approved${rule.department_id ? ` in ${departmentName.get(rule.department_id) || 'a department'}` : ''} → ${formatAmount(rule.amount_minor, rule.currency)}`
          ).join('\n') || '_No rules yet. Add one with `/bonuses rule-set`._')],
      }));
      return;
    }

    // Everything below is the owner's: bonuses are money.
    assertCan(actor, CAPABILITIES.TASK_PAY_APPROVE);

    if (sub === 'rule-set') {
      const currency = interaction.options.getString('currency') || config.default_currency;
      if (!isSupportedCurrency(currency)) {
        await interaction.reply(priv(`❌ Unsupported currency \`${currency}\`.`));
        return;
      }

      const departmentRaw = interaction.options.getString('department');
      const departmentId = departmentRaw ? Number(departmentRaw) : null;
      if (departmentRaw && !Number.isInteger(departmentId)) {
        await interaction.reply(priv('❌ Pick a department from the list rather than typing one.'));
        return;
      }

      const rule = bonusFlow.upsertRule(db, guildId, {
        key: interaction.options.getString('key', true),
        label: interaction.options.getString('label', true),
        departmentId,
        threshold: interaction.options.getInteger('threshold', true),
        amountMinor: parseAmount(interaction.options.getString('amount', true), currency),
        currency,
      }, userId);

      await interaction.reply(priv(
        `✅ **${rule.key}** — ${rule.label}\n` +
        `Every ${rule.threshold} client-approved task earns ${formatAmount(rule.amount_minor, rule.currency)}.\n` +
        '_Milestones are flagged for your approval; nothing is owed automatically._'
      ));
      return;
    }

    if (sub === 'rule-off' || sub === 'rule-on') {
      const key = interaction.options.getString('key', true);
      const rule = bonusFlow.setRuleActive(db, guildId, key, sub === 'rule-on', userId);
      if (!rule) {
        await interaction.reply(priv(`❌ No rule called \`${key}\`.`));
        return;
      }
      await interaction.reply(priv(
        sub === 'rule-on'
          ? `✅ **${rule.key}** is running again.`
          : `✅ **${rule.key}** will not earn anything further. Awards already made are untouched.`
      ));
      return;
    }

    if (sub === 'pending') {
      const awards = bonusFlow.listAwards(db, guildId, { status: 'pending' });
      await interaction.reply(priv({
        embeds: [new EmbedBuilder()
          .setTitle('Bonuses waiting on you')
          .setColor(0xfaa61a)
          .setDescription(awards.map((award) =>
            `**#${award.id}** <@${award.user_id}> — ${award.rule_label}\n` +
            `┗ ${formatAmount(award.amount_minor, award.currency)} · ${award.qualifying_count} approved · flagged ${discordTimestamp(award.created_at, 'R')}`
          ).join('\n') || '_Nothing waiting._')
          .setFooter({ text: 'Approve with /bonuses approve id:<number>' })],
      }));
      return;
    }

    const id = interaction.options.getInteger('id', true);

    if (sub === 'approve' || sub === 'decline') {
      const approve = sub === 'approve';
      const award = bonusFlow.decideAward(db, guildId, id, {
        approve,
        actorUserId: userId,
        reason: approve ? null : interaction.options.getString('reason', true),
      });

      if (!award) {
        await interaction.reply(priv(`❌ Award #${id} is not pending — it may already have been decided.`));
        return;
      }

      await interaction.reply(priv(
        approve
          ? `✅ Approved **${formatAmount(award.amount_minor, award.currency)}** for <@${award.user_id}> (${award.rule_label}).\n` +
            `Record it once paid: \`/bonuses pay id:${award.id}\`.`
          : `✅ Award #${award.id} declined. <@${award.user_id}> has been told the reason.`
      ));

      await notifyUser(interaction.client, db, guildId, award.user_id, {
        content: approve
          ? `🎉 Your bonus for **${award.rule_label}** — **${formatAmount(award.amount_minor, award.currency)}** — has been approved.`
          : `Your milestone for **${award.rule_label}** was reviewed and not awarded.\nReason: ${award.declined_reason}`,
      }).catch(() => null);
      return;
    }

    if (sub === 'pay') {
      const award = bonusFlow.getAward(db, guildId, id);
      if (!award || award.status !== 'approved') {
        await interaction.reply(priv(`❌ Award #${id} is not approved and waiting to be paid.`));
        return;
      }

      const { created } = paymentsRepo.recordPayment(db, guildId, {
        direction: paymentsRepo.DIRECTIONS.PAYOUT,
        payeeUserId: award.user_id,
        amountMinor: award.amount_minor,
        currency: award.currency,
        methodLabel: interaction.options.getString('method'),
        reference: interaction.options.getString('reference'),
        note: `Bonus: ${award.rule_label}`,
        recordedBy: userId,
        idempotencyKey: `bonus:${award.id}`,
      });

      if (!created) {
        await interaction.reply(priv('That bonus payment was already recorded.'));
        return;
      }

      bonusFlow.markAwardPaid(db, guildId, id, userId);
      await interaction.reply(priv(
        `✅ Recorded **${formatAmount(award.amount_minor, award.currency)}** paid to <@${award.user_id}> for ${award.rule_label}.\n` +
        '_Recorded only — the bot does not move money._'
      ));

      await notifyUser(interaction.client, db, guildId, award.user_id, {
        content: `💰 Your **${award.rule_label}** bonus of **${formatAmount(award.amount_minor, award.currency)}** has been recorded as paid.`,
      }).catch(() => null);
    }
  },
};
