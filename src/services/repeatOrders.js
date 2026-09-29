const clientRecordsRepo = require('../db/repos/clientRecords');
const clientsRepo = require('../db/repos/clients');
const projectsRepo = require('../db/repos/projects');
const tasksRepo = require('../db/repos/tasks');
const { recordAudit } = require('../db/repos/core');

/**
 * Turning a repeat-order draft into a real order.
 *
 * A draft becomes a project only when scope, price and deadline have each been
 * confirmed by a person. The three are checked here rather than trusted from
 * the caller, because this is the last point before the studio is committed.
 */

function summarise(db, guildId, draft) {
  const items = clientRecordsRepo.draftItems(draft);
  const source = draft.source_project_id
    ? projectsRepo.getProject(db, guildId, draft.source_project_id)
    : null;

  return {
    draft,
    items,
    source,
    client: clientsRepo.getClient(db, guildId, draft.client_id),
    missing: clientRecordsRepo.outstandingConfirmations(draft),
  };
}

/**
 * Creates the project and its tasks from a draft.
 *
 * Everything happens in one transaction: a half-created order — a project with
 * some of its items — would be worse than none, because somebody would start
 * working from it.
 */
function materialise(db, guildId, draftId, { actorUserId, clientChannelId = null }) {
  const draft = clientRecordsRepo.getDraft(db, guildId, draftId);
  if (!draft) return { ok: false, reason: 'not_found' };
  if (draft.status !== clientRecordsRepo.DRAFT_STATES.DRAFT) {
    return { ok: false, reason: 'already_decided', draft };
  }

  const missing = clientRecordsRepo.outstandingConfirmations(draft);
  if (missing.length > 0) return { ok: false, reason: 'unconfirmed', missing, draft };

  const items = clientRecordsRepo.draftItems(draft);
  if (items.length === 0) return { ok: false, reason: 'no_items', draft };

  const source = draft.source_project_id
    ? projectsRepo.getProject(db, guildId, draft.source_project_id)
    : null;

  return db.transaction(() => {
    const project = projectsRepo.createProject(db, guildId, {
      name: draft.name,
      brief: draft.brief,
      referenceLinks: draft.reference_links,
      deadlineUtc: draft.deadline_utc,
      clientAmountMinor: draft.client_amount_minor,
      clientCurrency: draft.client_currency,
      // Who found the client and who moderates them are facts about the
      // relationship, so they carry across; pay and dates do not.
      finderUserId: source?.finder_user_id ?? null,
      modUserId: source?.mod_user_id ?? null,
      managerUserId: source?.manager_user_id ?? null,
    }, actorUserId);

    clientsRepo.linkProject(db, guildId, project.id, draft.client_id, actorUserId, {
      clientChannelId: clientChannelId ?? undefined,
    });

    const created = items.map((item) => tasksRepo.createTask(db, guildId, {
      projectId: project.id,
      title: item.title,
      departmentId: item.department_id,
      brief: item.brief ?? null,
      deliverables: item.deliverables_json ? JSON.parse(item.deliverables_json) : [],
      formats: item.formats ?? null,
      techRequirements: item.tech_requirements ?? null,
      revisionRounds: item.revision_rounds ?? null,
      // No pay and no per-task price: those are this order's to agree.
    }, actorUserId));

    clientRecordsRepo.markConfirmed(db, guildId, draft.id, project.id, actorUserId);

    recordAudit(db, {
      guildId, actorUserId, action: 'project.from_repeat_order', entityType: 'project', entityId: project.id,
      after: { draft_id: draft.id, source_project_id: draft.source_project_id, tasks: created.length },
      detail: 'Scope, price and deadline were each confirmed before this was created.',
    });

    return {
      ok: true,
      project: projectsRepo.getProject(db, guildId, project.id),
      tasks: created,
      draft: clientRecordsRepo.getDraft(db, guildId, draft.id),
    };
  })();
}

module.exports = { summarise, materialise };
