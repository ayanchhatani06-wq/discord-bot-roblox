const { EmbedBuilder } = require('discord.js');
const { getOffsetMinutes, formatOffsetLabel, formatTimeInZone } = require('../utils/timezones');

const MAX_FIELDS = 25;
const MAX_FIELD_VALUE = 1024;

function buildTimezoneEmbed(timezoneRows) {
  const embed = new EmbedBuilder()
    .setTitle('🌍 Member Timezones')
    .setColor(0x5865f2)
    .setFooter({ text: 'Updates automatically • Register with /timezone set' })
    .setTimestamp();

  if (timezoneRows.length === 0) {
    embed.setDescription('Nobody has registered a timezone yet. Use `/timezone set` to add yours.');
    return embed;
  }

  const now = new Date();
  const groups = new Map();
  for (const { userId, timezone } of timezoneRows) {
    if (!groups.has(timezone)) groups.set(timezone, []);
    groups.get(timezone).push(userId);
  }

  const sortedGroups = [...groups.entries()]
    .map(([timezone, userIds]) => ({
      timezone,
      userIds,
      offset: getOffsetMinutes(timezone, now),
    }))
    .sort((a, b) => a.offset - b.offset);

  const visibleGroups = sortedGroups.slice(0, MAX_FIELDS);
  const overflowCount = sortedGroups.length - visibleGroups.length;

  for (const group of visibleGroups) {
    const time = formatTimeInZone(group.timezone, now);
    const offsetLabel = formatOffsetLabel(group.offset);
    let mentions = group.userIds.map((id) => `<@${id}>`).join(' ');
    if (mentions.length > MAX_FIELD_VALUE) {
      let shown = [];
      let length = 0;
      for (const id of group.userIds) {
        const mention = `<@${id}> `;
        if (length + mention.length > MAX_FIELD_VALUE - 20) break;
        shown.push(mention);
        length += mention.length;
      }
      const remaining = group.userIds.length - shown.length;
      mentions = `${shown.join('')}…and ${remaining} more`;
    }

    embed.addFields({
      name: `${time} — ${group.timezone} (${offsetLabel})`,
      value: mentions,
    });
  }

  if (overflowCount > 0) {
    embed.addFields({
      name: 'More timezones',
      value: `…and ${overflowCount} more timezone group(s) not shown.`,
    });
  }

  return embed;
}

module.exports = { buildTimezoneEmbed };
