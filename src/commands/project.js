const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const projectsRepo = require('../db/repos/projects');
const tasksRepo = require('../db/repos/tasks');
const configRepo = require('../db/repos/config');
const staffRepo = require('../db/repos/staff');
const { contextFor } = require('../services/actor');
const { taskSummaryLine } = require('../services/taskView');
const { CAPABILITIES, assertCan, can } = require('../domain/permissions');
const { parseBulkSpec, taskTitlesFor } = require('../domain/bulkSpec');
const { parseAmount, formatAmount, formatTotals, isSupportedCurrency, CURRENCIES } = require('../domain/money');
const { parseDeadlineInput, discordTimestamp } = require('../utils/time');
const { priv } = require('../utils/reply');

const CURRENCY_CHOICES = Object.keys(CURRENCIES).map((code) => ({ name: code, value: code }));

/**
 * Deadlines are typed as wall-clock text and must be interpreted in somebody's
 * timezone. The caller's own profile timezone is used, and the interpreted
 * result is always echoed back so a mistake is visible immediately.
 */
function resolveDeadline(db, guildId, userId, text) {
  if (!text) return { ok: true, utcMs: null, note: null };

  const staff = staffRepo.getStaff(db, guildId, userId);
  if (!staff?.timezone) {
    return { ok: false, message: 'Set your own timezone first with `/profile timezone` so deadlines can be read correctly.' };
  }

  const parsed = parseDeadlineInput(text, staff.timezone);
  if (!parsed.ok) {
    if (parsed.reason === 'nonexistent_local_time') {
      return { ok: false, message: `That local time does not exist in \`${staff.timezone}\` — the clocks skip it for daylight saving. Pick another time.` };
    }
    return { ok: false, message: `Could not read "${text}". Use \`YYYY-MM-DD\` or \`YYYY-MM-DD HH:MM\` (24-hour).` };
  }

  const notes = [`Deadline read as **${parsed.preview}**`];
  if (parsed.impliedEndOfDay) notes.push('no time given, so end of day (23:59) was used');
  if (parsed.ambiguous) notes.push('⚠️ that local time happens twice on this date (clocks go back); the earlier one was used');
  notes.push(`shows for everyone as ${discordTimestamp(parsed.utcMs, 'F')}`);

  return { ok: true, utcMs: parsed.utcMs, note: notes.join(' — ') };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('project')
    .setDescription('Client projects and their tasks')
    .addSubcommand((sub) =>
      sub
        .setName('create')
        .setDescription('Create a project')
        .addStringOption((opt) => opt.setName('name').setDescription('Project name').setRequired(true))
        .addStringOption((opt) => opt.setName('client_ref').setDescription('Private client reference (kept off shared boards)').setRequired(false))
        .addStringOption((opt) => opt.setName('budget').setDescription('What the client pays, e.g. 400').setRequired(false))
        .addStringOption((opt) => opt.setName('currency').setDescription('Currency of the client payment').addChoices(...CURRENCY_CHOICES).setRequired(false))
        .addStringOption((opt) => opt.setName('deadline').setDescription('Overall deadline, YYYY-MM-DD [HH:MM] in your timezone').setRequired(false))
        .addUserOption((opt) => opt.setName('manager').setDescription('Responsible manager').setRequired(false))
        .addUserOption((opt) => opt.setName('finder').setDescription('Who found this client (you, if you did)').setRequired(false))
        .addUserOption((opt) => opt.setName('mod').setDescription('Mod credited on this project').setRequired(false))
        .addStringOption((opt) => opt.setName('ticket').setDescription('Link to the Ticket Tool ticket or client channel').setRequired(false))
    )
    .addSubcommand((sub) =>
      sub
        .setName('view')
        .setDescription('Show a project')
        .addStringOption((opt) => opt.setName('project').setDescription('Project code').setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('list')
        .setDescription('List projects')
        .addStringOption((opt) =>
          opt.setName('status').setDescription('Which projects').setRequired(false).addChoices(
            { name: 'Active', value: 'active' },
            { name: 'Delivered', value: 'delivered' },
            { name: 'Cancelled', value: 'cancelled' },
            { name: 'All', value: 'all' }
          )
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('tasks')
        .setDescription('List the tasks on a project')
        .addStringOption((opt) => opt.setName('project').setDescription('Project code').setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('bulk')
        .setDescription('Turn a bulk order into tasks, e.g. "12 models, 4 vfx, 2 animations"')
        .addStringOption((opt) => opt.setName('project').setDescription('Project code').setRequired(true).setAutocomplete(true))
        .addStringOption((opt) => opt.setName('spec').setDescription('Counts and departments, comma separated').setRequired(true))
        .addStringOption((opt) => opt.setName('deadline').setDescription('Deadline for these tasks (defaults to the project deadline)').setRequired(false))
    )
    .addSubcommand((sub) =>
      sub
        .setName('edit')
        .setDescription('Change a project field')
        .addStringOption((opt) => opt.setName('project').setDescription('Project code').setRequired(true).setAutocomplete(true))
        .addStringOption((opt) => opt.setName('brief').setDescription('Project brief').setRequired(false))
        .addStringOption((opt) => opt.setName('references').setDescription('Reference links').setRequired(false))
        .addStringOption((opt) => opt.setName('budget').setDescription('What the client pays').setRequired(false))
        .addStringOption((opt) => opt.setName('currency').setDescription('Currency of the client payment').addChoices(...CURRENCY_CHOICES).setRequired(false))
        .addStringOption((opt) => opt.setName('ticket').setDescription('Ticket or client channel link').setRequired(false))
        .addUserOption((opt) => opt.setName('finder').setDescription('Who found this client').setRequired(false))
        .addUserOption((opt) => opt.setName('mod').setDescription('Mod credited on this project').setRequired(false))
        .addStringOption((opt) =>
          opt.setName('status').setDescription('Project status').setRequired(false).addChoices(
            { name: 'Active', value: 'active' },
            { name: 'Delivered', value: 'delivered' },
            { name: 'Cancelled', value: 'cancelled' }
          )
        )
    ),

  async autocomplete(interaction) {
    const { db, guildId } = contextFor(interaction);
    const query = String(interaction.options.getFocused() || '');
    const matches = query
      ? projectsRepo.searchProjects(db, guildId, query, 25)
      : projectsRepo.listProjects(db, guildId, { status: 'active', limit: 25 });

    await interaction.respond(matches.map((project) => ({
      name: `${project.code} · ${project.name}`.slice(0, 100),
      value: project.code,
    })));
  },

  async execute(interaction) {
    const { db, guildId, config, actor } = contextFor(interaction);
    const sub = interaction.options.getSubcommand();
    const userId = interaction.user.id;

    if (sub === 'create') {
      assertCan(actor, CAPABILITIES.PROJECT_CREATE);

      const budgetText = interaction.options.getString('budget');
      const currency = interaction.options.getString('currency') || config.default_currency;
      let clientAmountMinor = null;

      if (budgetText) {
        if (!isSupportedCurrency(currency)) {
          await interaction.reply(priv(`❌ Unsupported currency \`${currency}\`.`));
          return;
        }
        clientAmountMinor = parseAmount(budgetText, currency);
      }

      const deadline = resolveDeadline(db, guildId, userId, interaction.options.getString('deadline'));
      if (!deadline.ok) {
        await interaction.reply(priv(`❌ ${deadline.message}`));
        return;
      }

      const project = projectsRepo.createProject(db, guildId, {
        name: interaction.options.getString('name', true),
        clientRef: interaction.options.getString('client_ref'),
        deadlineUtc: deadline.utcMs,
        clientAmountMinor,
        clientCurrency: clientAmountMinor === null ? null : currency,
        managerUserId: interaction.options.getUser('manager')?.id ?? userId,
        finderUserId: interaction.options.getUser('finder')?.id ?? null,
        modUserId: interaction.options.getUser('mod')?.id ?? null,
        ticketUrl: interaction.options.getString('ticket'),
      }, userId);

      const lines = [
        `✅ Created **${project.code} · ${project.name}**.`,
        deadline.note,
        clientAmountMinor !== null ? `Client payment expected: **${formatAmount(clientAmountMinor, currency)}**.` : null,
        project.finder_user_id
          ? `Finder: <@${project.finder_user_id}>.`
          : 'No finder recorded, so the finder share stays with you.',
        project.mod_user_id
          ? `Mod: <@${project.mod_user_id}>.`
          : 'No mod recorded, so the mod share stays with you.',
        '',
        `Add tasks with \`/project bulk project:${project.code} spec:"12 models, 4 vfx"\` or \`/task create\`.`,
        `Add the brief with \`/project edit project:${project.code} brief:...\`.`,
      ].filter((line) => line !== null);

      await interaction.reply(priv(lines.join('\n')));
      return;
    }

    const code = interaction.options.getString('project');
    const project = code ? projectsRepo.getProjectByCode(db, guildId, code) : null;
    if (code && !project) {
      await interaction.reply(priv(`❌ No project with code \`${code}\`.`));
      return;
    }

    if (sub === 'view') {
      const progress = projectsRepo.projectProgress(db, project.id);
      const received = projectsRepo.clientReceipts(db, project.id);
      const showFinance = actor.isOwner || can(actor, CAPABILITIES.FINANCE_VIEW_ALL);

      const embed = new EmbedBuilder()
        .setTitle(`${project.code} · ${project.name}`)
        .setColor(0x5865f2)
        .addFields(
          { name: 'Status', value: project.status, inline: true },
          { name: 'Manager', value: project.manager_user_id ? `<@${project.manager_user_id}>` : '—', inline: true },
          { name: 'Deadline', value: project.deadline_utc ? discordTimestamp(project.deadline_utc, 'F') : '_none_', inline: true },
          {
            name: 'Tasks',
            value: progress.total === 0
              ? '_none yet_'
              : Object.entries(progress.counts).map(([state, n]) => `${state.replace(/_/g, ' ')}: ${n}`).join(' · '),
            inline: false,
          }
        );

      if (project.brief) embed.addFields({ name: 'Brief', value: project.brief.slice(0, 1024), inline: false });
      if (project.reference_links) embed.addFields({ name: 'References', value: project.reference_links.slice(0, 1024), inline: false });
      if (project.ticket_url) embed.addFields({ name: 'Ticket', value: project.ticket_url, inline: false });

      // Client identity and money are shown only to those entitled to see them.
      if (showFinance) {
        embed.addFields(
          { name: 'Client reference', value: project.client_ref || '_none_', inline: true },
          {
            name: 'Client payment',
            value: project.client_amount_minor === null
              ? '_not set_'
              : `${formatAmount(project.client_amount_minor, project.client_currency)} expected\n${formatTotals(received)} received`,
            inline: true,
          },
          {
            name: 'Finder / mod',
            value: `${project.finder_user_id ? `<@${project.finder_user_id}>` : 'you (unrecorded)'} / ${project.mod_user_id ? `<@${project.mod_user_id}>` : 'you (unrecorded)'}`,
            inline: true,
          }
        );
      }

      await interaction.reply(priv({ embeds: [embed] }));
      return;
    }

    if (sub === 'list') {
      const status = interaction.options.getString('status') || 'active';
      const projects = projectsRepo.listProjects(db, guildId, { status, limit: 25 });

      if (projects.length === 0) {
        await interaction.reply(priv(`No ${status === 'all' ? '' : `${status} `}projects.`));
        return;
      }

      const lines = projects.map((row) => {
        const progress = projectsRepo.projectProgress(db, row.id);
        const done = progress.counts.client_approved || 0;
        return `**${row.code}** ${row.name} — ${done}/${progress.total} approved${row.deadline_utc ? ` · due ${discordTimestamp(row.deadline_utc, 'R')}` : ''}`;
      });

      await interaction.reply(priv({
        embeds: [new EmbedBuilder().setTitle('Projects').setColor(0x5865f2).setDescription(lines.join('\n').slice(0, 4000))],
      }));
      return;
    }

    if (sub === 'tasks') {
      const tasks = tasksRepo.listTasksForProject(db, project.id);
      if (tasks.length === 0) {
        await interaction.reply(priv(`**${project.code}** has no tasks yet. Add them with \`/project bulk\`.`));
        return;
      }

      const showPay = actor.isOwner || can(actor, CAPABILITIES.FINANCE_VIEW_ALL);
      const byDepartment = new Map();
      for (const task of tasks) {
        if (!byDepartment.has(task.department_id)) byDepartment.set(task.department_id, []);
        byDepartment.get(task.department_id).push(task);
      }

      const sections = [...byDepartment.entries()].map(([departmentId, rows]) => {
        const department = configRepo.getDepartment(db, guildId, departmentId);
        const body = rows.map((task) => taskSummaryLine(task, { showPay })).join('\n');
        return `**${department?.name || 'Unknown department'}** (${rows.length})\n${body}`;
      });

      await interaction.reply(priv({
        embeds: [new EmbedBuilder()
          .setTitle(`${project.code} · tasks`)
          .setColor(0x5865f2)
          .setDescription(sections.join('\n\n').slice(0, 4000))],
      }));
      return;
    }

    if (sub === 'bulk') {
      assertCan(actor, CAPABILITIES.TASK_CREATE);

      const departments = configRepo.listDepartments(db, guildId);
      const parsed = parseBulkSpec(interaction.options.getString('spec', true), departments);

      if (parsed.items.length === 0) {
        await interaction.reply(priv(
          `❌ Nothing could be created.\n${parsed.errors.map((error) => `• ${error}`).join('\n')}\n\n` +
          `Departments available: ${departments.map((dept) => `\`${dept.key}\``).join(', ')}`
        ));
        return;
      }

      const deadlineText = interaction.options.getString('deadline');
      const deadline = resolveDeadline(db, guildId, userId, deadlineText);
      if (!deadline.ok) {
        await interaction.reply(priv(`❌ ${deadline.message}`));
        return;
      }
      const deadlineUtc = deadline.utcMs ?? project.deadline_utc;

      const created = [];
      db.transaction(() => {
        for (const item of parsed.items) {
          const checklist = configRepo.departmentChecklist(item.department);
          for (const title of taskTitlesFor(item)) {
            created.push(tasksRepo.createTask(db, guildId, {
              projectId: project.id,
              title,
              departmentId: item.department.id,
              brief: project.brief,
              deliverables: checklist,
              referenceLinks: project.reference_links,
              deadlineUtc,
            }, userId));
          }
        }
      })();

      const summary = parsed.items.map((item) => `${item.count} × ${item.department.name}`).join(', ');
      await interaction.reply(priv([
        `✅ Created **${created.length} tasks** on **${project.code}**: ${summary}.`,
        `Codes ${created[0].code}–${created[created.length - 1].code}.`,
        deadlineText ? deadline.note : (deadlineUtc ? `Deadline inherited from the project: ${discordTimestamp(deadlineUtc, 'F')}.` : 'No deadline set.'),
        parsed.errors.length > 0 ? `\n⚠️ Ignored: ${parsed.errors.join(' ')}` : null,
        '',
        'Each task starts in its department\'s unassigned queue. Set pay before it can be offered:',
        '`/task pay propose` (leaders) then `/task pay approve` (you), or `/task pay approve` directly.',
      ].filter((line) => line !== null).join('\n')));
      return;
    }

    if (sub === 'edit') {
      assertCan(actor, CAPABILITIES.PROJECT_EDIT);

      const patch = {};
      const brief = interaction.options.getString('brief');
      const references = interaction.options.getString('references');
      const ticket = interaction.options.getString('ticket');
      const status = interaction.options.getString('status');
      const finder = interaction.options.getUser('finder');
      const mod = interaction.options.getUser('mod');
      const budgetText = interaction.options.getString('budget');
      const currency = interaction.options.getString('currency');

      if (brief !== null) patch.brief = brief;
      if (references !== null) patch.reference_links = references;
      if (ticket !== null) patch.ticket_url = ticket;
      if (status !== null) patch.status = status;
      if (finder) patch.finder_user_id = finder.id;
      if (mod) patch.mod_user_id = mod.id;

      if (budgetText !== null) {
        const targetCurrency = currency || project.client_currency || config.default_currency;
        patch.client_amount_minor = parseAmount(budgetText, targetCurrency);
        patch.client_currency = targetCurrency;
      } else if (currency !== null) {
        patch.client_currency = currency;
      }

      if (Object.keys(patch).length === 0) {
        await interaction.reply(priv('Nothing to change.'));
        return;
      }

      const updated = projectsRepo.updateProject(db, guildId, project.id, patch, userId);
      await interaction.reply(priv(
        `✅ Updated **${updated.code}**.${patch.client_amount_minor !== undefined ? ` Client payment: ${formatAmount(updated.client_amount_minor, updated.client_currency)}.` : ''}`
      ));
    }
  },
};
