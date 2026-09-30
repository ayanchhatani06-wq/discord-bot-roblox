const configRepo = require('../db/repos/config');
const staffRepo = require('../db/repos/staff');
const clientsRepo = require('../db/repos/clients');
const messagingRepo = require('../db/repos/messaging');
const tasksRepo = require('../db/repos/tasks');
const webRepo = require('../db/repos/web');
const { TASK_STATES } = require('../domain/taskState');

/**
 * Things that are quietly wrong.
 *
 * Every check here is something that breaks without an error message: an offer
 * that vanishes because DMs are shut and there is no fallback channel, a
 * deadline read in the wrong timezone, a client who cannot open the dashboard
 * posted for them. The bot cannot fix these, because each one is a decision,
 * but it can stop them being invisible.
 *
 * Severity is about consequence, not tidiness. `breaks` means something will
 * silently not work. `risky` means it works until it doesn't. `note` is worth
 * knowing and nothing more.
 */

const SEVERITY = Object.freeze({ BREAKS: 'breaks', RISKY: 'risky', NOTE: 'note' });

const ORDER = Object.freeze([SEVERITY.BREAKS, SEVERITY.RISKY, SEVERITY.NOTE]);

function finding(severity, title, detail, fix = null) {
  return { severity, title, detail, fix };
}

/** Configuration the studio cannot work without. */
function checkConfig(db, guildId) {
  const config = configRepo.getConfig(db, guildId);
  const findings = [];

  if (!config?.owner_user_id) {
    findings.push(finding(
      SEVERITY.BREAKS,
      'No studio owner is recorded',
      'Pay cannot be approved, splits have nowhere to fall back to, and nothing that needs an owner decision can happen.',
      '`/studio setup`'
    ));
  }

  if (!config?.fallback_channel_id) {
    findings.push(finding(
      SEVERITY.BREAKS,
      'No fallback channel',
      'Task offers and reminders go by DM. Anybody with DMs closed simply never receives them, and nothing tells you it happened.',
      '`/studio channels`'
    ));
  }

  if (!config?.staff_board_channel_id) {
    findings.push(finding(
      SEVERITY.NOTE,
      'No staff board channel',
      'The per-department boards showing who is available and their local time have nowhere to post.',
      '`/studio channels`'
    ));
  }

  if (!config?.summary_channel_id) {
    findings.push(finding(
      SEVERITY.NOTE,
      'No summary channel',
      'The weekly management digest has nowhere to go, so it is only ever seen by running `/summary now`.',
      '`/studio channels`'
    ));
  }

  return findings;
}

/** Departments nobody can be assigned work in. */
function checkDepartments(db, guildId) {
  const findings = [];
  const departments = configRepo.listDepartments(db, guildId);

  if (departments.length === 0) {
    return [finding(
      SEVERITY.BREAKS,
      'No departments',
      'Work cannot be routed anywhere.',
      '`/studio setup`'
    )];
  }

  const leaderless = departments.filter((department) => !department.leader_role_id);
  if (leaderless.length > 0) {
    findings.push(finding(
      SEVERITY.RISKY,
      `${leaderless.length} department(s) have no leader role`,
      `${leaderless.map((d) => d.name).join(', ')} — nobody holds the power to assign work or review it there, ` +
      'so every task in them waits on you personally.',
      '`/studio department-roles`'
    ));
  }

  const memberless = departments.filter((department) => !department.member_role_id);
  if (memberless.length > 0) {
    findings.push(finding(
      SEVERITY.RISKY,
      `${memberless.length} department(s) have no member role`,
      `${memberless.map((d) => d.name).join(', ')} — the assignment shortlist for those will be empty.`,
      '`/studio department-roles`'
    ));
  }

  return findings;
}

/** People whose records will make the bot behave oddly. */
function checkStaff(db, guildId) {
  const findings = [];
  const staff = staffRepo.listStaff(db, guildId);

  if (staff.length === 0) {
    return [finding(
      SEVERITY.NOTE,
      'No staff profiles yet',
      'Nobody has run `/profile me`. Timezones, availability and the boards all come from those.',
      'Ask your team to run `/profile me`'
    )];
  }

  const noTimezone = staff.filter((member) => !member.timezone && !member.removed_at);
  if (noTimezone.length > 0) {
    findings.push(finding(
      SEVERITY.RISKY,
      `${noTimezone.length} staff member(s) have no timezone`,
      'Their deadlines are read as UTC, which is usually not what anybody meant. ' +
      'It fails quietly: the date looks right and lands hours out.',
      'Ask them to run `/profile timezone`'
    ));
  }

  const noDepartment = staff.filter((member) => !member.department_id && !member.removed_at);
  if (noDepartment.length > 0) {
    findings.push(finding(
      SEVERITY.NOTE,
      `${noDepartment.length} staff member(s) are in no department`,
      'They will not appear on any board or in any assignment shortlist.',
      '`/profile view member:` to check, then their department role in Discord'
    ));
  }

  return findings;
}

