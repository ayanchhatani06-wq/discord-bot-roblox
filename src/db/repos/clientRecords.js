const { recordAudit } = require('./core');

/**
 * Standing client requirements, and repeat orders drafted from old ones.
 *
 * The design rule here: a repeat order copies the *shape* of a previous job,
 * never its commercial terms. Scope, price and deadline are the three things
 * that change between orders, so each is confirmed deliberately before the
 * draft can become a project. Copying last time's price into a live job is
 * exactly the mistake this is meant to prevent.
 */

const DRAFT_STATES = Object.freeze({ DRAFT: 'draft', CONFIRMED: 'confirmed', DISCARDED: 'discarded' });

// ---------------------------------------------------------------------------
// Standing requirements
// ---------------------------------------------------------------------------

function addRequirement(db, guildId, clientId, { label, detail, departmentId = null }, actorUserId) {
  const now = Date.now();
  const requirement = db.prepare(`
    INSERT INTO client_requirements (guild_id, client_id, label, detail, department_id, created_by, created_at, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *
  `).get(guildId, clientId, label, detail, departmentId, actorUserId, now, actorUserId, now);

  recordAudit(db, {
    guildId, actorUserId, action: 'client.requirement.add', entityType: 'client', entityId: clientId,
    after: { label, department_id: departmentId },
  });
  return requirement;
}

function updateRequirement(db, guildId, id, patch, actorUserId) {
  const allowed = ['label', 'detail', 'department_id', 'active'];
  const entries = Object.entries(patch).filter(([key]) => allowed.includes(key));
  if (entries.length === 0) return getRequirement(db, guildId, id);

  db.prepare(`
    UPDATE client_requirements SET ${entries.map(([key]) => `${key} = ?`).join(', ')}, updated_by = ?, updated_at = ?
    WHERE guild_id = ? AND id = ?
  `).run(...entries.map(([, value]) => value), actorUserId, Date.now(), guildId, id);

  recordAudit(db, {
    guildId, actorUserId, action: 'client.requirement.update', entityType: 'client_requirement', entityId: id,
    after: Object.fromEntries(entries),
  });
  return getRequirement(db, guildId, id);
}

function getRequirement(db, guildId, id) {
  return db.prepare('SELECT * FROM client_requirements WHERE guild_id = ? AND id = ?').get(guildId, id) || null;
}

/**
 * A client's standing requirements.
 *
 * `departmentId` narrows to the ones that department needs to see, plus the
 * ones that apply to everybody — a requirement with no department is not
 * department-specific, so it is never filtered out.
 */
function listRequirements(db, guildId, clientId, { departmentId = undefined, includeInactive = false } = {}) {
  const rows = db.prepare(`
    SELECT * FROM client_requirements
    WHERE guild_id = ? AND client_id = ? ${includeInactive ? '' : 'AND active = 1'}
    ORDER BY department_id IS NOT NULL, label
  `).all(guildId, clientId);

  if (departmentId === undefined) return rows;
  return rows.filter((row) => row.department_id === null || row.department_id === departmentId);
}

/** The requirements that apply to one project's client, if it has one. */
function requirementsForProject(db, guildId, project, { departmentId = undefined } = {}) {
  if (!project?.client_id) return [];
  return listRequirements(db, guildId, project.client_id, { departmentId });
}

// ---------------------------------------------------------------------------
// Repeat orders
// ---------------------------------------------------------------------------

/**
 * Copies a previous order's shape into a draft.
 *
 * The brief, references and the list of items come across. The deadline and
 * the money deliberately do not: they are last time's terms, and carrying them
 * silently into a new job is how a studio ends up honouring a price it never
 * agreed to.
 */
function draftFromProject(db, guildId, sourceProject, tasks, { name = null } = {}, actorUserId) {
  const items = tasks
    .filter((task) => task.state !== 'cancelled')
    .map((task) => ({
      title: task.title,
      department_id: task.department_id,
      brief: task.brief,
      deliverables_json: task.deliverables_json,
      formats: task.formats,
      tech_requirements: task.tech_requirements,
      revision_rounds: task.revision_rounds,
    }));

  const now = Date.now();
  const draft = db.prepare(`
    INSERT INTO order_drafts (guild_id, client_id, source_project_id, name, brief, reference_links, items_json, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *
  `).get(
    guildId, sourceProject.client_id, sourceProject.id,
    name || `${sourceProject.name} (repeat)`,
    sourceProject.brief, sourceProject.reference_links,
    JSON.stringify(items), actorUserId, now, now
  );

  recordAudit(db, {
    guildId, actorUserId, action: 'order_draft.create', entityType: 'order_draft', entityId: draft.id,
    after: { source: sourceProject.code, items: items.length },
    detail: 'Scope, price and deadline start unconfirmed and must each be set before this becomes an order.',
  });
  return draft;
}

