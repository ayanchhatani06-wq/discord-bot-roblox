const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const clientsRepo = require('../db/repos/clients');
const projectsRepo = require('../db/repos/projects');
const messagingRepo = require('../db/repos/messaging');
const { contextFor } = require('../services/actor');
const clientMessaging = require('../services/clientMessaging');
const messageTriggers = require('../services/messageTriggers');
const { CAPABILITIES, assertCan } = require('../domain/permissions');
const { PLACEHOLDERS, preview: previewTemplate } = require('../domain/templates');
const { discordTimestamp } = require('../utils/time');
const { priv } = require('../utils/reply');

const TRIGGER_CHOICES = Object.entries(messagingRepo.TRIGGER_LABELS)
  .map(([value, name]) => ({ name: name.slice(0, 100), value }));

/**
 * The studio's automated messages to clients: the wording, the queue, the
 * rules, and what has actually been sent.
 */
module.exports = {
  data: new SlashCommandBuilder()
    .setName('outreach')
    .setDescription('Automated client messages: templates, queue and history')
    .addSubcommand((sub) =>
      sub
        .setName('template-set')
        .setDescription('Write or rewrite a message template (it starts as a draft)')
        .addStringOption((opt) => opt.setName('key').setDescription('Short id, e.g. delivery-note').setRequired(true))
        .addStringOption((opt) => opt.setName('label').setDescription('What it is for, in your words').setRequired(true))
        .addStringOption((opt) => opt.setName('body').setDescription('The message. Use {{placeholders}} — see /outreach placeholders').setRequired(true))
        .addStringOption((opt) =>
          opt.setName('kind').setDescription('Transactional or promotional').setRequired(true)
            .addChoices(
              { name: 'Transactional — about work they ordered', value: 'transactional' },
              { name: 'Promotional — needs their opt-in', value: 'promotional' }
            )
        )
        .addStringOption((opt) => opt.setName('trigger').setDescription('When it sends').setRequired(false).addChoices(...TRIGGER_CHOICES))
    )
    .addSubcommand((sub) =>
      sub
        .setName('template-approve')
        .setDescription('Approve a template so it can actually send')
        .addStringOption((opt) => opt.setName('key').setDescription('Template id').setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('templates')
        .setDescription('Every template and whether it is approved')
    )
    .addSubcommand((sub) =>
      sub
        .setName('preview')
        .setDescription('See a template with sample values, without sending anything')
        .addStringOption((opt) => opt.setName('key').setDescription('Template id').setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((sub) => sub.setName('placeholders').setDescription('Every value a template may use'))
    .addSubcommand((sub) =>
      sub
        .setName('queue')
        .setDescription('Messages waiting to go out, and ones that were held back')
    )
    .addSubcommand((sub) =>
      sub
        .setName('cancel')
        .setDescription('Cancel a queued message before it sends')
        .addIntegerOption((opt) => opt.setName('id').setDescription('Number from /outreach queue').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('history')
        .setDescription('What has been sent to a client')
        .addStringOption((opt) => opt.setName('client').setDescription('Client name').setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('prefs')
        .setDescription("Set a client's messaging rules")
        .addStringOption((opt) => opt.setName('client').setDescription('Client name').setRequired(true).setAutocomplete(true))
        .addIntegerOption((opt) => opt.setName('max-per-week').setDescription('Most promotional messages per week').setRequired(false).setMinValue(0).setMaxValue(7))
        .addIntegerOption((opt) => opt.setName('pause-days').setDescription('Pause all automated messages for this many days').setRequired(false).setMinValue(0).setMaxValue(365))
        .addStringOption((opt) => opt.setName('pause-reason').setDescription('Why they are paused').setRequired(false))
        .addUserOption((opt) => opt.setName('follow-up').setDescription('Who looks after this client').setRequired(false))
        .addBooleanOption((opt) => opt.setName('promotional').setDescription('Whether they have opted in to promotional messages').setRequired(false))
    )
    .addSubcommand((sub) => sub.setName('replies').setDescription('Clients who wrote in and are waiting on an answer'))
    .addSubcommand((sub) =>
      sub
        .setName('handled')
        .setDescription('Mark a client reply dealt with, which lets automation resume')
        .addIntegerOption((opt) => opt.setName('id').setDescription('Number from /outreach replies').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('offer')
        .setDescription('Queue the approved cross-service offer for one order')
        .addStringOption((opt) => opt.setName('project').setDescription('Project code').setRequired(true).setAutocomplete(true))
    ),

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);
    const { db, guildId } = contextFor(interaction);
    const query = String(focused.value || '');

    if (focused.name === 'key') {
      await interaction.respond(messagingRepo.listTemplates(db, guildId).slice(0, 25).map((template) => ({
        name: `${template.key} · ${template.label} · ${template.status}`.slice(0, 100),
        value: template.key,
      })));
      return;
    }

    if (focused.name === 'client') {
      const matches = query ? clientsRepo.searchClients(db, guildId, query, 25) : clientsRepo.listClients(db, guildId, { limit: 25 });
      await interaction.respond(matches.map((client) => ({ name: client.display_name.slice(0, 100), value: String(client.id) })));
      return;
    }

    if (focused.name === 'project') {
      const matches = query
        ? projectsRepo.searchProjects(db, guildId, query, 25)
        : projectsRepo.listProjects(db, guildId, { status: 'active', limit: 25 });
      await interaction.respond(matches.map((project) => ({ name: `${project.code} · ${project.name}`.slice(0, 100), value: project.code })));
    }
  },

  async execute(interaction) {
    const { db, guildId, actor } = contextFor(interaction);
    const sub = interaction.options.getSubcommand();
    const userId = interaction.user.id;

    if (sub === 'placeholders') {
      await interaction.reply(priv({
        embeds: [new EmbedBuilder()
          .setTitle('Template placeholders')
          .setColor(0x5865f2)
          .setDescription(
            'Only these may be used. Anything else is refused when you write the template, ' +
            'and a placeholder with nothing recorded behind it stops the message going out ' +
            'rather than sending a gap.\n\n' +
            Object.entries(PLACEHOLDERS).map(([name, note]) => `\`{{${name}}}\` — ${note}`).join('\n')
          )],
      }));
      return;
    }

    // Everything else is the studio's voice, so it sits with client records.
    assertCan(actor, CAPABILITIES.CLIENT_RECORD);

    if (sub === 'templates') {
      const templates = messagingRepo.listTemplates(db, guildId);
      await interaction.reply(priv({
        embeds: [new EmbedBuilder()
          .setTitle('Message templates')
          .setColor(0x5865f2)
          .setDescription(templates.map((template) =>
            `${template.status === 'approved' && template.active ? '🟢' : '⚪'} **${template.key}** — ${template.label}\n` +
            `┗ ${template.kind}${template.trigger_event ? ` · ${messagingRepo.TRIGGER_LABELS[template.trigger_event] || template.trigger_event}` : ' · not attached to an event'}` +
            ` · v${template.version} · ${template.status}`
          ).join('\n').slice(0, 4000) || '_No templates yet. Write one with `/outreach template-set`._')
          .setFooter({ text: 'Only approved, active templates ever send.' })],
      }));
      return;
    }

    if (sub === 'preview') {
      const template = messagingRepo.getTemplate(db, guildId, interaction.options.getString('key', true));
      if (!template) {
        await interaction.reply(priv('❌ No template with that key.'));
        return;
      }

      const rendered = previewTemplate(template.body);
      await interaction.reply(priv({
        embeds: [new EmbedBuilder()
          .setTitle(`${template.label} · v${template.version}`)
          .setColor(template.status === 'approved' ? 0x57f287 : 0xfaa61a)
          .setDescription(rendered.ok ? rendered.text.slice(0, 4000) : `❌ This template cannot render: unknown ${rendered.unknown?.join(', ')}`)
          .setFooter({ text: 'Sample values, shown in brackets. Nothing has been sent.' })],
      }));
      return;
    }

    if (sub === 'template-set') {
      const result = messagingRepo.upsertTemplate(db, guildId, {
        key: interaction.options.getString('key', true),
        label: interaction.options.getString('label', true),
        kind: interaction.options.getString('kind', true),
        triggerEvent: interaction.options.getString('trigger'),
        body: interaction.options.getString('body', true),
      }, userId);

      if (!result.ok) {
        await interaction.reply(priv(
          `❌ Unknown placeholder(s): ${result.unknown.map((name) => `\`{{${name}}}\``).join(', ')}.\n` +
          'See `/outreach placeholders` for the ones that exist.'
        ));
        return;
      }

      await interaction.reply(priv(
        `✅ **${result.template.key}** saved as a **draft** (v${result.template.version}).\n` +
        `${result.wordingChanged ? '⚠️ The wording changed, so its approval was withdrawn.\n' : ''}` +
        `Check it with \`/outreach preview key:${result.template.key}\`, then approve it with ` +
        `\`/outreach template-approve key:${result.template.key}\`. Nothing sends until then.`
      ));
      return;
    }

    if (sub === 'template-approve') {
      // Approving the studio's outgoing words is a decision about money and
      // reputation, so it sits with the owner rather than with client records.
      assertCan(actor, CAPABILITIES.CONFIG_MANAGE);

      const key = interaction.options.getString('key', true);
      const template = messagingRepo.approveTemplate(db, guildId, key, userId);
      if (!template) {
        const existing = messagingRepo.getTemplate(db, guildId, key);
        await interaction.reply(priv(existing
          ? `**${key}** is already approved at v${existing.version}.`
          : '❌ No template with that key.'));
        return;
      }

      await interaction.reply(priv(
        `✅ **${template.key}** v${template.version} approved. It can now send` +
        `${template.trigger_event ? ` when: ${messagingRepo.TRIGGER_LABELS[template.trigger_event]}` : ', once you attach it to an event'}.`
      ));
      return;
    }

    if (sub === 'queue') {
      const queued = messagingRepo.history(db, guildId, { status: 'queued', limit: 15 });
      const blocked = messagingRepo.history(db, guildId, { status: 'blocked', limit: 10 });
      const failed = messagingRepo.history(db, guildId, { status: 'failed', limit: 10 });

      const describe = (rows) => rows.map((row) =>
        `**#${row.id}** ${row.template_key || 'manual'} → client ${row.client_id}` +
        `${row.project_id ? ` · project ${row.project_id}` : ''}` +
        `${row.status === 'queued' ? ` · due ${discordTimestamp(row.send_after, 'R')}` : ''}` +
        `${row.blocked_reason ? `\n┗ held back: ${row.blocked_reason}` : ''}` +
        `${row.failure_reason ? `\n┗ failed: ${row.failure_reason}` : ''}`
      ).join('\n').slice(0, 1024) || '_none_';

      await interaction.reply(priv({
        embeds: [new EmbedBuilder()
          .setTitle('Client message queue')
          .setColor(failed.length > 0 ? 0xed4245 : 0x5865f2)
          .addFields(
            { name: `Waiting to send (${queued.length})`, value: describe(queued), inline: false },
            { name: `Held back (${blocked.length})`, value: describe(blocked), inline: false },
            { name: `Failed (${failed.length})`, value: describe(failed), inline: false }
          )],
      }));
      return;
    }

    if (sub === 'cancel') {
      const cancelled = messagingRepo.cancelMessage(db, guildId, interaction.options.getInteger('id', true), userId);
      await interaction.reply(priv(cancelled
        ? `✅ Message **#${cancelled.id}** cancelled before it went out.`
        : '❌ That message is not queued — it may already have been sent.'));
      return;
    }

    if (sub === 'replies') {
      const replies = messagingRepo.openReplies(db, guildId);
      await interaction.reply(priv({
        embeds: [new EmbedBuilder()
          .setTitle('Clients waiting on an answer')
          .setColor(replies.length > 0 ? 0xfaa61a : 0x57f287)
          .setDescription(replies.map((reply) =>
            `**#${reply.id}** <@${reply.user_id}> in <#${reply.channel_id}> · ${discordTimestamp(reply.received_at, 'R')}\n` +
            `┗ ${reply.excerpt.slice(0, 200)}`
          ).join('\n').slice(0, 4000) || '_Nobody is waiting._')
          .setFooter({ text: 'Automated messages to these clients are paused. Clear with /outreach handled id:<number>' })],
      }));
      return;
    }

    if (sub === 'handled') {
      const reply = messagingRepo.markReplyHandled(db, guildId, interaction.options.getInteger('id', true), userId);
      await interaction.reply(priv(reply
        ? `✅ Reply **#${reply.id}** marked dealt with. Automated messages to this client can resume.`
        : '❌ That reply is not open — somebody may already have marked it handled.'));
      return;
    }

    if (sub === 'offer') {
      const project = projectsRepo.getProjectByCode(db, guildId, interaction.options.getString('project', true));
      if (!project) {
        await interaction.reply(priv('❌ No project with that code.'));
        return;
      }

      const result = messageTriggers.crossServiceOffer(db, guildId, project, { queuedBy: userId });
      if (!result.ok) {
        await interaction.reply(priv(
          `❌ Not queued: ${clientMessaging.BLOCKED_TEXT[result.reason] || result.reason}.` +
          `${result.missing ? ` Missing: ${result.missing.join(', ')}.` : ''}`
        ));
        return;
      }

      await interaction.reply(priv(result.created
        ? `✅ Queued for ${project.code}. It goes out on the next pass unless you cancel it — \`/outreach queue\`.`
        : 'That offer was already queued for this order today.'));
      return;
    }

    if (sub === 'prefs') {
      const client = clientsRepo.getClient(db, guildId, Number(interaction.options.getString('client', true)));
      if (!client) {
        await interaction.reply(priv('❌ No client with that name.'));
        return;
      }

      const pauseDays = interaction.options.getInteger('pause-days');
      const promotional = interaction.options.getBoolean('promotional');
      const followUp = interaction.options.getUser('follow-up');
      const maxPerWeek = interaction.options.getInteger('max-per-week');

      const prefs = messagingRepo.setPrefs(db, guildId, client.id, {
        ...(maxPerWeek !== null ? { maxPerWeek } : {}),
        ...(pauseDays !== null ? {
          pausedUntil: pauseDays > 0 ? Date.now() + pauseDays * 24 * 60 * 60 * 1000 : null,
          pausedReason: pauseDays > 0 ? (interaction.options.getString('pause-reason') || 'no reason recorded') : null,
        } : {}),
        ...(followUp ? { followUpUserId: followUp.id } : {}),
      }, userId);

      if (promotional !== null) {
        // Consent is a fact about the client, so it lives on their record and
        // withdrawing it is stamped rather than just flipped back.
        clientsRepo.updateClient(db, guildId, client.id, {
          promo_opt_in: promotional ? 1 : 0,
          promo_stopped_at: promotional ? null : Date.now(),
        }, userId);
      }

      const updated = clientsRepo.getClient(db, guildId, client.id);
      await interaction.reply(priv([
        `✅ Messaging rules for **${updated.display_name}**:`,
        `• Promotional messages: ${updated.promo_opt_in === 1 && !updated.promo_stopped_at ? 'opted in' : 'not opted in'}`,
        `• Most per week: ${prefs.max_per_week ?? clientMessaging.DEFAULT_MAX_PROMOTIONAL_PER_WEEK} (default)`,
        prefs.paused_until && prefs.paused_until > Date.now()
          ? `• ⏸️ Paused until ${discordTimestamp(prefs.paused_until, 'F')} — ${prefs.paused_reason}`
          : '• Not paused',
        prefs.follow_up_user_id ? `• Looked after by <@${prefs.follow_up_user_id}>` : '• No follow-up owner set',
      ].join('\n')));
      return;
    }

    if (sub === 'history') {
      const client = clientsRepo.getClient(db, guildId, Number(interaction.options.getString('client', true)));
      if (!client) {
        await interaction.reply(priv('❌ No client with that name.'));
        return;
      }

      const rows = messagingRepo.history(db, guildId, { clientId: client.id, limit: 20 });
      await interaction.reply(priv({
        embeds: [new EmbedBuilder()
          .setTitle(`Messages · ${client.display_name}`)
          .setColor(0x5865f2)
          .setDescription(rows.map((row) =>
            `${row.status === 'sent' ? '📨' : row.status === 'failed' ? '⚠️' : '⏸️'} ` +
            `**${row.template_key || 'manual'}** · ${row.status}` +
            `${row.sent_at ? ` ${discordTimestamp(row.sent_at, 'R')}` : ''}` +
            `${row.blocked_reason ? ` — ${row.blocked_reason}` : ''}`
          ).join('\n').slice(0, 4000) || '_Nothing has been sent to this client._')],
      }));
    }
  },
};
