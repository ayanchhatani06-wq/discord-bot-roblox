const { SlashCommandBuilder, EmbedBuilder, ChannelType } = require('discord.js');
const enquiriesRepo = require('../db/repos/enquiries');
const clientsRepo = require('../db/repos/clients');
const configRepo = require('../db/repos/config');
const { contextFor } = require('../services/actor');
const quoteFlow = require('../services/quoteFlow');
const { notifyUser } = require('../services/notify');
const { CAPABILITIES, assertCan, can } = require('../domain/permissions');
const { parseAmount, formatAmount, formatTotals, isSupportedCurrency, CURRENCIES } = require('../domain/money');
const { parseDeadlineInput, discordTimestamp } = require('../utils/time');
const { priv } = require('../utils/reply');

const CURRENCY_CHOICES = Object.keys(CURRENCIES).map((code) => ({ name: code, value: code }));
const { STATUSES, STATUS_LABELS } = enquiriesRepo;

module.exports = {
  data: new SlashCommandBuilder()
    .setName('enquiry')
    .setDescription('Incoming work enquiries and quotes')
    .addSubcommand((sub) =>
      sub
        .setName('new')
        .setDescription('Record an enquiry that came in outside the bot')
        .addStringOption((opt) => opt.setName('service').setDescription('What they want, e.g. "12 models, 4 vfx"').setRequired(true))
        .addStringOption((opt) => opt.setName('client').setDescription('Existing client').setRequired(false).setAutocomplete(true))
        .addStringOption((opt) => opt.setName('contact').setDescription('Who they are, if not an existing client').setRequired(false))
        .addStringOption((opt) => opt.setName('references').setDescription('References and style').setRequired(false))
        .addStringOption((opt) => opt.setName('formats').setDescription('Required formats or technical specs').setRequired(false))
        .addStringOption((opt) => opt.setName('deadline').setDescription('Desired deadline, YYYY-MM-DD').setRequired(false))
        .addStringOption((opt) => opt.setName('budget').setDescription('Budget range as they stated it').setRequired(false))
        .addStringOption((opt) => opt.setName('notes').setDescription('Anything else').setRequired(false))
    )
    .addSubcommand((sub) =>
      sub
        .setName('list')
        .setDescription('The enquiry pipeline')
        .addStringOption((opt) =>
          opt.setName('status').setDescription('Which').setRequired(false).addChoices(
            { name: 'Open (not yet accepted or closed)', value: 'open' },
            ...Object.entries(STATUS_LABELS).map(([value, name]) => ({ name, value })),
            { name: 'All', value: 'all' }
          )
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('view')
        .setDescription('One enquiry and its quotes')
        .addStringOption((opt) => opt.setName('enquiry').setDescription('Enquiry code').setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('needs-info')
        .setDescription('Mark that you are waiting on the client for details')
        .addStringOption((opt) => opt.setName('enquiry').setDescription('Enquiry code').setRequired(true).setAutocomplete(true))
        .addStringOption((opt) => opt.setName('question').setDescription('What you need from them').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('draft-quote')
        .setDescription('Prepare a draft quote from your templates (still needs owner approval)')
        .addStringOption((opt) => opt.setName('enquiry').setDescription('Enquiry code').setRequired(true).setAutocomplete(true))
        .addStringOption((opt) => opt.setName('total').setDescription('Override the total').setRequired(false))
        .addStringOption((opt) => opt.setName('currency').setDescription('Currency').addChoices(...CURRENCY_CHOICES).setRequired(false))
        .addIntegerOption((opt) => opt.setName('turnaround_days').setDescription('Working days to deliver').setMinValue(1).setRequired(false))
        .addStringOption((opt) => opt.setName('terms').setDescription('Terms to include').setRequired(false))
    )
    .addSubcommand((sub) =>
      sub
        .setName('approve-quote')
        .setDescription('Approve a draft quote so it can be sent (owner only)')
        .addStringOption((opt) => opt.setName('enquiry').setDescription('Enquiry code').setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('send-quote')
        .setDescription('Record that the approved quote has been sent to the client')
        .addStringOption((opt) => opt.setName('enquiry').setDescription('Enquiry code').setRequired(true).setAutocomplete(true))
        .addChannelOption((opt) =>
          opt.setName('post_to').setDescription('Post it in this channel too').addChannelTypes(ChannelType.GuildText).setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('accept')
        .setDescription('Client accepted: turn the enquiry into a project with its tasks')
        .addStringOption((opt) => opt.setName('enquiry').setDescription('Enquiry code').setRequired(true).setAutocomplete(true))
        .addStringOption((opt) => opt.setName('deadline').setDescription('Agreed deadline, YYYY-MM-DD').setRequired(false))
        .addChannelOption((opt) =>
          opt.setName('client_channel').setDescription('Their ticket channel').addChannelTypes(ChannelType.GuildText).setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('decline')
        .setDescription('Record that the enquiry did not go ahead')
        .addStringOption((opt) => opt.setName('enquiry').setDescription('Enquiry code').setRequired(true).setAutocomplete(true))
        .addStringOption((opt) => opt.setName('reason').setDescription('Why').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('template')
        .setDescription('Set a pricing template for a service')
        .addStringOption((opt) => opt.setName('department').setDescription('Department').setRequired(true).setAutocomplete(true))
        .addStringOption((opt) => opt.setName('unit_price').setDescription('Price per item, e.g. 40').setRequired(true))
        .addStringOption((opt) => opt.setName('currency').setDescription('Currency').addChoices(...CURRENCY_CHOICES).setRequired(false))
        .addIntegerOption((opt) => opt.setName('turnaround_days').setDescription('Typical working days').setMinValue(1).setRequired(false))
        .addIntegerOption((opt) => opt.setName('revisions').setDescription('Revision rounds included').setMinValue(0).setRequired(false))
    )
    .addSubcommand((sub) => sub.setName('templates').setDescription('Current pricing templates')),

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);
    const { db, guildId } = contextFor(interaction);
    const query = String(focused.value || '');

    if (focused.name === 'enquiry') {
      const matches = query
        ? enquiriesRepo.searchEnquiries(db, guildId, query, 25)
        : enquiriesRepo.listEnquiries(db, guildId, { status: 'open', limit: 25 });
      await interaction.respond(matches.map((row) => ({
        name: `${row.code} · ${row.service_request} · ${STATUS_LABELS[row.status]}`.slice(0, 100),
        value: row.code,
      })));
      return;
    }

    if (focused.name === 'client') {
      const matches = query
        ? clientsRepo.searchClients(db, guildId, query, 25)
        : clientsRepo.listClients(db, guildId, { limit: 25 });
      await interaction.respond(matches.map((row) => ({ name: row.display_name.slice(0, 100), value: String(row.id) })));
      return;
    }

    if (focused.name === 'department') {
      const lower = query.toLowerCase();
      const matches = configRepo.listDepartments(db, guildId)
        .filter((dept) => dept.key.includes(lower) || dept.name.toLowerCase().includes(lower))
        .slice(0, 25);
      await interaction.respond(matches.map((dept) => ({ name: dept.name, value: dept.key })));
    }
  },

  async execute(interaction) {
    const { db, guildId, config, actor } = contextFor(interaction);
    const sub = interaction.options.getSubcommand();
    const userId = interaction.user.id;

    if (sub === 'templates') {
      assertCan(actor, CAPABILITIES.PROJECT_CREATE);
      const templates = enquiriesRepo.listTemplates(db, guildId);

      await interaction.reply(priv({
        embeds: [new EmbedBuilder()
          .setTitle('Pricing templates')
          .setColor(0x5865f2)
          .setDescription(templates.length === 0
            ? 'None yet. Add one with `/enquiry template`.\nWithout templates, quotes have to be priced by hand every time.'
            : templates.map((row) =>
                `**${row.label}** (\`${row.key}\`) — ${row.unit_amount_minor === null ? 'no price' : formatAmount(row.unit_amount_minor, row.currency)} each` +
                `${row.turnaround_days ? ` · ${row.turnaround_days} day(s)` : ''}` +
                `${row.revision_rounds !== null ? ` · ${row.revision_rounds} revision(s)` : ''}`
              ).join('\n').slice(0, 4000))
          .setFooter({ text: 'A template pre-fills a draft. It never sets a price without your approval.' })],
      }));
      return;
    }

    if (sub === 'template') {
      assertCan(actor, CAPABILITIES.TASK_PAY_APPROVE);

      const key = interaction.options.getString('department', true);
      const department = configRepo.getDepartmentByKey(db, guildId, key);
      if (!department) {
        await interaction.reply(priv('❌ No department with that key.'));
        return;
      }

      const currency = interaction.options.getString('currency') || config.default_currency;
      if (!isSupportedCurrency(currency)) {
        await interaction.reply(priv(`❌ Unsupported currency \`${currency}\`.`));
        return;
      }

      const template = enquiriesRepo.upsertTemplate(db, guildId, {
        key: department.key,
        label: department.name,
        departmentId: department.id,
        unitAmountMinor: parseAmount(interaction.options.getString('unit_price', true), currency),
        currency,
        turnaroundDays: interaction.options.getInteger('turnaround_days'),
        revisionRounds: interaction.options.getInteger('revisions'),
        deliverables: configRepo.departmentChecklist(department),
      }, userId);

      await interaction.reply(priv(
        `✅ **${template.label}** priced at ${formatAmount(template.unit_amount_minor, template.currency)} per item` +
        `${template.turnaround_days ? `, ${template.turnaround_days} working day(s)` : ''}.\n` +
        'This only pre-fills draft quotes — every quote still needs your approval before it goes out.'
      ));
      return;
    }

    if (sub === 'new') {
      assertCan(actor, CAPABILITIES.PROJECT_CREATE);

      const service = interaction.options.getString('service', true);
      const parsed = quoteFlow.parseServiceRequest(db, guildId, service);
      const clientOption = interaction.options.getString('client');
      const deadlineText = interaction.options.getString('deadline');

      let desiredDeadlineUtc = null;
      if (deadlineText) {
        const staffTimezone = db.prepare('SELECT timezone FROM staff WHERE guild_id = ? AND user_id = ?').get(guildId, userId)?.timezone;
        if (staffTimezone) {
          const result = parseDeadlineInput(deadlineText, staffTimezone);
          if (result.ok) desiredDeadlineUtc = result.utcMs;
        }
      }

      const enquiry = enquiriesRepo.createEnquiry(db, guildId, {
        clientId: clientOption ? Number(clientOption) : null,
        raisedBy: null,
        contactRef: interaction.options.getString('contact'),
        source: 'staff',
        serviceRequest: service,
        parsed: parsed.items,
        referencesText: interaction.options.getString('references'),
        formatsText: interaction.options.getString('formats'),
        desiredDeadlineUtc,
        deadlineText,
        budgetText: interaction.options.getString('budget'),
        notes: interaction.options.getString('notes'),
      }, userId);

      const suggestion = quoteFlow.suggestLeaderRole(db, guildId, enquiry);
      await interaction.reply(priv([
        `✅ Recorded **${enquiry.code}**.`,
        parsed.items.length > 0
          ? `Matched to: ${parsed.items.map((item) => `${item.count} × ${item.departmentName}`).join(', ')}.`
          : '⚠️ Could not match the request to any department, so it cannot be priced or converted automatically yet.',
        parsed.errors.length > 0 ? `Not understood: ${parsed.errors.join(' ')}` : null,
        suggestion ? `Routed to ${`<@&${suggestion.leaderRoleId}>`} as the largest part of the job.` : null,
        '',
        `Next: \`/enquiry draft-quote enquiry:${enquiry.code}\`.`,
      ].filter((line) => line !== null).join('\n')));

      if (suggestion && config.owner_user_id) {
        await notifyUser(interaction.client, db, guildId, config.owner_user_id, {
          content: `📥 New enquiry **${enquiry.code}**: ${service}\nMostly ${suggestion.departmentName}. Draft a quote with \`/enquiry draft-quote enquiry:${enquiry.code}\`.`,
        }).catch(() => null);
      }
      return;
    }

    if (sub === 'list') {
      assertCan(actor, CAPABILITIES.PROJECT_CREATE);

      const status = interaction.options.getString('status') || 'open';
      const rows = enquiriesRepo.listEnquiries(db, guildId, { status, limit: 25 });
      const counts = enquiriesRepo.pipelineCounts(db, guildId);
      const outstanding = enquiriesRepo.outstandingQuoteValue(db, guildId);

      const embed = new EmbedBuilder()
        .setTitle('Enquiries')
        .setColor(0x5865f2)
        .setDescription(rows.length === 0
          ? 'Nothing here.'
          : rows.map((row) =>
              `**${row.code}** ${row.service_request.slice(0, 60)}\n` +
              `┗ ${STATUS_LABELS[row.status]} · ${discordTimestamp(row.created_at, 'R')}` +
              `${row.budget_text ? ` · budget: ${row.budget_text}` : ''}`
            ).join('\n').slice(0, 4000))
        .addFields(
          {
            name: 'Pipeline',
            value: Object.entries(STATUS_LABELS).map(([key, label]) => `${label}: ${counts[key]}`).join(' · '),
            inline: false,
          },
          { name: 'Quotes sent, awaiting an answer', value: formatTotals(outstanding), inline: false }
        );

      await interaction.reply(priv({ embeds: [embed] }));
      return;
    }

    const code = interaction.options.getString('enquiry', true);
    const enquiry = enquiriesRepo.getEnquiryByCode(db, guildId, code);
    if (!enquiry) {
      await interaction.reply(priv(`❌ No enquiry with code \`${code}\`.`));
      return;
    }

    if (sub === 'view') {
      assertCan(actor, CAPABILITIES.PROJECT_CREATE);

      const quotes = enquiriesRepo.listQuotes(db, enquiry.id);
      const client = enquiry.client_id ? clientsRepo.getClient(db, guildId, enquiry.client_id) : null;

      const embed = new EmbedBuilder()
        .setTitle(`${enquiry.code} · ${STATUS_LABELS[enquiry.status]}`)
        .setColor(0x5865f2)
        .setDescription(enquiry.service_request.slice(0, 2000))
        .addFields(
          { name: 'From', value: client ? client.display_name : (enquiry.contact_ref || (enquiry.raised_by ? `<@${enquiry.raised_by}>` : 'unknown')), inline: true },
          { name: 'Source', value: enquiry.source, inline: true },
          { name: 'Received', value: discordTimestamp(enquiry.created_at, 'f'), inline: true }
        );

      if (enquiry.references_text) embed.addFields({ name: 'References and style', value: enquiry.references_text.slice(0, 1024), inline: false });
      if (enquiry.formats_text) embed.addFields({ name: 'Formats / technical', value: enquiry.formats_text.slice(0, 1024), inline: false });
      if (enquiry.deadline_text || enquiry.desired_deadline_utc) {
        embed.addFields({
          name: 'Desired deadline',
          value: enquiry.desired_deadline_utc ? discordTimestamp(enquiry.desired_deadline_utc, 'D') : enquiry.deadline_text,
          inline: true,
        });
      }
      if (enquiry.budget_text) embed.addFields({ name: 'Budget as stated', value: enquiry.budget_text.slice(0, 1024), inline: true });
      if (enquiry.notes) embed.addFields({ name: 'Notes', value: enquiry.notes.slice(0, 1024), inline: false });

      const items = enquiriesRepo.parsedItems(enquiry);
      embed.addFields({
        name: 'Matched to departments',
        value: items.length > 0
          ? items.map((item) => `${item.count} × ${item.departmentName}`).join(', ')
          : '_not matched — cannot be priced or converted automatically_',
        inline: false,
      });

      if (quotes.length > 0) {
        embed.addFields({
          name: `Quotes (${quotes.length})`,
          value: quotes.map((quote) =>
            `v${quote.version} · ${formatAmount(quote.total_minor, quote.currency)} · **${quote.status}**` +
            `${quote.approved_by ? ` · approved by <@${quote.approved_by}>` : ''}` +
            `${quote.sent_at ? ` · sent ${discordTimestamp(quote.sent_at, 'd')}` : ''}`
          ).join('\n').slice(0, 1024),
          inline: false,
        });
      }

      if (enquiry.project_id) {
        const project = require('../db/repos/projects').getProject(db, guildId, enquiry.project_id);
        if (project) embed.addFields({ name: 'Became', value: `${project.code} · ${project.name}`, inline: false });
      }

      await interaction.reply(priv({ embeds: [embed] }));
      return;
    }

    if (sub === 'needs-info') {
      assertCan(actor, CAPABILITIES.PROJECT_CREATE);
      const question = interaction.options.getString('question', true);

      enquiriesRepo.setStatus(db, guildId, enquiry.id, STATUSES.NEEDS_INFO, userId, { detail: question });
      await interaction.reply(priv(
        `✅ **${enquiry.code}** marked as waiting on the client.\nRecorded: ${question}\n` +
        'Ask them yourself — the bot does not chase clients for enquiry details.'
      ));
      return;
    }

    if (sub === 'draft-quote') {
      assertCan(actor, CAPABILITIES.PROJECT_CREATE);

      const overrideText = interaction.options.getString('total');
      const currency = interaction.options.getString('currency') || config.default_currency;
      const draft = quoteFlow.draftFromEnquiry(db, guildId, enquiry, { currency: interaction.options.getString('currency') });

      if (!draft.ok && !overrideText) {
        await interaction.reply(priv(
          `❌ Could not build a draft: ${draft.detail}\n` +
          `Give a total yourself: \`/enquiry draft-quote enquiry:${enquiry.code} total:250\`.`
        ));
        return;
      }

      const lines = draft.ok ? draft.lines : [];
      const totalMinor = overrideText
        ? parseAmount(overrideText, currency)
        : draft.totalMinor;

      if (!overrideText && draft.ok && !draft.complete) {
        await interaction.reply(priv(
          `❌ Some items have no price template, so a total cannot be worked out:\n${draft.warnings.map((w) => `• ${w}`).join('\n')}\n\n` +
          `Either add templates, or give the total yourself with \`total:\`.`
        ));
        return;
      }

      const quote = enquiriesRepo.createQuote(db, guildId, enquiry.id, {
        lines,
        totalMinor,
        currency: draft.ok ? draft.currency : currency,
        turnaroundDays: interaction.options.getInteger('turnaround_days') ?? draft.turnaroundDays ?? null,
        terms: interaction.options.getString('terms'),
      }, userId);

      enquiriesRepo.setStatus(db, guildId, enquiry.id, STATUSES.QUOTE_PREPARED, userId);

      await interaction.reply(priv([
        `📝 Draft quote v${quote.version} for **${enquiry.code}**:`,
        lines.length > 0 ? quoteFlow.renderQuoteLines(lines) : '_priced as a single total_',
        `**Total: ${formatAmount(quote.total_minor, quote.currency)}**` +
        `${quote.turnaround_days ? ` · ${quote.turnaround_days} working day(s)` : ''}`,
        '',
        '⚠️ **This is a draft and has not been sent.** It needs your approval first:',
        `\`/enquiry approve-quote enquiry:${enquiry.code}\``,
      ].join('\n')));

      if (config.owner_user_id && config.owner_user_id !== userId) {
        await notifyUser(interaction.client, db, guildId, config.owner_user_id, {
          content:
            `📝 <@${userId}> drafted quote v${quote.version} for **${enquiry.code}** at ` +
            `${formatAmount(quote.total_minor, quote.currency)}. It cannot be sent until you approve it: ` +
            `\`/enquiry approve-quote enquiry:${enquiry.code}\`.`,
        }).catch(() => null);
      }
      return;
    }

    if (sub === 'approve-quote') {
      // Prices and delivery commitments are the owner's alone.
      assertCan(actor, CAPABILITIES.TASK_PAY_APPROVE);

      const quote = enquiriesRepo.latestQuote(db, enquiry.id);
      if (!quote) {
        await interaction.reply(priv(`❌ **${enquiry.code}** has no quote yet.`));
        return;
      }
      if (quote.status !== 'draft') {
        await interaction.reply(priv(`Quote v${quote.version} is already **${quote.status}**, not a draft awaiting approval.`));
        return;
      }

      const approved = enquiriesRepo.approveQuote(db, guildId, quote.id, userId);
      await interaction.reply(priv(
        `✅ Quote v${approved.version} for **${enquiry.code}** approved at **${formatAmount(approved.total_minor, approved.currency)}**` +
        `${approved.turnaround_days ? ` over ${approved.turnaround_days} working day(s)` : ''}.\n` +
        `Send it, then record that with \`/enquiry send-quote enquiry:${enquiry.code}\`.`
      ));

      if (quote.prepared_by !== userId) {
        await notifyUser(interaction.client, db, guildId, quote.prepared_by, {
          content: `✅ Your quote v${approved.version} for **${enquiry.code}** was approved at ${formatAmount(approved.total_minor, approved.currency)}.`,
        }).catch(() => null);
      }
      return;
    }

    if (sub === 'send-quote') {
      assertCan(actor, CAPABILITIES.PROJECT_CREATE);

      const quote = enquiriesRepo.latestQuote(db, enquiry.id);
      if (!quote) {
        await interaction.reply(priv(`❌ **${enquiry.code}** has no quote.`));
        return;
      }
      if (quote.status !== 'approved') {
        await interaction.reply(priv(
          quote.status === 'draft'
            ? `❌ Quote v${quote.version} has not been approved yet. Nothing goes to a client before the owner approves it.`
            : `Quote v${quote.version} is **${quote.status}**.`
        ));
        return;
      }

      const sent = enquiriesRepo.markQuoteSent(db, guildId, quote.id, userId);
      enquiriesRepo.setStatus(db, guildId, enquiry.id, STATUSES.QUOTE_SENT, userId);

      const channel = interaction.options.getChannel('post_to');
      let posted = false;
      if (channel?.isTextBased?.()) {
        const message = await channel.send({
          embeds: [new EmbedBuilder()
            .setTitle(`Quote for ${enquiry.service_request.slice(0, 200)}`)
            .setColor(0x1abc9c)
            .setDescription(
              `${enquiriesRepo.quoteLines(sent).length > 0 ? `${quoteFlow.renderQuoteLines(enquiriesRepo.quoteLines(sent))}\n\n` : ''}` +
              `**Total: ${formatAmount(sent.total_minor, sent.currency)}**` +
              `${sent.turnaround_days ? `\nEstimated ${sent.turnaround_days} working day(s) from start.` : ''}` +
              `${sent.terms ? `\n\n${sent.terms}` : ''}`
            )
            .setFooter({ text: 'Reply here to accept or ask questions.' })],
        }).catch(() => null);
        posted = Boolean(message);
      }

      await interaction.reply(priv(
        `✅ Recorded as sent: quote v${sent.version}, ${formatAmount(sent.total_minor, sent.currency)}.` +
        `${channel ? (posted ? ` Posted in <#${channel.id}>.` : ' ⚠️ Could not post it in that channel — send it yourself.') : ''}\n` +
        `When they answer: \`/enquiry accept enquiry:${enquiry.code}\` or \`/enquiry decline\`.`
      ));
      return;
    }

    if (sub === 'accept') {
      assertCan(actor, CAPABILITIES.PROJECT_CREATE);

      const quote = enquiriesRepo.latestQuote(db, enquiry.id);
      if (quote && quote.status === 'draft') {
        await interaction.reply(priv(
          `❌ Quote v${quote.version} has never been approved or sent. Approve it first so what the client agreed to is on record.`
        ));
        return;
      }

      const deadlineText = interaction.options.getString('deadline');
      let deadlineUtc = null;
      if (deadlineText) {
        const staffTimezone = db.prepare('SELECT timezone FROM staff WHERE guild_id = ? AND user_id = ?').get(guildId, userId)?.timezone;
        if (!staffTimezone) {
          await interaction.reply(priv('❌ Set your timezone with `/profile timezone` so the deadline is read correctly.'));
          return;
        }
        const parsedDeadline = parseDeadlineInput(deadlineText, staffTimezone);
        if (!parsedDeadline.ok) {
          await interaction.reply(priv(`❌ Could not read "${deadlineText}" as a date. Use YYYY-MM-DD.`));
          return;
        }
        deadlineUtc = parsedDeadline.utcMs;
      }

      const clientChannel = interaction.options.getChannel('client_channel');
      const result = quoteFlow.convertToProject(db, guildId, enquiry, {
        actorUserId: userId,
        clientAmountMinor: quote ? quote.total_minor : null,
        currency: quote ? quote.currency : null,
        deadlineUtc,
        clientChannelId: clientChannel?.id ?? null,
      });

      if (!result.ok) {
        const reasons = {
          no_parsed_items: 'the request was never matched to departments, so there are no tasks to create',
          already_converted: 'this enquiry has already become a project',
        };
        await interaction.reply(priv(`❌ Could not convert it: ${reasons[result.reason] || result.reason}.`));
        return;
      }

      if (quote && quote.status === 'sent') {
        enquiriesRepo.respondToQuote(db, guildId, quote.id, { accepted: true, actorUserId: userId });
      }

      await interaction.reply(priv([
        `✅ **${enquiry.code}** accepted and became **${result.project.code}** with ${result.tasks.length} task(s).`,
        'The brief, references, formats and notes carried across — nothing to retype.',
        quote ? `Client payment recorded as ${formatAmount(quote.total_minor, quote.currency)}.` : 'No quote was attached, so no client payment is recorded yet.',
        '',
        '⚠️ Artist pay is **not** set on these tasks. The quote is what the client pays, not what artists are paid.',
        `Set pay with \`/task pay\`, then leaders can assign: \`/task queue\`.`,
      ].join('\n')));
      return;
    }

    if (sub === 'decline') {
      assertCan(actor, CAPABILITIES.PROJECT_CREATE);

      const reason = interaction.options.getString('reason', true);
      const quote = enquiriesRepo.latestQuote(db, enquiry.id);
      if (quote && quote.status === 'sent') {
        enquiriesRepo.respondToQuote(db, guildId, quote.id, { accepted: false, actorUserId: userId, declineReason: reason });
      }

      enquiriesRepo.setStatus(db, guildId, enquiry.id, STATUSES.DECLINED, userId, { detail: reason, closedReason: reason });
      await interaction.reply(priv(
        `✅ **${enquiry.code}** marked declined.\nReason recorded: ${reason}\n` +
        'It stays on record, so you can see why enquiries do not convert.'
      ));
    }
  },
};