function getDraft(db, guildId, id) {
  return db.prepare('SELECT * FROM order_drafts WHERE guild_id = ? AND id = ?').get(guildId, id) || null;
}

function listDrafts(db, guildId, { status = DRAFT_STATES.DRAFT, clientId = null, limit = 25 } = {}) {
  const clauses = ['guild_id = ?'];
  const params = [guildId];
  if (status !== 'all') { clauses.push('status = ?'); params.push(status); }
  if (clientId) { clauses.push('client_id = ?'); params.push(clientId); }

  return db.prepare(`
    SELECT * FROM order_drafts WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT ?
  `).all(...params, limit);
}

function draftItems(draft) {
  try {
    const parsed = JSON.parse(draft.items_json || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Records one of the three confirmations.
 *
 * Each is stamped with who confirmed it and when, so "we agreed that price"
 * has a name against it. Changing a value after it was confirmed clears the
 * confirmation, because agreeing to one figure is not agreeing to another.
 */
function confirmScope(db, guildId, id, { items, actorUserId }) {
  db.prepare(`
    UPDATE order_drafts SET items_json = ?, scope_confirmed_by = ?, scope_confirmed_at = ?, updated_at = ?
    WHERE guild_id = ? AND id = ? AND status = 'draft'
  `).run(JSON.stringify(items), actorUserId, Date.now(), Date.now(), guildId, id);

  recordAudit(db, {
    guildId, actorUserId, action: 'order_draft.scope', entityType: 'order_draft', entityId: id,
    after: { items: items.length },
  });
  return getDraft(db, guildId, id);
}

function confirmPrice(db, guildId, id, { amountMinor, currency, actorUserId }) {
  db.prepare(`
    UPDATE order_drafts SET client_amount_minor = ?, client_currency = ?, price_confirmed_by = ?, price_confirmed_at = ?, updated_at = ?
    WHERE guild_id = ? AND id = ? AND status = 'draft'
  `).run(amountMinor, currency, actorUserId, Date.now(), Date.now(), guildId, id);

  recordAudit(db, {
    guildId, actorUserId, action: 'order_draft.price', entityType: 'order_draft', entityId: id,
    after: { amount_minor: amountMinor, currency },
  });
  return getDraft(db, guildId, id);
}

function confirmDeadline(db, guildId, id, { deadlineUtc, actorUserId }) {
  db.prepare(`
    UPDATE order_drafts SET deadline_utc = ?, deadline_confirmed_by = ?, deadline_confirmed_at = ?, updated_at = ?
    WHERE guild_id = ? AND id = ? AND status = 'draft'
  `).run(deadlineUtc, actorUserId, Date.now(), Date.now(), guildId, id);

  recordAudit(db, {
    guildId, actorUserId, action: 'order_draft.deadline', entityType: 'order_draft', entityId: id,
    after: { deadline_utc: deadlineUtc },
  });
  return getDraft(db, guildId, id);
}

/** What is still missing before this draft can become an order. */
function outstandingConfirmations(draft) {
  const missing = [];
  if (!draft.scope_confirmed_at) missing.push('scope');
  if (!draft.price_confirmed_at) missing.push('price');
  if (!draft.deadline_confirmed_at) missing.push('deadline');
  return missing;
}

function markConfirmed(db, guildId, id, projectId, actorUserId) {
  const result = db.prepare(`
    UPDATE order_drafts SET status = 'confirmed', project_id = ?, updated_at = ?
    WHERE guild_id = ? AND id = ? AND status = 'draft'
  `).run(projectId, Date.now(), guildId, id);

  if (result.changes === 0) return null;
  recordAudit(db, {
    guildId, actorUserId, action: 'order_draft.confirmed', entityType: 'order_draft', entityId: id,
    after: { project_id: projectId },
  });
  return getDraft(db, guildId, id);
}

function discardDraft(db, guildId, id, actorUserId) {
  const result = db.prepare(`
    UPDATE order_drafts SET status = 'discarded', updated_at = ? WHERE guild_id = ? AND id = ? AND status = 'draft'
  `).run(Date.now(), guildId, id);

  if (result.changes === 0) return null;
  recordAudit(db, { guildId, actorUserId, action: 'order_draft.discard', entityType: 'order_draft', entityId: id });
  return getDraft(db, guildId, id);
}

module.exports = {
  DRAFT_STATES,
  addRequirement,
  updateRequirement,
  getRequirement,
  listRequirements,
  requirementsForProject,
  draftFromProject,
  getDraft,
  listDrafts,
  draftItems,
  confirmScope,
  confirmPrice,
  confirmDeadline,
  outstandingConfirmations,
  markConfirmed,
  discardDraft,
};
