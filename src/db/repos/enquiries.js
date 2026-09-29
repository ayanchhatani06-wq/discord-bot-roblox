const { nextCode, recordAudit } = require('./core');
const { totalsByCurrency } = require('../../domain/money');

const STATUSES = Object.freeze({
  NEW: 'new',
  NEEDS_INFO: 'needs_info',
  QUOTE_PREPARED: 'quote_prepared',
  QUOTE_SENT: 'quote_sent',
  ACCEPTED: 'accepted',
  DECLINED: 'declined',
  CLOSED: 'closed',
});

const STATUS_LABELS = Object.freeze({
  new: 'New',
  needs_info: 'Needs information',
  quote_prepared: 'Quote prepared',
  quote_sent: 'Quote sent',
  accepted: 'Accepted',
  declined: 'Declined',
  closed: 'Closed',
});

const QUOTE_STATUSES = Object.freeze({
  DRAFT: 'draft',
  APPROVED: 'approved',
  SENT: 'sent',
  ACCEPTED: 'accepted',
  DECLINED: 'declined',
  SUPERSEDED: 'superseded',
});

function createEnquiry(db, guildId, {
  clientId = null,
  raisedBy = null,
  contactRef = null,
  source = 'discord',
  serviceRequest,
  parsed = null,
  referencesText = null,
  formatsText = null,
  desiredDeadlineUtc = null,
  deadlineText = null,
  budgetText = null,
  notes = null,
  assignedLeader = null,
}, actorUserId) {
  return db.transaction(() => {
    const now = Date.now();
    const code = nextCode(db, guildId, 'enquiry');

    const enquiry = db.prepare(`
      INSERT INTO enquiries (
        guild_id, code, client_id, raised_by, contact_ref, source, service_request, parsed_json,
        references_text, formats_text, desired_deadline_utc, deadline_text, budget_text, notes,
        assigned_leader, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING *
    `).get(
      guildId, code, clientId, raisedBy, contactRef, source, serviceRequest,
      parsed ? JSON.stringify(parsed) : null, referencesText, formatsText,
      desiredDeadlineUtc, deadlineText, budgetText, notes, assignedLeader, now, now
    );

    recordAudit(db, {
      guildId, actorUserId: actorUserId ?? raisedBy, action: 'enquiry.create',
      entityType: 'enquiry', entityId: enquiry.id,
      after: { code, source, service_request: serviceRequest },
    });
    return enquiry;
  })();
}

function getEnquiry(db, guildId, id) {
  return db.prepare('SELECT * FROM enquiries WHERE guild_id = ? AND id = ?').get(guildId, id) || null;
}

function getEnquiryByCode(db, guildId, code) {
  return db.prepare('SELECT * FROM enquiries WHERE guild_id = ? AND code = ?')
    .get(guildId, String(code).toUpperCase()) || null;
}

