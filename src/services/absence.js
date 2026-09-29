const tasksRepo = require('../db/repos/tasks');
const offersRepo = require('../db/repos/offers');
const { notifyUser } = require('./notify');
const { ACTIVE_STATES, stateLabel } = require('../domain/taskState');
const { discordTimestamp } = require('../utils/time');

/**
 * Tells the relevant group leaders that one of their artists has gone away.
 *
 * Nothing is cancelled or reassigned: going away is information for the
 * leader to act on, not an instruction to the bot. Leaders are found from the
 * artist's own live tasks, so only the people actually affected are told.
 */
async function notifyLeadersOfAbsence(client, db, guildId, userId, { awayUntil = null, note = null } = {}) {
  const active = tasksRepo.listTasksForArtist(db, guildId, userId, { states: ACTIVE_STATES });
  if (active.length === 0) return { notified: [], activeCount: 0 };

  const byLeader = new Map();
  for (const task of active) {
    if (!task.leader_user_id || task.leader_user_id === userId) continue;
    if (!byLeader.has(task.leader_user_id)) byLeader.set(task.leader_user_id, []);
    byLeader.get(task.leader_user_id).push(task);
  }

  const notified = [];
  for (const [leaderUserId, tasks] of byLeader) {
    const lines = tasks.map((task) =>
      `• **${task.code}** ${task.title} — ${stateLabel(task.state)}` +
      `${task.deadline_utc ? ` · due ${discordTimestamp(task.deadline_utc, 'R')}` : ''}`
    );

    const pendingOffers = tasks.filter((task) => offersRepo.getPendingOffer(db, task.id)).length;

    const result = await notifyUser(client, db, guildId, leaderUserId, {
      content: [
        `👋 <@${userId}> has marked themselves **away**${awayUntil ? ` until ${discordTimestamp(awayUntil, 'D')}` : ''}.`,
        note ? `> ${note}` : null,
        '',
        `They are still holding ${tasks.length} task(s):`,
        ...lines,
        '',
        pendingOffers > 0 ? `${pendingOffers} of these is an unanswered offer you can withdraw with \`/task withdraw\`.` : null,
        'Nothing has been cancelled or reassigned. Use `/manage reassign` if you need to move work.',
      ].filter((line) => line !== null).join('\n').slice(0, 2000),
    }).catch(() => ({ delivered: false }));

    notified.push({ leaderUserId, taskCount: tasks.length, delivered: result.delivered });
  }

  return { notified, activeCount: active.length };
}

/**
 * Work done so far that would be lost if a task changed hands or was dropped.
 * Used to decide whether the original artist's contribution needs paying for.
 */
function contributionSummary(db, taskId) {
  const submissions = db.prepare('SELECT COUNT(*) AS n, MAX(submitted_at) AS latest FROM submissions WHERE task_id = ?').get(taskId);
  const finals = db.prepare("SELECT COUNT(*) AS n FROM submissions WHERE task_id = ? AND kind = 'final'").get(taskId);

  return {
    submissionCount: submissions.n,
    finalCount: finals.n,
    lastSubmittedAt: submissions.latest,
    hasWork: submissions.n > 0,
  };
}

module.exports = { notifyLeadersOfAbsence, contributionSummary };
