const {
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  EmbedBuilder,
} = require('discord.js');
const { getDatabase } = require('../db');
const clientsRepo = require('../db/repos/clients');
const tasksRepo = require('../db/repos/tasks');
const projectsRepo = require('../db/repos/projects');
const configRepo = require('../db/repos/config');
const submissionsRepo = require('../db/repos/submissions');
const clientReport = require('../services/clientReport');
const dashboard = require('../services/clientDashboard');
const paymentState = require('../services/paymentState');
const { notifyUser } = require('../services/notify');
const { register, customId } = require('./router');
const { TASK_STATES } = require('../domain/taskState');
const { discordTimestamp } = require('../utils/time');
const { priv } = require('../utils/reply');

const NAMESPACE = dashboard.NAMESPACE;

/**
 * Client controls are used inside a ticket channel, so the guild is taken from
 * the interaction when present and otherwise recovered from the project. Access
 * is always re-checked against client_accounts — never inferred from where the
 * button was clicked.
 */
function loadProject(interaction, projectId) {
  const db = getDatabase();
  const row = db.prepare('SELECT guild_id FROM projects WHERE id = ?').get(projectId);
  if (!row) return { db, guildId: null, access: { ok: false, reason: 'not_found' } };

  const guildId = row.guild_id;
  const access = clientsRepo.authorizeProjectAccess(db, guildId, projectId, interaction.user.id);
  return { db, guildId, access };
}

function loadTask(interaction, taskId) {
  const db = getDatabase();
  const row = db.prepare('SELECT guild_id, project_id FROM tasks WHERE id = ?').get(taskId);
  if (!row) return { db, guildId: null, access: { ok: false, reason: 'not_found' } };

  const access = clientsRepo.authorizeProjectAccess(db, row.guild_id, row.project_id, interaction.user.id);
  return { db, guildId: row.guild_id, projectId: row.project_id, access };
}

function feedbackModal(action, taskId, submissionId, title) {
  return new ModalBuilder()
    .setCustomId(customId(NAMESPACE, action, taskId, submissionId))
    .setTitle(title)
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('body')
          .setLabel('What would you like changed?')
          .setPlaceholder('Be as specific as you can — this goes straight to the team.')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(1500)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('references')
          .setLabel('Reference links (optional, one per line)')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(600)
      )
    );
}

function requestModal(kind, projectId, { title, label, placeholder }) {
  return new ModalBuilder()
    .setCustomId(customId(NAMESPACE, kind, projectId))
    .setTitle(title)
    .addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('body')
        .setLabel(label)
        .setPlaceholder(placeholder)
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(1500)
    ));
}

/** Tells the people responsible, without exposing them to the client. */
async function notifyStaffOfRequest(interaction, db, guildId, { project, request, headline }) {
  const config = configRepo.getConfig(db, guildId);
  const recipients = new Set([config?.owner_user_id, project.manager_user_id].filter(Boolean));

  for (const userId of recipients) {
    await notifyUser(interaction.client, db, guildId, userId, {
      content:
        `${headline}\n**${project.code} · ${project.name}** — from <@${interaction.user.id}>\n` +
        `> ${request.body.slice(0, 800)}\n` +
        `${request.attachments ? `References: ${request.attachments}\n` : ''}` +
        `Handle it with \`/clients requests\`.`,
    }).catch(() => null);
  }
}

