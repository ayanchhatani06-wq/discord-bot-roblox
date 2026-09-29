const { MessageFlags } = require('discord.js');

/** Marks a reply private to the caller. `ephemeral: true` is deprecated in discord.js 14.27. */
function priv(body) {
  const payload = typeof body === 'string' ? { content: body } : { ...body };
  payload.flags = (payload.flags || 0) | MessageFlags.Ephemeral;
  return payload;
}

/**
 * Replies privately whether or not the interaction has already been answered,
 * which keeps error paths from throwing a second "already replied" error.
 */
async function replyPrivate(interaction, body) {
  const payload = priv(body);
  if (interaction.replied || interaction.deferred) {
    return interaction.followUp(payload).catch(() => null);
  }
  return interaction.reply(payload).catch(() => null);
}

module.exports = { priv, replyPrivate };
