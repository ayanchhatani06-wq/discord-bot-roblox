const { EmbedBuilder, PermissionsBitField } = require('discord.js');
const configRepo = require('../db/repos/config');
const staffRepo = require('../db/repos/staff');
const {
  formatTimeInZone,
  formatOffsetLabel,
  getOffsetMinutes,
  discordTimestamp,
  formatClockMinutes,
  formatWorkingDays,
} = require('../utils/time');

const MEMBERS_PER_PAGE = 20;
const BOARD_COLOUR = 0x5865f2;

/**
 * One staff line. Deliberately contains directory and workload information
 * only: task briefs, client details and pay never appear on a shared board.
 */
function renderStaffLine(staff, { activeCount = 0, now = new Date() } = {}) {
  const emoji = staffRepo.AVAILABILITY_EMOJI[staff.availability] || '⚪';
  const parts = [`${emoji} <@${staff.user_id}>`];

  if (staff.timezone) {
    parts.push(`${formatTimeInZone(staff.timezone, now)} · \`${staff.timezone}\``);
  } else {
    parts.push('_no timezone set_');
  }

  parts.push(`${activeCount} active`);

  const line = parts.join(' · ');
  const extras = [];

  if (staff.availability === staffRepo.AVAILABILITY.AWAY && staff.away_until) {
    extras.push(`away until ${discordTimestamp(staff.away_until, 'd')}`);
  }
  // The title first, then how long they have done it: this is the order
  // somebody reads when deciding who to put on a job.
  if (staff.sub_role) extras.push(`**${staff.sub_role}**`);
  if (staff.experience) extras.push(staff.experience);
  if (staff.specialties) extras.push(staff.specialties);
  if (staff.software) extras.push(`_${staff.software}_`);

  const hours = staff.working_start_minute !== null && staff.working_start_minute !== undefined
    ? `${formatClockMinutes(staff.working_start_minute)}-${formatClockMinutes(staff.working_end_minute)}${formatWorkingDays(staff.working_days) ? ` ${formatWorkingDays(staff.working_days)}` : ''}`
    : null;
  if (hours) extras.push(hours);

  if (staff.portfolio_url) extras.push(`[portfolio](${staff.portfolio_url})`);

  const detail = extras.length > 0 ? `\n┗ ${extras.join(' · ')}` : '';
  return `${line}${detail}`;
}

function chunkLines(lines, perPage = MEMBERS_PER_PAGE, maxChars = 3800) {
  const pages = [];
  let current = [];
  let length = 0;

  for (const line of lines) {
    const wouldOverflow = current.length >= perPage || length + line.length + 1 > maxChars;
    if (wouldOverflow && current.length > 0) {
      pages.push(current);
      current = [];
      length = 0;
    }
    current.push(line);
    length += line.length + 1;
  }

  if (current.length > 0) pages.push(current);
  return pages.length > 0 ? pages : [[]];
}

function summariseAvailability(staffRows) {
  const counts = { accepting: 0, at_capacity: 0, away: 0 };
  for (const staff of staffRows) {
    if (counts[staff.availability] !== undefined) counts[staff.availability] += 1;
  }
  return counts;
}

function buildDepartmentPages({ department, staffRows, activeCounts, now = new Date() }) {
  const lines = staffRows.map((staff) =>
    renderStaffLine(staff, { activeCount: activeCounts.get(staff.user_id) || 0, now })
  );
  const pages = chunkLines(lines);
  const availability = summariseAvailability(staffRows);
  const leaderText = department?.leader_role_id ? `<@&${department.leader_role_id}>` : '_not set_';

  return pages.map((pageLines, index) => {
    const title = department
      ? `${department.name}${pages.length > 1 ? ` (${index + 1}/${pages.length})` : ''}`
      : `Unassigned staff${pages.length > 1 ? ` (${index + 1}/${pages.length})` : ''}`;

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setColor(BOARD_COLOUR)
      .setDescription(pageLines.length > 0 ? pageLines.join('\n') : '_Nobody in this department yet._');

    if (index === 0) {
      const summary = [
        `${staffRepo.AVAILABILITY_EMOJI.accepting} ${availability.accepting} accepting`,
        `${staffRepo.AVAILABILITY_EMOJI.at_capacity} ${availability.at_capacity} at capacity`,
        `${staffRepo.AVAILABILITY_EMOJI.away} ${availability.away} away`,
      ].join(' · ');
      embed.addFields(
        { name: 'Group leader', value: leaderText, inline: true },
        { name: 'Availability', value: summary, inline: false }
      );
    }

    // "Updated at" is rendered as a Discord timestamp so each viewer reads it
    // in their own local time.
    embed.setFooter({ text: 'Availability is self-declared, not Discord presence' });
    embed.addFields({ name: 'Updated', value: discordTimestamp(now.getTime(), 'T'), inline: true });
    return embed;
  });
}

