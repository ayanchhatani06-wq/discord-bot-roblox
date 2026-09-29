const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const planningRepo = require('../db/repos/planning');
const tasksRepo = require('../db/repos/tasks');
const projectsRepo = require('../db/repos/projects');
const configRepo = require('../db/repos/config');
const staffRepo = require('../db/repos/staff');
const { contextFor } = require('../services/actor');
const { checkTaskReadiness, describeReadiness } = require('../services/readiness');
const { notifyUser } = require('../services/notify');
const { CAPABILITIES, assertCan, can, PermissionError } = require('../domain/permissions');
const { stateLabel } = require('../domain/taskState');
const { parseDeadlineInput, discordTimestamp, DAY_MS } = require('../utils/time');
const { priv } = require('../utils/reply');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('plan')
    .setDescription('Templates, dependencies, blockers and deadline changes')
    .addSubcommand((sub) =>
      sub
        .setName('template')
        .setDescription('Save a reusable task template')
        .addStringOption((opt) => opt.setName('key').setDescription('Short key, e.g. character-model').setRequired(true))
        .addStringOption((opt) => opt.setName('department').setDescription('Department').setRequired(true).setAutocomplete(true))
        .addStringOption((opt) => opt.setName('label').setDescription('Display name').setRequired(true))
        .addStringOption((opt) => opt.setName('brief').setDescription('Default brief').setRequired(false))
        .addStringOption((opt) => opt.setName('deliverables').setDescription('Comma separated').setRequired(false))
        .addStringOption((opt) => opt.setName('formats').setDescription('Required formats').setRequired(false))
        .addStringOption((opt) => opt.setName('tech').setDescription('Technical requirements').setRequired(false))
        .addIntegerOption((opt) => opt.setName('revisions').setDescription('Revision rounds').setMinValue(0).setRequired(false))
        .addIntegerOption((opt) => opt.setName('days').setDescription('Typical working days').setMinValue(1).setRequired(false))
    )
    .addSubcommand((sub) => sub.setName('templates').setDescription('Saved task templates'))
    .addSubcommand((sub) =>
      sub
        .setName('batch')
        .setDescription('Create several tasks from a template')
        .addStringOption((opt) => opt.setName('project').setDescription('Project code').setRequired(true).setAutocomplete(true))
        .addStringOption((opt) => opt.setName('template').setDescription('Template key').setRequired(true).setAutocomplete(true))
        .addIntegerOption((opt) => opt.setName('count').setDescription('How many').setRequired(true).setMinValue(1).setMaxValue(50))
        .addStringOption((opt) => opt.setName('deadline').setDescription('Deadline, YYYY-MM-DD').setRequired(false))
    )
    .addSubcommand((sub) =>
      sub
        .setName('depends')
        .setDescription('Record that one task needs another finished first')
        .addStringOption((opt) => opt.setName('task').setDescription('The task that waits').setRequired(true).setAutocomplete(true))
        .addStringOption((opt) => opt.setName('needs').setDescription('The task it needs first').setRequired(true).setAutocomplete(true))
        .addStringOption((opt) => opt.setName('note').setDescription('What it needs from it').setRequired(false))
    )
    .addSubcommand((sub) =>
      sub
        .setName('undepend')
        .setDescription('Remove a dependency')
        .addStringOption((opt) => opt.setName('task').setDescription('The task that waits').setRequired(true).setAutocomplete(true))
        .addStringOption((opt) => opt.setName('needs').setDescription('The prerequisite to detach').setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('chain')
        .setDescription('Show what a task waits on and what waits on it')
        .addStringOption((opt) => opt.setName('task').setDescription('Task code').setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((sub) => sub.setName('risks').setDescription('Work whose prerequisite is late'))
    .addSubcommand((sub) =>
      sub
        .setName('ready')
        .setDescription('Check whether a task is complete enough to offer')
        .addStringOption((opt) => opt.setName('task').setDescription('Task code').setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((sub) => sub.setName('blockers').setDescription('Open blockers across your departments'))
    .addSubcommand((sub) =>
      sub
        .setName('clear-blocker')
        .setDescription('Mark a blocker resolved')
        .addIntegerOption((opt) => opt.setName('id').setDescription('Blocker id').setRequired(true))
        .addStringOption((opt) => opt.setName('note').setDescription('How it was resolved').setRequired(false))
    )
    .addSubcommand((sub) =>
      sub
        .setName('extend')
        .setDescription('Request a later deadline for a task')
        .addStringOption((opt) => opt.setName('task').setDescription('Task code').setRequired(true).setAutocomplete(true))
        .addStringOption((opt) => opt.setName('new_deadline').setDescription('YYYY-MM-DD [HH:MM] in your timezone').setRequired(true))
        .addStringOption((opt) => opt.setName('reason').setDescription('Why').setRequired(true))
    )
    .addSubcommand((sub) => sub.setName('extensions').setDescription('Deadline requests waiting on a decision'))
    .addSubcommand((sub) =>
      sub
        .setName('decide-extension')
        .setDescription('Approve or decline a deadline request')
        .addIntegerOption((opt) => opt.setName('id').setDescription('Request id').setRequired(true))
        .addBooleanOption((opt) => opt.setName('approve').setDescription('Approve it').setRequired(true))
        .addStringOption((opt) => opt.setName('note').setDescription('Note for the requester').setRequired(false))
    ),

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

    if (focused.name === 'template') {
      const lower = query.toLowerCase();
      const matches = planningRepo.listTemplates(db, guildId)
        .filter((row) => row.key.includes(lower) || row.label.toLowerCase().includes(lower))
        .slice(0, 25);
      await interaction.respond(matches.map((row) => ({ name: `${row.label} (${row.key})`.slice(0, 100), value: row.key })));
      return;
    }

    const departmentId = actor.isOwner || actor.leadDepartmentIds.length === 0 ? null : actor.leadDepartmentIds[0];
    const matches = tasksRepo.searchTasks(db, guildId, query, { departmentId, limit: 25 });
    await interaction.respond(matches.map((task) => ({
      name: `${task.code} · ${task.title} · ${stateLabel(task.state)}`.slice(0, 100),
      value: task.code,
    })));
  },

  async execute(interaction) {
    const { db, guildId, actor } = contextFor(interaction);
    const sub = interaction.options.getSubcommand();
    const userId = interaction.user.id;

    if (sub === 'templates') {
      const templates = planningRepo.listTemplates(db, guildId);
      await interaction.reply(priv({
        embeds: [new EmbedBuilder()
          .setTitle('Task templates')
          .setColor(0x5865f2)
          .setDescription(templates.length === 0
            ? 'None yet. Save one with `/plan template`.'
            : templates.map((row) => {
                const department = configRepo.getDepartment(db, guildId, row.department_id);
                return `**${row.label}** (\`${row.key}\`) — ${department?.name || 'no department'}` +
                  `${row.default_days ? ` · ${row.default_days} day(s)` : ''}` +
                  `\n┗ ${planningRepo.templateDeliverables(row).join(', ') || 'no deliverables listed'}`;
              }).join('\n').slice(0, 4000))],
      }));
      return;
    }

    if (sub === 'template') {
      assertCan(actor, CAPABILITIES.TASK_CREATE);

      const department = configRepo.getDepartmentByKey(db, guildId, interaction.options.getString('department', true));
      if (!department) {
        await interaction.reply(priv('❌ No department with that key.'));
        return;
      }

      const deliverablesText = interaction.options.getString('deliverables');
      const template = planningRepo.upsertTemplate(db, guildId, {
        key: interaction.options.getString('key', true).trim().toLowerCase(),
        label: interaction.options.getString('label', true),
        departmentId: department.id,
        brief: interaction.options.getString('brief'),
        deliverables: deliverablesText
          ? deliverablesText.split(',').map((item) => item.trim()).filter(Boolean)
          : configRepo.departmentChecklist(department),
        formats: interaction.options.getString('formats'),
        techRequirements: interaction.options.getString('tech'),
        revisionRounds: interaction.options.getInteger('revisions'),
        defaultDays: interaction.options.getInteger('days'),
      }, userId);

      await interaction.reply(priv(
        `✅ Saved template **${template.label}** (\`${template.key}\`) for ${department.name}.\n` +
        `Create work from it with \`/plan batch template:${template.key} count:5\`.`
      ));
      return;
    }

    if (sub === 'batch') {
      assertCan(actor, CAPABILITIES.TASK_CREATE);

      const project = projectsRepo.getProjectByCode(db, guildId, interaction.options.getString('project', true));
      const template = planningRepo.getTemplate(db, guildId, interaction.options.getString('template', true));
      if (!project || !template) {
        await interaction.reply(priv('❌ No project or template with that code.'));
        return;
      }

      const count = interaction.options.getInteger('count', true);
      const deadlineText = interaction.options.getString('deadline');
      let deadlineUtc = project.deadline_utc;

      if (deadlineText) {
        const timezone = staffRepo.getStaff(db, guildId, userId)?.timezone;
        if (!timezone) {
          await interaction.reply(priv('❌ Set your timezone with `/profile timezone` first.'));
          return;
        }
        const parsed = parseDeadlineInput(deadlineText, timezone);
        if (!parsed.ok) {
          await interaction.reply(priv(`❌ Could not read "${deadlineText}". Use YYYY-MM-DD.`));
          return;
        }
        deadlineUtc = parsed.utcMs;
      } else if (template.default_days) {
        deadlineUtc = Date.now() + template.default_days * DAY_MS;
      }

      const pattern = template.title_pattern || `${template.label} {n}/{total}`;
      const created = db.transaction(() => {
        const tasks = [];
        for (let index = 1; index <= count; index += 1) {
          tasks.push(tasksRepo.createTask(db, guildId, {
            projectId: project.id,
            title: pattern.replace('{n}', index).replace('{total}', count),
            departmentId: template.department_id,
            brief: template.brief ?? project.brief,
            deliverables: planningRepo.templateDeliverables(template),
            formats: template.formats,
            techRequirements: template.tech_requirements,
            referenceLinks: project.reference_links,
            deadlineUtc,
            revisionRounds: template.revision_rounds,
          }, userId));
        }
        return tasks;
      })();

      await interaction.reply(priv(
        `✅ Created ${created.length} task(s) on **${project.code}** from **${template.label}** ` +
        `(${created[0].code}–${created[created.length - 1].code}).\n` +
        `${deadlineUtc ? `Deadline ${discordTimestamp(deadlineUtc, 'D')}.` : 'No deadline set.'}\n` +
        'Pay still needs setting before any of them can be offered.'
      ));
      return;
    }

    if (sub === 'risks') {
      const risks = planningRepo.downstreamAtRisk(db, guildId);
      const visible = actor.isOwner || actor.leadDepartmentIds.length === 0
        ? risks
        : risks.filter((row) => actor.leadDepartmentIds.includes(row.down_department));

      await interaction.reply(priv({
        embeds: [new EmbedBuilder()
          .setTitle('Work whose prerequisite is late')
          .setColor(0xfaa61a)
          .setDescription(visible.length === 0
            ? 'Nothing is waiting on late work.'
            : visible.slice(0, 15).map((row) =>
                `**${row.down_code}** ${row.down_title}` +
                `${row.down_deadline ? ` · due ${discordTimestamp(row.down_deadline, 'R')}` : ''}\n` +
                `┗ waits on **${row.up_code}** ${row.up_title} (${stateLabel(row.up_state)})` +
                `${row.up_deadline ? ` · was due ${discordTimestamp(row.up_deadline, 'R')}` : ''}`
              ).join('\n').slice(0, 4000))
          .setFooter({ text: 'Flagged only. No deadline has been moved — that is your call.' })],
      }));
      return;
    }

    if (sub === 'blockers') {
      const departmentId = actor.isOwner ? null : (actor.leadDepartmentIds[0] ?? null);
      const blockers = planningRepo.listOpenBlockers(db, guildId, { departmentId });

      await interaction.reply(priv({
        embeds: [new EmbedBuilder()
          .setTitle('Open blockers')
          .setColor(0xed4245)
          .setDescription(blockers.length === 0
            ? 'Nothing is blocked.'
            : blockers.slice(0, 15).map((row) =>
                `**#${row.id}** ${row.code} ${row.title} · raised by <@${row.raised_by}> ${discordTimestamp(row.created_at, 'R')}\n` +
                `┗ ${row.reason.slice(0, 200)}${row.attachment ? `\n┗ ${row.attachment}` : ''}`
              ).join('\n').slice(0, 4000))
          .setFooter({ text: 'Clear one with /plan clear-blocker id:<number>' })],
      }));
      return;
    }

    if (sub === 'clear-blocker') {
      const id = interaction.options.getInteger('id', true);
      const blocker = db.prepare('SELECT * FROM task_blockers WHERE guild_id = ? AND id = ?').get(guildId, id);
      if (!blocker) {
        await interaction.reply(priv(`❌ No blocker with id ${id}.`));
        return;
      }

      const task = tasksRepo.getTask(db, guildId, blocker.task_id);
      const mayClear = actor.isOwner
        || blocker.raised_by === userId
        || can(actor, CAPABILITIES.TASK_HOLD, { departmentId: task?.department_id });
      if (!mayClear) {
        throw new PermissionError('blocker.clear', 'Only the person who raised it, their leader, or the owner can clear a blocker.');
      }

      const cleared = planningRepo.clearBlocker(db, guildId, id, {
        actorUserId: userId, resolution: interaction.options.getString('note'),
      });

      await interaction.reply(priv(
        cleared ? `✅ Blocker #${id} cleared on **${task?.code}**.` : 'That blocker was already cleared.'
      ));

      if (cleared && blocker.raised_by !== userId) {
        await notifyUser(interaction.client, db, guildId, blocker.raised_by, {
          content: `✅ The blocker you raised on **${task?.code} · ${task?.title}** has been cleared by <@${userId}>.`,
        }).catch(() => null);
      }
      return;
    }

    if (sub === 'extensions') {
      const departmentId = actor.isOwner ? null : (actor.leadDepartmentIds[0] ?? null);
      const requests = planningRepo.listDeadlineRequests(db, guildId, { status: 'pending', departmentId });

      await interaction.reply(priv({
        embeds: [new EmbedBuilder()
          .setTitle('Deadline requests')
          .setColor(0xfaa61a)
          .setDescription(requests.length === 0
            ? 'Nothing waiting.'
            : requests.map((row) =>
                `**#${row.id}** ${row.code} ${row.title} · <@${row.requested_by}>\n` +
                `┗ ${row.previous_deadline ? discordTimestamp(row.previous_deadline, 'd') : 'no date'} → ` +
                `**${discordTimestamp(row.requested_deadline, 'd')}**\n┗ ${row.reason.slice(0, 200)}`
              ).join('\n').slice(0, 4000))
          .setFooter({ text: 'Decide with /plan decide-extension id:<number> approve:true' })],
      }));
      return;
    }

    if (sub === 'decide-extension') {
      const id = interaction.options.getInteger('id', true);
      const request = db.prepare('SELECT * FROM deadline_requests WHERE guild_id = ? AND id = ?').get(guildId, id);
      if (!request) {
        await interaction.reply(priv(`❌ No deadline request with id ${id}.`));
        return;
      }

      const task = tasksRepo.getTask(db, guildId, request.task_id);
      assertCan(actor, CAPABILITIES.TASK_EDIT, { departmentId: task?.department_id });

      const approve = interaction.options.getBoolean('approve', true);
      const decided = planningRepo.decideDeadlineRequest(db, guildId, id, {
        approve, actorUserId: userId, note: interaction.options.getString('note'),
      });

      if (!decided) {
        await interaction.reply(priv('That request has already been decided.'));
        return;
      }

      await interaction.reply(priv(
        approve
          ? `✅ Deadline for **${task.code}** moved to ${discordTimestamp(decided.requested_deadline, 'F')}.\n` +
            `The previous date (${decided.previous_deadline ? discordTimestamp(decided.previous_deadline, 'd') : 'none'}) is kept on the record, against your name.`
          : `✅ Request #${id} declined. The deadline stays as it was.`
      ));

      await notifyUser(interaction.client, db, guildId, request.requested_by, {
        content: approve
          ? `✅ Your deadline request for **${task.code} · ${task.title}** was approved — now ${discordTimestamp(decided.requested_deadline, 'F')}.`
          : `❌ Your deadline request for **${task.code} · ${task.title}** was declined.` +
            `${decided.decision_note ? `\n> ${decided.decision_note}` : ''}`,
      }).catch(() => null);
      return;
    }

    // Everything below acts on a named task.
    const code = interaction.options.getString('task', true);
    const task = tasksRepo.getTaskByCode(db, guildId, code);
    if (!task) {
      await interaction.reply(priv(`❌ No task with code \`${code}\`.`));
      return;
    }

    if (sub === 'ready') {
      const readiness = checkTaskReadiness(db, guildId, task);
      await interaction.reply(priv({
        embeds: [new EmbedBuilder()
          .setTitle(`Readiness · ${task.code}`)
          .setColor(readiness.ok ? 0x57f287 : 0xed4245)
          .setDescription(readiness.ok
            ? '✅ Ready to offer.' + (readiness.warnings.length > 0 ? `\n\n${describeReadiness(readiness)}` : '')
            : describeReadiness(readiness))],
      }));
      return;
    }

    if (sub === 'chain') {
      const upstream = planningRepo.dependenciesOf(db, task.id);
      const downstream = planningRepo.dependentsOf(db, task.id);

      await interaction.reply(priv({
        embeds: [new EmbedBuilder()
          .setTitle(`Chain · ${task.code} ${task.title}`)
          .setColor(0x5865f2)
          .addFields(
            {
              name: `Waits on (${upstream.length})`,
              value: upstream.length === 0 ? '_nothing_' : upstream.map((row) =>
                `**${row.code}** ${row.title} — ${stateLabel(row.state)}` +
                `${planningRepo.READY_STATES.includes(row.state) ? ' ✅ ready' : ''}`
              ).join('\n').slice(0, 1024),
              inline: false,
            },
            {
              name: `Waiting on this (${downstream.length})`,
              value: downstream.length === 0 ? '_nothing_' : downstream.map((row) =>
                `**${row.code}** ${row.title} — ${stateLabel(row.state)}`
              ).join('\n').slice(0, 1024),
              inline: false,
            }
          )],
      }));
      return;
    }

    if (sub === 'extend') {
      // The artist holding the task, or anyone who can edit it, may ask.
      const isHolder = task.artist_user_id === userId;
      if (!isHolder) assertCan(actor, CAPABILITIES.TASK_EDIT, { departmentId: task.department_id });

      const timezone = staffRepo.getStaff(db, guildId, userId)?.timezone;
      if (!timezone) {
        await interaction.reply(priv('❌ Set your timezone with `/profile timezone` so the new date is read correctly.'));
        return;
      }

      const parsed = parseDeadlineInput(interaction.options.getString('new_deadline', true), timezone);
      if (!parsed.ok) {
        await interaction.reply(priv('❌ Could not read that date. Use `YYYY-MM-DD` or `YYYY-MM-DD HH:MM`.'));
        return;
      }
      if (task.deadline_utc && parsed.utcMs <= task.deadline_utc) {
        await interaction.reply(priv(
          `That is not later than the current deadline (${discordTimestamp(task.deadline_utc, 'F')}). ` +
          'To bring a deadline forward, ask your leader to edit it directly.'
        ));
        return;
      }

      const request = planningRepo.requestDeadlineChange(db, guildId, {
        taskId: task.id,
        requestedBy: userId,
        previousDeadline: task.deadline_utc,
        requestedDeadline: parsed.utcMs,
        reason: interaction.options.getString('reason', true),
      });

      await interaction.reply(priv(
        `✅ Requested **${parsed.preview}** for **${task.code}** (request #${request.id}).\n` +
        'The current deadline stands until somebody approves the change.'
      ));

      if (task.leader_user_id && task.leader_user_id !== userId) {
        await notifyUser(interaction.client, db, guildId, task.leader_user_id, {
          content:
            `📅 <@${userId}> asked to move **${task.code} · ${task.title}** to ${discordTimestamp(parsed.utcMs, 'F')}` +
            `${task.deadline_utc ? ` (from ${discordTimestamp(task.deadline_utc, 'd')})` : ''}.\n` +
            `> ${interaction.options.getString('reason', true)}\n` +
            `Decide with \`/plan decide-extension id:${request.id} approve:true\`.`,
        }).catch(() => null);
      }
      return;
    }

    // depends / undepend
    assertCan(actor, CAPABILITIES.TASK_EDIT, { departmentId: task.department_id });
    const prerequisite = tasksRepo.getTaskByCode(db, guildId, interaction.options.getString('needs', true));
    if (!prerequisite) {
      await interaction.reply(priv('❌ No task with that code for the prerequisite.'));
      return;
    }

    if (sub === 'depends') {
      const result = planningRepo.addDependency(db, guildId, {
        taskId: task.id,
        dependsOnTaskId: prerequisite.id,
        note: interaction.options.getString('note'),
      }, userId);

      if (!result.ok) {
        const reasons = {
          self_dependency: 'A task cannot depend on itself.',
          cycle: 'That would make a loop — the two tasks would each be waiting for the other.',
          already_exists: 'That dependency is already recorded.',
        };
        await interaction.reply(priv(`❌ ${reasons[result.reason] || result.reason}`));
        return;
      }

      await interaction.reply(priv(
        `✅ **${task.code}** now waits on **${prerequisite.code} ${prerequisite.title}**.\n` +
        `${planningRepo.READY_STATES.includes(prerequisite.state)
          ? 'That prerequisite has already passed review, so this is ready to go.'
          : `It is ${stateLabel(prerequisite.state)}. The department will be told when it is ready.`}\n` +
        'Nothing is blocked by this — it drives notifications and warnings only.'
      ));
      return;
    }

    if (sub === 'undepend') {
      const removed = planningRepo.removeDependency(db, guildId, task.id, prerequisite.id, userId);
      await interaction.reply(priv(
        removed ? `✅ **${task.code}** no longer waits on **${prerequisite.code}**.` : 'That dependency was not recorded.'
      ));
    }
  },
};
