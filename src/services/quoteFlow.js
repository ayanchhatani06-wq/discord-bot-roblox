const enquiriesRepo = require('../db/repos/enquiries');
const configRepo = require('../db/repos/config');
const projectsRepo = require('../db/repos/projects');
const tasksRepo = require('../db/repos/tasks');
const clientsRepo = require('../db/repos/clients');
const { parseBulkSpec, taskTitlesFor } = require('../domain/bulkSpec');
const { formatAmount } = require('../domain/money');

/**
 * Reads "12 models, 4 vfx" out of what a client typed and maps it onto the
 * studio's own departments, so an enquiry can become tasks later without
 * anyone retyping the brief.
 */
function parseServiceRequest(db, guildId, text) {
  const departments = configRepo.listDepartments(db, guildId);
  const parsed = parseBulkSpec(text, departments);

  return {
    items: parsed.items.map((item) => ({
      departmentId: item.department.id,
      departmentKey: item.department.key,
      departmentName: item.department.name,
      count: item.count,
      label: item.label,
    })),
    errors: parsed.errors,
    total: parsed.total ?? 0,
  };
}

/**
 * Builds a draft quote from configured templates.
 *
 * A template only pre-fills a figure; it never commits to one. Anything with no
 * template comes back as a line with no price and a warning, so a quote cannot
 * quietly go out with a number nobody chose.
 */
function draftFromEnquiry(db, guildId, enquiry, { currency = null } = {}) {
  const items = enquiriesRepo.parsedItems(enquiry);
  const config = configRepo.getConfig(db, guildId);
  const warnings = [];

  if (items.length === 0) {
    return {
      ok: false,
      reason: 'no_parsed_items',
      detail: 'The requested service could not be matched to departments, so there is nothing to price automatically.',
    };
  }

  const lines = [];
  let resolvedCurrency = currency;

  for (const item of items) {
    const template = enquiriesRepo.templateForDepartment(db, guildId, item.departmentId);

    if (!template || template.unit_amount_minor === null) {
      lines.push({
        departmentId: item.departmentId,
        label: `${item.count} × ${item.departmentName}`,
        count: item.count,
        unitMinor: null,
        lineTotalMinor: null,
        currency: null,
        needsPrice: true,
      });
      warnings.push(`No price template for ${item.departmentName} — set one with \`/enquiry template\` or price it by hand.`);
      continue;
    }

    const lineCurrency = template.currency || config.default_currency;
    if (!resolvedCurrency) resolvedCurrency = lineCurrency;

    // Mixing currencies inside one quote would produce a total that cannot be
    // added up, so it is refused rather than approximated.
    if (lineCurrency !== resolvedCurrency) {
      return {
        ok: false,
        reason: 'mixed_currencies',
        detail: `Templates for this enquiry use both ${resolvedCurrency} and ${lineCurrency}. One quote has to be in a single currency.`,
      };
    }

    lines.push({
      departmentId: item.departmentId,
      label: `${item.count} × ${item.departmentName}`,
      count: item.count,
      unitMinor: template.unit_amount_minor,
      lineTotalMinor: template.unit_amount_minor * item.count,
      currency: lineCurrency,
      turnaroundDays: template.turnaround_days,
      needsPrice: false,
    });
  }

  const priced = lines.filter((line) => !line.needsPrice);
  const totalMinor = priced.reduce((sum, line) => sum + line.lineTotalMinor, 0);
  const turnaroundDays = lines.reduce((max, line) => Math.max(max, line.turnaroundDays || 0), 0) || null;

  return {
    ok: true,
    lines,
    totalMinor,
    currency: resolvedCurrency || config.default_currency,
    turnaroundDays,
    warnings,
    complete: lines.every((line) => !line.needsPrice),
  };
}

function renderQuoteLines(lines) {
  return lines.map((line) => {
    if (line.needsPrice || line.unitMinor === null) {
      return `• ${line.label} — **price not set**`;
    }
    return `• ${line.label} — ${formatAmount(line.unitMinor, line.currency)} each = ${formatAmount(line.lineTotalMinor, line.currency)}`;
  }).join('\n');
}