function departmentTimeLines(staffRows, { now = new Date() } = {}) {
  const withZone = staffRows.filter((staff) => staff.timezone);
  const withoutZone = staffRows.filter((staff) => !staff.timezone);

  const sorted = withZone
    .map((staff) => ({ staff, offset: getOffsetMinutes(staff.timezone, now) }))
    .sort((a, b) => a.offset - b.offset);

  const lines = sorted.map(({ staff, offset }) => {
    const emoji = staffRepo.AVAILABILITY_EMOJI[staff.availability] || '⚪';
    return `${emoji} <@${staff.user_id}> — **${formatTimeInZone(staff.timezone, now)}** · \`${staff.timezone}\` (${formatOffsetLabel(offset)})`;
  });

  for (const staff of withoutZone) {
    lines.push(`⚪ <@${staff.user_id}> — _no timezone set_`);
  }

  return lines;
}

function canPostIn(channel, guild) {
  if (!channel || !channel.isTextBased?.()) return false;
  const me = guild.members.me;
  if (!me) return false;
  const perms = channel.permissionsFor(me);
  return Boolean(
    perms?.has(PermissionsBitField.Flags.ViewChannel) &&
    perms?.has(PermissionsBitField.Flags.SendMessages) &&
    perms?.has(PermissionsBitField.Flags.EmbedLinks)
  );
}

/**
 * Publishes or edits the department boards for one guild.
 *
 * Missing messages are re-posted (somebody deleted the board), and pages that
 * are no longer needed are removed, so the channel cannot accumulate stale
 * duplicates as the studio grows or shrinks.
 */
async function refreshGuildBoards(client, guildId, db) {
  const config = configRepo.getConfig(db, guildId);
  if (!config?.staff_board_channel_id) return { skipped: 'no_channel' };

  const guild = client.guilds.cache.get(guildId);
  if (!guild) return { skipped: 'guild_unavailable' };

  const channel = guild.channels.cache.get(config.staff_board_channel_id)
    || await guild.channels.fetch(config.staff_board_channel_id).catch(() => null);
  if (!canPostIn(channel, guild)) return { skipped: 'missing_permissions' };

  const departments = configRepo.listDepartments(db, guildId);
  const activeCounts = staffRepo.activeTaskCounts(db, guildId);
  const now = new Date();

  const groups = departments.map((department) => ({
    boardKeyBase: `dept:${department.id}`,
    department,
    staffRows: staffRepo.listStaff(db, guildId, { departmentId: department.id }),
  }));

  const unassigned = staffRepo.listStaff(db, guildId, { departmentId: null });
  if (unassigned.length > 0) {
    groups.push({ boardKeyBase: 'dept:none', department: null, staffRows: unassigned });
  }

  const expectedKeys = new Set();
  let posted = 0;

  for (const group of groups) {
    const pages = buildDepartmentPages({ ...group, activeCounts, now });

    for (let index = 0; index < pages.length; index += 1) {
      const boardKey = `${group.boardKeyBase}:p${index}`;
      expectedKeys.add(boardKey);
      const existing = configRepo.getBoardMessage(db, guildId, boardKey);

      let message = null;
      if (existing && existing.channel_id === channel.id) {
        message = await channel.messages.fetch(existing.message_id).catch(() => null);
      }

      if (message) {
        await message.edit({ embeds: [pages[index]] }).catch(() => null);
      } else {
        const sent = await channel.send({ embeds: [pages[index]] }).catch(() => null);
        if (sent) configRepo.setBoardMessage(db, guildId, boardKey, channel.id, sent.id);
      }
      posted += 1;
    }
  }

  for (const row of configRepo.listBoardMessages(db, guildId)) {
    if (!row.board_key.startsWith('dept:') || expectedKeys.has(row.board_key)) continue;
    const stale = await channel.messages.fetch(row.message_id).catch(() => null);
    if (stale) await stale.delete().catch(() => null);
    configRepo.deleteBoardMessage(db, guildId, row.board_key);
  }

  return { posted };
}

async function refreshAllBoards(client, db) {
  for (const config of configRepo.listConfiguredGuilds(db)) {
    try {
      await refreshGuildBoards(client, config.guild_id, db);
    } catch (error) {
      console.error(`Failed to refresh staff board for guild ${config.guild_id}:`, error);
    }
  }
}

module.exports = {
  MEMBERS_PER_PAGE,
  renderStaffLine,
  chunkLines,
  buildDepartmentPages,
  departmentTimeLines,
  refreshGuildBoards,
  refreshAllBoards,
};
