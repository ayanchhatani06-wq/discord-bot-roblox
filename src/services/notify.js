const { PermissionsBitField } = require('discord.js');
const configRepo = require('../db/repos/config');

/**
 * Sends to a member's DMs, falling back to the configured private staff channel
 * when DMs are closed. Notifications must not be silently lost: if neither
 * route works the caller is told so it can surface the failure.
 *
 * @returns {Promise<{delivered: boolean, via: 'dm'|'fallback'|null, reason?: string}>}
 */
async function notifyUser(client, db, guildId, userId, payload, { fallbackNote = null, allowFallback = true } = {}) {
  const user = await client.users.fetch(userId).catch(() => null);

  if (user) {
    const sent = await user.send(payload).catch(() => null);
    if (sent) return { delivered: true, via: 'dm' };
  }

  // The fallback posts the message in full, which is right for an offer or a
  // reminder and wrong for anything that is itself a credential: a channel
  // readable by the whole team is not a place to put a client's access code.
  // Callers carrying secrets pass allowFallback: false and handle the miss.
  if (!allowFallback) {
    return { delivered: false, via: null, reason: 'dms_closed_and_fallback_refused' };
  }

  const config = configRepo.getConfig(db, guildId);
  if (!config?.fallback_channel_id) {
    return { delivered: false, via: null, reason: 'dms_closed_and_no_fallback' };
  }

  const guild = client.guilds.cache.get(guildId);
  const channel = guild?.channels.cache.get(config.fallback_channel_id)
    || await guild?.channels.fetch(config.fallback_channel_id).catch(() => null);

  if (!channel?.isTextBased?.()) {
    return { delivered: false, via: null, reason: 'fallback_channel_unavailable' };
  }

  const me = guild.members.me;
  const perms = channel.permissionsFor(me);
  if (!perms?.has(PermissionsBitField.Flags.SendMessages) || !perms?.has(PermissionsBitField.Flags.ViewChannel)) {
    return { delivered: false, via: null, reason: 'fallback_channel_permissions' };
  }

  const body = { ...payload };
  body.content = [
    `<@${userId}> — sending here because I could not DM you.`,
    fallbackNote,
    body.content,
  ].filter(Boolean).join('\n');
  body.allowedMentions = { users: [userId] };

  const sent = await channel.send(body).catch(() => null);
  return sent ? { delivered: true, via: 'fallback' } : { delivered: false, via: null, reason: 'fallback_send_failed' };
}

/**
 * Notifies several people, returning who could not be reached so the caller can
 * report it rather than assuming everyone saw it.
 */
async function notifyMany(client, db, guildId, userIds, payloadFor, options = {}) {
  const failures = [];
  for (const userId of new Set(userIds.filter(Boolean))) {
    const payload = typeof payloadFor === 'function' ? payloadFor(userId) : payloadFor;
    const result = await notifyUser(client, db, guildId, userId, payload, options);
    if (!result.delivered) failures.push({ userId, reason: result.reason });
  }
  return { failures };
}

/** Posts to the audit log channel if one is configured. Never throws. */
async function postAudit(client, db, guildId, payload) {
  const config = configRepo.getConfig(db, guildId);
  if (!config?.audit_log_channel_id) return { delivered: false };

  const guild = client.guilds.cache.get(guildId);
  const channel = guild?.channels.cache.get(config.audit_log_channel_id)
    || await guild?.channels.fetch(config.audit_log_channel_id).catch(() => null);
  if (!channel?.isTextBased?.()) return { delivered: false };

  const sent = await channel.send(payload).catch(() => null);
  return { delivered: Boolean(sent) };
}

module.exports = { notifyUser, notifyMany, postAudit };
