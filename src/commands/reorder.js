const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const configRepo = require('../db/repos/config');
const clientsRepo = require('../db/repos/clients');
const projectsRepo = require('../db/repos/projects');
const tasksRepo = require('../db/repos/tasks');
const staffRepo = require('../db/repos/staff');
const clientRecordsRepo = require('../db/repos/clientRecords');
const repeatOrders = require('../services/repeatOrders');
const { contextFor } = require('../services/actor');
const { CAPABILITIES, assertCan } = require('../domain/permissions');
const { parseAmount, formatAmount, isSupportedCurrency, CURRENCIES } = require('../domain/money');
const { parseBulkSpec, taskTitlesFor } = require('../domain/bulkSpec');
const { parseDeadlineInput, discordTimestamp } = require('../utils/time');
const { priv } = require('../utils/reply');

const CURRENCY_CHOICES = Object.keys(CURRENCIES).map((code) => ({ name: code, value: code }));

/**
 * Repeat orders.
 *
 * A draft copies what a previous order *was*, never what it cost or when it was
 * due. Those three — scope, price, deadline — are confirmed one at a time, each
 * stamped with who confirmed it, before the draft can become a real order.
 */

function draftEmbed(db, guildId, summary, departments) {
  const { draft, items, client, missing } = summary;
  const departmentName = new Map(departments.map((dept) => [dept.id, dept.name]));

  const byDepartment = new Map();
  for (const item of items) {
    const name = departmentName.get(item.department_id) || 'Unknown';
    byDepartment.set(name, (byDepartment.get(name) || 0) + 1);
  }

  return new EmbedBuilder()
    .setTitle(`Repeat order draft #${draft.id} · ${draft.name}`)
    .setColor(missing.length === 0 ? 0x57f287 : 0xfaa61a)
    .setDescription(
      `For **${client?.display_name || 'unknown client'}**` +
      `${summary.source ? `, copied from **${summary.source.code} · ${summary.source.name}**` : ''}.\n` +
      '_This is not an order yet. Nothing is queued, offered or shown to the client._'
    )
    .addFields(
      {
        name: `Scope — ${items.length} item(s) ${draft.scope_confirmed_at ? '✅' : '⬜'}`,
        value: ([...byDepartment.entries()].map(([name, count]) => `• ${count} × ${name}`).join('\n') || '_nothing_') +
          (draft.scope_confirmed_at ? `\nConfirmed by <@${draft.scope_confirmed_by}> ${discordTimestamp(draft.scope_confirmed_at, 'R')}` : ''),
        inline: false,
      },
      {
        name: `Price ${draft.price_confirmed_at ? '✅' : '⬜'}`,
        value: draft.client_amount_minor === null
          ? '_not set — last time\'s price is deliberately not carried over_'
          : `**${formatAmount(draft.client_amount_minor, draft.client_currency)}**` +
            `\nConfirmed by <@${draft.price_confirmed_by}> ${discordTimestamp(draft.price_confirmed_at, 'R')}`,
        inline: true,
      },
      {
        name: `Deadline ${draft.deadline_confirmed_at ? '✅' : '⬜'}`,
        value: draft.deadline_utc === null
          ? '_not set_'
          : `${discordTimestamp(draft.deadline_utc, 'F')}` +
            `\nConfirmed by <@${draft.deadline_confirmed_by}> ${discordTimestamp(draft.deadline_confirmed_at, 'R')}`,
        inline: true,
      }
    )
    .setFooter({
      text: missing.length === 0
        ? `Ready. Create it with /reorder create id:${draft.id}`
        : `Still to confirm: ${missing.join(', ')}`,
    });
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('reorder')
    .setDescription('Order a client something like last time')
    .addSubcommand((sub) =>
      sub
        .setName('from')
        .setDescription('Start a draft from a previous order')
        .addStringOption((opt) => opt.setName('project').setDescription('The order to copy').setRequired(true).setAutocomplete(true))
        .addStringOption((opt) => opt.setName('name').setDescription('Name for the new order').setRequired(false))
    )
    .addSubcommand((sub) =>
      sub
        .setName('show')
        .setDescription('See a draft and what is still to confirm')
        .addIntegerOption((opt) => opt.setName('id').setDescription('Draft number').setRequired(true))
    )
    .addSubcommand((sub) => sub.setName('list').setDescription('Drafts waiting to be confirmed'))
    .addSubcommand((sub) =>
      sub
        .setName('scope')
        .setDescription('Confirm what is in the order, changing it if needed')
        .addIntegerOption((opt) => opt.setName('id').setDescription('Draft number').setRequired(true))
        .addStringOption((opt) => opt.setName('spec').setDescription('Replace the items, e.g. "12 models, 4 vfx". Leave empty to confirm as copied').setRequired(false))
    )
    .addSubcommand((sub) =>
      sub
        .setName('price')
        .setDescription('Confirm what the client is paying this time')
        .addIntegerOption((opt) => opt.setName('id').setDescription('Draft number').setRequired(true))
        .addStringOption((opt) => opt.setName('amount').setDescription('What they are paying').setRequired(true))
        .addStringOption((opt) => opt.setName('currency').setDescription('Currency').addChoices(...CURRENCY_CHOICES).setRequired(false))
    )
    .addSubcommand((sub) =>
      sub
        .setName('deadline')
        .setDescription('Confirm the deadline for this order')
        .addIntegerOption((opt) => opt.setName('id').setDescription('Draft number').setRequired(true))
        .addStringOption((opt) => opt.setName('date').setDescription('e.g. 2026-11-20 or 2026-11-20 18:00').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('create')
        .setDescription('Turn a fully confirmed draft into a real order')
        .addIntegerOption((opt) => opt.setName('id').setDescription('Draft number').setRequired(true))
        .addChannelOption((opt) => opt.setName('channel').setDescription("The client's channel for this order").setRequired(false))
    )
    .addSubcommand((sub) =>
      sub
        .setName('discard')
        .setDescription('Throw a draft away')
        .addIntegerOption((opt) => opt.setName('id').setDescription('Draft number').setRequired(true))
    ),

  async autocomplete(interaction) {
    const { db, guildId } = contextFor(interaction);
    const query = String(interaction.options.getFocused() || '');
    // Past orders are the useful ones to copy, so delivered projects are
    // offered alongside live ones.
    const matches = query
      ? projectsRepo.searchProjects(db, guildId, query, 25)
      : projectsRepo.listProjects(db, guildId, { status: 'all', limit: 25 });

    await interaction.respond(matches
      .filter((project) => project.client_id)
      .slice(0, 25)
      .map((project) => ({ name: `${project.code} · ${project.name} · ${project.status}`.slice(0, 100), value: project.code })));
  },

  async execute(interaction) {
    const { db, guildId, config, departments, actor } = contextFor(interaction);
    const sub = interaction.options.getSubcommand();
    const userId = interaction.user.id;

    assertCan(actor, CAPABILITIES.PROJECT_CREATE);

    if (sub === 'from') {
      const source = projectsRepo.getProjectByCode(db, guildId, interaction.options.getString('project', true));
      if (!source) {
        await interaction.reply(priv('❌ No project with that code.'));
        return;
      }
      if (!source.client_id) {
        await interaction.reply(priv(
          `❌ **${source.code}** is not linked to a client, so there is nobody to repeat it for. ` +
          'Link it with `/clients link` first.'
        ));
        return;
      }

      const tasks = tasksRepo.listTasksForProject(db, source.id);
      const draft = clientRecordsRepo.draftFromProject(db, guildId, source, tasks, {
        name: interaction.options.getString('name'),
      }, userId);

      const summary = repeatOrders.summarise(db, guildId, draft);
      await interaction.reply(priv({
        content:
          'Copied the shape of that order. **Last time\'s price and deadline were not carried over** — ' +
          'those are this order\'s to agree.',
        embeds: [draftEmbed(db, guildId, summary, departments)],
      }));
      return;
    }

    if (sub === 'list') {
      const drafts = clientRecordsRepo.listDrafts(db, guildId);
      await interaction.reply(priv({
        embeds: [new EmbedBuilder()
          .setTitle('Repeat order drafts')
          .setColor(0x5865f2)
          .setDescription(drafts.map((draft) => {
            const client = clientsRepo.getClient(db, guildId, draft.client_id);
            const missing = clientRecordsRepo.outstandingConfirmations(draft);
            return `**#${draft.id}** ${draft.name} — ${client?.display_name || 'unknown client'}\n` +
              `┗ ${missing.length === 0 ? '✅ ready to create' : `still to confirm: ${missing.join(', ')}`}`;
          }).join('\n').slice(0, 4000) || '_No drafts. Start one with `/reorder from project:<code>`._')],
      }));
      return;
    }

    const id = interaction.options.getInteger('id', true);
    const draft = clientRecordsRepo.getDraft(db, guildId, id);
    if (!draft) {
      await interaction.reply(priv('❌ No draft with that number.'));
      return;
    }

    if (sub === 'show') {
      await interaction.reply(priv({ embeds: [draftEmbed(db, guildId, repeatOrders.summarise(db, guildId, draft), departments)] }));
      return;
    }

    if (draft.status !== clientRecordsRepo.DRAFT_STATES.DRAFT && sub !== 'show') {
      await interaction.reply(priv(
        draft.status === 'confirmed'
          ? `**#${draft.id}** already became an order${draft.project_id ? ` (project ${projectsRepo.getProject(db, guildId, draft.project_id)?.code})` : ''}.`
          : `**#${draft.id}** was discarded.`
      ));
      return;
    }

    if (sub === 'discard') {
      clientRecordsRepo.discardDraft(db, guildId, draft.id, userId);
      await interaction.reply(priv(`✅ Draft **#${draft.id}** discarded. Nothing was created.`));
      return;
    }

    if (sub === 'scope') {
      const spec = interaction.options.getString('spec');
      const warnings = [];
      let items = clientRecordsRepo.draftItems(draft);

      if (spec) {
        const parsed = parseBulkSpec(spec, departments);
        if (parsed.items.length === 0) {
          await interaction.reply(priv(
            `❌ Nothing could be read from that.\n${parsed.errors.map((error) => `• ${error}`).join('\n')}\n\n` +
            `Departments available: ${departments.map((dept) => `\`${dept.key}\``).join(', ')}`
          ));
          return;
        }

        // A rewritten scope is a new list of items, titled the same way bulk
        // orders are so "Model 3/12" reads the same wherever it appears.
        items = parsed.items.flatMap((item) =>
          taskTitlesFor(item).map((title) => ({
            title,
            department_id: item.department.id,
            brief: null,
            deliverables_json: item.department.checklist_json,
            formats: null,
            tech_requirements: null,
            revision_rounds: null,
          }))
        );

        // Partial reads are reported rather than silently dropped.
        if (parsed.errors.length > 0) {
          warnings.push(`⚠️ Left out because it could not be read:\n${parsed.errors.map((e) => `• ${e}`).join('\n')}`);
        }
      }

      if (items.length === 0) {
        await interaction.reply(priv('❌ An order with nothing in it cannot be confirmed. Give a scope with `spec:`.'));
        return;
      }

      const updated = clientRecordsRepo.confirmScope(db, guildId, draft.id, { items, actorUserId: userId });
      await interaction.reply(priv({
        content: [`✅ Scope confirmed: ${items.length} item(s).`, ...warnings].join('\n'),
        embeds: [draftEmbed(db, guildId, repeatOrders.summarise(db, guildId, updated), departments)],
      }));
      return;
    }

    if (sub === 'price') {
      const currency = interaction.options.getString('currency') || config.default_currency;
      if (!isSupportedCurrency(currency)) {
        await interaction.reply(priv(`❌ Unsupported currency \`${currency}\`.`));
        return;
      }

      const amountMinor = parseAmount(interaction.options.getString('amount', true), currency);
      const updated = clientRecordsRepo.confirmPrice(db, guildId, draft.id, { amountMinor, currency, actorUserId: userId });

      await interaction.reply(priv({
        content: `✅ Price confirmed at **${formatAmount(amountMinor, currency)}** for this order.`,
        embeds: [draftEmbed(db, guildId, repeatOrders.summarise(db, guildId, updated), departments)],
      }));
      return;
    }

    if (sub === 'deadline') {
      const timezone = staffRepo.getStaff(db, guildId, userId)?.timezone || 'UTC';
      const parsed = parseDeadlineInput(interaction.options.getString('date', true), timezone);

      if (!parsed.ok) {
        await interaction.reply(priv(
          parsed.reason === 'nonexistent_local_time'
            ? `❌ That local time does not exist in \`${timezone}\` because the clocks skip it. Pick another.`
            : '❌ Could not read that date. Use `YYYY-MM-DD` or `YYYY-MM-DD HH:MM` (24-hour).'
        ));
        return;
      }

      const updated = clientRecordsRepo.confirmDeadline(db, guildId, draft.id, {
        deadlineUtc: parsed.utcMs, actorUserId: userId,
      });

      await interaction.reply(priv({
        content: `✅ Deadline confirmed: **${parsed.preview}**${parsed.impliedEndOfDay ? ' (end of day)' : ''}.`,
        embeds: [draftEmbed(db, guildId, repeatOrders.summarise(db, guildId, updated), departments)],
      }));
      return;
    }

    if (sub === 'create') {
      const channel = interaction.options.getChannel('channel');
      const result = repeatOrders.materialise(db, guildId, draft.id, {
        actorUserId: userId,
        clientChannelId: channel ? channel.id : null,
      });

      if (!result.ok) {
        const reasons = {
          unconfirmed: `❌ Still to confirm: **${(result.missing || []).join(', ')}**. Each one is a decision about this order, not last one's.`,
          no_items: '❌ There is nothing in this draft. Confirm a scope first.',
          already_decided: '❌ That draft has already been decided.',
        };
        await interaction.reply(priv(reasons[result.reason] || `❌ ${result.reason}`));
        return;
      }

      const requirements = clientRecordsRepo.listRequirements(db, guildId, result.project.client_id);
      await interaction.reply(priv([
        `✅ **${result.project.code} · ${result.project.name}** created with ${result.tasks.length} task(s).`,
        `Client payment recorded as **${formatAmount(result.project.client_amount_minor, result.project.client_currency)}**, due ${discordTimestamp(result.project.deadline_utc, 'D')}.`,
        'No pay is set on any task yet — that is still yours to agree per item.',
        requirements.length > 0
          ? `\n📌 This client's standing requirements (${requirements.length}) apply: \`/clients requirements client:${result.project.client_id}\`.`
          : null,
        channel ? `\nTheir dashboard can go in <#${channel.id}> — \`/clients dashboard project:${result.project.code}\`.` : null,
      ].filter(Boolean).join('\n')));
    }
  },
};
