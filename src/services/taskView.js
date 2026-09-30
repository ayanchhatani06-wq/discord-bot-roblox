const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const tasksRepo = require('../db/repos/tasks');
const clientRecordsRepo = require('../db/repos/clientRecords');
const { stateLabel, TASK_STATES } = require('../domain/taskState');
const { canViewTaskFinance } = require('../domain/permissions');
const { formatAmount } = require('../domain/money');
const { discordTimestamp } = require('../utils/time');
const { customId } = require('../interactions/router');

const STATE_COLOURS = {
  unassigned: 0x99aab5,
  offered: 0xfaa61a,
  in_progress: 0x5865f2,
  internal_review: 0x9b59b6,
  awaiting_client: 0x1abc9c,
  client_approved: 0x57f287,
  revision_needed: 0xed4245,
  on_hold: 0x4f545c,
  cancelled: 0x36393f,
};

const PAYMENT_LABELS = {
  pending_client_payment: 'Pending — client payment not received',
  payable: 'Payable',
  partially_paid: 'Partially paid',
  paid: 'Paid',
};

function formatPay(task) {
  if (task.artist_pay_minor === null || !task.artist_pay_currency) {
    if (task.pay_state === tasksRepo.PAY_STATES.PROPOSED && task.pay_proposed_minor !== null) {
      return `${formatAmount(task.pay_proposed_minor, task.pay_proposed_currency)} _(proposed, awaiting owner approval)_`;
    }
    return '_not set_';
  }
  return formatAmount(task.artist_pay_minor, task.artist_pay_currency);
}

function deadlineText(task) {
  if (!task.deadline_utc) return '_none_';
  return `${discordTimestamp(task.deadline_utc, 'F')} (${discordTimestamp(task.deadline_utc, 'R')})`;
}

function revisionText(task) {
  const parts = [];
  if (task.revision_rounds !== null && task.revision_rounds !== undefined) {
    parts.push(`${task.revision_rounds} round(s)`);
  }
  if (task.revision_notes) parts.push(task.revision_notes);
  return parts.length > 0 ? parts.join(' — ') : '_not agreed_';
}

function deliverablesText(task) {
  const items = tasksRepo.deliverables(task);
  return items.length > 0 ? items.map((item) => `• ${item}`).join('\n') : '_none listed_';
}

/**
 * The full task view. Pay is included only for people entitled to see it: the
 * owner, an explicit finance grant, or the artist looking at their own task.
 */
/**
 * A client's standing requirements, shown on the work itself.
 *
 * The point of recording "always 4K textures" once is that nobody has to
 * remember it, so it appears on the task and on the offer rather than living
 * in the client record where the artist would never look.
 */
function requirementsText(db, guildId, project, task) {
  if (!db || !project?.client_id) return null;

  const rows = clientRecordsRepo.requirementsForProject(db, guildId, project, {
    departmentId: task?.department_id,
  });
  if (rows.length === 0) return null;

  return rows.map((row) => `• **${row.label}** — ${row.detail}`).join('\n').slice(0, 1024);
}

function taskEmbed({ task, project, department, actor, includeFinance = null, db = null, guildId = null }) {
  const showFinance = includeFinance === null ? canViewTaskFinance(actor, task) : includeFinance;

  const embed = new EmbedBuilder()
    .setTitle(`${task.code} · ${task.title}`)
    .setColor(STATE_COLOURS[task.state] ?? 0x5865f2)
    .addFields(
      { name: 'Status', value: stateLabel(task.state), inline: true },
      { name: 'Department', value: department?.name || '—', inline: true },
      { name: 'Project', value: project ? `${project.code} · ${project.name}` : '—', inline: true },
      { name: 'Artist', value: task.artist_user_id ? `<@${task.artist_user_id}>` : '_unassigned_', inline: true },
      { name: 'Group leader', value: task.leader_user_id ? `<@${task.leader_user_id}>` : '—', inline: true },
      { name: 'Deadline', value: deadlineText(task), inline: true }
    );

  if (task.brief) embed.addFields({ name: 'Brief', value: task.brief.slice(0, 1024), inline: false });
  embed.addFields({ name: 'Deliverables', value: deliverablesText(task).slice(0, 1024), inline: false });

  if (task.formats) embed.addFields({ name: 'Formats', value: task.formats.slice(0, 1024), inline: true });
  if (task.tech_requirements) embed.addFields({ name: 'Technical requirements', value: task.tech_requirements.slice(0, 1024), inline: false });
  if (task.reference_links) embed.addFields({ name: 'References', value: task.reference_links.slice(0, 1024), inline: false });

  const requirements = requirementsText(db, guildId, project, task);
  if (requirements) {
    embed.addFields({ name: 'This client always asks for', value: requirements, inline: false });
  }

  embed.addFields({ name: 'Revision scope', value: revisionText(task), inline: true });

  if (showFinance) {
    embed.addFields(
      { name: 'Agreed pay', value: formatPay(task), inline: true },
      { name: 'Payment', value: PAYMENT_LABELS[task.payment_state] || task.payment_state, inline: true }
    );
  }

  const flags = [];
  if (task.scope_review_flag) flags.push('⚠️ Out-of-scope request awaiting the owner');
  if (task.compensation_review_flag) flags.push('⚠️ Compensation review needed for work already done');
  if (flags.length > 0) embed.addFields({ name: 'Flags', value: flags.join('\n'), inline: false });

  return embed;
}

