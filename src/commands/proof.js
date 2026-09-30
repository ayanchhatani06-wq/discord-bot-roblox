const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const projectsRepo = require('../db/repos/projects');
const tasksRepo = require('../db/repos/tasks');
const clientsRepo = require('../db/repos/clients');
const evidenceRepo = require('../db/repos/evidence');
const { contextFor } = require('../services/actor');
const disputePack = require('../services/disputePack');
const { CAPABILITIES, assertCan } = require('../domain/permissions');
const { discordTimestamp } = require('../utils/time');
const { priv } = require('../utils/reply');

const KIND_CHOICES = Object.entries(evidenceRepo.KIND_LABELS)
  .map(([value, name]) => ({ name: name.slice(0, 100), value }));

/**
 * Screenshots and files kept as proof, and the whole record of one order.
 *
 * The studio keeps the bytes. Discord's attachment links are signed, expire,
 * and stop working for good once the message is deleted — so a link is not
 * proof, it is a bet that Discord is still holding something for you on the
 * day somebody disputes an invoice.
 */
module.exports = {
  data: new SlashCommandBuilder()
    .setName('proof')
    .setDescription('Keep screenshots as proof, and produce the full record of an order')
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('File a screenshot or document as proof')
        .addAttachmentOption((opt) => opt.setName('file').setDescription('The screenshot or document').setRequired(true))
        .addStringOption((opt) => opt.setName('kind').setDescription('What it proves').setRequired(true).addChoices(...KIND_CHOICES))
        .addStringOption((opt) => opt.setName('note').setDescription('What it shows, in your words').setRequired(false).setMaxLength(500))
        .addStringOption((opt) => opt.setName('project').setDescription('Attach to an order').setRequired(false).setAutocomplete(true))
        .addStringOption((opt) => opt.setName('task').setDescription('Attach to one item').setRequired(false).setAutocomplete(true))
        .addStringOption((opt) => opt.setName('client').setDescription('Attach to a client').setRequired(false).setAutocomplete(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('list')
        .setDescription('What has been filed')
        .addStringOption((opt) => opt.setName('project').setDescription('For one order').setRequired(false).setAutocomplete(true))
        .addStringOption((opt) => opt.setName('task').setDescription('For one item').setRequired(false).setAutocomplete(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('show')
        .setDescription('Get a filed file back')
        .addIntegerOption((opt) => opt.setName('id').setDescription('Number from /proof list').setRequired(true))
    )
    .addSubcommand((sub) => sub.setName('verify').setDescription('Check every filed file is still the one that was filed'))
    .addSubcommand((sub) =>
      sub
        .setName('record')
        .setDescription('The whole record of an order, as a file — for a dispute or a chargeback')
        .addStringOption((opt) => opt.setName('project').setDescription('Which order').setRequired(true).setAutocomplete(true))
    ),

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);
    const { db, guildId } = contextFor(interaction);
    const query = String(focused.value || '');

    if (focused.name === 'project') {
      const matches = query
        ? projectsRepo.searchProjects(db, guildId, query, 25)
        : projectsRepo.listProjects(db, guildId, { status: 'all', limit: 25 });
      await interaction.respond(matches.map((p) => ({ name: `${p.code} · ${p.name}`.slice(0, 100), value: p.code })));
      return;
    }

    if (focused.name === 'task') {
      await interaction.respond(tasksRepo.searchTasks(db, guildId, query, { limit: 25 })
        .map((task) => ({ name: `${task.code} · ${task.title}`.slice(0, 100), value: task.code })));
      return;
    }

    const matches = query
      ? clientsRepo.searchClients(db, guildId, query, 25)
      : clientsRepo.listClients(db, guildId, { limit: 25 });
    await interaction.respond(matches.map((c) => ({ name: c.display_name.slice(0, 100), value: String(c.id) })));
  },

  async execute(interaction) {
    const { db, guildId, actor } = contextFor(interaction);
    const sub = interaction.options.getSubcommand();
    const userId = interaction.user.id;

    // Proof is used in money and client disputes, so it sits with the people
    // who handle those rather than with everybody.
    assertCan(actor, CAPABILITIES.CLIENT_RECORD);

    if (sub === 'add') {
      const attachment = interaction.options.getAttachment('file', true);
      await interaction.deferReply(priv({}));

      if (attachment.size > evidenceRepo.MAX_BYTES) {
        await interaction.editReply(
          `❌ That file is ${Math.round(attachment.size / 1024 / 1024)} MB. The limit is ` +
          `${evidenceRepo.MAX_BYTES / 1024 / 1024} MB — crop the screenshot or send the part that matters.`
        );
        return;
      }

      // Downloaded now, on purpose. The link Discord gave us expires, and dies
      // for good if the message is ever deleted.
      let buffer;
      try {
        // Bounded, so a CDN that never answers fails with a message the person
        // can act on rather than leaving the command hanging.
        const response = await fetch(attachment.url, { signal: AbortSignal.timeout(20000) });
        if (!response.ok) throw new Error(`Discord returned ${response.status}`);
        buffer = Buffer.from(await response.arrayBuffer());
      } catch (error) {
        await interaction.editReply(
          `❌ Could not download that file to keep it: ${error.name === 'TimeoutError' ? 'Discord did not answer in time' : error.message}.\n` +
          'Nothing was filed. Try again — the file has to be downloaded now, because the link Discord gave expires.'
        );
        return;
      }

      const projectCode = interaction.options.getString('project');
      const taskCode = interaction.options.getString('task');
      const clientRaw = interaction.options.getString('client');

      const project = projectCode ? projectsRepo.getProjectByCode(db, guildId, projectCode) : null;
      const task = taskCode ? tasksRepo.getTaskByCode(db, guildId, taskCode) : null;

      const stored = evidenceRepo.store(db, guildId, {
        buffer,
        filename: attachment.name,
        contentType: attachment.contentType,
        kind: interaction.options.getString('kind', true),
        projectId: project?.id ?? task?.project_id ?? null,
        taskId: task?.id ?? null,
        clientId: clientRaw ? Number(clientRaw) : project?.client_id ?? null,
        note: interaction.options.getString('note'),
        sourceUrl: attachment.url,
      }, userId);

      if (!stored.ok) {
        const reasons = {
          too_large: `❌ Too large. The limit is ${evidenceRepo.MAX_BYTES / 1024 / 1024} MB.`,
          unsupported_type: `❌ Only images, PDFs and plain text are kept. An evidence store that accepts anything is a way to pass malware around with the studio's name on it.`,
          empty: '❌ That file is empty.',
        };
        await interaction.editReply(reasons[stored.reason] || `❌ ${stored.reason}`);
        return;
      }

      await interaction.editReply(
        stored.created
          ? `🔒 Filed as **#${stored.evidence.id}** — ${stored.evidence.filename}\n` +
            `The file itself is kept, not a link to it, so it still works when the Discord message is gone.\n` +
            `Fingerprint: \`${stored.evidence.sha256.slice(0, 16)}…\` — recorded now, so a copy that still matches it later is provably this one.`
          : `That exact file was already filed as **#${stored.evidence.id}**. One record, not two.`
      );
      return;
    }

    if (sub === 'list') {
      const projectCode = interaction.options.getString('project');
      const taskCode = interaction.options.getString('task');

      const project = projectCode ? projectsRepo.getProjectByCode(db, guildId, projectCode) : null;
      const task = taskCode ? tasksRepo.getTaskByCode(db, guildId, taskCode) : null;

      const files = project
        ? evidenceRepo.forProject(db, guildId, project.id)
        : evidenceRepo.listFor(db, guildId, { taskId: task?.id ?? null });

      await interaction.reply(priv({
        embeds: [new EmbedBuilder()
          .setTitle(project ? `Proof on file · ${project.code}` : 'Proof on file')
          .setColor(0x5865f2)
          .setDescription(files.map((file) =>
            `**#${file.id}** ${file.filename} — _${evidenceRepo.KIND_LABELS[file.kind] || file.kind}_\n` +
            `┗ filed ${discordTimestamp(file.added_at, 'R')} by <@${file.added_by}>` +
            `${file.note ? `\n┗ ${file.note.slice(0, 150)}` : ''}`
          ).join('\n').slice(0, 4000) || '_Nothing filed yet. Add one with `/proof add`._')
          .setFooter({ text: `${Math.round(evidenceRepo.totalBytes(db, guildId) / 1024)} KB kept in total.` })],
      }));
      return;
    }

    if (sub === 'show') {
      const result = evidenceRepo.read(db, guildId, interaction.options.getInteger('id', true));

      if (!result.ok) {
        const reasons = {
          not_found: '❌ No filed proof with that number.',
          missing_file: '⚠️ That record exists but the file is gone from disk. Check your backups.',
          hash_mismatch: '🚨 That file no longer matches the fingerprint recorded when it was filed. ' +
            'Do not rely on it — a changed file is worse than a missing one.',
        };
        await interaction.reply(priv(reasons[result.reason] || `❌ ${result.reason}`));
        return;
      }

      await interaction.reply(priv({
        content:
          `🔒 **#${result.evidence.id}** ${result.evidence.filename}\n` +
          `Filed ${discordTimestamp(result.evidence.added_at, 'F')} by <@${result.evidence.added_by}>.\n` +
          `${result.evidence.note ? `> ${result.evidence.note}\n` : ''}` +
          `Fingerprint still matches: \`${result.evidence.sha256}\``,
        files: [new AttachmentBuilder(result.buffer, { name: result.evidence.filename })],
      }));
      return;
    }

    if (sub === 'verify') {
      const result = evidenceRepo.verifyAll(db, guildId);
      const bad = result.missing.length + result.changed.length;

      await interaction.reply(priv({
        embeds: [new EmbedBuilder()
          .setTitle('Filed proof')
          .setColor(bad === 0 ? 0x57f287 : 0xed4245)
          .setDescription(
            `**${result.ok} of ${result.checked}** files still match the fingerprint recorded when they were filed.\n\n` +
            `${result.missing.length > 0
              ? `⚠️ **${result.missing.length} missing from disk:** ${result.missing.map((row) => `#${row.id}`).join(', ')}\n`
              : ''}` +
            `${result.changed.length > 0
              ? `🚨 **${result.changed.length} changed since filing:** ${result.changed.map((row) => `#${row.id}`).join(', ')}\n`
              : ''}` +
            `${bad === 0 ? 'Nothing to worry about.' : 'Check your backups — a changed file cannot be relied on.'}`
          )],
      }));
      return;
    }

    if (sub === 'record') {
      const project = projectsRepo.getProjectByCode(db, guildId, interaction.options.getString('project', true));
      if (!project) {
        await interaction.reply(priv('❌ No order with that code.'));
        return;
      }

      // The record carries money, so it needs the finance permission too.
      assertCan(actor, CAPABILITIES.FINANCE_VIEW_ALL);

      const pack = disputePack.build(db, guildId, project);
      const text = disputePack.render(pack);

      await interaction.reply(priv({
        content:
          `📄 The full record of **${project.code} · ${project.name}**.\n` +
          `${pack.items.length} item(s), ${pack.receipts.length} payment(s) in, ` +
          `${pack.payouts.length} out, ${pack.files.length} file(s) of proof.\n` +
          `${pack.gaps.length > 0
            ? `\n⚠️ **${pack.gaps.length} gap(s) in the record**, listed in the file. Better to know now than mid-dispute.`
            : '\n✅ No gaps found in the record.'}\n` +
          '\n_Every timestamp in it was written when the thing happened, not when this was produced._',
        files: [new AttachmentBuilder(Buffer.from(text, 'utf8'), {
          name: `${project.code}-record-${new Date().toISOString().slice(0, 10)}.txt`,
        })],
      }));
    }
  },
};