/**
 * Turns an accepted enquiry into a real project with its tasks.
 *
 * The brief, references, formats and notes carry across, so nobody retypes
 * them. Pay is deliberately left unset: the quote is what the client pays, not
 * what an artist is paid, and those are separate decisions the owner makes.
 */
function convertToProject(db, guildId, enquiry, {
  actorUserId,
  clientAmountMinor = null,
  currency = null,
  deadlineUtc = null,
  managerUserId = null,
  clientChannelId = null,
}) {
  const items = enquiriesRepo.parsedItems(enquiry);
  if (items.length === 0) {
    return { ok: false, reason: 'no_parsed_items' };
  }
  if (enquiry.project_id) {
    return { ok: false, reason: 'already_converted', projectId: enquiry.project_id };
  }

  return db.transaction(() => {
    const briefParts = [
      enquiry.service_request,
      enquiry.formats_text ? `Formats / technical: ${enquiry.formats_text}` : null,
      enquiry.notes ? `Client notes: ${enquiry.notes}` : null,
    ].filter(Boolean);

    const project = projectsRepo.createProject(db, guildId, {
      name: `${enquiry.code} · ${enquiry.service_request}`.slice(0, 120),
      clientRef: enquiry.contact_ref,
      brief: briefParts.join('\n\n'),
      referenceLinks: enquiry.references_text,
      deadlineUtc: deadlineUtc ?? enquiry.desired_deadline_utc,
      clientAmountMinor,
      clientCurrency: clientAmountMinor === null ? null : currency,
      managerUserId: managerUserId ?? actorUserId,
      finderUserId: null,
      modUserId: null,
    }, actorUserId);

    if (enquiry.client_id) {
      clientsRepo.linkProject(db, guildId, project.id, enquiry.client_id, actorUserId, {
        clientChannelId: clientChannelId ?? undefined,
      });
    }

    const created = [];
    for (const item of items) {
      const department = configRepo.getDepartment(db, guildId, item.departmentId);
      if (!department) continue;

      const template = enquiriesRepo.templateForDepartment(db, guildId, item.departmentId);
      const deliverables = template && enquiriesRepo.templateDeliverables(template).length > 0
        ? enquiriesRepo.templateDeliverables(template)
        : configRepo.departmentChecklist(department);

      for (const title of taskTitlesFor({ label: item.label || department.name, count: item.count })) {
        created.push(tasksRepo.createTask(db, guildId, {
          projectId: project.id,
          title,
          departmentId: department.id,
          brief: briefParts.join('\n\n'),
          deliverables,
          formats: enquiry.formats_text,
          referenceLinks: enquiry.references_text,
          deadlineUtc: deadlineUtc ?? enquiry.desired_deadline_utc,
          revisionRounds: template?.revision_rounds ?? null,
        }, actorUserId));
      }
    }

    enquiriesRepo.updateEnquiry(db, guildId, enquiry.id, { project_id: project.id }, actorUserId);
    enquiriesRepo.setStatus(db, guildId, enquiry.id, enquiriesRepo.STATUSES.ACCEPTED, actorUserId, {
      detail: `Converted to ${project.code} with ${created.length} task(s)`,
    });

    return { ok: true, project, tasks: created };
  })();
}

/**
 * Which leader should see an enquiry: the leader of the department with the
 * most items in it. Only a suggestion — it is stored so a person can change it.
 */
function suggestLeaderRole(db, guildId, enquiry) {
  const items = enquiriesRepo.parsedItems(enquiry);
  if (items.length === 0) return null;

  const biggest = [...items].sort((a, b) => b.count - a.count)[0];
  const department = configRepo.getDepartment(db, guildId, biggest.departmentId);
  return department?.leader_role_id
    ? { departmentId: department.id, departmentName: department.name, leaderRoleId: department.leader_role_id }
    : null;
}

module.exports = {
  parseServiceRequest,
  draftFromEnquiry,
  renderQuoteLines,
  convertToProject,
  suggestLeaderRole,
};
