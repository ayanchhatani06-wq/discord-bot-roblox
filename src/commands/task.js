const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const tasksRepo = require('../db/repos/tasks');
const projectsRepo = require('../db/repos/projects');
const offersRepo = require('../db/repos/offers');
const configRepo = require('../db/repos/config');
const staffRepo = require('../db/repos/staff');
const { contextFor } = require('../services/actor');
const { taskEmbed, queueEmbed, taskSummaryLine, formatPay } = require('../services/taskView');
const { withdrawOffer, describeTerms } = require('../services/offerFlow');
const { notifyUser } = require('../services/notify');
const budget = require('../services/budget');
const { CAPABILITIES, assertCan, can, canViewTaskFinance, isAssignedArtist, PermissionError } = require('../domain/permissions');
const { ACTIVE_STATES, TASK_STATES, stateLabel } = require('../domain/taskState');
const { parseAmount, formatAmount, isSupportedCurrency, CURRENCIES } = require('../domain/money');
const { parseDeadlineInput, discordTimestamp } = require('../utils/time');
const { customId } = require('../interactions/router');
const { priv } = require('../utils/reply');

const CURRENCY_CHOICES = Object.keys(CURRENCIES).map((code) => ({ name: code, value: code }));

function resolveDeadline(db, guildId, userId, text) {
  const staff = staffRepo.getStaff(db, guildId, userId);
  if (!staff?.timezone) {
    return { ok: false, message: 'Set your timezone first with `/profile timezone` so deadlines can be read correctly.' };
  }

  const parsed = parseDeadlineInput(text, staff.timezone);
  if (!parsed.ok) {
    if (parsed.reason === 'nonexistent_local_time') {
      return { ok: false, message: `That local time does not exist in \`${staff.timezone}\` because the clocks skip it. Pick another time.` };
    }
    return { ok: false, message: `Could not read "${text}". Use \`YYYY-MM-DD\` or \`YYYY-MM-DD HH:MM\` (24-hour).` };
  }

  const notes = [`**${parsed.preview}**`];
  if (parsed.impliedEndOfDay) notes.push('end of day, since no time was given');
  if (parsed.ambiguous) notes.push('⚠️ this local time occurs twice today (clocks go back); the earlier was used');
  return { ok: true, utcMs: parsed.utcMs, note: notes.join(' — '), timezone: staff.timezone };
}

