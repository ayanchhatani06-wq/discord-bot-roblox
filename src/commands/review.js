const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const tasksRepo = require('../db/repos/tasks');
const projectsRepo = require('../db/repos/projects');
const configRepo = require('../db/repos/config');
const submissionsRepo = require('../db/repos/submissions');
const { contextFor } = require('../services/actor');
const { recomputeTaskPaymentState } = require('../services/paymentState');
const bonusFlow = require('../services/bonusFlow');
const { notifyUser } = require('../services/notify');
const { CAPABILITIES, assertCan, can } = require('../domain/permissions');
const { TASK_STATES, stateLabel } = require('../domain/taskState');
const { discordTimestamp } = require('../utils/time');
const { customId } = require('../interactions/router');
const { priv } = require('../utils/reply');

/** Builds the review panel for one task: what was submitted, and the choices. */
function reviewPanel(db, guildId, task, { includeButtons = true } = {}) {
  const submission = submissionsRepo.latestSubmission(db, task.id, { kind: 'final' });
  const department = configRepo.getDepartment(db, guildId, task.department_id);
  const project = projectsRepo.getProject(db, guildId, task.project_id);

  const embed = new EmbedBuilder()
    .setTitle(`Review: ${task.code} · ${task.title}`)
    .setColor(0x9b59b6)
    .setDescription(
      `${task.artist_user_id ? `<@${task.artist_user_id}>` : 'Unassigned'}` +
      `${department ? ` · ${department.name}` : ''}${project ? ` · ${project.code}` : ''}\n` +
      `Status: **${stateLabel(task.state)}**`
    );

  if (submission) {
    const links = submissionsRepo.links(submission);
    const checklist = submissionsRepo.checklist(submission);

    embed.addFields(
      { name: `Submission v${submission.version}`, value: `Sent ${discordTimestamp(submission.submitted_at, 'F')}`, inline: false },
      { name: 'Links', value: links.map((link) => `• ${link}`).join('\n').slice(0, 1024) || '_none_', inline: false }
    );
    if (checklist.length > 0) {
      embed.addFields({
        name: 'Deliverables checklist',
        value: checklist.map((entry) =>
          typeof entry === 'string' ? `✅ ${entry}` : `${entry.included ? '✅' : '⬜'} ${entry.item}`
        ).join('\n').slice(0, 1024),
        inline: false,
      });
    }
    if (submission.notes) embed.addFields({ name: 'Artist notes', value: submission.notes.slice(0, 1024), inline: false });
  } else {
    embed.addFields({ name: 'No final submission', value: 'Nothing has been submitted for review yet.', inline: false });
  }

  const reviews = submissionsRepo.listReviews(db, task.id);
  if (reviews.length > 0) {
    embed.addFields({
      name: 'Earlier reviews',
      value: reviews.slice(-3).map((review) =>
        `${review.decision === 'ready_for_client' ? '✅' : '🔁'} <@${review.reviewer_user_id}> · ${discordTimestamp(review.created_at, 'd')}${review.notes ? ` — ${review.notes.slice(0, 120)}` : ''}`
      ).join('\n').slice(0, 1024),
      inline: false,
    });
  }

  embed.setFooter({ text: 'Marking work ready for the client is an internal check, not client approval.' });

  const components = [];
  if (includeButtons && task.state === TASK_STATES.INTERNAL_REVIEW) {
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(customId('review', 'ready', task.id))
        .setLabel('Ready for client')
        .setStyle(ButtonStyle.Success)
        .setEmoji('✅'),
      new ButtonBuilder()
        .setCustomId(customId('review', 'changes', task.id))
        .setLabel('Request changes')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('🔁')
    ));
  }

  return { embed, components, submission };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('review')
    .setDescription('Internal review and recording client decisions')
    .addSubcommand((sub) =>
      sub
        .setName('queue')
        .setDescription('Work waiting for your internal review')
        .addStringOption((opt) => opt.setName('department').setDescription('Department (defaults to yours)').setRequired(false).setAutocomplete(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('decide')
        .setDescription('Review one task: request changes or mark it ready for the client')
        .addStringOption((opt) => opt.setName('task').setDescription('Task code').setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('client')
        .setDescription("Record the client's decision after they replied to you")
        .addStringOption((opt) => opt.setName('task').setDescription('Task code').setRequired(true).setAutocomplete(true))
        .addStringOption((opt) =>
          opt.setName('decision').setDescription('What the client said').setRequired(true).addChoices(
            { name: 'Approved', value: 'approved' },
            { name: 'Revisions requested', value: 'revisions_requested' }
          )
        )
        .addStringOption((opt) => opt.setName('feedback').setDescription("The client's words, as close as possible").setRequired(false))
        .addStringOption((opt) => opt.setName('reference').setDescription('Message link or other supporting reference').setRequired(false))
        .addBooleanOption((opt) => opt.setName('out_of_scope').setDescription('Flag this as beyond the agreed revision scope').setRequired(false))
    )
    .addSubcommand((sub) =>
      sub
        .setName('awaiting-client')
        .setDescription('Work that has been sent to clients and has no decision yet')
    ),

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);
    const { db, guildId, actor } = contextFor(interaction);
    const query = String(focused.value || '').toLowerCase();

    if (focused.name === 'department') {
      const matches = configRepo.listDepartments(db, guildId)
        .filter((dept) => dept.key.includes(query) || dept.name.toLowerCase().includes(query))
        .slice(0, 25);
      await interaction.respond(matches.map((dept) => ({ name: dept.name, value: dept.key })));
      return;
    }

    const sub = interaction.options.getSubcommand();
    const states = sub === 'client'
      ? [TASK_STATES.AWAITING_CLIENT, TASK_STATES.CLIENT_APPROVED]
      : [TASK_STATES.INTERNAL_REVIEW];

    let candidates = tasksRepo.listTasksInStates(db, guildId, states);
    if (!actor.isOwner && actor.leadDepartmentIds.length > 0) {
      candidates = candidates.filter((task) => actor.leadDepartmentIds.includes(task.department_id));
    }

    const matches = candidates
      .filter((task) => !query || task.code.toLowerCase().includes(query) || task.title.toLowerCase().includes(query))
      .slice(0, 25);

    await interaction.respond(matches.map((task) => ({
      name: `${task.code} · ${task.title} · ${stateLabel(task.state)}`.slice(0, 100),
      value: task.code,
    })));
  },

  async execute(interaction) {
    const { db, guildId, actor, departments } = contextFor(interaction);
    const sub = interaction.options.getSubcommand();
    const userId = interaction.user.id;

    if (sub === 'queue') {
      const key = interaction.options.getString('department');
      let scoped = tasksRepo.listTasksInStates(db, guildId, [TASK_STATES.INTERNAL_REVIEW]);

      if (key) {
        const department = configRepo.getDepartmentByKey(db, guildId, key);
        if (!department) {
          await interaction.reply(priv('❌ No department with that key.'));
          return;
        }
        assertCan(actor, CAPABILITIES.REVIEW_INTERNAL, { departmentId: department.id });
        scoped = scoped.filter((task) => task.department_id === department.id);
      } else if (!actor.isOwner) {
        if (actor.leadDepartmentIds.length === 0) {
          await interaction.reply(priv('You do not run a department, so you have no review queue.'));
          return;
        }
        scoped = scoped.filter((task) => actor.leadDepartmentIds.includes(task.department_id));
      }

      if (scoped.length === 0) {
        await interaction.reply(priv('Nothing is waiting for internal review.'));
        return;
      }

      const embed = new EmbedBuilder()
        .setTitle('Awaiting your internal review')
        .setColor(0x9b59b6)
        .setDescription(scoped.map((task) => {
          const department = departments.find((dept) => dept.id === task.department_id);
          const submission = submissionsRepo.latestSubmission(db, task.id, { kind: 'final' });
          return `**${task.code}** ${task.title} · ${department?.name || '—'}` +
            `${task.artist_user_id ? ` · <@${task.artist_user_id}>` : ''}` +
            `${submission ? ` · submitted ${discordTimestamp(submission.submitted_at, 'R')}` : ''}`;
        }).join('\n').slice(0, 4000));

      const rows = scoped.slice(0, 5).map((task) => new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(customId('review', 'open', task.id))
          .setLabel(`Review ${task.code}`)
          .setStyle(ButtonStyle.Primary)
      ));

      await interaction.reply(priv({ embeds: [embed], components: rows }));
      return;
    }

    if (sub === 'awaiting-client') {
      const tasks = tasksRepo.listTasksInStates(db, guildId, [TASK_STATES.AWAITING_CLIENT]);
      const visible = actor.isOwner || can(actor, CAPABILITIES.CLIENT_RECORD)
        ? tasks
        : tasks.filter((task) => actor.leadDepartmentIds.includes(task.department_id));

      if (visible.length === 0) {
        await interaction.reply(priv('Nothing is waiting on a client right now.'));
        return;
      }

      await interaction.reply(priv({
        embeds: [new EmbedBuilder()
          .setTitle('Sent to clients, no decision recorded')
          .setColor(0x1abc9c)
          .setDescription(visible.map((task) => {
            const review = submissionsRepo.listReviews(db, task.id).filter((r) => r.decision === 'ready_for_client').pop();
            return `**${task.code}** ${task.title}${task.artist_user_id ? ` · <@${task.artist_user_id}>` : ''}` +
              `${review ? ` · ready since ${discordTimestamp(review.created_at, 'R')}` : ''}`;
          }).join('\n').slice(0, 4000))
          .setFooter({ text: 'Record what the client said with /review client' })],
      }));
      return;
    }

    const code = interaction.options.getString('task', true);
    const task = tasksRepo.getTaskByCode(db, guildId, code);
    if (!task) {
      await interaction.reply(priv(`❌ No task with code \`${code}\`.`));
      return;
    }

    if (sub === 'decide') {
      assertCan(actor, CAPABILITIES.REVIEW_INTERNAL, { departmentId: task.department_id });

      if (task.state !== TASK_STATES.INTERNAL_REVIEW) {
        await interaction.reply(priv(
          `**${task.code}** is ${stateLabel(task.state)}, not waiting for internal review.` +
          `${task.state === TASK_STATES.AWAITING_CLIENT ? '\nIt is already with the client — record their answer with `/review client`.' : ''}`
        ));
        return;
      }

      const panel = reviewPanel(db, guildId, task);
      await interaction.reply(priv({ embeds: [panel.embed], components: panel.components }));
      return;
    }

    if (sub === 'client') {
      // Owner-only by default: recording a client's decision is what finishes
      // a task, so it is deliberately not delegated unless explicitly granted.
      assertCan(actor, CAPABILITIES.CLIENT_RECORD, { departmentId: task.department_id });

      const decision = interaction.options.getString('decision', true);
      const feedback = interaction.options.getString('feedback');
      const reference = interaction.options.getString('reference');
      const outOfScopeFlag = interaction.options.getBoolean('out_of_scope') ?? false;

      const approving = decision === 'approved';
      const validFrom = approving
        ? [TASK_STATES.AWAITING_CLIENT]
        : [TASK_STATES.AWAITING_CLIENT, TASK_STATES.CLIENT_APPROVED];

      if (!validFrom.includes(task.state)) {
        await interaction.reply(priv(
          `❌ **${task.code}** is ${stateLabel(task.state)}. A client decision can only be recorded once the work has been sent for client review.`
        ));
        return;
      }

      if (!approving && !feedback) {
        await interaction.reply(priv('❌ Give the client\'s feedback so the artist knows what to change.'));
        return;
      }

      const submission = submissionsRepo.latestSubmission(db, task.id, { kind: 'final' });
      const roundsUsedBefore = submissionsRepo.revisionRoundsUsed(db, task.id);
      const agreedRounds = task.revision_rounds;
      const reopening = task.state === TASK_STATES.CLIENT_APPROVED;

      // Beyond the agreed rounds, or a change after sign-off, is the owner's
      // call on extra pay or a new task, so it is flagged rather than absorbed.
      const beyondScope = !approving && (
        outOfScopeFlag ||
        reopening ||
        (agreedRounds !== null && agreedRounds !== undefined && roundsUsedBefore >= agreedRounds)
      );

      const action = approving ? 'client_approve' : (reopening ? 'client_reopen' : 'client_request_revisions');

      const updated = db.transaction(() => {
        submissionsRepo.addClientDecision(db, guildId, task.id, {
          submissionId: submission?.id ?? null,
          decision,
          feedback,
          referenceUrl: reference,
          outOfScope: beyondScope,
          recordedBy: userId,
        });

        const moved = tasksRepo.applyTransition(db, guildId, task.id, action, {
          actorUserId: userId,
          detail: `Recorded by ${userId}${reference ? ` · ${reference}` : ''}`,
        });

        if (beyondScope) {
          tasksRepo.setFlag(db, guildId, task.id, 'scope', true, userId,
            'Client revision request falls outside the agreed scope');
        }
        return moved;
      })();

      // Approval can make the work payable, but only if the client's money is in.
      const afterPayment = approving
        ? recomputeTaskPaymentState(db, guildId, task.id, userId, 'Client approved the work')
        : updated;

      // Approval is also what can complete a bonus milestone. Nothing becomes
      // owed here: milestones are only flagged for the owner to decide.
      const earned = approving
        ? bonusFlow.evaluateForTask(db, guildId, afterPayment, { actorUserId: userId })
        : [];

      const project = projectsRepo.getProject(db, guildId, task.project_id);
      const lines = [
        approving
          ? `✅ Recorded: the client approved **${task.code} · ${task.title}**.`
          : `🔁 Recorded: the client asked for revisions on **${task.code} · ${task.title}**.`,
        `Recorded by you at ${discordTimestamp(Date.now(), 'F')}${reference ? ` · [reference](${reference})` : ''}.`,
      ];

      if (approving) {
        lines.push(
          afterPayment.payment_state === 'payable'
            ? '💰 Now **payable** — the client payment for this project is recorded as received.'
            : `💰 Payment stays **pending**: the client payment for ${project?.code} has not been recorded as received yet. ` +
              'Record it with `/pay client-receipt`, or override with `/pay mark-payable`.'
        );

        for (const { award, rule } of earned) {
          lines.push(`🏅 <@${award.user_id}> reached a milestone: ${rule.label}. Waiting on you — \`/bonuses pending\`.`);
        }
      } else {
        lines.push('The task is back with the artist.');
        if (beyondScope) {
          lines.push(
            `⚠️ Flagged as outside the agreed scope${agreedRounds !== null ? ` (${roundsUsedBefore + 1} of ${agreedRounds} agreed rounds used)` : ''}. ` +
            'Decide whether this needs extra pay or a new task.'
          );
        }
      }

      await interaction.reply(priv(lines.join('\n')));

      if (task.artist_user_id) {
        await notifyUser(interaction.client, db, guildId, task.artist_user_id, {
          content: approving
            ? `✅ The client approved your work on **${task.code} · ${task.title}**. Nothing more to do — payment is tracked separately.`
            : `🔁 The client asked for revisions on **${task.code} · ${task.title}**.\n> ${(feedback || '').slice(0, 500)}\n` +
              `${beyondScope ? 'This is flagged as beyond the agreed scope, so wait for the owner before doing extra work.\n' : ''}` +
              'Submit again with `/my-work submit` when it is ready.',
        }).catch(() => null);
      }

      if (task.leader_user_id && task.leader_user_id !== userId) {
        await notifyUser(interaction.client, db, guildId, task.leader_user_id, {
          content: approving
            ? `✅ Client approved **${task.code} · ${task.title}**.`
            : `🔁 Client requested revisions on **${task.code} · ${task.title}**${beyondScope ? ' (flagged out of scope)' : ''}.`,
        }).catch(() => null);
      }
    }
  },
};

module.exports.reviewPanel = reviewPanel;
