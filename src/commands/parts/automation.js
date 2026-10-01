const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const configRepo = require('../../db/repos/config');
const { contextFor } = require('../../services/actor');
const automation = require('../../services/automation');
const { CAPABILITIES, assertCan } = require('../../domain/permissions');
const { discordTimestamp } = require('../../utils/time');
const { priv } = require('../../utils/reply');

const TRIGGER_CHOICES = Object.entries(automation.TRIGGER_LABELS)
  .map(([value, name]) => ({ name: name.slice(0, 100), value }));

const ACTION_CHOICES = Object.entries(automation.ACTION_LABELS)
  .map(([value, name]) => ({ name: name.slice(0, 100), value }));

/**
 * Automation rules the owner configures.
 *
 * A new or changed rule is always disabled, and switching it on is refused
 * until it has been previewed. That is deliberate: the failure mode of
 * automation is a rule that quietly messages forty people, and a preview costs
 * one command.
 */
module.exports = {
  data: new SlashCommandBuilder()
    .setName('automation')
    .setDescription('Rules that watch for a situation and tell somebody')
    .addSubcommand((sub) =>
      sub
        .setName('set')
        .setDescription('Create or change a rule (it starts switched off)')
        .addStringOption((opt) => opt.setName('key').setDescription('Short id, e.g. chase-overdue').setRequired(true))
        .addStringOption((opt) => opt.setName('label').setDescription('What it is for, in your words').setRequired(true))
        .addStringOption((opt) => opt.setName('when').setDescription('What it watches for').setRequired(true).addChoices(...TRIGGER_CHOICES))
        .addStringOption((opt) => opt.setName('then').setDescription('What it does').setRequired(true).addChoices(...ACTION_CHOICES))
        .addIntegerOption((opt) => opt.setName('days').setDescription('How many days, where the trigger needs one').setRequired(false).setMinValue(1).setMaxValue(365))
        .addStringOption((opt) => opt.setName('department').setDescription('Only this department').setRequired(false).setAutocomplete(true))
        .addUserOption((opt) => opt.setName('person').setDescription('Who to tell, if the action is one named person').setRequired(false))
        .addStringOption((opt) => opt.setName('note').setDescription('A line to include in the message').setRequired(false))
    )
    .addSubcommand((sub) => sub.setName('list').setDescription('Every rule, and whether it is on'))
    .addSubcommand((sub) =>
      sub
        .setName('preview')
        .setDescription('What a rule would do right now — it does none of it')
        .addStringOption((opt) => opt.setName('key').setDescription('Rule id').setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('on')
        .setDescription('Switch a rule on')
        .addStringOption((opt) => opt.setName('key').setDescription('Rule id').setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('off')
        .setDescription('Switch a rule off')
        .addStringOption((opt) => opt.setName('key').setDescription('Rule id').setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('delete')
        .setDescription('Remove a rule entirely')
        .addStringOption((opt) => opt.setName('key').setDescription('Rule id').setRequired(true).setAutocomplete(true))
    ),

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);
    const { db, guildId } = contextFor(interaction);

    if (focused.name === 'department') {
      await interaction.respond(configRepo.listDepartments(db, guildId).slice(0, 25)
        .map((dept) => ({ name: dept.name.slice(0, 100), value: String(dept.id) })));
      return;
    }

    await interaction.respond(automation.listRules(db, guildId).slice(0, 25).map((rule) => ({
      name: `${rule.key} · ${rule.label} · ${rule.enabled ? 'on' : 'off'}`.slice(0, 100),
      value: rule.key,
    })));
  },

  async execute(interaction) {
    const { db, guildId, departments, actor } = contextFor(interaction);
    const sub = interaction.options.getSubcommand();
    const userId = interaction.user.id;

    // Automation acts in the studio's name, so it is the owner's to configure.
    assertCan(actor, CAPABILITIES.CONFIG_MANAGE);
    const departmentName = new Map(departments.map((dept) => [dept.id, dept.name]));

    if (sub === 'list') {
      const rules = automation.listRules(db, guildId);
      await interaction.reply(priv({
        embeds: [new EmbedBuilder()
          .setTitle('Automation rules')
          .setColor(0x5865f2)
          .setDescription(rules.map((rule) =>
            `${rule.enabled ? '🟢' : '⚪'} **${rule.key}** — ${rule.label}\n` +
            `┗ when: ${automation.TRIGGER_LABELS[rule.trigger_key]}` +
            `${rule.threshold ? ` (${rule.threshold} days)` : ''}` +
            `${rule.department_id ? ` · ${departmentName.get(rule.department_id) || 'a department'}` : ''}\n` +
            `┗ then: ${automation.ACTION_LABELS[rule.action_key]}` +
            `${rule.last_run_at ? ` · last ran ${discordTimestamp(rule.last_run_at, 'R')}` : ' · never run'}`
          ).join('\n').slice(0, 4000) || '_No rules. Add one with `/setup auto set`._')
          .setFooter({ text: 'A rule can only tell somebody or flag a task. None of them can change pay, approve work or message a client.' })],
      }));
      return;
    }

    if (sub === 'set') {
      const triggerKey = interaction.options.getString('when', true);
      const actionKey = interaction.options.getString('then', true);
      const person = interaction.options.getUser('person');
      const departmentRaw = interaction.options.getString('department');
      const threshold = interaction.options.getInteger('days');

      if (automation.THRESHOLD_TRIGGERS.includes(triggerKey) && !threshold) {
        await interaction.reply(priv(
          `❌ "${automation.TRIGGER_LABELS[triggerKey]}" needs a number of days. Add \`days:\`.`
        ));
        return;
      }

      const result = automation.upsertRule(db, guildId, {
        key: interaction.options.getString('key', true),
        label: interaction.options.getString('label', true),
        triggerKey,
        threshold: automation.THRESHOLD_TRIGGERS.includes(triggerKey) ? threshold : null,
        departmentId: departmentRaw ? Number(departmentRaw) : null,
        actionKey,
        targetUserId: person?.id ?? null,
        note: interaction.options.getString('note'),
      }, userId);

      if (!result.ok) {
        const reasons = {
          no_target: '❌ That action sends to one named person, so add `person:`.',
          unknown_trigger: '❌ Unknown trigger.',
          unknown_action: '❌ Unknown action.',
        };
        await interaction.reply(priv(reasons[result.reason] || `❌ ${result.reason}`));
        return;
      }

      const rule = result.rule;
      const check = automation.preview(db, guildId, rule);

      await interaction.reply(priv({
        content:
          `✅ **${rule.key}** saved and **switched off**.\n` +
          `${result.wasExisting ? 'A changed rule is a different rule, so it was switched off again.\n' : ''}` +
          `Right now it would act on **${check.wouldAct}** task(s), telling ${check.recipient}.\n` +
          `Look at it with \`/setup auto preview key:${rule.key}\`, then \`/setup auto on key:${rule.key}\`.`,
      }));
      return;
    }

    const key = interaction.options.getString('key', true);
    const rule = automation.getRule(db, guildId, key);
    if (!rule) {
      await interaction.reply(priv('❌ No rule with that id.'));
      return;
    }

    if (sub === 'preview') {
      const check = automation.preview(db, guildId, rule);
      await interaction.reply(priv({
        embeds: [new EmbedBuilder()
          .setTitle(`Preview · ${rule.label}`)
          .setColor(0xfaa61a)
          .setDescription(
            `**When:** ${automation.TRIGGER_LABELS[rule.trigger_key]}${rule.threshold ? ` (${rule.threshold} days)` : ''}\n` +
            `**Then:** ${automation.ACTION_LABELS[rule.action_key]} → ${check.recipient}\n\n` +
            `**Would act on ${check.wouldAct} task(s) now.**` +
            `${check.alreadyActed > 0 ? `\n${check.alreadyActed} already handled by this rule and would be left alone.` : ''}`
          )
          .addFields({
            name: 'Which ones',
            value: check.sample.map((task) => `**${task.code}** ${task.title}`).join('\n').slice(0, 1024) || '_none_',
            inline: false,
          })
          .setFooter({ text: 'Nothing has been sent or changed. This is what would happen.' })],
      }));
      return;
    }

    if (sub === 'on') {
      const check = automation.preview(db, guildId, rule);
      automation.setRuleEnabled(db, guildId, key, true, userId);

      await interaction.reply(priv(
        `✅ **${rule.key}** is on.\n` +
        `${check.wouldAct > 0
          ? `On its next run it will act on **${check.wouldAct}** task(s), telling ${check.recipient}.`
          : 'Nothing matches it at the moment, so it will be quiet until something does.'}\n` +
        '_Each task is acted on once by a rule, ever, so this will not become a daily nag._'
      ));
      return;
    }

    if (sub === 'off') {
      automation.setRuleEnabled(db, guildId, key, false, userId);
      await interaction.reply(priv(`✅ **${rule.key}** is off. What it has already done stays on the record.`));
      return;
    }

    if (sub === 'delete') {
      automation.deleteRule(db, guildId, key, userId);
      await interaction.reply(priv(`✅ **${rule.key}** deleted.`));
    }
  },
};