/** The task plus the permission context needed to act on it. */
function loadTask(db, guildId, code) {
  const task = tasksRepo.getTaskByCode(db, guildId, code);
  if (!task) return null;
  return {
    task,
    project: projectsRepo.getProject(db, guildId, task.project_id),
    department: configRepo.getDepartment(db, guildId, task.department_id),
  };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('task')
    .setDescription('Tasks, assignment and pay')
    .addSubcommand((sub) =>
      sub
        .setName('create')
        .setDescription('Create a single task')
        .addStringOption((opt) => opt.setName('project').setDescription('Project code').setRequired(true).setAutocomplete(true))
        .addStringOption((opt) => opt.setName('department').setDescription('Department').setRequired(true).setAutocomplete(true))
        .addStringOption((opt) => opt.setName('title').setDescription('Short title').setRequired(true))
        .addStringOption((opt) => opt.setName('brief').setDescription('What is needed').setRequired(false))
        .addStringOption((opt) => opt.setName('deadline').setDescription('YYYY-MM-DD [HH:MM] in your timezone').setRequired(false))
        .addStringOption((opt) => opt.setName('formats').setDescription('Required file formats').setRequired(false))
        .addStringOption((opt) => opt.setName('tech').setDescription('Technical requirements').setRequired(false))
        .addStringOption((opt) => opt.setName('references').setDescription('Reference links').setRequired(false))
        .addIntegerOption((opt) => opt.setName('revisions').setDescription('Agreed revision rounds').setMinValue(0).setRequired(false))
    )
    .addSubcommand((sub) =>
      sub
        .setName('view')
        .setDescription('Show a task')
        .addStringOption((opt) => opt.setName('task').setDescription('Task code').setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('queue')
        .setDescription('Unassigned tasks waiting for you to pick an artist')
        .addStringOption((opt) => opt.setName('department').setDescription('Department (defaults to yours)').setRequired(false).setAutocomplete(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('assign')
        .setDescription('Choose the artist for a task and send them the offer')
        .addStringOption((opt) => opt.setName('task').setDescription('Task code').setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('pay')
        .setDescription('Set pay (owner) or propose it (group leader)')
        .addStringOption((opt) => opt.setName('task').setDescription('Task code').setRequired(true).setAutocomplete(true))
        .addStringOption((opt) => opt.setName('amount').setDescription('Amount, e.g. 25 or 1500').setRequired(true))
        .addStringOption((opt) => opt.setName('currency').setDescription('Currency').addChoices(...CURRENCY_CHOICES).setRequired(false))
    )
    .addSubcommand((sub) =>
      sub
        .setName('approve-pay')
        .setDescription("Approve a leader's proposed pay (owner)")
        .addStringOption((opt) => opt.setName('task').setDescription('Task code').setRequired(true).setAutocomplete(true))
        .addStringOption((opt) => opt.setName('amount').setDescription('Override the proposed amount').setRequired(false))
        .addStringOption((opt) => opt.setName('currency').setDescription('Currency').addChoices(...CURRENCY_CHOICES).setRequired(false))
    )
    .addSubcommand((sub) =>
      sub
        .setName('edit')
        .setDescription('Change a task')
        .addStringOption((opt) => opt.setName('task').setDescription('Task code').setRequired(true).setAutocomplete(true))
        .addStringOption((opt) => opt.setName('title').setDescription('New title').setRequired(false))
        .addStringOption((opt) => opt.setName('brief').setDescription('New brief').setRequired(false))
        .addStringOption((opt) => opt.setName('deadline').setDescription('New deadline, YYYY-MM-DD [HH:MM] in your timezone').setRequired(false))
        .addStringOption((opt) => opt.setName('formats').setDescription('Required formats').setRequired(false))
        .addStringOption((opt) => opt.setName('tech').setDescription('Technical requirements').setRequired(false))
        .addStringOption((opt) => opt.setName('references').setDescription('Reference links').setRequired(false))
        .addStringOption((opt) => opt.setName('deliverables').setDescription('Deliverables, comma separated').setRequired(false))
        .addIntegerOption((opt) => opt.setName('revisions').setDescription('Agreed revision rounds').setMinValue(0).setRequired(false))
    )
    .addSubcommand((sub) =>
      sub
        .setName('withdraw')
        .setDescription('Take back an offer that has not been answered')
        .addStringOption((opt) => opt.setName('task').setDescription('Task code').setRequired(true).setAutocomplete(true))
        .addStringOption((opt) => opt.setName('reason').setDescription('Why').setRequired(false))
    )
    .addSubcommand((sub) => sub.setName('mine').setDescription('Your offers and current assignments')),

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);
    const { db, guildId, actor } = contextFor(interaction);
    const query = String(focused.value || '');

    if (focused.name === 'project') {
      const matches = query
        ? projectsRepo.searchProjects(db, guildId, query, 25)
        : projectsRepo.listProjects(db, guildId, { status: 'active', limit: 25 });
      await interaction.respond(matches.map((p) => ({ name: `${p.code} · ${p.name}`.slice(0, 100), value: p.code })));
      return;
    }

    if (focused.name === 'department') {
      const lower = query.toLowerCase();
      const matches = configRepo.listDepartments(db, guildId)
        .filter((dept) => dept.key.includes(lower) || dept.name.toLowerCase().includes(lower))
        .slice(0, 25);
      await interaction.respond(matches.map((dept) => ({ name: dept.name, value: dept.key })));
      return;
    }

    if (focused.name === 'task') {
      // Leaders see their own departments' tasks first; the owner sees everything.
      const departmentId = actor.isOwner || actor.leadDepartmentIds.length === 0 ? null : actor.leadDepartmentIds[0];
      const matches = tasksRepo.searchTasks(db, guildId, query, { departmentId, limit: 25 });
      await interaction.respond(matches.map((task) => ({
        name: `${task.code} · ${task.title} · ${stateLabel(task.state)}`.slice(0, 100),
        value: task.code,
      })));
    }
  },

  async execute(interaction) {
    const ctx = contextFor(interaction);
    const { db, guildId, config, actor, departments } = ctx;
    const sub = interaction.options.getSubcommand();
    const userId = interaction.user.id;

    if (sub === 'create') {
      assertCan(actor, CAPABILITIES.TASK_CREATE);

      const project = projectsRepo.getProjectByCode(db, guildId, interaction.options.getString('project', true));
      if (!project) {
        await interaction.reply(priv('❌ No project with that code.'));
        return;
      }

      const department = configRepo.getDepartmentByKey(db, guildId, interaction.options.getString('department', true));
      if (!department) {
        await interaction.reply(priv('❌ No department with that key.'));
        return;
      }

      let deadlineUtc = project.deadline_utc;
      let deadlineNote = null;
      const deadlineText = interaction.options.getString('deadline');
      if (deadlineText) {
        const deadline = resolveDeadline(db, guildId, userId, deadlineText);
        if (!deadline.ok) {
          await interaction.reply(priv(`❌ ${deadline.message}`));
          return;
        }
        deadlineUtc = deadline.utcMs;
        deadlineNote = `Deadline saved as ${deadline.note}`;
      }

      const task = tasksRepo.createTask(db, guildId, {
        projectId: project.id,
        title: interaction.options.getString('title', true),
        departmentId: department.id,
        brief: interaction.options.getString('brief') ?? project.brief,
        deliverables: configRepo.departmentChecklist(department),
        formats: interaction.options.getString('formats'),
        techRequirements: interaction.options.getString('tech'),
        referenceLinks: interaction.options.getString('references') ?? project.reference_links,
        deadlineUtc,
        revisionRounds: interaction.options.getInteger('revisions'),
      }, userId);

      await interaction.reply(priv([
        `✅ Created **${task.code} · ${task.title}** in **${department.name}**.`,
        deadlineNote,
        'It is in the department queue. Pay must be approved before it can be offered.',
      ].filter(Boolean).join('\n')));
      return;
    }

    if (sub === 'queue') {
      const key = interaction.options.getString('department');
      let department = null;

      if (key) {
        department = configRepo.getDepartmentByKey(db, guildId, key);
        if (!department) {
          await interaction.reply(priv('❌ No department with that key.'));
          return;
        }
      } else if (actor.leadDepartmentIds.length > 0) {
        department = departments.find((dept) => dept.id === actor.leadDepartmentIds[0]) || null;
      } else {
        const staff = staffRepo.getStaff(db, guildId, userId);
        department = staff?.department_id ? departments.find((d) => d.id === staff.department_id) || null : null;
      }

      if (!department) {
        await interaction.reply(priv('Name a department: `/task queue department:<name>`.'));
        return;
      }

      // Viewing a queue needs the right to offer work in it.
      assertCan(actor, CAPABILITIES.TASK_OFFER, { departmentId: department.id });

      const queue = tasksRepo.listQueue(db, guildId, department.id);
      const blocked = queue.filter((task) => !tasksRepo.isPayApproved(task)).length;

      // Discord allows five action rows, so only the five most urgent tasks get
      // a button; the embed still lists the whole queue.
      const rows = queue.slice(0, 5).map((queued) => new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(customId('assign', 'pick', queued.id))
          .setLabel(`Choose artist · ${queued.code}`)
          .setStyle(tasksRepo.isPayApproved(queued) ? ButtonStyle.Primary : ButtonStyle.Secondary)
          .setDisabled(!tasksRepo.isPayApproved(queued))
      ));

      await interaction.reply(priv({
        embeds: [queueEmbed({ department, tasks: queue, payWarnings: blocked })],
        components: rows,
      }));
      return;
    }

    if (sub === 'mine') {
      const pending = offersRepo.listPendingForArtist(db, guildId, userId);
      const assigned = tasksRepo.listTasksForArtist(db, guildId, userId, { states: ACTIVE_STATES });

      const embed = new EmbedBuilder().setTitle('Your work').setColor(0x5865f2);

      if (pending.length > 0) {
        embed.addFields({
          name: `Offers awaiting your answer (${pending.length})`,
          value: pending.map((offer) => {
            const task = tasksRepo.getTask(db, guildId, offer.task_id);
            const terms = offersRepo.terms(offer);
            return `**${task.code}** ${task.title}\n${describeTerms(terms)}`;
          }).join('\n\n').slice(0, 1024),
          inline: false,
        });
      }

      const active = assigned.filter((task) => task.state !== TASK_STATES.OFFERED);
      embed.addFields({
        name: `Active assignments (${active.length})`,
        value: active.length > 0
          ? active.map((task) => taskSummaryLine(task, { showPay: true })).join('\n').slice(0, 1024)
          : '_nothing in progress_',
        inline: false,
      });

      if (pending.length === 0 && active.length === 0) {
        embed.setDescription('No offers and no active tasks right now.');
      } else {
        embed.setFooter({ text: 'Answer offers from the message I sent you. Pay shown is your agreed amount.' });
      }

      await interaction.reply(priv({ embeds: [embed] }));
      return;
    }

    const code = interaction.options.getString('task', true);
    const loaded = loadTask(db, guildId, code);
    if (!loaded) {
      await interaction.reply(priv(`❌ No task with code \`${code}\`.`));
      return;
    }
    const { task, project, department } = loaded;

    if (sub === 'view') {
      const mayView = actor.isOwner
        || can(actor, CAPABILITIES.TASK_EDIT, { departmentId: task.department_id })
        || can(actor, CAPABILITIES.REVIEW_INTERNAL, { departmentId: task.department_id })
        || isAssignedArtist(actor, task)
        || can(actor, CAPABILITIES.FINANCE_VIEW_ALL);

      if (!mayView) {
        throw new PermissionError('task.view', 'You can only view tasks in a department you lead, or tasks assigned to you.');
      }

      const embed = taskEmbed({ task, project, department, actor });
      const history = offersRepo.offerHistory(db, task.id);
      if (history.length > 0) {
        embed.addFields({
          name: 'Offer history',
          value: history.map((offer) =>
            `${offer.state} · <@${offer.artist_user_id}> · ${discordTimestamp(offer.offered_at, 'd')}${offer.decline_reason ? ` — ${offer.decline_reason}` : ''}`
          ).join('\n').slice(0, 1024),
          inline: false,
        });
      }

      const unacknowledged = tasksRepo.unacknowledgedTermChanges(db, task.id);
      if (unacknowledged.length > 0) {
        embed.addFields({
          name: '⚠️ Changes awaiting the artist\'s acknowledgement',
          value: unacknowledged.map((change) => `${change.field}: ${change.old_value} → ${change.new_value}`).join('\n').slice(0, 1024),
          inline: false,
        });
      }

      await interaction.reply(priv({ embeds: [embed] }));
      return;
    }

    if (sub === 'assign') {
      assertCan(actor, CAPABILITIES.TASK_OFFER, { departmentId: task.department_id });

      if (task.state !== TASK_STATES.UNASSIGNED) {
        await interaction.reply(priv(
          `❌ **${task.code}** is ${stateLabel(task.state)}, not waiting for an artist.` +
          `${task.state === TASK_STATES.OFFERED ? ' Use `/task withdraw` first.' : ''}`
        ));
        return;
      }

      if (!tasksRepo.isPayApproved(task)) {
        await interaction.reply(priv(
          `❌ **${task.code}** has no approved pay yet, so it cannot be offered.\n` +
          `${task.pay_state === tasksRepo.PAY_STATES.PROPOSED
            ? `A proposal of ${formatAmount(task.pay_proposed_minor, task.pay_proposed_currency)} is waiting for the owner.`
            : 'Propose an amount with `/task pay`.'}`
        ));
        return;
      }

      await interaction.reply(priv({
        content: `Choose who to offer **${task.code} · ${task.title}** to.`,
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(customId('assign', 'pick', task.id))
            .setLabel('Choose artist')
            .setStyle(ButtonStyle.Primary)
        )],
      }));
      return;
    }

    if (sub === 'pay') {
      const mayApprove = can(actor, CAPABILITIES.TASK_PAY_APPROVE);
      const mayPropose = can(actor, CAPABILITIES.TASK_PAY_PROPOSE, { departmentId: task.department_id });
      if (!mayApprove && !mayPropose) {
        throw new PermissionError(CAPABILITIES.TASK_PAY_PROPOSE, 'You cannot set or propose pay for this task.');
      }

      const currency = interaction.options.getString('currency') || task.artist_pay_currency || config.default_currency;
      if (!isSupportedCurrency(currency)) {
        await interaction.reply(priv(`❌ Unsupported currency \`${currency}\`.`));
        return;
      }
      const amountMinor = parseAmount(interaction.options.getString('amount', true), currency);

      if (!mayApprove) {
        tasksRepo.proposePay(db, guildId, task.id, { amountMinor, currency, actorUserId: userId });
        await interaction.reply(priv(
          `✅ Proposed **${formatAmount(amountMinor, currency)}** for **${task.code}**. ` +
          'The owner must approve it before the task can be offered.'
        ));

        if (config.owner_user_id) {
          await notifyUser(interaction.client, db, guildId, config.owner_user_id, {
            content:
              `💰 <@${userId}> proposed **${formatAmount(amountMinor, currency)}** for **${task.code} · ${task.title}** (${department?.name}).\n` +
              `Approve with \`/task approve-pay task:${task.code}\`.`,
          }).catch(() => null);
        }
        return;
      }

      const check = budget.checkBudget(db, guildId, task, { amountMinor, currency });
      if (!check.ok) {
        await interaction.reply(priv(
          `❌ ${budget.describeBudgetFailure(check)}\n\n` +
          `Lower the figure, raise the recorded client payment, or allow it deliberately with ` +
          `\`/finance budget-override project:${check.project.code} reason:...\`.`
        ));
        return;
      }

      const { task: updated, requiresAcknowledgement } = tasksRepo.approvePay(db, guildId, task.id, {
        amountMinor, currency, actorUserId: userId,
      });

      await interaction.reply(priv(
        `✅ Agreed pay for **${updated.code}** is **${formatAmount(amountMinor, currency)}**.` +
        `${requiresAcknowledgement ? '\n⚠️ This task was already accepted at a different figure, so the artist has been asked to acknowledge the change.' : ''}` +
        `${updated.state === TASK_STATES.UNASSIGNED ? '\nIt can now be offered — `/task assign`.' : ''}`
      ));

      if (requiresAcknowledgement && updated.artist_user_id) {
        await notifyUser(interaction.client, db, guildId, updated.artist_user_id, {
          content:
            `⚠️ The agreed pay on **${updated.code} · ${updated.title}** changed to **${formatAmount(amountMinor, currency)}**.\n` +
            'This change is recorded. Reply to your group leader if you do not agree to it.',
        }).catch(() => null);
      }
      return;
    }

    if (sub === 'approve-pay') {
      assertCan(actor, CAPABILITIES.TASK_PAY_APPROVE);

      const amountText = interaction.options.getString('amount');
      // Keep the currency the leader proposed unless it is explicitly changed,
      // so approving a Robux proposal cannot silently record it as USD.
      const currency = interaction.options.getString('currency')
        || task.pay_proposed_currency
        || task.artist_pay_currency
        || config.default_currency;

      let amountMinor;
      if (amountText) {
        amountMinor = parseAmount(amountText, currency);
      } else if (task.pay_proposed_minor !== null) {
        amountMinor = task.pay_proposed_minor;
      } else {
        await interaction.reply(priv(`❌ **${task.code}** has no proposed pay. Give an amount: \`/task approve-pay task:${task.code} amount:25\`.`));
        return;
      }

      const check = budget.checkBudget(db, guildId, task, { amountMinor, currency });
      if (!check.ok) {
        await interaction.reply(priv(
          `❌ ${budget.describeBudgetFailure(check)}\n\n` +
          `Lower the figure, raise the recorded client payment, or allow it deliberately with ` +
          `\`/finance budget-override project:${check.project.code} reason:...\`.`
        ));
        return;
      }

      const { task: updated, requiresAcknowledgement } = tasksRepo.approvePay(db, guildId, task.id, {
        amountMinor,
        currency,
        actorUserId: userId,
      });

      await interaction.reply(priv(
        `✅ Approved **${formatPay(updated)}** for **${updated.code}**.` +
        `${task.pay_proposed_by ? ` Proposed by <@${task.pay_proposed_by}>.` : ''}` +
        `${requiresAcknowledgement ? '\n⚠️ The artist has been asked to acknowledge the change.' : ''}`
      ));

      if (task.pay_proposed_by && task.pay_proposed_by !== userId) {
        await notifyUser(interaction.client, db, guildId, task.pay_proposed_by, {
          content: `✅ Pay for **${updated.code} · ${updated.title}** approved at **${formatPay(updated)}**. You can offer it now: \`/task assign task:${updated.code}\`.`,
        }).catch(() => null);
      }
      return;
    }

    if (sub === 'edit') {
      assertCan(actor, CAPABILITIES.TASK_EDIT, { departmentId: task.department_id });

      const patch = {};
      const notes = [];

      for (const [option, column] of [
        ['title', 'title'],
        ['brief', 'brief'],
        ['formats', 'formats'],
        ['tech', 'tech_requirements'],
        ['references', 'reference_links'],
      ]) {
        const value = interaction.options.getString(option);
        if (value !== null) patch[column] = value;
      }

      const revisions = interaction.options.getInteger('revisions');
      if (revisions !== null) patch.revision_rounds = revisions;

      const deliverablesText = interaction.options.getString('deliverables');
      if (deliverablesText !== null) {
        patch.deliverables_json = JSON.stringify(deliverablesText.split(',').map((item) => item.trim()).filter(Boolean));
      }

      const deadlineText = interaction.options.getString('deadline');
      if (deadlineText !== null) {
        const deadline = resolveDeadline(db, guildId, userId, deadlineText);
        if (!deadline.ok) {
          await interaction.reply(priv(`❌ ${deadline.message}`));
          return;
        }
        patch.deadline_utc = deadline.utcMs;
        notes.push(`Deadline saved as ${deadline.note}`);
      }

      if (Object.keys(patch).length === 0) {
        await interaction.reply(priv('Nothing to change.'));
        return;
      }

      // Changing agreed terms after acceptance is recorded for the artist to
      // acknowledge, rather than quietly replacing what they agreed to.
      const acceptedAndMaterial = task.accepted_at &&
        (patch.deadline_utc !== undefined || patch.revision_rounds !== undefined || patch.deliverables_json !== undefined);

      const updated = tasksRepo.updateTask(db, guildId, task.id, patch, userId);

      if (acceptedAndMaterial) {
        if (patch.deadline_utc !== undefined) {
          tasksRepo.recordTermChange(db, task.id, {
            field: 'deadline', oldValue: task.deadline_utc, newValue: patch.deadline_utc, changedBy: userId,
          });
        }
        if (patch.revision_rounds !== undefined) {
          tasksRepo.recordTermChange(db, task.id, {
            field: 'revision_rounds', oldValue: task.revision_rounds, newValue: patch.revision_rounds, changedBy: userId,
          });
        }
        if (patch.deliverables_json !== undefined) {
          tasksRepo.recordTermChange(db, task.id, {
            field: 'deliverables', oldValue: task.deliverables_json, newValue: patch.deliverables_json, changedBy: userId,
          });
        }

        if (updated.artist_user_id) {
          await notifyUser(interaction.client, db, guildId, updated.artist_user_id, {
            content:
              `⚠️ Terms changed on **${updated.code} · ${updated.title}** after you accepted it.\n` +
              `${notes.join('\n')}\nThe change is recorded. Speak to your leader if it does not work for you.`,
          }).catch(() => null);
        }
        notes.push('The artist has been told, and the change is recorded for acknowledgement.');
      }

      await interaction.reply(priv([`✅ Updated **${updated.code}**.`, ...notes].join('\n')));
      return;
    }

    if (sub === 'withdraw') {
      assertCan(actor, CAPABILITIES.TASK_OFFER, { departmentId: task.department_id });

      const result = await withdrawOffer(interaction.client, db, {
        guildId,
        taskId: task.id,
        actorUserId: userId,
        reason: interaction.options.getString('reason'),
      });

      await interaction.reply(priv(
        result.ok
          ? `✅ Offer for **${task.code}** withdrawn and back in your queue.`
          : `❌ Nothing to withdraw: ${result.reason === 'no_pending_offer' ? 'there is no unanswered offer on that task.' : 'it was just answered.'}`
      ));
    }
  },
};
