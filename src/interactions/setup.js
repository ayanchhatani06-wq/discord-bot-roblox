const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
  ChannelType,
  PermissionsBitField,
} = require('discord.js');
const configRepo = require('../db/repos/config');
const staffRepo = require('../db/repos/staff');
const { contextFor } = require('../services/actor');
const { refreshGuildBoards } = require('../services/staffBoard');
const boardScheduler = require('../services/boardScheduler');
const { register, customId } = require('./router');
const { CAPABILITIES, assertCan } = require('../domain/permissions');
const { RECIPIENT_KINDS } = require('../domain/allocations');
const { priv } = require('../utils/reply');

const NAMESPACE = 'setup';

const CHANNEL_FIELDS = {
  board: { column: 'staff_board_channel_id', label: 'Staff info board' },
  fallback: { column: 'fallback_channel_id', label: 'DM fallback' },
  summary: { column: 'summary_channel_id', label: 'Weekly summary' },
};

function tick(done) {
  return done ? '✅' : '⬜';
}

/**
 * The checklist doubles as the wizard: it shows what is still missing and
 * carries the controls to fix each item, so nothing has to be memorised.
 */
function buildPanel(db, guildId) {
  const config = configRepo.getConfig(db, guildId);
  const departments = configRepo.listDepartments(db, guildId);
  const mapped = departments.filter((dept) => dept.leader_role_id).length;
  const splits = configRepo.getAllocationPercentages(db, guildId);
  const onboarded = staffRepo.listStaff(db, guildId).filter((staff) => staffRepo.isProfileComplete(staff)).length;

  const steps = [
    { done: Boolean(config.owner_user_id), text: `Owner recorded${config.owner_user_id ? ` — <@${config.owner_user_id}>` : ''}` },
    { done: departments.length > 0, text: `Departments created — ${departments.length}` },
    { done: Boolean(config.staff_board_channel_id), text: `Staff board channel${config.staff_board_channel_id ? ` — <#${config.staff_board_channel_id}>` : ''}` },
    { done: Boolean(config.fallback_channel_id), text: `DM fallback channel${config.fallback_channel_id ? ` — <#${config.fallback_channel_id}>` : ''}` },
    { done: Boolean(config.summary_channel_id), text: `Weekly summary channel${config.summary_channel_id ? ` — <#${config.summary_channel_id}>` : ''}`, optional: true },
    { done: mapped === departments.length && departments.length > 0, text: `Leader roles mapped — ${mapped} of ${departments.length}` },
    { done: true, text: `Pool split — ${RECIPIENT_KINDS.map((kind) => `${kind} ${splits[kind] / 100}%`).join(' · ')}` },
    { done: onboarded > 0, text: `Staff profiles completed — ${onboarded}` },
  ];

  const embed = new EmbedBuilder()
    .setTitle('Studio setup')
    .setColor(0x5865f2)
    .setDescription(steps.map((step) => `${tick(step.done)} ${step.text}${step.optional ? ' _(optional)_' : ''}`).join('\n'))
    .setFooter({ text: 'Use the controls below. Everything here can be changed later with /studio.' });

  const components = [
    new ActionRowBuilder().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId(customId(NAMESPACE, 'chan', 'board'))
        .setPlaceholder('1. Staff info board channel')
        .addChannelTypes(ChannelType.GuildText)
    ),
    new ActionRowBuilder().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId(customId(NAMESPACE, 'chan', 'fallback'))
        .setPlaceholder('2. Private channel for when DMs are closed')
        .addChannelTypes(ChannelType.GuildText)
    ),
    new ActionRowBuilder().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId(customId(NAMESPACE, 'chan', 'summary'))
        .setPlaceholder('3. Weekly summary channel (private, optional)')
        .addChannelTypes(ChannelType.GuildText)
    ),
    new ActionRowBuilder().addComponents(
      new RoleSelectMenuBuilder()
        .setCustomId(customId(NAMESPACE, 'role', 'owner'))
        .setPlaceholder('4. Role with full owner authority (optional)')
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(customId(NAMESPACE, 'dept'))
        .setLabel('5. Map department roles')
        .setStyle(mapped === departments.length && departments.length > 0 ? ButtonStyle.Secondary : ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(customId(NAMESPACE, 'splits'))
        .setLabel('6. Pool split')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(customId(NAMESPACE, 'refresh'))
        .setLabel('Recheck')
        .setStyle(ButtonStyle.Secondary)
    ),
  ];

  return { embed, components, config, departments };
}

function splitsModal(percentages) {
  const modal = new ModalBuilder()
    .setCustomId(customId(NAMESPACE, 'splitsModal'))
    .setTitle('Split of the leftover pool');

  for (const kind of RECIPIENT_KINDS) {
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId(kind)
        .setLabel(`${kind} %`)
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(6)
        .setValue(String(percentages[kind] / 100))
    ));
  }
  return modal;
}

async function showPanel(interaction, db, guildId, note = null) {
  const panel = buildPanel(db, guildId);
  const body = {
    content: note,
    embeds: [panel.embed],
    components: panel.components,
  };

  if (interaction.isModalSubmit() || interaction.replied || interaction.deferred) {
    if (interaction.message) {
      await interaction.update(body).catch(() => interaction.followUp(priv(body)).catch(() => null));
      return;
    }
    await interaction.followUp(priv(body)).catch(() => null);
    return;
  }

  if (interaction.message) {
    await interaction.update(body).catch(() => null);
    return;
  }
  await interaction.reply(priv(body));
}

