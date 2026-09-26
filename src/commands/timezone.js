const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  EmbedBuilder,
} = require('discord.js');
const db = require('../db');
const { isValidTimezone, searchTimezones, formatTimeInZone, formatOffsetLabel, getOffsetMinutes } = require('../utils/timezones');
const { refreshGuild } = require('../scheduler');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('timezone')
    .setDescription('Manage member timezones and the live time channel')
    .addSubcommand((sub) =>
      sub
        .setName('set')
        .setDescription('Register your timezone, or assign one to another member')
        .addStringOption((opt) =>
          opt
            .setName('timezone')
            .setDescription('The IANA timezone, e.g. America/New_York or Europe/London')
            .setRequired(true)
            .setAutocomplete(true)
        )
        .addUserOption((opt) =>
          opt
            .setName('user')
            .setDescription('Assign this timezone to another member instead of yourself (requires Manage Server)')
            .setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('Remove a registered timezone')
        .addUserOption((opt) =>
          opt
            .setName('user')
            .setDescription("Remove another member's timezone instead of your own (requires Manage Server)")
            .setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('view')
        .setDescription("Check a member's current local time")
        .addUserOption((opt) =>
          opt.setName('user').setDescription('The member to check (defaults to you)').setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('setchannel')
        .setDescription('Set the channel that shows the live-updating timezone list (admin only)')
        .addChannelOption((opt) =>
          opt
            .setName('channel')
            .setDescription('The text channel to post the live timezone embed in')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true)
        )
    ),

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused();
    const matches = searchTimezones(focused, 25);
    await interaction.respond(matches.map((tz) => ({ name: tz, value: tz })));
  },

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'set') {
      const target = interaction.options.getUser('user') || interaction.user;
      const isSelf = target.id === interaction.user.id;

      if (!isSelf && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        await interaction.reply({
          content: '❌ You need the **Manage Server** permission to set another member\'s timezone.',
          ephemeral: true,
        });
        return;
      }

      const timezone = interaction.options.getString('timezone', true);
      if (!isValidTimezone(timezone)) {
        await interaction.reply({
          content: `❌ \`${timezone}\` isn't a recognized IANA timezone. Try typing a city or region name (e.g. \`America/New_York\`) and pick a suggestion.`,
          ephemeral: true,
        });
        return;
      }

      db.setUserTimezone(interaction.guildId, target.id, timezone);
      const who = isSelf ? 'Your' : `<@${target.id}>'s`;
      await interaction.reply({
        content: `✅ ${who} timezone is set to \`${timezone}\` (currently ${formatTimeInZone(timezone)}).`,
        ephemeral: true,
      });

      const settings = db.getGuildSettings(interaction.guildId);
      if (settings?.channelId) {
        refreshGuild(interaction.client, interaction.guildId, settings.channelId, settings.messageId).catch((err) =>
          console.error('Failed to refresh timezone embed after /timezone set:', err)
        );
      }
      return;
    }

    if (sub === 'remove') {
      const target = interaction.options.getUser('user') || interaction.user;
      const isSelf = target.id === interaction.user.id;

      if (!isSelf && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        await interaction.reply({
          content: '❌ You need the **Manage Server** permission to remove another member\'s timezone.',
          ephemeral: true,
        });
        return;
      }

      const removed = db.removeUserTimezone(interaction.guildId, target.id);
      const who = isSelf ? 'Your' : `<@${target.id}>'s`;
      await interaction.reply({
        content: removed ? `✅ ${who} timezone has been removed.` : `${who} timezone wasn't registered.`,
        ephemeral: true,
      });

      if (removed) {
        const settings = db.getGuildSettings(interaction.guildId);
        if (settings?.channelId) {
          refreshGuild(interaction.client, interaction.guildId, settings.channelId, settings.messageId).catch((err) =>
            console.error('Failed to refresh timezone embed after /timezone remove:', err)
          );
        }
      }
      return;
    }

    if (sub === 'view') {
      const target = interaction.options.getUser('user') || interaction.user;
      const timezone = db.getUserTimezone(interaction.guildId, target.id);

      if (!timezone) {
        const who = target.id === interaction.user.id ? 'You' : `<@${target.id}>`;
        await interaction.reply({
          content: `${who} ${target.id === interaction.user.id ? "haven't" : "hasn't"} registered a timezone yet. Use \`/timezone set\` to add one.`,
          ephemeral: true,
        });
        return;
      }

      const offset = getOffsetMinutes(timezone);
      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setDescription(
          `🕐 <@${target.id}>'s local time is **${formatTimeInZone(timezone)}**\n` +
          `\`${timezone}\` (${formatOffsetLabel(offset)})`
        );

      await interaction.reply({ embeds: [embed] });
      return;
    }

    if (sub === 'setchannel') {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        await interaction.reply({
          content: '❌ You need the **Manage Server** permission to set the timezone channel.',
          ephemeral: true,
        });
        return;
      }

      const channel = interaction.options.getChannel('channel', true);
      const me = interaction.guild.members.me;
      const perms = channel.permissionsFor(me);
      const missing = [];
      if (!perms?.has(PermissionFlagsBits.ViewChannel)) missing.push('View Channel');
      if (!perms?.has(PermissionFlagsBits.SendMessages)) missing.push('Send Messages');
      if (!perms?.has(PermissionFlagsBits.EmbedLinks)) missing.push('Embed Links');

      if (missing.length > 0) {
        await interaction.reply({
          content: `❌ I'm missing these permissions in <#${channel.id}>: ${missing.join(', ')}.`,
          ephemeral: true,
        });
        return;
      }

      db.setGuildChannel(interaction.guildId, channel.id);
      await interaction.reply({
        content: `✅ The live timezone list will now be posted and kept updated in <#${channel.id}>.`,
        ephemeral: true,
      });

      const settings = db.getGuildSettings(interaction.guildId);
      refreshGuild(interaction.client, interaction.guildId, settings.channelId, settings.messageId).catch((err) =>
        console.error('Failed to post timezone embed after /timezone setchannel:', err)
      );
    }
  },
};