/** Clients who cannot actually reach what was posted for them. */
function checkClients(db, guildId) {
  const findings = [];

  const orphaned = db.prepare(`
    SELECT c.display_name FROM clients c
    WHERE c.guild_id = ?
      AND NOT EXISTS (SELECT 1 FROM client_accounts a WHERE a.client_id = c.id AND a.revoked_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM client_emails e WHERE e.client_id = c.id AND e.revoked_at IS NULL)
      AND EXISTS (SELECT 1 FROM projects p WHERE p.client_id = c.id)
  `).all(guildId);

  if (orphaned.length > 0) {
    findings.push(finding(
      SEVERITY.BREAKS,
      `${orphaned.length} client(s) with orders cannot open anything`,
      `${orphaned.map((row) => row.display_name).join(', ')} — no Discord account and no email address is authorised ` +
      'for them, so a dashboard posted in their channel opens for nobody.',
      '`/clients add-account` or `/web client-email`'
    ));
  }

  const noChannel = db.prepare(`
    SELECT COUNT(*) AS n FROM projects
    WHERE guild_id = ? AND client_id IS NOT NULL AND client_channel_id IS NULL AND status = 'active'
  `).get(guildId).n;

  if (noChannel > 0) {
    findings.push(finding(
      SEVERITY.RISKY,
      `${noChannel} active order(s) have no client channel`,
      'Their dashboard has nowhere to be posted and any automated message to them is held back.',
      '`/clients link project:<code> channel:#their-channel`'
    ));
  }

  return findings;
}

/** Work that is stuck in a way nobody is being told about. */
function checkWork(db, guildId, { now = Date.now() } = {}) {
  const findings = [];
  const DAY = 24 * 60 * 60 * 1000;

  const unapprovedPay = db.prepare(`
    SELECT COUNT(*) AS n FROM tasks WHERE guild_id = ? AND pay_state = 'proposed'
  `).get(guildId).n;

  if (unapprovedPay > 0) {
    findings.push(finding(
      SEVERITY.RISKY,
      `${unapprovedPay} task(s) have pay waiting on you`,
      'They cannot be offered to anybody until the figure is approved, so they are sitting still.',
      '`/task approve-pay`'
    ));
  }

  const oldUnassigned = tasksRepo.listTasksInStates(db, guildId, [TASK_STATES.UNASSIGNED])
    .filter((task) => task.created_at < now - 7 * DAY);

  if (oldUnassigned.length > 0) {
    findings.push(finding(
      SEVERITY.NOTE,
      `${oldUnassigned.length} task(s) have had nobody on them for over a week`,
      'Either they need staffing or they are not really live.',
      '`/task queue`'
    ));
  }

  return findings;
}

/** Things the website needs before it says anything sensible. */
function checkWebsite(db, guildId) {
  const findings = [];
  const config = configRepo.getConfig(db, guildId);

  if (!config?.studio_name) {
    findings.push(finding(
      SEVERITY.NOTE,
      'The website has no studio name',
      'Every public page currently says "Studio".',
      '`/web identity name:`'
    ));
  }

  const approvedTemplates = messagingRepo.listTemplates(db, guildId, { approvedOnly: true });
  const drafts = messagingRepo.listTemplates(db, guildId).filter((template) => template.status === 'draft');

  if (drafts.length > 0 && approvedTemplates.length === 0) {
    findings.push(finding(
      SEVERITY.RISKY,
      `${drafts.length} message template(s) written but none approved`,
      'Nothing will send to a client. A draft never goes out, by design.',
      '`/messages template-approve key:`'
    ));
  }

  return findings;
}

/**
 * Everything at once, worst first.
 *
 * Returns an empty list when the studio is properly set up, and the caller
 * should say so plainly rather than manufacturing advice.
 */
function diagnose(db, guildId, { now = Date.now() } = {}) {
  const findings = [
    ...checkConfig(db, guildId),
    ...checkDepartments(db, guildId),
    ...checkStaff(db, guildId),
    ...checkClients(db, guildId),
    ...checkWork(db, guildId, { now }),
    ...checkWebsite(db, guildId),
  ];

  findings.sort((a, b) => ORDER.indexOf(a.severity) - ORDER.indexOf(b.severity));

  return {
    findings,
    breaks: findings.filter((item) => item.severity === SEVERITY.BREAKS).length,
    risky: findings.filter((item) => item.severity === SEVERITY.RISKY).length,
    notes: findings.filter((item) => item.severity === SEVERITY.NOTE).length,
  };
}

module.exports = {
  SEVERITY,
  ORDER,
  finding,
  checkConfig,
  checkDepartments,
  checkStaff,
  checkClients,
  checkWork,
  checkWebsite,
  diagnose,
};