/**
 * What the chosen artist is shown. Always states the terms in full, because
 * accepting is a commitment to exactly these.
 */
function offerEmbed({ task, project, department, guildName, db = null, guildId = null }) {
  const requirements = requirementsText(db, guildId, project, task);

  const embed = new EmbedBuilder()
    .setTitle(`Task offer: ${task.code} · ${task.title}`)
    .setColor(0xfaa61a)
    .setDescription(
      `You have been offered this task${guildName ? ` in **${guildName}**` : ''}.\n` +
      'Accepting records that you agree to the terms below.'
    )
    .addFields(
      { name: 'Department', value: department?.name || '—', inline: true },
      { name: 'Project', value: project ? `${project.code} · ${project.name}` : '—', inline: true },
      { name: 'Deadline', value: deadlineText(task), inline: false },
      { name: 'Brief', value: (task.brief || '_see the project channel_').slice(0, 1024), inline: false },
      { name: 'Deliverables', value: deliverablesText(task).slice(0, 1024), inline: false },
      { name: 'Revision scope', value: revisionText(task), inline: true },
      { name: 'Your pay', value: formatPay(task), inline: true }
    )
    .setFooter({ text: 'Declining asks for a short reason and returns the task to your group leader.' });

  // Shown before accepting, not after: these are part of what is being agreed.
  if (requirements) {
    embed.spliceFields(4, 0, { name: 'This client always asks for', value: requirements, inline: false });
  }

  // A one-time introduction fee has to be visible at the moment somebody decides
  // whether to take the job. An agreed figure that arrives smaller is a broken
  // promise even when the arrangement behind it is fair.
  if (db && guildId && task.artist_user_id && task.artist_pay_minor) {
    const recruiterFee = require('./recruiterFee');
    const config = require('../db/repos/config').getConfig(db, guildId) || {};
    const disclosure = recruiterFee.disclosureFor(db, guildId, {
      artistUserId: task.artist_user_id,
      amountMinor: task.artist_pay_minor,
      currency: task.artist_pay_currency,
      config,
      task,
    });
    if (disclosure) {
      embed.addFields({ name: '\u{1F91D} Your first task \u2014 read this', value: disclosure, inline: false });
    }
  }

  return embed;
}

function offerComponents(offerId) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(customId('offer', 'accept', offerId))
      .setLabel('Accept')
      .setStyle(ButtonStyle.Success)
      .setEmoji('✅'),
    new ButtonBuilder()
      .setCustomId(customId('offer', 'decline', offerId))
      .setLabel('Decline')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('✖️')
  )];
}

function taskSummaryLine(task, { showPay = false } = {}) {
  const bits = [`**${task.code}** ${task.title}`];
  bits.push(stateLabel(task.state));
  if (task.artist_user_id) bits.push(`<@${task.artist_user_id}>`);
  if (task.deadline_utc) bits.push(discordTimestamp(task.deadline_utc, 'R'));
  if (showPay) bits.push(formatPay(task));
  return bits.join(' · ');
}

function queueEmbed({ department, tasks, payWarnings = 0 }) {
  const embed = new EmbedBuilder()
    .setTitle(`${department.name} — unassigned queue`)
    .setColor(0x99aab5);

  if (tasks.length === 0) {
    embed.setDescription('Nothing waiting. New tasks for this department appear here.');
    return embed;
  }

  embed.setDescription(tasks.map((task) => {
    const ready = tasksRepo.isPayApproved(task) ? '' : ' · ⚠️ pay not approved yet';
    const deadline = task.deadline_utc ? ` · due ${discordTimestamp(task.deadline_utc, 'R')}` : '';
    return `**${task.code}** ${task.title}${deadline}${ready}`;
  }).join('\n').slice(0, 4000));

  if (payWarnings > 0) {
    embed.setFooter({ text: `${payWarnings} task(s) cannot be offered until the owner approves the pay.` });
  }
  return embed;
}

/** One select-menu line per candidate: everything the leader needs to choose. */
function candidateDescription({ staff, activeCount, localTime, taskCap }) {
  const bits = [];
  if (localTime) bits.push(localTime);
  bits.push(`${activeCount} active${taskCap ? `/${taskCap}` : ''}`);
  if (staff.specialties) bits.push(staff.specialties);
  return bits.join(' · ').slice(0, 100);
}

module.exports = {
  requirementsText,
  STATE_COLOURS,
  PAYMENT_LABELS,
  TASK_STATES,
  formatPay,
  deadlineText,
  revisionText,
  deliverablesText,
  taskEmbed,
  offerEmbed,
  offerComponents,
  taskSummaryLine,
  queueEmbed,
  candidateDescription,
};
