const clientsRepo = require('../db/repos/clients');
const projectsRepo = require('../db/repos/projects');
const tasksRepo = require('../db/repos/tasks');
const clientMessaging = require('./clientMessaging');
const { notifyUser } = require('./notify');
const { TASK_STATES } = require('../domain/taskState');

/**
 * Noticing when a client writes in their own channel.
 *
 * The bot reads nothing else. It looks only at channels a project is linked to,
 * only at messages from accounts explicitly authorised for that client, and it
 * stores a short excerpt rather than the conversation. What it does with that
 * is get out of the way: pending promotional messages are cancelled and a
 * person is told, because a client who has written deserves an answer from
 * somebody rather than the next scheduled line.
 */

const EXCERPT_LENGTH = 400;

/**
 * What the bot can honestly say the client wrote.
 *
 * Message content is a privileged intent. Without it Discord delivers the
 * event with an empty body, so the excerpt says so plainly rather than
 * implying the client sent a blank message.
 */
function excerptOf(message) {
  const text = String(message.content || '').trim();
  if (text) return text.slice(0, EXCERPT_LENGTH);
  if (message.attachments?.size > 0) return `(${message.attachments.size} attachment(s), no text)`;
  return '(the bot cannot read message text — enable the Message Content intent to quote clients here)';
}

/** The project whose client channel this is, if any. */
function projectForChannel(db, guildId, channelId) {
  return db.prepare('SELECT * FROM projects WHERE guild_id = ? AND client_channel_id = ?')
    .get(guildId, channelId) || null;
}

/**
 * Whether this author is an authorised account for that project's client.
 *
 * Staff writing in the channel is not a client reply: it is the studio doing
 * its job, and it must not pause the studio's own automation.
 */
function authorisedClientAccount(db, project, userId) {
  if (!project?.client_id) return null;
  const account = db.prepare(`
    SELECT * FROM client_accounts WHERE client_id = ? AND user_id = ? AND revoked_at IS NULL
  `).get(project.client_id, userId);
  return account || null;
}

async function handleMessage(discordClient, db, message) {
  if (!message.guildId || message.author?.bot) return { handled: false, reason: 'not_applicable' };

  const project = projectForChannel(db, message.guildId, message.channelId);
  if (!project) return { handled: false, reason: 'not_a_client_channel' };

  if (!authorisedClientAccount(db, project, message.author.id)) {
    return { handled: false, reason: 'not_a_client_account' };
  }

  const client = clientsRepo.getClient(db, message.guildId, project.client_id);
  if (!client) return { handled: false, reason: 'no_client_record' };

  const { reply, cancelledPromotional } = clientMessaging.recordClientReply(db, message.guildId, {
    project,
    client,
    userId: message.author.id,
    channelId: message.channelId,
    messageId: message.id,
    content: excerptOf(message),
  });

  // Already seen: Discord can deliver the same message twice, and a second
  // notification about it would just be noise.
  if (reply.handled_at) return { handled: false, reason: 'already_handled' };

  const tellWho = clientMessaging.whoToTell(db, message.guildId, client, project);
  if (!tellWho) return { handled: true, reply, notified: null, cancelledPromotional };

  // What of theirs is currently waiting on them, so whoever picks this up can
  // see at a glance what the message might be about.
  const awaiting = tasksRepo.listTasksForProject(db, project.id)
    .filter((task) => task.state === TASK_STATES.AWAITING_CLIENT);

  await notifyUser(discordClient, db, message.guildId, tellWho, {
    content: [
      `💬 **${client.display_name}** wrote in <#${message.channelId}> about **${project.code} · ${project.name}**.`,
      `> ${excerptOf(message)}`,
      awaiting.length > 0
        ? `\nWaiting on them right now: ${awaiting.map((task) => `**${task.code}** ${task.title}`).join(', ')}.` +
          `\nRecord any decision per item with \`/review client task:<code>\`.`
        : '',
      cancelledPromotional > 0
        ? `\n_${cancelledPromotional} queued promotional message(s) cancelled so we are not talking over them._`
        : '',
      '\nAutomated messages to this client are paused until you mark it handled — `/messages replies`.',
    ].filter(Boolean).join('\n'),
  }).catch(() => null);

  return { handled: true, reply, notified: tellWho, cancelledPromotional, awaiting };
}

module.exports = { EXCERPT_LENGTH, excerptOf, projectForChannel, authorisedClientAccount, handleMessage };