register(NAMESPACE, async (interaction, { action, args }) => {
  const { db, guildId, actor } = contextFor(interaction);
  assertCan(actor, CAPABILITIES.CONFIG_MANAGE);
  const userId = interaction.user.id;

  if (action === 'refresh') {
    await showPanel(interaction, db, guildId, 'Rechecked.');
    return;
  }

  if (action === 'chan') {
    const field = CHANNEL_FIELDS[args[0]];
    const channel = interaction.channels.first();

    // Checked now rather than discovered later when a board silently fails.
    const perms = channel.permissionsFor(interaction.guild.members.me);
    const missing = [];
    if (!perms?.has(PermissionsBitField.Flags.ViewChannel)) missing.push('View Channel');
    if (!perms?.has(PermissionsBitField.Flags.SendMessages)) missing.push('Send Messages');
    if (!perms?.has(PermissionsBitField.Flags.EmbedLinks)) missing.push('Embed Links');

    if (missing.length > 0) {
      await interaction.reply(priv(`❌ I cannot use <#${channel.id}>: missing ${missing.join(', ')}. Fix that and pick it again.`));
      return;
    }

    configRepo.updateConfig(db, guildId, { [field.column]: channel.id }, userId);

    if (args[0] === 'board') {
      boardScheduler.invalidate(guildId);
      refreshGuildBoards(interaction.client, guildId, db)
        .then(() => boardScheduler.markRefreshed(guildId))
        .catch((error) => console.error('Initial board build failed:', error));
    }

    await showPanel(interaction, db, guildId, `✅ ${field.label} set to <#${channel.id}>.`);
    return;
  }

  if (action === 'role') {
    const role = interaction.roles.first();
    configRepo.updateConfig(db, guildId, { owner_role_id: role.id }, userId);
    await showPanel(interaction, db, guildId, `✅ Owner role set to <@&${role.id}>.`);
    return;
  }

  if (action === 'dept') {
    const departments = configRepo.listDepartments(db, guildId);
    if (departments.length === 0) {
      await interaction.reply(priv('No departments yet. Run `/studio setup` first to create the defaults.'));
      return;
    }

    await interaction.reply(priv({
      content: 'Which department? You will then pick its leader and member roles.',
      components: [new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(customId(NAMESPACE, 'deptsel'))
          .setPlaceholder('Choose a department')
          .addOptions(departments.slice(0, 25).map((dept) => ({
            label: dept.name.slice(0, 100),
            value: String(dept.id),
            description: `${dept.leader_role_id ? 'leader set' : 'no leader role'} · ${dept.member_role_id ? 'members set' : 'no member role'}`.slice(0, 100),
          })))
      )],
    }));
    return;
  }

  if (action === 'deptsel') {
    const departmentId = Number(interaction.values[0]);
    const department = configRepo.getDepartment(db, guildId, departmentId);

    await interaction.update({
      content:
        `**${department.name}** — pick the role its group leader holds, then the role its artists hold.\n` +
        'The leader role is what gives someone the right to assign work in this department.',
      components: [
        new ActionRowBuilder().addComponents(
          new RoleSelectMenuBuilder()
            .setCustomId(customId(NAMESPACE, 'deptlead', departmentId))
            .setPlaceholder('Group leader role')
        ),
        new ActionRowBuilder().addComponents(
          new RoleSelectMenuBuilder()
            .setCustomId(customId(NAMESPACE, 'deptmem', departmentId))
            .setPlaceholder('Artist / member role')
        ),
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(customId(NAMESPACE, 'dept'))
            .setLabel('Map another department')
            .setStyle(ButtonStyle.Secondary)
        ),
      ],
    });
    return;
  }

  if (action === 'deptlead' || action === 'deptmem') {
    const departmentId = Number(args[0]);
    const department = configRepo.getDepartment(db, guildId, departmentId);
    const role = interaction.roles.first();
    const isLeader = action === 'deptlead';

    configRepo.upsertDepartment(db, guildId, {
      key: department.key,
      leaderRoleId: isLeader ? role.id : undefined,
      memberRoleId: isLeader ? undefined : role.id,
    }, userId);

    await interaction.reply(priv(
      `✅ **${department.name}** ${isLeader ? 'leader' : 'member'} role set to <@&${role.id}>.` +
      `${isLeader ? '\nAnyone with that role can now assign and review work in this department.' : ''}`
    ));
    return;
  }

  if (action === 'splits') {
    await interaction.showModal(splitsModal(configRepo.getAllocationPercentages(db, guildId)));
    return;
  }

  if (action === 'splitsModal') {
    const percentages = {};
    for (const kind of RECIPIENT_KINDS) {
      const raw = interaction.fields.getTextInputValue(kind).trim().replace('%', '');
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0) {
        await interaction.reply(priv(`❌ "${raw}" is not a valid percentage for ${kind}.`));
        return;
      }
      percentages[kind] = Math.round(value * 100);
    }

    const total = RECIPIENT_KINDS.reduce((sum, kind) => sum + percentages[kind], 0);
    if (total !== 10000) {
      await interaction.reply(priv(
        `❌ Those add up to ${total / 100}%, not 100%. Nothing was changed.`
      ));
      return;
    }

    configRepo.setAllocationPercentages(db, guildId, percentages, userId);
    await showPanel(interaction, db, guildId,
      `✅ Split saved: ${RECIPIENT_KINDS.map((kind) => `${kind} ${percentages[kind] / 100}%`).join(' · ')}.`
    );
    return;
  }

  await interaction.reply(priv('❌ Unknown setup action.'));
});

module.exports = { NAMESPACE, buildPanel };
