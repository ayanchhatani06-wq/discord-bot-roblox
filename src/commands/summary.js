const { SlashCommandBuilder } = require('discord.js');
const configRepo = require('../db/repos/config');
const { contextFor } = require('../services/actor');
const { buildWeeklySummary, postWeeklySummary } = require('../services/summary');
const { runSweep } = require('../services/reminders');
const { scheduleSummaryFor } = require('../services/jobs');
const { CAPABILITIES, assertCan } = require('../domain/permissions');
const { priv } = require('../utils/reply');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('summary')
    .setDescription('Management summary and reminder controls')
    .addSubcommand((sub) => sub.setName('now').setDescription('Show the weekly summary right now, privately'))
    .addSubcommand((sub) => sub.setName('post').setDescription('Post the weekly summary to its channel now'))
    .addSubcommand((sub) =>
      sub
        .setName('schedule')
        .setDescription('Change when the weekly summary is posted')
        .addStringOption((opt) =>
          opt.setName('cron').setDescription('Five-field cron, e.g. "0 9 * * 1" for Mondays at 09:00 UTC').setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub.setName('run-reminders').setDescription('Run the reminder sweep now instead of waiting for the next one')
    ),

  async execute(interaction) {
    const { db, guildId, config, actor } = contextFor(interaction);
    assertCan(actor, CAPABILITIES.SUMMARY_VIEW);
    const sub = interaction.options.getSubcommand();

    if (sub === 'now') {
      await interaction.reply(priv({ embeds: [buildWeeklySummary(db, guildId)] }));
      return;
    }

    if (sub === 'post') {
      await interaction.deferReply(priv({}));
      const result = await postWeeklySummary(interaction.client, db, guildId);
      await interaction.editReply(
        result.delivered
          ? `✅ Summary posted${result.via === 'channel' ? ' to the summary channel' : ` by ${result.via}`}.`
          : `❌ Could not post it: ${result.reason.replace(/_/g, ' ')}. Set a channel with \`/studio channel purpose:Weekly management summary\`.`
      );
      return;
    }

    if (sub === 'schedule') {
      assertCan(actor, CAPABILITIES.CONFIG_MANAGE);

      const expression = interaction.options.getString('cron', true).trim();
      const fields = expression.split(/\s+/);
      if (fields.length !== 5) {
        await interaction.reply(priv('❌ A cron expression needs five fields: minute hour day month weekday. For example `0 9 * * 1`.'));
        return;
      }

      const previous = config.summary_cron;
      configRepo.updateConfig(db, guildId, { summary_cron: expression }, interaction.user.id);

      // Rejected expressions are rolled back rather than left to fail silently
      // every week from now on.
      const task = scheduleSummaryFor(interaction.client, db, guildId);
      if (!task) {
        configRepo.updateConfig(db, guildId, { summary_cron: previous }, interaction.user.id);
        await interaction.reply(priv(`❌ \`${expression}\` is not a valid cron expression, so the previous schedule was kept.`));
        return;
      }

      await interaction.reply(priv(
        `✅ Weekly summary now runs on \`${expression}\` (server time, UTC on most hosts). It was \`${previous}\`.`
      ));
      return;
    }

    if (sub === 'run-reminders') {
      assertCan(actor, CAPABILITIES.CONFIG_MANAGE);
      await interaction.deferReply(priv({}));

      const result = await runSweep(interaction.client, db);
      await interaction.editReply(
        `✅ Sweep finished: ${result.sent} person/people notified, ${result.deferred} held back by quiet hours` +
        `${result.failed.length > 0 ? `, ${result.failed.length} could not be reached` : ''}.`
      );
    }
  },
};
