const { EmbedBuilder, PermissionsBitField } = require('discord.js');
const configRepo = require('../db/repos/config');
const { recordAudit } = require('../db/repos/core');

/**
 * Telling somebody a quote request arrived.
 *
 * The website writes the enquiry and stops there — it runs as its own process
 * with no Discord connection, so it cannot post the alert itself. The bot picks
 * up anything not yet announced and posts it.
 *
 * Which ones have been announced is a column in the database rather than
 * something held in memory, so restarting the bot neither re-announces a week of
 * enquiries nor quietly skips the ones that arrived while it was down.
 */

const DEFAULT_LIMIT = 10;

/** Enquiries that arrived and nobody has been told about. */
function pending(db, guildId, { limit = DEFAULT_LIMIT } = {}) {
  return db.prepare(`
    SELECT * FROM enquiries
    WHERE guild_id = ? AND announced_at IS NULL AND status != 'declined'
    ORDER BY created_at LIMIT ?
  `).all(guildId, limit);
}

function markAnnounced(db, guildId, enquiryId, messageId = null) {
  const result = db.prepare(`
    UPDATE enquiries SET announced_at = ?, announced_message_id = ?
    WHERE guild_id = ? AND id = ? AND announced_at IS NULL
  `).run(Date.now(), messageId, guildId, enquiryId);
  return result.changes === 1;
}

/** What a new enquiry looks like in the channel. */
function embedFor(enquiry) {
  const embed = new EmbedBuilder()
    .setTitle(`New quote request · ${enquiry.code}`)
    .setColor(0x57f287)
    .setDescription(String(enquiry.service_request || '').slice(0, 2000))
    .setFooter({ text: `Came in from ${enquiry.source === 'web' ? 'the website' : enquiry.source}` })
    .setTimestamp(enquiry.created_at ? new Date(enquiry.created_at) : new Date());

  const fields = [];
  if (enquiry.contact_ref) fields.push({ name: 'Contact', value: String(enquiry.contact_ref).slice(0, 1024), inline: true });
  if (enquiry.budget_text) fields.push({ name: 'Budget', value: String(enquiry.budget_text).slice(0, 1024), inline: true });
  if (enquiry.deadline_text) fields.push({ name: 'Deadline', value: String(enquiry.deadline_text).slice(0, 1024), inline: true });
  if (enquiry.references_text) fields.push({ name: 'References', value: String(enquiry.references_text).slice(0, 1024), inline: false });
  if (fields.length > 0) embed.addFields(fields);

  embed.addFields({
    name: 'Next',
    value: `\`/quotes view code:${enquiry.code}\` to read it all, then \`/quotes draft-quote\`.`,
    inline: false,
  });

  return embed;
}

function canPostIn(channel, clientUserId) {
  const perms = channel?.permissionsFor?.(clientUserId);
  return Boolean(
    perms?.has(PermissionsBitField.Flags.ViewChannel) &&
    perms?.has(PermissionsBitField.Flags.SendMessages) &&
    perms?.has(PermissionsBitField.Flags.EmbedLinks)
  );
}

/**
 * Announces whatever is waiting, for one guild.
 *
 * Marks each one only after the message actually posted. An enquiry marked
 * announced that was never posted is worse than one announced twice: the second
 * is noise, the first is a client nobody answers.
 */
async function announcePending(client, db, guildId, { limit = DEFAULT_LIMIT } = {}) {
  const config = configRepo.getConfig(db, guildId);
  const waiting = pending(db, guildId, { limit });
  if (waiting.length === 0) return { posted: 0, skipped: 0, reason: null };

  if (!config?.enquiry_channel_id) {
    // Deliberately left unmarked, so they are announced once a channel is set
    // rather than lost because none was.
    return { posted: 0, skipped: waiting.length, reason: 'no_channel' };
  }

  const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
  const channel = guild?.channels.cache.get(config.enquiry_channel_id)
    || await guild?.channels.fetch(config.enquiry_channel_id).catch(() => null);

  if (!channel?.isTextBased?.()) return { posted: 0, skipped: waiting.length, reason: 'channel_missing' };
  if (!canPostIn(channel, client.user.id)) return { posted: 0, skipped: waiting.length, reason: 'no_permission' };

  let posted = 0;
  for (const enquiry of waiting) {
    const sent = await channel.send({ embeds: [embedFor(enquiry)] }).catch(() => null);
    if (!sent) break;

    markAnnounced(db, guildId, enquiry.id, sent.id);
    recordAudit(db, {
      guildId, actorUserId: null, action: 'enquiry.announced',
      entityType: 'enquiry', entityId: enquiry.id, detail: `Posted to ${channel.id}`,
    });
    posted += 1;
  }

  return { posted, skipped: waiting.length - posted, reason: null };
}

module.exports = { pending, markAnnounced, embedFor, announcePending };