function listEnquiries(db, guildId, { status = 'open', limit = 25 } = {}) {
  if (status === 'open') {
    return db.prepare(`
      SELECT * FROM enquiries WHERE guild_id = ? AND status NOT IN ('accepted', 'declined', 'closed')
      ORDER BY created_at DESC LIMIT ?
    `).all(guildId, limit);
  }
  if (status === 'all') {
    return db.prepare('SELECT * FROM enquiries WHERE guild_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(guildId, limit);
  }
  return db.prepare('SELECT * FROM enquiries WHERE guild_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?')
    .all(guildId, status, limit);
}

function searchEnquiries(db, guildId, query, limit = 25) {
  const like = `%${String(query || '').toLowerCase()}%`;
  return db.prepare(`
    SELECT * FROM enquiries WHERE guild_id = ? AND (LOWER(code) LIKE ? OR LOWER(service_request) LIKE ?)
    ORDER BY created_at DESC LIMIT ?
  `).all(guildId, like, like, limit);
}

/**
 * Status changes go through here so every move between stages is audited and
 * the set of valid statuses is enforced in one place.
 */
function setStatus(db, guildId, id, status, actorUserId, { detail = null, closedReason = null } = {}) {
  if (!Object.values(STATUSES).includes(status)) {
    throw new Error(`Unknown enquiry status: ${status}`);
  }

  const before = getEnquiry(db, guildId, id);
  if (!before) return null;

  db.prepare('UPDATE enquiries SET status = ?, closed_reason = COALESCE(?, closed_reason), updated_at = ? WHERE id = ?')
    .run(status, closedReason, Date.now(), id);

  recordAudit(db, {
    guildId, actorUserId, action: 'enquiry.status', entityType: 'enquiry', entityId: id,
    before: { status: before.status }, after: { status }, detail,
  });
  return getEnquiry(db, guildId, id);
}

function updateEnquiry(db, guildId, id, patch, actorUserId) {
  const allowed = [
    'client_id', 'assigned_leader', 'service_request', 'references_text', 'formats_text',
    'desired_deadline_utc', 'deadline_text', 'budget_text', 'notes', 'parsed_json', 'project_id', 'contact_ref',
  ];
  const before = getEnquiry(db, guildId, id);
  if (!before) return null;

  const entries = Object.entries(patch).filter(([key]) => allowed.includes(key));
  if (entries.length === 0) return before;

  db.prepare(`UPDATE enquiries SET ${entries.map(([key]) => `${key} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
    .run(...entries.map(([, value]) => value), Date.now(), id);

  const after = getEnquiry(db, guildId, id);
  recordAudit(db, {
    guildId, actorUserId, action: 'enquiry.update', entityType: 'enquiry', entityId: id,
    before: Object.fromEntries(entries.map(([key]) => [key, before[key]])),
    after: Object.fromEntries(entries.map(([key]) => [key, after[key]])),
  });
  return after;
}

function parsedItems(enquiry) {
  try {
    const parsed = JSON.parse(enquiry?.parsed_json || 'null');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// --- quote templates -----------------------------------------------------

function upsertTemplate(db, guildId, {
  key, label, departmentId = null, unitAmountMinor = null, currency = null,
  turnaroundDays = null, deliverables = [], revisionRounds = null, notes = null,
}, actorUserId) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO quote_templates (
      guild_id, key, label, department_id, unit_amount_minor, currency,
      turnaround_days, deliverables_json, revision_rounds, notes, created_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (guild_id, key) DO UPDATE SET
      label = excluded.label,
      department_id = excluded.department_id,
      unit_amount_minor = excluded.unit_amount_minor,
      currency = excluded.currency,
      turnaround_days = excluded.turnaround_days,
      deliverables_json = excluded.deliverables_json,
      revision_rounds = excluded.revision_rounds,
      notes = excluded.notes,
      updated_at = excluded.updated_at
  `).run(
    guildId, key, label, departmentId, unitAmountMinor, currency,
    turnaroundDays, JSON.stringify(deliverables), revisionRounds, notes, actorUserId, now, now
  );

  const saved = getTemplate(db, guildId, key);
  recordAudit(db, {
    guildId, actorUserId, action: 'quote_template.upsert', entityType: 'quote_template', entityId: saved.id,
    after: { key, unit_amount_minor: unitAmountMinor, currency },
  });
  return saved;
}

function getTemplate(db, guildId, key) {
  return db.prepare('SELECT * FROM quote_templates WHERE guild_id = ? AND key = ?').get(guildId, key) || null;
}

function templateForDepartment(db, guildId, departmentId) {
  return db.prepare('SELECT * FROM quote_templates WHERE guild_id = ? AND department_id = ? LIMIT 1')
    .get(guildId, departmentId) || null;
}

function listTemplates(db, guildId) {
  return db.prepare('SELECT * FROM quote_templates WHERE guild_id = ? ORDER BY label').all(guildId);
}

function templateDeliverables(template) {
  try {
    const parsed = JSON.parse(template?.deliverables_json || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// --- quotes --------------------------------------------------------------

/**
 * Creates a draft. A draft is never a commitment: it cannot be sent until the
 * owner approves it, which is enforced by `approveQuote` being the only path
 * to the approved status.
 */
function createQuote(db, guildId, enquiryId, { lines, totalMinor, currency, turnaroundDays = null, deliveryNote = null, terms = null }, actorUserId) {
  return db.transaction(() => {
    const previous = db.prepare('SELECT COALESCE(MAX(version), 0) AS latest FROM quotes WHERE enquiry_id = ?').get(enquiryId);
    const version = previous.latest + 1;

    // Any earlier draft or sent quote is superseded rather than left looking live.
    db.prepare(`
      UPDATE quotes SET status = 'superseded'
      WHERE enquiry_id = ? AND status IN ('draft', 'approved', 'sent')
    `).run(enquiryId);

    const quote = db.prepare(`
      INSERT INTO quotes (
        guild_id, enquiry_id, version, lines_json, total_minor, currency,
        turnaround_days, delivery_note, terms, prepared_by, prepared_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING *
    `).get(
      guildId, enquiryId, version, JSON.stringify(lines), totalMinor, currency,
      turnaroundDays, deliveryNote, terms, actorUserId, Date.now()
    );

    recordAudit(db, {
      guildId, actorUserId, action: 'quote.draft', entityType: 'enquiry', entityId: enquiryId,
      after: { version, total_minor: totalMinor, currency },
      detail: 'Draft only; not valid until the owner approves it',
    });
    return quote;
  })();
}

function getQuote(db, guildId, id) {
  return db.prepare('SELECT * FROM quotes WHERE guild_id = ? AND id = ?').get(guildId, id) || null;
}

function latestQuote(db, enquiryId) {
  return db.prepare('SELECT * FROM quotes WHERE enquiry_id = ? ORDER BY version DESC LIMIT 1').get(enquiryId) || null;
}

function listQuotes(db, enquiryId) {
  return db.prepare('SELECT * FROM quotes WHERE enquiry_id = ? ORDER BY version').all(enquiryId);
}

/** The owner's approval. Nothing reaches a client without passing through here. */
function approveQuote(db, guildId, quoteId, actorUserId) {
  const result = db.prepare(`
    UPDATE quotes SET status = 'approved', approved_by = ?, approved_at = ?
    WHERE guild_id = ? AND id = ? AND status = 'draft'
  `).run(actorUserId, Date.now(), guildId, quoteId);

  if (result.changes === 0) return null;

  recordAudit(db, {
    guildId, actorUserId, action: 'quote.approve', entityType: 'quote', entityId: quoteId,
  });
  return getQuote(db, guildId, quoteId);
}

function markQuoteSent(db, guildId, quoteId, actorUserId) {
  const result = db.prepare(`
    UPDATE quotes SET status = 'sent', sent_by = ?, sent_at = ?
    WHERE guild_id = ? AND id = ? AND status = 'approved'
  `).run(actorUserId, Date.now(), guildId, quoteId);

  if (result.changes === 0) return null;

  recordAudit(db, { guildId, actorUserId, action: 'quote.send', entityType: 'quote', entityId: quoteId });
  return getQuote(db, guildId, quoteId);
}

function respondToQuote(db, guildId, quoteId, { accepted, actorUserId, declineReason = null }) {
  const result = db.prepare(`
    UPDATE quotes SET status = ?, responded_at = ?, decline_reason = ?
    WHERE guild_id = ? AND id = ? AND status = 'sent'
  `).run(accepted ? 'accepted' : 'declined', Date.now(), declineReason, guildId, quoteId);

  if (result.changes === 0) return null;

  recordAudit(db, {
    guildId, actorUserId, action: accepted ? 'quote.accepted' : 'quote.declined',
    entityType: 'quote', entityId: quoteId, detail: declineReason,
  });
  return getQuote(db, guildId, quoteId);
}

function quoteLines(quote) {
  try {
    const parsed = JSON.parse(quote?.lines_json || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function pipelineCounts(db, guildId) {
  const rows = db.prepare('SELECT status, COUNT(*) AS n FROM enquiries WHERE guild_id = ? GROUP BY status').all(guildId);
  const counts = Object.fromEntries(Object.values(STATUSES).map((status) => [status, 0]));
  for (const row of rows) counts[row.status] = row.n;
  return counts;
}

/** Value of quotes sent and awaiting an answer, per currency. */
function outstandingQuoteValue(db, guildId) {
  const rows = db.prepare(`
    SELECT total_minor AS minor, currency FROM quotes WHERE guild_id = ? AND status = 'sent'
  `).all(guildId);
  return totalsByCurrency(rows);
}

module.exports = {
  STATUSES,
  STATUS_LABELS,
  QUOTE_STATUSES,
  createEnquiry,
  getEnquiry,
  getEnquiryByCode,
  listEnquiries,
  searchEnquiries,
  setStatus,
  updateEnquiry,
  parsedItems,
  upsertTemplate,
  getTemplate,
  templateForDepartment,
  listTemplates,
  templateDeliverables,
  createQuote,
  getQuote,
  latestQuote,
  listQuotes,
  approveQuote,
  markQuoteSent,
  respondToQuote,
  quoteLines,
  pipelineCounts,
  outstandingQuoteValue,
};
