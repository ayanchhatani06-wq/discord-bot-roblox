const path = require('node:path');
const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { openDatabase } = require('../../db');
const { contextFor } = require('../../services/actor');
const exporter = require('../../services/exporter');
const evidenceRepo = require('../../db/repos/evidence');
const { recordAudit } = require('../../db/repos/core');
const { CAPABILITIES, assertCan } = require('../../domain/permissions');
const { discordTimestamp } = require('../../utils/time');
const { priv } = require('../../utils/reply');

const KIND_CHOICES = exporter.EXPORT_KINDS.map((kind) => ({
  name: exporter.EXPORTABLE[kind].label.slice(0, 100),
  value: kind,
}));

const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, '..', '..', 'data', 'backups');

/**
 * Backups and exports.
 *
 * The distinction this command exists to keep clear: a backup is what you
 * restore from, an export is what you read. Somebody who keeps only CSVs finds
 * out on the worst possible day that they cannot put the studio back.
 */
module.exports = {
  data: new SlashCommandBuilder()
    .setName('backup')
    .setDescription('Backups you can restore from, and exports you can read')
    .addSubcommand((sub) =>
      sub
        .setName('now')
        .setDescription('Take a consistent copy of the database, right now')
    )
    .addSubcommand((sub) =>
      sub
        .setName('export')
        .setDescription('Download readable data as a spreadsheet file')
        .addStringOption((opt) => opt.setName('what').setDescription('Which records').setRequired(true).addChoices(...KIND_CHOICES))
    )
    .addSubcommand((sub) =>
      sub
        .setName('verify')
        .setDescription('Check a backup file is really a database that opens')
        .addStringOption((opt) => opt.setName('file').setDescription('Path on the server, or leave empty for the newest').setRequired(false))
    )
    .addSubcommand((sub) => sub.setName('restore').setDescription('How to put a backup back — read this before you need it')),

  async execute(interaction) {
    const { db, guildId, actor } = contextFor(interaction);
    const sub = interaction.options.getSubcommand();
    const userId = interaction.user.id;

    // Exports carry the whole studio's records, so they are the owner's alone.
    assertCan(actor, CAPABILITIES.CONFIG_MANAGE);
    assertCan(actor, CAPABILITIES.FINANCE_VIEW_ALL);

    if (sub === 'restore') {
      await interaction.reply(priv({
        embeds: [new EmbedBuilder()
          .setTitle('Putting a backup back')
          .setColor(0xfaa61a)
          .setDescription(exporter.RESTORE_STEPS.map((step, index) => `**${index + 1}.** ${step}`).join('\n\n'))
          .setFooter({ text: 'A backup nobody has ever opened is a hope, not a backup. Try /setup backup verify on a real file.' })],
      }));
      return;
    }

    if (sub === 'now') {
      await interaction.deferReply({ flags: priv('').flags });

      const destination = exporter.defaultBackupPath(BACKUP_DIR);
      try {
        const result = await exporter.backup(db, destination);
        recordAudit(db, {
          guildId, actorUserId: userId, action: 'backup.taken', entityType: 'guild', entityId: guildId,
          after: { path: result.path, bytes: result.bytes },
        });

        const check = exporter.verifyBackup(openDatabase, result.path);

        // The database holds each filed screenshot's hash and path, not its
        // bytes, so the files have to be copied too or a restore comes back
        // with every piece of proof reading as missing.
        const evidence = exporter.backupEvidence(
          evidenceRepo.evidenceDir(),
          `${result.path.replace(/\.sqlite$/, '')}-evidence`
        );

        await interaction.editReply(
          `✅ Backup written to \`${result.path}\` (${Math.round(result.bytes / 1024)} KB) at ${discordTimestamp(result.takenAt, 'f')}.\n` +
          `${check.ok
            ? `Checked: it opens, integrity is fine, and it holds ${check.counts.projects} order(s), ${check.counts.tasks} task(s) and ${check.counts.payments} payment(s).`
            : `⚠️ It was written but did **not** verify: ${check.reason}. Do not rely on it.`}\n` +
          `🔒 Filed proof: ${evidence.copied} file(s) copied` +
          `${evidence.skipped > 0 ? `, ${evidence.skipped} already there` : ''}` +
          ` to \`${evidence.directory}\`.\n\n` +
          '_Both of these are on the server, not in Discord. Copy them somewhere else, **together** — ' +
          'the database without the files gives you proof records with nothing behind them._'
        );
      } catch (error) {
        await interaction.editReply(`❌ The backup failed and nothing usable was written: ${error.message}`);
      }
      return;
    }

    if (sub === 'verify') {
      const file = interaction.options.getString('file') || exporter.newestBackup(BACKUP_DIR);
      if (!file) {
        await interaction.reply(priv(`❌ No backup found in \`${BACKUP_DIR}\`. Take one with \`/setup backup now\`.`));
        return;
      }

      const check = exporter.verifyBackup(openDatabase, file);
      await interaction.reply(priv(check.ok
        ? `✅ \`${file}\` opens and passes SQLite's own integrity check.\n` +
          `It holds ${check.counts.projects} order(s), ${check.counts.tasks} task(s) and ${check.counts.payments} payment(s), ` +
          `in ${Math.round(check.bytes / 1024)} KB.`
        : `❌ \`${file}\` is not usable: ${check.reason}${check.detail ? ` — ${check.detail}` : ''}.`));
      return;
    }

    if (sub === 'export') {
      const kind = interaction.options.getString('what', true);
      const result = exporter.exportCsv(db, guildId, kind);

      if (!result || result.rows === 0) {
        await interaction.reply(priv(`There is nothing to export for **${exporter.EXPORTABLE[kind]?.label || kind}** yet.`));
        return;
      }

      recordAudit(db, {
        guildId, actorUserId: userId, action: 'export.taken', entityType: 'guild', entityId: guildId,
        after: { kind, rows: result.rows },
      });

      const file = new AttachmentBuilder(Buffer.from(result.csv, 'utf8'), {
        name: `${kind}-${new Date().toISOString().slice(0, 10)}.csv`,
      });

      await interaction.reply(priv({
        content:
          `📄 **${result.label}** — ${result.rows} row(s).\n` +
          `${kind === 'payments' ? '_Payment references are deliberately left out: one of them could be a gift card code._\n' : ''}` +
          '⚠️ **This is not a backup.** You cannot put the studio back from a spreadsheet — use `/setup backup now` for that.',
        files: [file],
      }));
    }
  },
};