register(NAMESPACE, async (interaction, { action, args }) => {
  // Approval and revision controls are keyed by task; everything else by project.
  const taskScoped = ['approve', 'revise', 'reviseModal', 'approveConfirm'];
  const isTaskScoped = taskScoped.includes(action);

  const loaded = isTaskScoped ? loadTask(interaction, Number(args[0])) : loadProject(interaction, Number(args[0]));
  const { db, guildId, access } = loaded;

  if (!access.ok) {
    await interaction.reply(priv(
      access.reason === 'not_found'
        ? '❌ That order no longer exists.'
        : '❌ This control is not for your account. If you should have access, ask the studio to add you.'
    ));
    return;
  }

  const project = isTaskScoped
    ? projectsRepo.getProject(db, guildId, loaded.projectId)
    : access.project;

  if (action === 'progress') {
    const report = clientReport.buildProjectReport(db, guildId, project);
    clientsRepo.logQuestion(db, guildId, {
      projectId: project.id, clientId: project.client_id, askedBy: interaction.user.id,
      kind: 'view_progress', answerSummary: clientReport.describeCounts(report),
    });

    await interaction.reply(priv({
      embeds: [dashboard.dashboardEmbed(report)],
      components: dashboard.dashboardComponents(project.id, {
        hasPreviews: report.previews.length > 0,
        canApprove: access.canApprove,
        hasDelivered: report.counts[clientReport.BUCKETS.APPROVED_BY_YOU] + report.counts[clientReport.BUCKETS.DELIVERED] > 0,
      }),
    }));
    return;
  }

  if (action === 'issue') {
    const report = clientReport.buildProjectReport(db, guildId, project);
    // A problem can only be reported against something the client actually
    // has: work they approved or that was delivered to them.
    const reportable = tasksRepo.listTasksForProject(db, project.id).filter((task) =>
      task.delivered_at || task.state === TASK_STATES.CLIENT_APPROVED
    );

    if (reportable.length === 0) {
      await interaction.reply(priv(
        'There is nothing delivered or approved on this order yet, so there is nothing to report a problem with. ' +
        'Use **Request Changes** for work still in review, or **Contact Manager** for anything else.'
      ));
      return;
    }

    await interaction.reply(priv({
      content: 'Which item has the problem?',
      components: [new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(customId(NAMESPACE, 'issueItem', project.id))
          .setPlaceholder('Choose the item')
          .addOptions(reportable.slice(0, 25).map((task) => ({
            label: task.title.slice(0, 100),
            value: String(task.id),
            description: (task.delivered_at ? 'delivered' : 'approved by you').slice(0, 100),
          })))
      )],
    }));
    return;
  }

  if (action === 'issueItem') {
    const taskId = Number(interaction.values[0]);
    await interaction.showModal(
      new ModalBuilder()
        .setCustomId(customId(NAMESPACE, 'issueModal', project.id, taskId))
        .setTitle('Report a problem')
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('body')
              .setLabel('What is wrong with it?')
              .setPlaceholder('What you received, what you expected, and how it differs.')
              .setStyle(TextInputStyle.Paragraph)
              .setRequired(true)
              .setMaxLength(1500)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('references')
              .setLabel('Screenshots or links (optional)')
              .setStyle(TextInputStyle.Paragraph)
              .setRequired(false)
              .setMaxLength(600)
          )
        )
    );
    return;
  }

  if (action === 'issueModal') {
    const taskId = Number(args[1]);
    const task = tasksRepo.getTask(db, guildId, taskId);
    if (!task || task.project_id !== project.id) {
      await interaction.reply(priv('❌ That item is not on this order.'));
      return;
    }

    const body = interaction.fields.getTextInputValue('body').trim();
    const references = interaction.fields.getTextInputValue('references').trim() || null;

    const request = clientsRepo.createRequest(db, guildId, {
      projectId: project.id,
      taskId: task.id,
      clientId: project.client_id,
      raisedBy: interaction.user.id,
      kind: 'delivery_issue',
      body,
      attachments: references,
    });

    await interaction.reply(priv(
      `✅ Reported against **${task.title}**. The studio has been told.\n` +
      'Someone will look at whether this is a correction we owe you or work beyond what was agreed, ' +
      'and come back to you. Nothing on your order has changed yet.'
    ));

    await notifyStaffOfRequest(interaction, db, guildId, {
      project,
      request,
      headline: `⚠️ A client has reported a problem with **${task.code} · ${task.title}**`,
    });

    // The leader of the department that produced it is told too, since they
    // will usually be the one to judge whether it is in scope.
    if (task.leader_user_id) {
      await notifyUser(interaction.client, db, guildId, task.leader_user_id, {
        content:
          `⚠️ Problem reported on **${task.code} · ${task.title}**:\n> ${body.slice(0, 800)}\n` +
          `${references ? `References: ${references}\n` : ''}` +
          `Triage it with \`/issues decide id:${request.id}\`.`,
      }).catch(() => null);
    }
    return;
  }

  if (action === 'previews') {
    const report = clientReport.buildProjectReport(db, guildId, project);
    clientsRepo.logQuestion(db, guildId, {
      projectId: project.id, clientId: project.client_id, askedBy: interaction.user.id,
      kind: 'view_previews', answerSummary: `${report.previews.length} released`,
    });

    const components = [];
    if (access.canApprove) {
      // One approval row per reviewable item, up to Discord's five-row limit.
      for (const entry of report.awaitingApproval.slice(0, 4)) {
        const [row] = dashboard.approvalComponents(entry.taskId, entry.submissionId);
        row.components.forEach((button) => {
          const label = button.data.label.includes('Approve') ? `Approve ${entry.title}` : `Changes: ${entry.title}`;
          button.setLabel(label.slice(0, 80));
        });
        components.push(row);
      }
    }

    await interaction.reply(priv({
      content: access.canApprove
        ? null
        : 'Your account can view this order but is not authorised to approve items.',
      embeds: dashboard.previewEmbeds(report),
      components,
    }));
    return;
  }

  if (action === 'deliverables') {
    const report = clientReport.buildProjectReport(db, guildId, project);
    await interaction.reply(priv({ embeds: [dashboard.deliverablesEmbed(db, guildId, report)] }));
    return;
  }

  if (action === 'ask') {
    await interaction.reply(priv({
      content: 'Pick a question. Answers come from your order records, and asking never changes anything.',
      components: [dashboard.questionMenu(project.id)],
    }));
    return;
  }

  if (action === 'question') {
    const kind = interaction.values[0];
    const report = clientReport.buildProjectReport(db, guildId, project);
    const answer = clientReport.answerQuestion(kind, report);

    if (!answer) {
      await interaction.reply(priv('❌ I do not have a recorded answer for that. Use **Contact Manager**.'));
      return;
    }

    clientsRepo.logQuestion(db, guildId, {
      projectId: project.id, clientId: project.client_id, askedBy: interaction.user.id,
      kind, question: answer.label, answerSummary: answer.body.slice(0, 500),
    });

    const embed = new EmbedBuilder()
      .setTitle(answer.label)
      .setColor(0x1abc9c)
      .setDescription(answer.body);

    // Where the honest answer is "that is not recorded", offer the human route
    // rather than filling the gap with a guess.
    const needsManager = kind === 'delivery_date' && !report.deadlineUtc;
    await interaction.reply(priv({
      embeds: [embed],
      components: needsManager
        ? [new ActionRowBuilder().addComponents(
            ...dashboard.dashboardComponents(project.id, { hasPreviews: false, canApprove: false })[2].components
          )]
        : [],
    }));
    return;
  }

  if (action === 'changes') {
    const report = clientReport.buildProjectReport(db, guildId, project);

    // A change request against a specific released item is bound to it; a
    // general one is recorded against the project.
    if (report.awaitingApproval.length > 0 && access.canApprove) {
      await interaction.reply(priv({
        content: 'Which item needs changing? Use the buttons under **View Previews** to tie your feedback to a specific version, or describe a general change below.',
        components: [new ActionRowBuilder().addComponents(
          ...dashboard.approvalComponents(report.awaitingApproval[0].taskId, report.awaitingApproval[0].submissionId)[0].components
            .filter((button) => button.data.custom_id.includes(':revise:'))
        )],
      }));
      return;
    }

    await interaction.showModal(requestModal('changesModal', project.id, {
      title: 'Request changes',
      label: 'What would you like changed?',
      placeholder: 'Describe the change. It goes to the studio, not to a specific artist.',
    }));
    return;
  }

  if (action === 'changesModal' || action === 'serviceModal' || action === 'managerModal') {
    const kindByAction = {
      changesModal: 'change_request',
      serviceModal: 'new_service',
      managerModal: 'contact_manager',
    };
    const headlineByAction = {
      changesModal: '🔁 A client has requested changes',
      serviceModal: '➕ A client has asked about more work',
      managerModal: '📨 A client has a message for the manager',
    };

    const body = interaction.fields.getTextInputValue('body').trim();
    const request = clientsRepo.createRequest(db, guildId, {
      projectId: project.id,
      clientId: project.client_id,
      raisedBy: interaction.user.id,
      kind: kindByAction[action],
      body,
    });

    await notifyStaffOfRequest(interaction, db, guildId, {
      project, request, headline: headlineByAction[action],
    });

    await interaction.reply(priv(
      `✅ Sent to the studio.${action === 'serviceModal' ? ' Any price or delivery date will be confirmed by the owner before anything is agreed.' : ''}\n` +
      'Your order records are unchanged — a person will action this.'
    ));
    return;
  }

  if (action === 'service') {
    await interaction.showModal(requestModal('serviceModal', project.id, {
      title: 'Request another service',
      label: 'What else would you like?',
      placeholder: 'e.g. rigging for the models, or 3 more VFX. Quantities help.',
    }));
    return;
  }

  if (action === 'manager') {
    await interaction.showModal(requestModal('managerModal', project.id, {
      title: 'Contact the manager',
      label: 'Your message',
      placeholder: 'Anything the buttons do not cover.',
    }));
    return;
  }

  // --- version-bound approvals -------------------------------------------

  const taskId = Number(args[0]);
  const submissionId = Number(args[1]);
  const task = tasksRepo.getTask(db, guildId, taskId);
  const submission = submissionsRepo.getSubmission(db, submissionId);

  if (!task || !submission || submission.task_id !== task.id) {
    await interaction.reply(priv('❌ That item or version no longer exists.'));
    return;
  }

  if (!access.canApprove) {
    await interaction.reply(priv('❌ Your account can view this order but is not authorised to approve items.'));
    return;
  }

  // An approval is bound to the exact version it was shown for. If a newer
  // version has since been released, the old button is refused rather than
  // approving work the client has not seen.
  const latestVisible = clientReport.clientVisibleSubmission(db, task.id);
  if (latestVisible && latestVisible.id !== submission.id) {
    await interaction.reply(priv(
      `❌ This button is for version ${submission.version}, but version ${latestVisible.version} has since been released. ` +
      'Open **View Previews** again to see the current one.'
    ));
    return;
  }

  if (task.state !== TASK_STATES.AWAITING_CLIENT) {
    await interaction.reply(priv(
      task.state === TASK_STATES.CLIENT_APPROVED
        ? `**${task.title}** is already approved — nothing more is needed from you.`
        : `**${task.title}** is not waiting on your decision at the moment.`
    ));
    return;
  }

  if (action === 'revise') {
    await interaction.showModal(feedbackModal('reviseModal', taskId, submissionId, 'Request changes'));
    return;
  }

  if (action === 'approve') {
    const decided = db.transaction(() => {
      submissionsRepo.addClientDecision(db, guildId, task.id, {
        submissionId: submission.id,
        decision: 'approved',
        feedback: null,
        referenceUrl: null,
        recordedBy: interaction.user.id,
      });

      return tasksRepo.applyTransition(db, guildId, task.id, 'client_approve', {
        actorUserId: interaction.user.id,
        guardKey: `client-approve:${task.id}:${submission.id}`,
        detail: `Approved by client account ${interaction.user.id} on version ${submission.version}`,
      });
    })();

    const afterPayment = paymentState.recomputeTaskPaymentState(db, guildId, task.id, interaction.user.id, 'Client approved');
    const report = clientReport.buildProjectReport(db, guildId, project);

    await interaction.reply(priv(
      `✅ **${task.title}** (version ${submission.version}) approved. Thank you.\n` +
      `This approves that item only — ${report.counts[clientReport.BUCKETS.AWAITING_YOUR_APPROVAL]} other item(s) on this order still await your review.`
    ));

    // The artist and their leader are told; the client never sees who they are.
    for (const userId of new Set([task.artist_user_id, task.leader_user_id].filter(Boolean))) {
      await notifyUser(interaction.client, db, guildId, userId, {
        content:
          `✅ The client approved **${task.code} · ${task.title}** (version ${submission.version}) ` +
          `at ${discordTimestamp(Date.now(), 'f')}.` +
          `${userId === task.leader_user_id && afterPayment?.payment_state === 'pending_client_payment'
            ? '\nPayout stays pending until the client payment is recorded as received.' : ''}`,
      }).catch(() => null);
    }

    const config = configRepo.getConfig(db, guildId);
    if (config?.owner_user_id) {
      await notifyUser(interaction.client, db, guildId, config.owner_user_id, {
        content: `✅ Client approved **${task.code} · ${task.title}** (v${submission.version}). Payment state: ${afterPayment?.payment_state.replace(/_/g, ' ')}.`,
      }).catch(() => null);
    }
    return;
  }

  if (action === 'reviseModal') {
    const body = interaction.fields.getTextInputValue('body').trim();
    const references = interaction.fields.getTextInputValue('references').trim() || null;
    const roundsUsed = submissionsRepo.revisionRoundsUsed(db, task.id);
    const agreedRounds = task.revision_rounds;
    const beyondScope = agreedRounds !== null && agreedRounds !== undefined && roundsUsed >= agreedRounds;

    const updated = db.transaction(() => {
      submissionsRepo.addClientDecision(db, guildId, task.id, {
        submissionId: submission.id,
        decision: 'revisions_requested',
        feedback: body,
        referenceUrl: references,
        outOfScope: beyondScope,
        recordedBy: interaction.user.id,
      });

      const moved = tasksRepo.applyTransition(db, guildId, task.id, 'client_request_revisions', {
        actorUserId: interaction.user.id,
        guardKey: `client-revise:${task.id}:${submission.id}`,
        detail: `Changes requested by client account on version ${submission.version}`,
      });

      clientsRepo.createRequest(db, guildId, {
        projectId: project.id,
        taskId: task.id,
        clientId: project.client_id,
        raisedBy: interaction.user.id,
        kind: 'change_request',
        body,
        attachments: references,
      });

      if (beyondScope) {
        tasksRepo.setFlag(db, guildId, task.id, 'scope', true, interaction.user.id,
          'Client change request beyond the agreed revision rounds');
      }
      return moved;
    })();

    await interaction.reply(priv(
      `✅ Your change request for **${task.title}** has been sent to the team.\n` +
      `${beyondScope
        ? 'This is beyond the revision rounds agreed on this item, so the studio owner will confirm whether it needs a separate quote before work starts.'
        : 'They will revise it and send you a new version to review.'}\n` +
      'Other items on your order are unaffected.'
    ));

    for (const userId of new Set([updated.artist_user_id, updated.leader_user_id].filter(Boolean))) {
      await notifyUser(interaction.client, db, guildId, userId, {
        content:
          `🔁 The client requested changes on **${updated.code} · ${updated.title}** (version ${submission.version}):\n` +
          `> ${body.slice(0, 800)}\n` +
          `${references ? `References: ${references}\n` : ''}` +
          `${beyondScope ? '⚠️ Beyond the agreed revision rounds — wait for the owner before doing the work.\n' : ''}` +
          `Resubmit with \`/work submit task:${updated.code}\`.`,
      }).catch(() => null);
    }

    const config = configRepo.getConfig(db, guildId);
    if (beyondScope && config?.owner_user_id) {
      await notifyUser(interaction.client, db, guildId, config.owner_user_id, {
        content:
          `⚠️ Client change request on **${updated.code} · ${updated.title}** is beyond the agreed ` +
          `${agreedRounds} revision round(s). Decide whether it is in scope or a new paid task — \`/manage flags\`.`,
      }).catch(() => null);
    }
    return;
  }

  await interaction.reply(priv('❌ Unknown action.'));
});

module.exports = { NAMESPACE };
