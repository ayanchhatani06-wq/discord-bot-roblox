const { SlashCommandBuilder, ChannelType, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const configRepo = require('../db/repos/config');
const { contextFor } = require('../services/actor');
const { refreshGuildBoards } = require('../services/staffBoard');
const boardScheduler = require('../services/boardScheduler');
const { buildPanel: buildSetupPanel } = require('../interactions/setup');
const { createSampleProject, listSampleProjects, removeSampleData } = require('../services/sampleData');
const { CAPABILITIES, ALL_CAPABILITIES, assertCan, canClaimStudio } = require('../domain/permissions');
const { RECIPIENT_KINDS } = require('../domain/allocations');
const { CURRENCIES } = require('../domain/money');
const { parseClockInput, formatClockMinutes } = require('../utils/time');
const { priv } = require('../utils/reply');

const CHANNEL_TARGETS = {
  board: { column: 'staff_board_channel_id', label: 'staff info board' },
  audit: { column: 'audit_log_channel_id', label: 'audit log' },
  fallback: { column: 'fallback_channel_id', label: 'DM fallback' },
  summary: { column: 'summary_channel_id', label: 'weekly summary' },
  enquiry: { column: 'enquiry_channel_id', label: 'new quote request' },
};

function percentToBp(percent) {
  const bp = Math.round(Number(percent) * 100);
  if (!Number.isFinite(bp) || bp < 0) throw new Error(`Invalid percentage: ${percent}`);
  return bp;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('studio')
    .setDescription('Configure the studio bot (owner only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub.setName('setup').setDescription('First-run setup: claim ownership and create the default departments')
    )
    .addSubcommand((sub) => sub.setName('status').setDescription('Show the current configuration'))
    .addSubcommand((sub) => sub.setName('doctor').setDescription('Find what is quietly misconfigured or stuck'))
    .addSubcommand((sub) =>
      sub
        .setName('channel')
        .setDescription('Set one of the bot channels')
        .addStringOption((opt) =>
          opt.setName('purpose').setDescription('Which channel to set').setRequired(true).addChoices(
            { name: 'Staff info board', value: 'board' },
            { name: 'Audit log', value: 'audit' },
            { name: 'DM fallback (private staff channel)', value: 'fallback' },
            { name: 'Weekly management summary', value: 'summary' },
            { name: 'New quote requests from the website', value: 'enquiry' }
          )
        )
        .addChannelOption((opt) =>
          opt.setName('channel').setDescription('The channel').addChannelTypes(ChannelType.GuildText).setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('roles')
        .setDescription('Set the owner and manager roles')
        .addRoleOption((opt) => opt.setName('owner').setDescription('Role with full owner authority').setRequired(false))
        .addRoleOption((opt) => opt.setName('manager').setDescription('Role allowed to create projects and tasks').setRequired(false))
    )
    .addSubcommand((sub) =>
      sub
        .setName('department')
        .setDescription('Create or update a department and its role mapping')
        .addStringOption((opt) => opt.setName('key').setDescription('Short key, e.g. modelling').setRequired(true).setAutocomplete(true))
        .addStringOption((opt) => opt.setName('name').setDescription('Display name').setRequired(false))
        .addRoleOption((opt) => opt.setName('leader_role').setDescription('Role held by this department\'s group leader').setRequired(false))
        .addRoleOption((opt) => opt.setName('member_role').setDescription('Role held by this department\'s artists').setRequired(false))
        .addIntegerOption((opt) => opt.setName('task_cap').setDescription('Suggested max concurrent tasks per artist').setMinValue(1).setRequired(false))
        .addStringOption((opt) => opt.setName('checklist').setDescription('Deliverables, comma separated').setRequired(false))
    )
    .addSubcommand((sub) => sub.setName('departments').setDescription('List departments and their role mappings'))
    .addSubcommand((sub) =>
      sub
        .setName('splits')
        .setDescription('Set how the leftover pool is divided (must total 100%)')
        .addNumberOption((opt) => opt.setName('finder').setDescription('Client finder %').setRequired(true).setMinValue(0).setMaxValue(100))
        .addNumberOption((opt) => opt.setName('leader').setDescription('Group leader %').setRequired(true).setMinValue(0).setMaxValue(100))
        .addNumberOption((opt) => opt.setName('mod').setDescription('Mod %').setRequired(true).setMinValue(0).setMaxValue(100))
        .addNumberOption((opt) => opt.setName('owner').setDescription('Owner %').setRequired(true).setMinValue(0).setMaxValue(100))
    )
    .addSubcommand((sub) =>
      sub
        .setName('reminders')
        .setDescription('Reminder timings and studio-wide quiet hours')
        .addIntegerOption((opt) => opt.setName('board_refresh_minutes').setDescription('How often boards refresh').setMinValue(1).setMaxValue(60).setRequired(false))
        .addIntegerOption((opt) => opt.setName('offer_reminder_hours').setDescription('Chase an unanswered offer after N hours').setMinValue(1).setRequired(false))
        .addIntegerOption((opt) => opt.setName('stale_progress_days').setDescription('Nudge after N days without an update').setMinValue(1).setRequired(false))
        .addIntegerOption((opt) => opt.setName('deadline_warning_hours').setDescription('Warn N hours before a deadline').setMinValue(1).setRequired(false))
        .addStringOption((opt) => opt.setName('quiet_start').setDescription('Default quiet hours start, HH:MM').setRequired(false))
        .addStringOption((opt) => opt.setName('quiet_end').setDescription('Default quiet hours end, HH:MM').setRequired(false))
    )
    .addSubcommand((sub) =>
      sub
        .setName('currency')
        .setDescription('Set the default currency for new projects')
        .addStringOption((opt) =>
          opt.setName('currency').setDescription('Default currency').setRequired(true)
            .addChoices(...Object.keys(CURRENCIES).map((code) => ({ name: code, value: code })))
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('capability')
        .setDescription('Grant or revoke a capability for a role')
        .addStringOption((opt) =>
          opt.setName('mode').setDescription('Grant or revoke').setRequired(true)
            .addChoices({ name: 'Grant', value: 'grant' }, { name: 'Revoke', value: 'revoke' })
        )
        .addRoleOption((opt) => opt.setName('role').setDescription('The role').setRequired(true))
        .addStringOption((opt) => opt.setName('capability').setDescription('Which capability').setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((sub) => sub.setName('capabilities').setDescription('Show which roles hold which capabilities'))
    .addSubcommand((sub) => sub.setName('refresh').setDescription('Rebuild the staff boards now'))
    .addSubcommand((sub) =>
      sub
        .setName('sample')
        .setDescription('Create or remove a demonstration project showing the whole workflow')
        .addStringOption((opt) =>
          opt.setName('action').setDescription('Create or remove').setRequired(true).addChoices(
            { name: 'Create sample project', value: 'create' },
            { name: 'Remove sample data', value: 'remove' }
          )
        )
        .addUserOption((opt) => opt.setName('leader').setDescription('Stand-in group leader (defaults to you)').setRequired(false))
        .addUserOption((opt) => opt.setName('artist').setDescription('Stand-in artist (defaults to you)').setRequired(false))
    ),

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);
    const query = String(focused.value || '').toLowerCase();

    if (focused.name === 'capability') {
      await interaction.respond(
        ALL_CAPABILITIES.filter((cap) => cap.includes(query)).slice(0, 25).map((cap) => ({ name: cap, value: cap }))
      );
      return;
    }

    if (focused.name === 'key') {
      const { db, guildId } = contextFor(interaction);
      const existing = configRepo.listDepartments(db, guildId, { includeArchived: true })
        .filter((dept) => dept.key.includes(query))
        .slice(0, 25);
      await interaction.respond(existing.map((dept) => ({ name: `${dept.name} (${dept.key})`, value: dept.key })));
    }
  },

  async execute(interaction) {
    const ctx = contextFor(interaction);
    const { db, guildId, config, actor } = ctx;
    const sub = interaction.options.getSubcommand();
    const userId = interaction.user.id;

    // First run: nobody holds config.manage yet, so somebody has to be able to
    // claim the bot or setup could never happen at all.
    //
    // The Discord server owner always can. So can anybody Discord already
    // trusts to manage the server, but only while the bot is unclaimed — a
    // studio whose server was created by somebody else (a founder who is not
    // the guild owner) would otherwise be locked out of its own bot forever.
    // Once an owner is recorded, that door closes and the normal rules apply.
    if (sub === 'doctor') {
      assertCan(actor, CAPABILITIES.SUMMARY_VIEW);

      const doctor = require('../services/doctor');
      const result = doctor.diagnose(db, guildId);

      if (result.findings.length === 0) {
        await interaction.reply(priv({
          embeds: [new EmbedBuilder()
            .setTitle('Nothing quietly broken')
            .setColor(0x57f287)
            .setDescription(
              'Owner set, channels configured, departments staffed, clients able to reach their orders.\n\n' +
              'This checks the things that fail without an error message. It cannot tell you whether the work is going well.'
            )],
        }));
        return;
      }

      const ICONS = { breaks: '🔴', risky: '🟡', note: '⚪' };
      const HEADINGS = {
        breaks: 'Will silently not work',
        risky: 'Works until it does not',
        note: 'Worth knowing',
      };

      const embed = new EmbedBuilder()
        .setTitle('Studio check')
        .setColor(result.breaks > 0 ? 0xed4245 : result.risky > 0 ? 0xfaa61a : 0x5865f2)
        .setDescription(
          `${result.breaks} thing(s) will silently not work, ` +
          `${result.risky} may bite later, ${result.notes} worth knowing.`
        );

      for (const severity of doctor.ORDER) {
        const group = result.findings.filter((item) => item.severity === severity);
        if (group.length === 0) continue;

        embed.addFields({
          name: `${ICONS[severity]} ${HEADINGS[severity]} (${group.length})`,
          value: group.map((item) =>
            `**${item.title}**\n${item.detail}${item.fix ? `\n┗ ${item.fix}` : ''}`
          ).join('\n\n').slice(0, 1024),
          inline: false,
        });
      }

      await interaction.reply(priv({ embeds: [embed] }));
      return;
    }

    if (sub === 'setup') {
      const mayClaim = canClaimStudio({
        userId,
        guildOwnerId: interaction.guild?.ownerId ?? null,
        managesServer: interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false,
        config,
        roleIds: ctx.roleIds,
      });

      if (!mayClaim) {
        assertCan(actor, CAPABILITIES.CONFIG_MANAGE);
      }

      if (!config.owner_user_id) {
        configRepo.updateConfig(db, guildId, { owner_user_id: userId }, userId);
      }
      const created = configRepo.seedDefaultDepartments(db, guildId, userId);
      configRepo.markSetupComplete(db, guildId, userId);

      // The wizard panel carries the remaining steps as controls, so nothing
      // below needs to be typed from memory.
      const panel = buildSetupPanel(db, guildId);
      await interaction.reply(priv({
        content:
          '✅ You are recorded as the studio owner.\n' +
          `${created.length > 0 ? `Created ${created.length} departments: ${created.join(', ')}.` : 'Departments already existed, so nothing was created.'}\n` +
          'Work through the checklist below — the controls do each step for you.',
        embeds: [panel.embed],
        components: panel.components,
      }));
      return;
    }

    assertCan(actor, CAPABILITIES.CONFIG_MANAGE);

    if (sub === 'status') {
      const departments = configRepo.listDepartments(db, guildId);
      const splits = configRepo.getAllocationPercentages(db, guildId);
      const mapped = departments.filter((dept) => dept.leader_role_id).length;

      const embed = new EmbedBuilder()
        .setTitle('Studio configuration')
        .setColor(0x5865f2)
        .addFields(
          { name: 'Owner', value: config.owner_user_id ? `<@${config.owner_user_id}>` : '_not set_', inline: true },
          { name: 'Owner role', value: config.owner_role_id ? `<@&${config.owner_role_id}>` : '_not set_', inline: true },
          { name: 'Manager role', value: config.manager_role_id ? `<@&${config.manager_role_id}>` : '_not set_', inline: true },
          {
            name: 'Channels',
            value: Object.entries(CHANNEL_TARGETS)
              .map(([, target]) => `${target.label}: ${config[target.column] ? `<#${config[target.column]}>` : '_not set_'}`)
              .join('\n'),
            inline: false,
          },
          { name: 'Departments', value: `${departments.length} total, ${mapped} with a leader role mapped`, inline: true },
          { name: 'Default currency', value: config.default_currency, inline: true },
          {
            name: 'Pool split',
            value: RECIPIENT_KINDS.map((kind) => `${kind} ${splits[kind] / 100}%`).join(' · '),
            inline: false,
          },
          {
            name: 'Reminders',
            value: [
              `boards every ${config.board_refresh_minutes} min`,
              `offers chased after ${config.offer_reminder_hours}h`,
              `stale after ${config.stale_progress_days}d`,
              `deadline warning ${config.deadline_warning_hours}h`,
              `quiet hours ${config.quiet_start_minute === null ? 'not set' : `${formatClockMinutes(config.quiet_start_minute)}–${formatClockMinutes(config.quiet_end_minute)}`}`,
            ].join('\n'),
            inline: false,
          }
        );

      await interaction.reply(priv({ embeds: [embed] }));
      return;
    }

    if (sub === 'channel') {
      const purpose = interaction.options.getString('purpose', true);
      const channel = interaction.options.getChannel('channel', true);
      const target = CHANNEL_TARGETS[purpose];

      const me = interaction.guild.members.me;
      const perms = channel.permissionsFor(me);
      const missing = [];
      if (!perms?.has(PermissionFlagsBits.ViewChannel)) missing.push('View Channel');
      if (!perms?.has(PermissionFlagsBits.SendMessages)) missing.push('Send Messages');
      if (!perms?.has(PermissionFlagsBits.EmbedLinks)) missing.push('Embed Links');
      if (missing.length > 0) {
        await interaction.reply(priv(`❌ I need these permissions in <#${channel.id}>: ${missing.join(', ')}.`));
        return;
      }

      configRepo.updateConfig(db, guildId, { [target.column]: channel.id }, userId);
      await interaction.reply(priv(`✅ The ${target.label} channel is now <#${channel.id}>.`));

      if (purpose === 'board') {
        boardScheduler.invalidate(guildId);
        refreshGuildBoards(interaction.client, guildId, db)
          .then(() => boardScheduler.markRefreshed(guildId))
          .catch((error) => console.error('Initial board build failed:', error));
      }
      return;
    }

    if (sub === 'roles') {
      const owner = interaction.options.getRole('owner');
      const manager = interaction.options.getRole('manager');
      if (!owner && !manager) {
        await interaction.reply(priv('Give at least one role to set.'));
        return;
      }

      const patch = {};
      if (owner) patch.owner_role_id = owner.id;
      if (manager) patch.manager_role_id = manager.id;
      configRepo.updateConfig(db, guildId, patch, userId);

      await interaction.reply(priv(
        `✅ Updated.${owner ? ` Owner role: <@&${owner.id}>.` : ''}${manager ? ` Manager role: <@&${manager.id}>.` : ''}`
      ));
      return;
    }

    if (sub === 'department') {
      const key = interaction.options.getString('key', true).trim().toLowerCase();
      const checklistText = interaction.options.getString('checklist');
      const leaderRole = interaction.options.getRole('leader_role');
      const memberRole = interaction.options.getRole('member_role');

      const department = configRepo.upsertDepartment(db, guildId, {
        key,
        name: interaction.options.getString('name') ?? undefined,
        leaderRoleId: leaderRole ? leaderRole.id : undefined,
        memberRoleId: memberRole ? memberRole.id : undefined,
        taskCap: interaction.options.getInteger('task_cap') ?? undefined,
        checklist: checklistText
          ? checklistText.split(',').map((item) => item.trim()).filter(Boolean)
          : undefined,
      }, userId);

      await interaction.reply(priv(
        `✅ **${department.name}** (\`${department.key}\`) saved.\n` +
        `Leader role: ${department.leader_role_id ? `<@&${department.leader_role_id}>` : '_not set_'} · ` +
        `Member role: ${department.member_role_id ? `<@&${department.member_role_id}>` : '_not set_'}\n` +
        `Deliverables: ${configRepo.departmentChecklist(department).join(', ') || '_none_'}`
      ));
      boardScheduler.invalidate(guildId);
      return;
    }

    if (sub === 'departments') {
      const departments = configRepo.listDepartments(db, guildId);
      if (departments.length === 0) {
        await interaction.reply(priv('No departments yet. Run `/studio setup` to create the defaults.'));
        return;
      }

      const embed = new EmbedBuilder()
        .setTitle('Departments')
        .setColor(0x5865f2)
        .setDescription(departments.map((dept) =>
          `**${dept.name}** \`${dept.key}\`\n` +
          `┗ leader ${dept.leader_role_id ? `<@&${dept.leader_role_id}>` : '—'} · ` +
          `members ${dept.member_role_id ? `<@&${dept.member_role_id}>` : '—'} · ` +
          `cap ${dept.task_cap ?? '—'}\n` +
          `┗ deliverables: ${configRepo.departmentChecklist(dept).join(', ') || '—'}`
        ).join('\n\n').slice(0, 4000));

      await interaction.reply(priv({ embeds: [embed] }));
      return;
    }

    if (sub === 'splits') {
      const percentages = {
        finder: percentToBp(interaction.options.getNumber('finder', true)),
        leader: percentToBp(interaction.options.getNumber('leader', true)),
        mod: percentToBp(interaction.options.getNumber('mod', true)),
        owner: percentToBp(interaction.options.getNumber('owner', true)),
      };

      // validatePercentages throws with a readable message if these miss 100%.
      const saved = configRepo.setAllocationPercentages(db, guildId, percentages, userId);
      await interaction.reply(priv(
        '✅ Pool split saved: ' + RECIPIENT_KINDS.map((kind) => `${kind} ${saved[kind] / 100}%`).join(' · ') +
        '\nThis applies to what is left of a task\'s client payment after the artist is paid. ' +
        'Shares with nobody to pay them (no mod recorded, no external finder) go to you.'
      ));
      return;
    }

    if (sub === 'reminders') {
      const patch = {};
      for (const [option, column] of [
        ['board_refresh_minutes', 'board_refresh_minutes'],
        ['offer_reminder_hours', 'offer_reminder_hours'],
        ['stale_progress_days', 'stale_progress_days'],
        ['deadline_warning_hours', 'deadline_warning_hours'],
      ]) {
        const value = interaction.options.getInteger(option);
        if (value !== null) patch[column] = value;
      }

      const quietStart = interaction.options.getString('quiet_start');
      const quietEnd = interaction.options.getString('quiet_end');
      for (const [text, column, label] of [
        [quietStart, 'quiet_start_minute', 'quiet_start'],
        [quietEnd, 'quiet_end_minute', 'quiet_end'],
      ]) {
        if (text === null) continue;
        if (text.trim() === '') { patch[column] = null; continue; }
        const minutes = parseClockInput(text);
        if (minutes === null) {
          await interaction.reply(priv(`❌ \`${label}\` should be 24-hour HH:MM, e.g. 22:00.`));
          return;
        }
        patch[column] = minutes;
      }

      if (Object.keys(patch).length === 0) {
        await interaction.reply(priv('Nothing to change.'));
        return;
      }

      const saved = configRepo.updateConfig(db, guildId, patch, userId);
      await interaction.reply(priv(
        '✅ Saved. Boards every ' + saved.board_refresh_minutes + ' min · offers chased after ' +
        saved.offer_reminder_hours + 'h · stale after ' + saved.stale_progress_days + 'd · deadline warning ' +
        saved.deadline_warning_hours + 'h · quiet hours ' +
        (saved.quiet_start_minute === null ? 'not set' : `${formatClockMinutes(saved.quiet_start_minute)}–${formatClockMinutes(saved.quiet_end_minute)}`) +
        '.\nStaff can set their own quiet hours, which take priority over this default.'
      ));
      return;
    }

    if (sub === 'currency') {
      const currency = interaction.options.getString('currency', true);
      configRepo.updateConfig(db, guildId, { default_currency: currency }, userId);
      await interaction.reply(priv(
        `✅ New projects default to **${currency}**. Each project and task still records its own currency, ` +
        'and totals are never combined across currencies.'
      ));
      return;
    }

    if (sub === 'capability') {
      const mode = interaction.options.getString('mode', true);
      const role = interaction.options.getRole('role', true);
      const capability = interaction.options.getString('capability', true);

      if (!ALL_CAPABILITIES.includes(capability)) {
        await interaction.reply(priv(`❌ Unknown capability \`${capability}\`.`));
        return;
      }

      if (mode === 'grant') {
        configRepo.grantCapability(db, guildId, role.id, capability, userId);
        await interaction.reply(priv(`✅ <@&${role.id}> now holds \`${capability}\`.`));
      } else {
        const removed = configRepo.revokeCapability(db, guildId, role.id, capability, userId);
        await interaction.reply(priv(
          removed ? `✅ Removed \`${capability}\` from <@&${role.id}>.` : 'That role did not hold that capability.'
        ));
      }
      return;
    }

    if (sub === 'capabilities') {
      const rows = configRepo.listRoleCapabilities(db, guildId);
      const grouped = new Map();
      for (const row of rows) {
        if (!grouped.has(row.role_id)) grouped.set(row.role_id, []);
        grouped.get(row.role_id).push(row.capability);
      }

      const description = grouped.size === 0
        ? 'No extra grants. You hold everything as owner; group leaders run their own departments by default.'
        : [...grouped.entries()].map(([roleId, caps]) => `<@&${roleId}>\n┗ ${caps.sort().join(', ')}`).join('\n\n');

      await interaction.reply(priv({
        embeds: [new EmbedBuilder().setTitle('Role capabilities').setColor(0x5865f2).setDescription(description.slice(0, 4000))],
      }));
      return;
    }

    if (sub === 'refresh') {
      await interaction.deferReply(priv({}));
      const result = await refreshGuildBoards(interaction.client, guildId, db);
      boardScheduler.markRefreshed(guildId);
      await interaction.editReply(
        result.skipped
          ? `❌ Could not refresh: ${result.skipped.replace(/_/g, ' ')}.`
          : `✅ Rebuilt ${result.posted} board message(s).`
      );
      return;
    }

    if (sub === 'sample') {
      const mode = interaction.options.getString('action', true);

      if (mode === 'remove') {
        const removed = removeSampleData(db, guildId);
        await interaction.reply(priv(
          removed.removedProjects === 0
            ? 'No sample data to remove.'
            : `✅ Removed ${removed.removedProjects} sample project(s) and ${removed.removedTasks} sample task(s).`
        ));
        boardScheduler.invalidate(guildId);
        return;
      }

      const existing = listSampleProjects(db, guildId);
      if (existing.length > 0) {
        await interaction.reply(priv(
          `There is already a sample project (**${existing[0].code}**). ` +
          'Remove it first with `/studio sample action:Remove sample data`.'
        ));
        return;
      }

      const result = createSampleProject(db, guildId, {
        ownerId: userId,
        leaderId: interaction.options.getUser('leader')?.id ?? userId,
        artistId: interaction.options.getUser('artist')?.id ?? userId,
      });

      if (!result.ok) {
        await interaction.reply(priv(
          `❌ Could not build the sample: ${result.reason === 'no_departments' ? 'no departments exist yet — run `/studio setup` first' : result.reason}.`
        ));
        return;
      }

      await interaction.reply(priv([
        `✅ Created **${result.project.code}** with ${result.taskCount} sample tasks, one in each stage of the workflow.`,
        '',
        '**Try these, in this order:**',
        `• \`/task queue\` — ${result.showcase.queued} is waiting for an artist, and one task is blocked until you approve its pay`,
        `• \`/task approve-pay task:${result.showcase.payProposed}\` — a leader has proposed a figure`,
        `• \`/task view task:${result.showcase.offered}\` — offered, waiting on an answer`,
        `• \`/review queue\` — ${result.showcase.inReview} is waiting for internal review`,
        `• \`/review client task:${result.showcase.inReview}\` — record a client decision (after passing review)`,
        `• \`/pay splits task:${result.showcase.finished}\` — see the pool divided`,
        `• \`/pay ledger\` and \`/summary now\` — the money and management views`,
        '',
        'Nobody was DMed about these: sample tasks are set up directly, not offered for real.',
        'Remove it all with `/studio sample action:Remove sample data`.',
      ].join('\n')));
      boardScheduler.invalidate(guildId);
    }
  },
};
