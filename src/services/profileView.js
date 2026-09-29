const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const staffRepo = require('../db/repos/staff');
const { customId } = require('../interactions/router');
const {
  formatDateTimeInZone,
  formatOffsetLabel,
  getOffsetMinutes,
  discordTimestamp,
  formatClockMinutes,
  formatWorkingDays,
} = require('../utils/time');

const NAMESPACE = 'profile';

function buildProfileEmbed({ staff, department, activeCount = 0, nextDeadline = null }) {
  const now = new Date();
  const embed = new EmbedBuilder()
    .setTitle(staff.display_name ? `${staff.display_name}` : 'Staff profile')
    .setColor(0x5865f2)
    .setDescription(`<@${staff.user_id}>`);

  const availability = `${staffRepo.AVAILABILITY_EMOJI[staff.availability] || '⚪'} ${staffRepo.AVAILABILITY_LABELS[staff.availability] || staff.availability}`;
  const availabilityDetail = [availability];
  if (staff.availability === staffRepo.AVAILABILITY.AWAY && staff.away_until) {
    availabilityDetail.push(`until ${discordTimestamp(staff.away_until, 'd')}`);
  }
  if (staff.away_note) availabilityDetail.push(`_${staff.away_note}_`);

  embed.addFields(
    { name: 'Department', value: department ? department.name : '_not set_', inline: true },
    {
      name: 'Group leader',
      value: staff.leader_user_id
        ? `<@${staff.leader_user_id}>`
        : department?.leader_role_id ? `<@&${department.leader_role_id}>` : '_not set_',
      inline: true,
    },
    { name: 'Active tasks', value: String(activeCount), inline: true },
    { name: 'Availability', value: availabilityDetail.join(' · '), inline: false }
  );

  if (staff.timezone) {
    const offset = getOffsetMinutes(staff.timezone, now);
    embed.addFields({
      name: 'Local time',
      value: `**${formatDateTimeInZone(staff.timezone, now)}**\n\`${staff.timezone}\` (${formatOffsetLabel(offset)})`,
      inline: false,
    });
  } else {
    embed.addFields({ name: 'Local time', value: '_no timezone set — use the button below_', inline: false });
  }

  if (staff.specialties) embed.addFields({ name: 'Specialties', value: staff.specialties, inline: true });
  if (staff.software) embed.addFields({ name: 'Software', value: staff.software, inline: true });
  if (staff.portfolio_url) embed.addFields({ name: 'Portfolio', value: staff.portfolio_url, inline: false });
  if (staff.roblox_username) embed.addFields({ name: 'Roblox', value: staff.roblox_username, inline: true });

  if (staff.working_start_minute !== null && staff.working_start_minute !== undefined) {
    const days = formatWorkingDays(staff.working_days);
    embed.addFields({
      name: 'Usual hours',
      value: `${formatClockMinutes(staff.working_start_minute)}–${formatClockMinutes(staff.working_end_minute)}${days ? ` · ${days}` : ''}${staff.timezone ? ` (${staff.timezone})` : ''}`,
      inline: true,
    });
  }

  if (staff.quiet_start_minute !== null && staff.quiet_start_minute !== undefined) {
    embed.addFields({
      name: 'Quiet hours',
      value: `${formatClockMinutes(staff.quiet_start_minute)}–${formatClockMinutes(staff.quiet_end_minute)} — routine reminders are held until these end`,
      inline: false,
    });
  }

  if (nextDeadline) {
    embed.addFields({ name: 'Next deadline', value: discordTimestamp(nextDeadline, 'F'), inline: false });
  }

  if (staff.availability_updated_at) {
    embed.setFooter({ text: 'Availability last updated' }).setTimestamp(staff.availability_updated_at);
  }

  return embed;
}

/**
 * Buttons rather than remembered commands: everything a staff member needs to
 * maintain their own profile is one click from here.
 */
function buildProfileComponents(staff) {
  const rows = [];

  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(customId(NAMESPACE, 'tz'))
      .setLabel(staff.timezone ? 'Change timezone' : 'Set timezone')
      .setStyle(staff.timezone ? ButtonStyle.Secondary : ButtonStyle.Primary)
      .setEmoji('🌍'),
    new ButtonBuilder()
      .setCustomId(customId(NAMESPACE, 'details'))
      .setLabel('Edit details')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('📝'),
    new ButtonBuilder()
      .setCustomId(customId(NAMESPACE, 'hours'))
      .setLabel('Hours & quiet hours')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('🕒')
  ));

  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(customId(NAMESPACE, 'avail', staffRepo.AVAILABILITY.ACCEPTING))
      .setLabel('Accepting tasks')
      .setStyle(ButtonStyle.Success)
      .setDisabled(staff.availability === staffRepo.AVAILABILITY.ACCEPTING),
    new ButtonBuilder()
      .setCustomId(customId(NAMESPACE, 'avail', staffRepo.AVAILABILITY.AT_CAPACITY))
      .setLabel('At capacity')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(staff.availability === staffRepo.AVAILABILITY.AT_CAPACITY),
    new ButtonBuilder()
      .setCustomId(customId(NAMESPACE, 'away'))
      .setLabel('Away')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(staff.availability === staffRepo.AVAILABILITY.AWAY)
  ));

  return rows;
}

function missingProfileFields(staff) {
  const missing = [];
  if (!staff.timezone) missing.push('timezone');
  if (!staff.department_id) missing.push('department');
  return missing;
}

module.exports = { NAMESPACE, buildProfileEmbed, buildProfileComponents, missingProfileFields };
