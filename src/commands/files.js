const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const assetsRepo = require('../db/repos/assets');
const projectsRepo = require('../db/repos/projects');
const configRepo = require('../db/repos/config');
const { contextFor } = require('../services/actor');
const { CAPABILITIES, assertCan, can, PermissionError } = require('../domain/permissions');
const { parseDeadlineInput, discordTimestamp } = require('../utils/time');
const { priv } = require('../utils/reply');
const staffRepo = require('../db/repos/staff');

function rightsBadge(rights) {
  if (!rights.recorded) return '⚪ no permission recorded';
  const parts = [];
  if (rights.staffAllowed) parts.push('staff');
  if (rights.studioAllowed) parts.push('studio');
  if (parts.length === 0) return '🔴 portfolio use refused';

  const who = parts.join(' + ');
  if (!rights.started) return `🟡 ${who}, from ${discordTimestamp(rights.fromUtc, 'd')}`;
  return `🟢 ${who}`;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('files')
    .setDescription('Search past work and manage portfolio permission')
    .addSubcommand((sub) =>
      sub
        .setName('search')
        .setDescription('Find files across past work')
        .addStringOption((opt) => opt.setName('query').setDescription('Text in the file, label or task title').setRequired(false))
        .addStringOption((opt) => opt.setName('project').setDescription('Limit to one project').setRequired(false).setAutocomplete(true))
        .addUserOption((opt) => opt.setName('artist').setDescription('Limit to one artist').setRequired(false))
        .addStringOption((opt) => opt.setName('type').setDescription('Asset type, e.g. modelling').setRequired(false).setAutocomplete(true))
        .addStringOption((opt) =>
          opt.setName('kind').setDescription('Which files').setRequired(false).addChoices(
            { name: 'Deliverables', value: 'deliverable' },
            { name: 'Source / working files', value: 'source' },
            { name: 'Previews', value: 'preview' }
          )
        )
        .addStringOption((opt) =>
          opt.setName('portfolio').setDescription('Filter by portfolio permission').setRequired(false).addChoices(
            { name: 'Usable in a staff portfolio now', value: 'staff' },
            { name: 'Usable in the studio portfolio now', value: 'studio' },
            { name: 'No permission recorded', value: 'none' },
            { name: 'Permitted but not started yet', value: 'pending' }
          )
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('rights')
        .setDescription('Record what the client allows for portfolio use')
        .addStringOption((opt) => opt.setName('project').setDescription('Project code').setRequired(true).setAutocomplete(true))
        .addBooleanOption((opt) => opt.setName('staff').setDescription('Artists may show this in their own portfolios').setRequired(true))
        .addBooleanOption((opt) => opt.setName('studio').setDescription('The studio may show it publicly').setRequired(true))
        .addStringOption((opt) => opt.setName('from').setDescription('Permission starts on YYYY-MM-DD (e.g. after the game releases)').setRequired(false))
        .addStringOption((opt) => opt.setName('restrictions').setDescription('Any client restriction, in their words').setRequired(false))
    )
    .addSubcommand((sub) =>
      sub
        .setName('asset-rights')
        .setDescription('Override portfolio permission for one file')
        .addIntegerOption((opt) => opt.setName('asset').setDescription('Asset id from /files search').setRequired(true))
        .addBooleanOption((opt) => opt.setName('staff').setDescription('Artists may show it').setRequired(true))
        .addBooleanOption((opt) => opt.setName('studio').setDescription('The studio may show it').setRequired(true))
        .addStringOption((opt) => opt.setName('from').setDescription('Permission starts on YYYY-MM-DD').setRequired(false))
        .addStringOption((opt) => opt.setName('restrictions').setDescription('Restriction for this file').setRequired(false))
    )
    .addSubcommand((sub) =>
      sub
        .setName('portfolio')
        .setDescription('What the studio may publish right now')
    )
    .addSubcommand((sub) =>
      sub
        .setName('roblox-id')
        .setDescription('Record the Roblox asset ID a file was uploaded as')
        .addIntegerOption((opt) => opt.setName('asset').setDescription('Asset id from /files search').setRequired(true))
        .addStringOption((opt) => opt.setName('id').setDescription('The Roblox asset ID, or a link containing it').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('roblox-ids')
        .setDescription('Every Roblox asset ID recorded on an order')
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

    if (focused.name === 'type') {
      const lower = query.toLowerCase();
      const matches = configRepo.listDepartments(db, guildId, { includeArchived: true })
        .filter((dept) => dept.key.includes(lower))
        .slice(0, 25);
      await interaction.respond(matches.map((dept) => ({ name: dept.name, value: dept.key })));
    }
  },

  async execute(interaction) {
    const { db, guildId, actor } = contextFor(interaction);
    const sub = interaction.options.getSubcommand();
    const userId = interaction.user.id;

    if (sub === 'search') {
      const kind = interaction.options.getString('kind');

      // Source files are the studio's working material, not general reading.
      const isManager = actor.isOwner || can(actor, CAPABILITIES.PROJECT_EDIT);
      if (kind === 'source' && !isManager && actor.leadDepartmentIds.length === 0) {
        throw new PermissionError('archive.source', 'Source files are visible to leaders and managers only.');
      }

      const projectCode = interaction.options.getString('project');
      const project = projectCode ? projectsRepo.getProjectByCode(db, guildId, projectCode) : null;
      if (projectCode && !project) {
        await interaction.reply(priv('❌ No project with that code.'));
        return;
      }

      const results = assetsRepo.search(db, guildId, {
        projectId: project?.id ?? null,
        artistUserId: interaction.options.getUser('artist')?.id ?? null,
        assetType: interaction.options.getString('type'),
        kind,
        query: interaction.options.getString('query'),
        portfolio: interaction.options.getString('portfolio'),
        limit: 25,
      });

      // An artist who is not a leader sees only their own work.
      const visible = isManager || actor.leadDepartmentIds.length > 0
        ? results
        : results.filter((row) => row.artist_user_id === userId);

      if (visible.length === 0) {
        await interaction.reply(priv('Nothing in the archive matches that.'));
        return;
      }

      await interaction.reply(priv({
        embeds: [new EmbedBuilder()
          .setTitle(`Archive · ${visible.length} result(s)`)
          .setColor(0x5865f2)
          .setDescription(visible.map((row) =>
            `**#${row.id}** ${row.task_code || '—'} · ${row.task_title || 'unknown item'} · v${row.version ?? '?'}\n` +
            `┗ ${row.kind}${row.asset_type ? ` · ${row.asset_type}` : ''} · ${rightsBadge(row.rights)}\n` +
            `┗ ${row.url.slice(0, 120)}`
          ).join('\n').slice(0, 4000))
          .setFooter({ text: 'Portfolio permission is never assumed: no record means nobody may show it.' })],
      }));
      return;
    }

    if (sub === 'portfolio') {
      const publishable = assetsRepo.publishablePortfolio(db, guildId, { limit: 50 });

      await interaction.reply(priv({
        embeds: [new EmbedBuilder()
          .setTitle('Publishable in the studio portfolio')
          .setColor(0x57f287)
          .setDescription(publishable.length === 0
            ? 'Nothing yet. Work becomes publishable once a client\'s permission is recorded with `/files rights` and any start date has passed.'
            : publishable.map((row) =>
                `**${row.project_code}** ${row.task_title} · ${row.asset_type || 'file'}` +
                `${row.rights.restrictions ? `\n┗ ⚠️ ${row.rights.restrictions}` : ''}`
              ).join('\n').slice(0, 4000))
          .setFooter({ text: 'This is the only list the public website may draw from.' })],
      }));
      return;
    }

    if (sub === 'roblox-ids') {
      const project = projectsRepo.getProjectByCode(db, guildId, interaction.options.getString('project', true));
      if (!project) {
        await interaction.reply(priv('❌ No order with that code.'));
        return;
      }

      const uploaded = assetsRepo.robloxAssetsForProject(db, guildId, project.id);

      await interaction.reply(priv({
        embeds: [new EmbedBuilder()
          .setTitle(`Roblox asset IDs · ${project.code}`)
          .setColor(0x5865f2)
          .setDescription(
            uploaded.length === 0
              ? 'No Roblox asset IDs recorded on this order yet.\n\n' +
                '_Record one with `/files roblox-id` after a file is uploaded. ' +
                'The ID is what a script needs and what stays findable when the original file does not._'
              : uploaded.map((asset) =>
                `**${asset.roblox_asset_id}** — ${asset.label || asset.task_title || 'unnamed file'}` +
                `${asset.task_code ? `\n┗ ${asset.task_code}` : ''}` +
                `${asset.asset_type ? ` · ${asset.asset_type}` : ''}`
              ).join('\n\n').slice(0, 4000)
          )],
      }));
      return;
    }

    // Recording what a client permits is a commitment about their property.
    assertCan(actor, CAPABILITIES.PROJECT_EDIT);

    if (sub === 'rights') {
      const project = projectsRepo.getProjectByCode(db, guildId, interaction.options.getString('project', true));
      if (!project) {
        await interaction.reply(priv('❌ No project with that code.'));
        return;
      }

      let fromUtc = null;
      const fromText = interaction.options.getString('from');
      if (fromText) {
        const timezone = staffRepo.getStaff(db, guildId, userId)?.timezone;
        if (!timezone) {
          await interaction.reply(priv('❌ Set your timezone with `/profile timezone` so the start date is read correctly.'));
          return;
        }
        const parsed = parseDeadlineInput(fromText, timezone);
        if (!parsed.ok) {
          await interaction.reply(priv(`❌ Could not read "${fromText}" as a date. Use YYYY-MM-DD.`));
          return;
        }
        fromUtc = parsed.utcMs;
      }

      const staffAllowed = interaction.options.getBoolean('staff', true);
      const studioAllowed = interaction.options.getBoolean('studio', true);
      const restrictions = interaction.options.getString('restrictions');

      assetsRepo.setProjectRights(db, guildId, project.id, {
        staffAllowed, studioAllowed, fromUtc, restrictions, actorUserId: userId,
      });

      const summary = assetsRepo.rightsSummary(db, guildId, project.id);
      await interaction.reply(priv([
        `✅ Portfolio permission recorded for **${project.code}**.`,
        `• Artists may show it: **${staffAllowed ? 'yes' : 'no'}**`,
        `• The studio may show it: **${studioAllowed ? 'yes' : 'no'}**`,
        fromUtc ? `• Not before ${discordTimestamp(fromUtc, 'D')}` : '• Effective immediately',
        restrictions ? `• Client restriction: ${restrictions}` : null,
        '',
        `This covers ${summary.total} file(s) on the project. Override any single file with \`/files asset-rights\`.`,
      ].filter(Boolean).join('\n')));
      return;
    }

    if (sub === 'asset-rights') {
      const assetId = interaction.options.getInteger('asset', true);
      const asset = assetsRepo.getAsset(db, guildId, assetId);
      if (!asset) {
        await interaction.reply(priv(`❌ No asset with id ${assetId}.`));
        return;
      }

      let fromUtc = null;
      const fromText = interaction.options.getString('from');
      if (fromText) {
        const timezone = staffRepo.getStaff(db, guildId, userId)?.timezone;
        const parsed = timezone ? parseDeadlineInput(fromText, timezone) : { ok: false };
        if (!parsed.ok) {
          await interaction.reply(priv('❌ Could not read that date. Use YYYY-MM-DD, and set your timezone first.'));
          return;
        }
        fromUtc = parsed.utcMs;
      }

      const updated = assetsRepo.setAssetRights(db, guildId, assetId, {
        staffAllowed: interaction.options.getBoolean('staff', true),
        studioAllowed: interaction.options.getBoolean('studio', true),
        fromUtc,
        restrictions: interaction.options.getString('restrictions'),
        actorUserId: userId,
      });

      const project = projectsRepo.getProject(db, guildId, updated.project_id);
      const rights = assetsRepo.resolvePortfolioRights(updated, project);

      await interaction.reply(priv(
        `✅ Asset #${assetId} now overrides its project: ${rightsBadge(rights)}.` +
        `${rights.restrictions ? `\nRestriction: ${rights.restrictions}` : ''}`
      ));
      return;
    }

    if (sub === 'roblox-id') {
      const assetId = interaction.options.getInteger('asset', true);
      const result = assetsRepo.setRobloxAssetId(db, guildId, assetId, {
        robloxAssetId: interaction.options.getString('id', true),
        actorUserId: userId,
      });

      if (!result.ok) {
        const reasons = {
          not_found: '❌ No file with that number. Find it with `/files search`.',
          not_an_id: '❌ I could not find a Roblox asset ID in that. Paste the ID itself, ' +
            'or a link with the ID in it — it is the long run of digits.',
        };
        await interaction.reply(priv(reasons[result.reason] || `❌ ${result.reason}`));
        return;
      }

      await interaction.reply(priv(
        `✅ File #${assetId} is recorded as Roblox asset **${result.asset.roblox_asset_id}**.` +
        `${result.previous && result.previous !== result.asset.roblox_asset_id
          ? `\n_It was previously recorded as ${result.previous}; the change is in the audit trail._`
          : ''}` +
        '\n\n_The ID is what lasts. A link to the original file can rot; the uploaded asset stays findable._' +
        `\nFind it later with \`/find query:${result.asset.roblox_asset_id}\`.`
      ));
      return;
    }
  },
};
