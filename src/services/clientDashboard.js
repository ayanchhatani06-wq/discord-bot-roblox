const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} = require('discord.js');
const { customId } = require('../interactions/router');
const clientReport = require('./clientReport');
const { discordTimestamp } = require('../utils/time');

const NAMESPACE = 'client';

/**
 * The client's view of their order. Carries only what
 * services/clientReport.js is allowed to read, so there is no route from this
 * embed to staff names, pay or internal notes.
 */
function dashboardEmbed(report) {
  const embed = new EmbedBuilder()
    .setTitle(`${report.project.name}`)
    .setColor(0x1abc9c)
    .setDescription(clientReport.statusParagraph(report))
    .setFooter({ text: 'Buttons below. Asking a question never changes your order.' })
    .setTimestamp(report.lastUpdatedAt);

  if (report.departments.length > 1) {
    embed.addFields({
      name: 'By type',
      value: report.departments.map((entry) => `${entry.name}: ${entry.count}`).join(' · '),
      inline: false,
    });
  }

  if (report.awaitingApproval.length > 0) {
    embed.addFields({
      name: `Ready for your review (${report.awaitingApproval.length})`,
      value: report.awaitingApproval.slice(0, 8)
        .map((entry) => `• **${entry.title}** — version ${entry.version}, released ${discordTimestamp(entry.releasedAt, 'R')}`)
        .join('\n').slice(0, 1024),
      inline: false,
    });
  }

  if (report.openRequests.length > 0) {
    embed.addFields({
      name: `Your open requests (${report.openRequests.length})`,
      value: report.openRequests.slice(0, 5)
        .map((request) => `• ${request.kind.replace(/_/g, ' ')} — sent ${discordTimestamp(request.created_at, 'R')} · ${request.status}`)
        .join('\n').slice(0, 1024),
      inline: false,
    });
  }

  return embed;
}

function dashboardComponents(projectId, { hasPreviews, canApprove }) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(customId(NAMESPACE, 'progress', projectId))
        .setLabel('View Progress')
        .setStyle(ButtonStyle.Primary)
        .setEmoji('📊'),
      new ButtonBuilder()
        .setCustomId(customId(NAMESPACE, 'previews', projectId))
        .setLabel('View Previews')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('🖼️')
        .setDisabled(!hasPreviews),
      new ButtonBuilder()
        .setCustomId(customId(NAMESPACE, 'deliverables', projectId))
        .setLabel('View Deliverables')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('📦')
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(customId(NAMESPACE, 'changes', projectId))
        .setLabel('Request Changes')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('🔁'),
      new ButtonBuilder()
        .setCustomId(customId(NAMESPACE, 'ask', projectId))
        .setLabel('Ask a Question')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('❓')
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(customId(NAMESPACE, 'service', projectId))
        .setLabel('Request Another Service')
        .setStyle(ButtonStyle.Success)
        .setEmoji('➕'),
      new ButtonBuilder()
        .setCustomId(customId(NAMESPACE, 'manager', projectId))
        .setLabel('Contact Manager')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('📨')
    ),
  ];
}

function questionMenu(projectId) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(customId(NAMESPACE, 'question', projectId))
      .setPlaceholder('Pick a question, or use Contact Manager for anything else')
      .addOptions(
        Object.entries(clientReport.QUESTIONS).map(([kind, question]) => ({
          label: question.label.slice(0, 100),
          value: kind,
        }))
      )
  );
}

/**
 * One approval control per released version, carrying the submission id so an
 * older button cannot approve newer work — and vice versa.
 */
function approvalComponents(taskId, submissionId, { disabled = false } = {}) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(customId(NAMESPACE, 'approve', taskId, submissionId))
      .setLabel('Approve this item')
      .setStyle(ButtonStyle.Success)
      .setEmoji('✅')
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(customId(NAMESPACE, 'revise', taskId, submissionId))
      .setLabel('Request changes')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('🔁')
      .setDisabled(disabled)
  )];
}

function previewEmbeds(report) {
  // Grouped so a bulk order does not produce one message per item, while each
  // reviewable item still gets its own approval control.
  const reviewable = report.awaitingApproval;
  const historical = report.previews.filter((entry) => !reviewable.includes(entry));

  const embeds = [];

  if (reviewable.length > 0) {
    embeds.push(new EmbedBuilder()
      .setTitle('Awaiting your decision')
      .setColor(0xfaa61a)
      .setDescription(
        'Each item is approved separately — approving one does not approve the rest of your order.'
      )
      .addFields(reviewable.slice(0, 10).map((entry) => ({
        name: `${entry.title} — version ${entry.version}`,
        value: `${entry.links.map((link) => `[file](${link})`).join(' · ') || '_no link recorded_'}\nReleased ${discordTimestamp(entry.releasedAt, 'R')}`,
        inline: false,
      }))));
  }

  if (historical.length > 0) {
    embeds.push(new EmbedBuilder()
      .setTitle('Previously released')
      .setColor(0x99aab5)
      .setDescription(historical.slice(0, 15).map((entry) =>
        `**${entry.title}** v${entry.version} · ${clientReport.BUCKET_LABELS[entry.bucket]} · ${entry.links.map((link) => `[file](${link})`).join(' ')}`
      ).join('\n').slice(0, 4000)));
  }

  if (embeds.length === 0) {
    embeds.push(new EmbedBuilder()
      .setTitle('No previews yet')
      .setColor(0x99aab5)
      .setDescription('Nothing has been released to you on this order yet. Use **Contact Manager** if you expected something.'));
  }

  return embeds;
}

function deliverablesEmbed(db, guildId, report) {
  const tasksRepo = require('../db/repos/tasks');
  const rows = tasksRepo.listTasksForProject(db, report.project.id)
    .filter((task) => task.state !== 'cancelled');

  const embed = new EmbedBuilder()
    .setTitle('Deliverables on this order')
    .setColor(0x5865f2)
    .setFooter({ text: 'What was agreed for each item. File formats as recorded on the order.' });

  if (rows.length === 0) {
    embed.setDescription('Nothing has been set up on this order yet.');
    return embed;
  }

  embed.setDescription(rows.slice(0, 20).map((task) => {
    const items = tasksRepo.deliverables(task);
    const bucket = clientReport.BUCKET_LABELS[clientReport.bucketFor(task)];
    return `**${task.title}** — ${bucket}\n` +
      `┗ ${items.length > 0 ? items.join(', ') : '_no list recorded_'}` +
      `${task.formats ? `\n┗ formats: ${task.formats}` : ''}`;
  }).join('\n').slice(0, 4000));

  if (rows.length > 20) {
    embed.addFields({ name: 'Note', value: `Showing 20 of ${rows.length} items.`, inline: false });
  }

  return embed;
}

module.exports = {
  NAMESPACE,
  dashboardEmbed,
  dashboardComponents,
  questionMenu,
  approvalComponents,
  previewEmbeds,
  deliverablesEmbed,
};
