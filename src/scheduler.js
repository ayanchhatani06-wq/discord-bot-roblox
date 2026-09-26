const cron = require('node-cron');
const { PermissionsBitField } = require('discord.js');
const db = require('./db');
const { buildTimezoneEmbed } = require('./services/timezoneEmbed');

async function refreshGuild(client, guildId, channelId, messageId) {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return;

  const channel = guild.channels.cache.get(channelId);
  if (!channel || !channel.isTextBased()) return;

  const me = guild.members.me;
  if (!me) return;
  const perms = channel.permissionsFor(me);
  if (!perms?.has(PermissionsBitField.Flags.ViewChannel) ||
      !perms?.has(PermissionsBitField.Flags.SendMessages) ||
      !perms?.has(PermissionsBitField.Flags.EmbedLinks)) {
    return;
  }

  const rows = db.getGuildTimezones(guildId);
  const embed = buildTimezoneEmbed(rows);

  let message = null;
  if (messageId) {
    try {
      message = await channel.messages.fetch(messageId);
    } catch {
      message = null;
    }
  }

  if (message) {
    await message.edit({ embeds: [embed] });
    return;
  }

  const sent = await channel.send({ embeds: [embed] });
  db.setGuildMessageId(guildId, sent.id);
  if (perms.has(PermissionsBitField.Flags.ManageMessages)) {
    try {
      await sent.pin();
    } catch {
      // Pinning is best-effort; ignore failures (e.g. pin list full).
    }
  }
}

async function refreshAll(client) {
  const guildSettings = db.getAllGuildSettings();
  for (const { guildId, channelId, messageId } of guildSettings) {
    try {
      await refreshGuild(client, guildId, channelId, messageId);
    } catch (error) {
      console.error(`Failed to refresh timezone embed for guild ${guildId}:`, error);
    }
  }
}

function start(client, intervalMinutes) {
  const minutes = Math.max(1, Math.min(60, intervalMinutes || 1));
  const expression = minutes === 1 ? '* * * * *' : `*/${minutes} * * * *`;
  cron.schedule(expression, () => refreshAll(client));
  console.log(`Timezone embed scheduler running every ${minutes} minute(s).`);
}

module.exports = { start, refreshAll, refreshGuild };
