const { SlashCommandBuilder, EmbedBuilder, ChannelType, PermissionFlagsBits } = require('discord.js');
const clientsRepo = require('../db/repos/clients');
const messageTriggers = require('../services/messageTriggers');
const projectsRepo = require('../db/repos/projects');
const { contextFor } = require('../services/actor');
const clientReport = require('../services/clientReport');
const dashboard = require('../services/clientDashboard');
const { notifyUser } = require('../services/notify');
const { CAPABILITIES, assertCan, can } = require('../domain/permissions');
const { discordTimestamp } = require('../utils/time');
const { priv } = require('../utils/reply');

/**
 * Posts or updates the client's dashboard in their channel.
 *
 * A closed or deleted ticket channel is reported rather than throwing: the
 * studio needs to know the client can no longer be reached there.
 */
async function publishDashboard(interaction, db, guildId, project) {
  const channelId = project.client_channel_id;
  if (!channelId) return { ok: false, reason: 'no_channel' };

  const guild = interaction.guild;
  const channel = guild.channels.cache.get(channelId)
    || await guild.channels.fetch(channelId).catch(() => null);

  if (!channel?.isTextBased?.()) return { ok: false, reason: 'channel_unavailable' };

  const perms = channel.permissionsFor(guild.members.me);
  if (!perms?.has(PermissionFlagsBits.SendMessages) || !perms?.has(PermissionFlagsBits.ViewChannel)) {
    return { ok: false, reason: 'missing_permissions' };
  }

  const report = clientReport.buildProjectReport(db, guildId, project);
  const payload = {
    embeds: [dashboard.dashboardEmbed(report)],
    components: dashboard.dashboardComponents(project.id, {
      hasPreviews: report.previews.length > 0,
      canApprove: true,
      hasDelivered: report.counts[clientReport.BUCKETS.APPROVED_BY_YOU] + report.counts[clientReport.BUCKETS.DELIVERED] > 0,
    }),
  };

  if (project.dashboard_message_id) {
    const existing = await channel.messages.fetch(project.dashboard_message_id).catch(() => null);
    if (existing) {
      await existing.edit(payload).catch(() => null);
      return { ok: true, updated: true, channelId };
    }
  }

  const sent = await channel.send(payload).catch(() => null);
  if (!sent) return { ok: false, reason: 'send_failed' };

  clientsRepo.setDashboardMessage(db, guildId, project.id, sent.id);
  return { ok: true, updated: false, channelId, messageId: sent.id };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('clients')
    .setDescription('Client records, access and their dashboard')
    .addSubcommand((sub) =>
      sub
        .setName('create')
        .setDescription('Create a client record')
        .addStringOption((opt) => opt.setName('name').setDescription('Client or studio name').setRequired(true))
        .addUserOption((opt) => opt.setName('account').setDescription('Their Discord account').setRequired(false))
        .addUserOption((opt) => opt.setName('finder').setDescription('Who introduced this client').setRequired(false))
        .addStringOption((opt) => opt.setName('notes').setDescription('Private notes (never shown to the client)').setRequired(false))
    )
    .addSubcommand((sub) =>
      sub
        .setName('add-account')
        .setDescription('Authorize a Discord account to act for a client')
        .addStringOption((opt) => opt.setName('client').setDescription('Client').setRequired(true).setAutocomplete(true))
        .addUserOption((opt) => opt.setName('account').setDescription('The Discord account').setRequired(true))
        .addBooleanOption((opt) => opt.setName('can_approve').setDescription('May approve work (default yes)').setRequired(false))
        .addStringOption((opt) => opt.setName('label').setDescription('Who they are, e.g. "art director"').setRequired(false))
    )
    .addSubcommand((sub) =>
      sub
        .setName('revoke-account')
        .setDescription("Remove an account's access")
        .addStringOption((opt) => opt.setName('client').setDescription('Client').setRequired(true).setAutocomplete(true))
        .addUserOption((opt) => opt.setName('account').setDescription('The Discord account').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('link')
        .setDescription('Attach a project to a client and their channel')
        .addStringOption((opt) => opt.setName('project').setDescription('Project code').setRequired(true).setAutocomplete(true))
        .addStringOption((opt) => opt.setName('client').setDescription('Client').setRequired(true).setAutocomplete(true))
        .addChannelOption((opt) =>
          opt.setName('channel').setDescription('Their ticket or private channel').addChannelTypes(ChannelType.GuildText).setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('dashboard')
        .setDescription("Post or refresh a project's client dashboard")
        .addStringOption((opt) => opt.setName('project').setDescription('Project code').setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('view')
        .setDescription('A client record, their accounts and order history')
        .addStringOption((opt) => opt.setName('client').setDescription('Client').setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((sub) => sub.setName('list').setDescription('All client records'))
    .addSubcommand((sub) =>
      sub
        .setName('preview')
        .setDescription('See exactly what a client can see on a project')
        .addStringOption((opt) => opt.setName('project').setDescription('Project code').setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('requests')
        .setDescription('Open client requests and questions')
        .addStringOption((opt) =>
          opt.setName('status').setDescription('Which requests').setRequired(false).addChoices(
            { name: 'Open', value: 'open' },
            { name: 'In progress', value: 'in_progress' },
            { name: 'Resolved', value: 'resolved' },
            { name: 'All', value: 'all' }
          )
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('resolve')
        .setDescription('Close a client request with a note')
        .addIntegerOption((opt) => opt.setName('id').setDescription('Request id').setRequired(true))
        .addStringOption((opt) =>
          opt.setName('status').setDescription('Outcome').setRequired(true).addChoices(
            { name: 'Resolved', value: 'resolved' },
            { name: 'Declined', value: 'declined' },
            { name: 'In progress', value: 'in_progress' }
          )
        )
        .addStringOption((opt) => opt.setName('note').setDescription('What was done').setRequired(false))
        .addBooleanOption((opt) => opt.setName('tell_client').setDescription('Send the note to the client channel').setRequired(false))
    )
    .addSubcommand((sub) => sub.setName('duplicates').setDescription('Possible duplicate client records')),

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);
    const { db, guildId } = contextFor(interaction);
    const query = String(focused.value || '');

    if (focused.name === 'client') {
      const matches = query
        ? clientsRepo.searchClients(db, guildId, query, 25)
        : clientsRepo.listClients(db, guildId, { limit: 25 });
      await interaction.respond(matches.map((client) => ({
        name: client.display_name.slice(0, 100),
        value: String(client.id),
      })));
      return;
    }

    if (focused.name === 'project') {
      const matches = query
        ? projectsRepo.searchProjects(db, guildId, query, 25)
        : projectsRepo.listProjects(db, guildId, { status: 'active', limit: 25 });
      await interaction.respond(matches.map((p) => ({ name: `${p.code} · ${p.name}`.slice(0, 100), value: p.code })));
    }
  },

  async execute(interaction) {
    const { db, guildId, actor } = contextFor(interaction);
    const sub = interaction.options.getSubcommand();
    const userId = interaction.user.id;

    // Client records carry contact details and finder arrangements, so they
    // sit behind project management rather than being open to all staff.
    const mayManage = can(actor, CAPABILITIES.PROJECT_EDIT) || actor.isOwner;
    if (!mayManage) assertCan(actor, CAPABILITIES.PROJECT_EDIT);

    if (sub === 'create') {
      const client = clientsRepo.createClient(db, guildId, {
        displayName: interaction.options.getString('name', true),
        notes: interaction.options.getString('notes'),
        finderUserId: interaction.options.getUser('finder')?.id ?? null,
      }, userId);

      const account = interaction.options.getUser('account');
      if (account) {
        clientsRepo.addAccount(db, guildId, client.id, { userId: account.id }, userId);
      }

      await interaction.reply(priv([
        `✅ Created client **${client.display_name}** (id ${client.id}).`,
        account ? `<@${account.id}> can act for them and approve work.` : 'No Discord account linked yet — add one with `/clients add-account`.',
        client.finder_user_id ? `Introduced by <@${client.finder_user_id}>, who takes the finder share on their projects.` : 'No finder recorded, so the finder share stays with you.',
        '',
        `Next: \`/clients link project:<code> client:${client.id} channel:#their-ticket\`.`,
      ].join('\n')));
      return;
    }

    if (sub === 'list') {
      const clients = clientsRepo.listClients(db, guildId, { limit: 25 });
      if (clients.length === 0) {
        await interaction.reply(priv('No client records yet. Create one with `/clients create`.'));
        return;
      }

      await interaction.reply(priv({
        embeds: [new EmbedBuilder()
          .setTitle('Clients')
          .setColor(0x1abc9c)
          .setDescription(clients.map((client) => {
            const accounts = clientsRepo.listAccounts(db, client.id);
            const orders = clientsRepo.clientOrderHistory(db, guildId, client.id);
            return `**${client.display_name}** (id ${client.id}) — ${orders.length} order(s), ${accounts.length} account(s)` +
              `${client.finder_user_id ? ` · found by <@${client.finder_user_id}>` : ''}`;
          }).join('\n').slice(0, 4000))],
      }));
      return;
    }

    if (sub === 'duplicates') {
      const groups = clientsRepo.findPossibleDuplicates(db, guildId);
      await interaction.reply(priv(
        groups.length === 0
          ? '✅ No obviously duplicated client records.'
          : `⚠️ Possible duplicates for review:\n${groups.map((group) =>
              `• ${group.map((client) => `**${client.display_name}** (id ${client.id})`).join(' · ')}`
            ).join('\n')}\n\nThese are flagged only — nothing has been merged.`
      ));
      return;
    }

    if (sub === 'requests') {
      const status = interaction.options.getString('status') || 'open';
      const requests = clientsRepo.listRequests(db, guildId, { status, limit: 20 });

      if (requests.length === 0) {
        await interaction.reply(priv(`No ${status === 'all' ? '' : `${status} `}client requests.`));
        return;
      }

      await interaction.reply(priv({
        embeds: [new EmbedBuilder()
          .setTitle(`Client requests (${status})`)
          .setColor(0xfaa61a)
          .setDescription(requests.map((request) => {
            const project = request.project_id ? projectsRepo.getProject(db, guildId, request.project_id) : null;
            return `**#${request.id}** ${request.kind.replace(/_/g, ' ')} · ${project ? project.code : 'no project'} · ${discordTimestamp(request.created_at, 'R')}\n` +
              `┗ from <@${request.raised_by}>: ${request.body.slice(0, 200)}`;
          }).join('\n').slice(0, 4000))
          .setFooter({ text: 'Close one with /clients resolve id:<number>' })],
      }));
      return;
    }

    if (sub === 'resolve') {
      const id = interaction.options.getInteger('id', true);
      const request = clientsRepo.getRequest(db, guildId, id);
      if (!request) {
        await interaction.reply(priv(`❌ No request with id ${id}.`));
        return;
      }

      const status = interaction.options.getString('status', true);
      const note = interaction.options.getString('note');
      clientsRepo.resolveRequest(db, guildId, id, { status, resolution: note, actorUserId: userId });

      let told = false;
      if (interaction.options.getBoolean('tell_client') && note && request.project_id) {
        const project = projectsRepo.getProject(db, guildId, request.project_id);
        const channel = project?.client_channel_id
          ? await interaction.guild.channels.fetch(project.client_channel_id).catch(() => null)
          : null;
        if (channel?.isTextBased?.()) {
          const sent = await channel.send({
            content: `<@${request.raised_by}> regarding your request: ${note}`,
            allowedMentions: { users: [request.raised_by] },
          }).catch(() => null);
          told = Boolean(sent);
        }
      }

      await interaction.reply(priv(
        `✅ Request #${id} marked **${status.replace(/_/g, ' ')}**.` +
        `${note ? `\nNote recorded: ${note}` : ''}` +
        `${interaction.options.getBoolean('tell_client') ? (told ? '\nThe client was told in their channel.' : '\n⚠️ Could not reach the client channel — tell them another way.') : ''}`
      ));
      return;
    }

    const clientIdOption = interaction.options.getString('client');
    const client = clientIdOption ? clientsRepo.getClient(db, guildId, Number(clientIdOption)) : null;
    if (clientIdOption && !client) {
      await interaction.reply(priv('❌ No client with that id.'));
      return;
    }

    if (sub === 'add-account' || sub === 'revoke-account') {
      const account = interaction.options.getUser('account', true);

      if (sub === 'add-account') {
        clientsRepo.addAccount(db, guildId, client.id, {
          userId: account.id,
          label: interaction.options.getString('label'),
          canApprove: interaction.options.getBoolean('can_approve') ?? true,
        }, userId);

        const canApprove = interaction.options.getBoolean('can_approve') ?? true;
        await interaction.reply(priv(
          `✅ <@${account.id}> can now act for **${client.display_name}**` +
          `${canApprove ? ' and approve work' : ' but cannot approve work'}.\n` +
          'Their access is checked on every button, and only covers this client\'s own projects.'
        ));
        return;
      }

      const removed = clientsRepo.revokeAccount(db, guildId, client.id, account.id, userId);
      await interaction.reply(priv(
        removed
          ? `✅ <@${account.id}> no longer has access to **${client.display_name}**'s projects. Existing approval buttons will refuse them.`
          : 'That account did not have access.'
      ));
      return;
    }

    if (sub === 'view') {
      const accounts = clientsRepo.listAccounts(db, client.id, { includeRevoked: true });
      const orders = clientsRepo.clientOrderHistory(db, guildId, client.id);

      const embed = new EmbedBuilder()
        .setTitle(client.display_name)
        .setColor(0x1abc9c)
        .addFields(
          {
            name: 'Authorized accounts',
            value: accounts.length === 0
              ? '_none_'
              : accounts.map((row) =>
                  `${row.revoked_at ? '🚫' : '✅'} <@${row.user_id}>${row.label ? ` (${row.label})` : ''}` +
                  `${row.can_approve ? '' : ' · view only'}${row.revoked_at ? ` · revoked ${discordTimestamp(row.revoked_at, 'd')}` : ''}`
                ).join('\n').slice(0, 1024),
            inline: false,
          },
          {
            name: `Order history (${orders.length})`,
            value: orders.length === 0
              ? '_no orders yet_'
              : orders.slice(0, 10).map((order) =>
                  `**${order.code}** ${order.name} — ${order.task_count} item(s) · ${order.status}`
                ).join('\n').slice(0, 1024),
            inline: false,
          },
          {
            name: 'Finder',
            value: client.finder_user_id ? `<@${client.finder_user_id}>` : '_none recorded — the finder share stays with you_',
            inline: true,
          },
          {
            name: 'Promotional follow-ups',
            value: client.promo_stopped_at
              ? `stopped ${discordTimestamp(client.promo_stopped_at, 'd')}`
              : client.promo_opt_in ? 'opted in' : 'not opted in',
            inline: true,
          }
        );

      if (client.notes) embed.addFields({ name: 'Private notes', value: client.notes.slice(0, 1024), inline: false });
      if (clientsRepo.hasOpenIssue(db, guildId, client.id)) {
        embed.addFields({ name: '⚠️ Open issue', value: 'Promotional messages are paused for this client.', inline: false });
      }

      await interaction.reply(priv({ embeds: [embed] }));
      return;
    }

    const projectCode = interaction.options.getString('project', true);
    const project = projectsRepo.getProjectByCode(db, guildId, projectCode);
    if (!project) {
      await interaction.reply(priv(`❌ No project with code \`${projectCode}\`.`));
      return;
    }

    if (sub === 'link') {
      const channel = interaction.options.getChannel('channel');
      clientsRepo.linkProject(db, guildId, project.id, client.id, userId, {
        clientChannelId: channel ? channel.id : undefined,
      });

      // This is the first moment there is somebody to write to about the
      // order, so it is where the confirmation message is raised.
      const confirmation = messageTriggers.orderConfirmed(
        db, guildId, projectsRepo.getProject(db, guildId, project.id), { queuedBy: userId }
      );

      const accounts = clientsRepo.listAccounts(db, client.id);
      await interaction.reply(priv([
        `✅ **${project.code}** is now ${client.display_name}'s order.`,
        confirmation.ok && confirmation.created
          ? '📨 Your approved confirmation message is queued for their channel.'
          : null,
        channel ? `Their channel: <#${channel.id}>.` : 'No client channel set — add one to post their dashboard there.',
        accounts.length === 0
          ? '⚠️ This client has no authorized Discord accounts yet, so nobody can open the dashboard. Add one with `/clients add-account`.'
          : `${accounts.length} account(s) can open the dashboard.`,
        channel ? `\nPost it with \`/clients dashboard project:${project.code}\`.` : '',
      ].filter(Boolean).join('\n')));
      return;
    }

    if (sub === 'dashboard') {
      const fresh = projectsRepo.getProject(db, guildId, project.id);
      if (!fresh.client_id) {
        await interaction.reply(priv(`❌ **${project.code}** is not linked to a client. Use \`/clients link\` first.`));
        return;
      }

      await interaction.deferReply(priv({}));
      const result = await publishDashboard(interaction, db, guildId, fresh);

      const reasons = {
        no_channel: 'no client channel is set on this project',
        channel_unavailable: 'the client channel no longer exists or I cannot see it — the ticket may have been closed',
        missing_permissions: 'I cannot post in the client channel',
        send_failed: 'the message could not be sent',
      };

      await interaction.editReply(
        result.ok
          ? `✅ Dashboard ${result.updated ? 'updated' : 'posted'} in <#${result.channelId}>.`
          : `❌ Could not post it: ${reasons[result.reason] || result.reason}.`
      );
      return;
    }

    if (sub === 'preview') {
      // Shows staff the client's exact view, so what clients can see is
      // verifiable rather than assumed.
      const report = clientReport.buildProjectReport(db, guildId, project);
      await interaction.reply(priv({
        content:
          '**This is precisely what the client sees.** No artist names, no pay, no internal notes.\n' +
          `Authorized accounts: ${project.client_id ? clientsRepo.listAccounts(db, project.client_id).map((row) => `<@${row.user_id}>`).join(', ') || 'none' : 'no client linked'}`,
        embeds: [dashboard.dashboardEmbed(report)],
      }));
    }
  },
};

module.exports.publishDashboard = publishDashboard;
