const { CAPABILITIES, can } = require('../domain/permissions');

/**
 * One search across everything.
 *
 * Thirty-two commands is a lot to hold in your head when you only want to find
 * a thing. This looks in every place a thing could be and answers in one list.
 *
 * Two rules it must not break. Results are filtered by what the caller may
 * see, using the same capabilities the commands use — a search that returns a
 * result somebody is then refused has already leaked that the thing exists.
 * And money never appears unless the caller could see it anyway.
 */

const KINDS = Object.freeze({
  TASK: 'task',
  PROJECT: 'project',
  CLIENT: 'client',
  STAFF: 'staff',
  ASSET: 'asset',
  ENQUIRY: 'enquiry',
  EVIDENCE: 'evidence',
});

const KIND_ICONS = Object.freeze({
  task: '📋', project: '📁', client: '🤝', staff: '👤',
  asset: '📎', enquiry: '✉️', evidence: '🔒',
});

function like(query) {
  return `%${String(query || '').toLowerCase().trim()}%`;
}

function result(kind, { id, title, subtitle = null, command = null }) {
  return { kind, id, title, subtitle, command };
}

/**
 * Tasks, by code or title.
 *
 * A leader who is not the owner sees their own departments. Somebody with no
 * department sees only work they are on, which is the same rule their desk
 * follows.
 */
function searchTasks(db, guildId, query, actor, { limit = 8 } = {}) {
  const rows = db.prepare(`
    SELECT t.*, d.name AS department_name, p.name AS project_name
    FROM tasks t
    LEFT JOIN departments d ON d.id = t.department_id
    LEFT JOIN projects p ON p.id = t.project_id
    WHERE t.guild_id = ? AND (LOWER(t.code) LIKE ? OR LOWER(t.title) LIKE ?)
    ORDER BY t.updated_at DESC LIMIT 40
  `).all(guildId, like(query), like(query));

  const seesEverything = actor.isOwner || can(actor, CAPABILITIES.SUMMARY_VIEW);

  return rows
    .filter((task) => {
      if (seesEverything) return true;
      if (actor.leadDepartmentIds.includes(task.department_id)) return true;
      // Otherwise only their own work.
      return task.artist_user_id === actor.userId;
    })
    .slice(0, limit)
    .map((task) => result(KINDS.TASK, {
      id: task.id,
      title: `${task.code} · ${task.title}`,
      subtitle: [
        String(task.state).replace(/_/g, ' '),
        task.department_name,
        task.project_name,
        task.artist_user_id ? `with <@${task.artist_user_id}>` : 'nobody on it',
      ].filter(Boolean).join(' · '),
      command: `/task view task:${task.code}`,
    }));
}

function searchProjects(db, guildId, query, actor, { limit = 6 } = {}) {
  if (!actor.isOwner && !can(actor, CAPABILITIES.PROJECT_EDIT) && !can(actor, CAPABILITIES.SUMMARY_VIEW)) {
    return [];
  }

  return db.prepare(`
    SELECT p.*, c.display_name AS client_name FROM projects p
    LEFT JOIN clients c ON c.id = p.client_id
    WHERE p.guild_id = ? AND (LOWER(p.code) LIKE ? OR LOWER(p.name) LIKE ?)
    ORDER BY p.updated_at DESC LIMIT ?
  `).all(guildId, like(query), like(query), limit)
    .map((project) => result(KINDS.PROJECT, {
      id: project.id,
      title: `${project.code} · ${project.name}`,
      subtitle: [project.status, project.client_name].filter(Boolean).join(' · '),
      command: `/project view project:${project.code}`,
    }));
}

function searchClients(db, guildId, query, actor, { limit = 5 } = {}) {
  // Client records carry contact details and finder arrangements.
  if (!actor.isOwner && !can(actor, CAPABILITIES.PROJECT_EDIT)) return [];

  return db.prepare(`
    SELECT * FROM clients WHERE guild_id = ? AND LOWER(display_name) LIKE ?
    ORDER BY display_name LIMIT ?
  `).all(guildId, like(query), limit)
    .map((client) => result(KINDS.CLIENT, {
      id: client.id,
      title: client.display_name,
      subtitle: client.preferred_contact || 'no contact recorded',
      command: `/clients view client:${client.display_name}`,
    }));
}

function searchStaff(db, guildId, query, actor, { limit = 5 } = {}) {
  return db.prepare(`
    SELECT * FROM staff
    WHERE guild_id = ? AND (LOWER(COALESCE(display_name, '')) LIKE ? OR LOWER(COALESCE(specialties, '')) LIKE ?)
    ORDER BY display_name LIMIT ?
  `).all(guildId, like(query), like(query), limit)
    .map((member) => result(KINDS.STAFF, {
      id: member.user_id,
      title: member.display_name || member.user_id,
      subtitle: [
        member.removed_at ? 'no longer here' : member.availability?.replace(/_/g, ' '),
        member.specialties,
      ].filter(Boolean).join(' · '),
      command: `/profile view member:<@${member.user_id}>`,
    }));
}

function searchAssets(db, guildId, query, actor, { limit = 6 } = {}) {
  if (!actor.isOwner && actor.capabilities.size === 0 && actor.leadDepartmentIds.length === 0) return [];

  return db.prepare(`
    SELECT a.*, t.code AS task_code, t.title AS task_title FROM assets a
    LEFT JOIN tasks t ON t.id = a.task_id
    WHERE a.guild_id = ? AND (
      LOWER(COALESCE(a.label, '')) LIKE ? OR LOWER(a.url) LIKE ?
      OR LOWER(COALESCE(a.roblox_asset_id, '')) LIKE ? OR LOWER(COALESCE(t.title, '')) LIKE ?
    )
    ORDER BY a.created_at DESC LIMIT ?
  `).all(guildId, like(query), like(query), like(query), like(query), limit)
    .map((asset) => result(KINDS.ASSET, {
      id: asset.id,
      title: asset.label || asset.task_title || 'Untitled file',
      subtitle: [
        asset.kind,
        asset.task_code,
        asset.roblox_asset_id ? `Roblox ${asset.roblox_asset_id}` : null,
      ].filter(Boolean).join(' · '),
      command: asset.task_code ? `/archive task task:${asset.task_code}` : '/archive search',
    }));
}

function searchEnquiries(db, guildId, query, actor, { limit = 4 } = {}) {
  if (!actor.isOwner && !can(actor, CAPABILITIES.PROJECT_CREATE)) return [];

  return db.prepare(`
    SELECT * FROM enquiries
    WHERE guild_id = ? AND (LOWER(code) LIKE ? OR LOWER(COALESCE(contact_ref, '')) LIKE ? OR LOWER(service_request) LIKE ?)
    ORDER BY created_at DESC LIMIT ?
  `).all(guildId, like(query), like(query), like(query), limit)
    .map((enquiry) => result(KINDS.ENQUIRY, {
      id: enquiry.id,
      title: `${enquiry.code} · ${enquiry.service_request}`,
      subtitle: [enquiry.status, enquiry.contact_ref].filter(Boolean).join(' · '),
      command: `/enquiry view code:${enquiry.code}`,
    }));
}

function searchEvidence(db, guildId, query, actor, { limit = 4 } = {}) {
  // Evidence is filed for disputes and payments, so it stays with the people
  // who handle those.
  if (!actor.isOwner && !can(actor, CAPABILITIES.FINANCE_VIEW_ALL) && !can(actor, CAPABILITIES.CLIENT_RECORD)) {
    return [];
  }

  return db.prepare(`
    SELECT * FROM evidence
    WHERE guild_id = ? AND (LOWER(filename) LIKE ? OR LOWER(COALESCE(note, '')) LIKE ?)
    ORDER BY added_at DESC LIMIT ?
  `).all(guildId, like(query), like(query), limit)
    .map((row) => result(KINDS.EVIDENCE, {
      id: row.id,
      title: row.filename,
      subtitle: [row.kind.replace(/_/g, ' '), row.note].filter(Boolean).join(' · '),
      command: `/proof show id:${row.id}`,
    }));
}

/**
 * Everything matching, grouped by kind.
 *
 * A short query is refused rather than returning half the studio: two
 * characters matches almost everything and helps nobody.
 */
function everything(db, guildId, query, actor, { limit = 25 } = {}) {
  const text = String(query || '').trim();
  if (text.length < 2) return { ok: false, reason: 'too_short' };

  const groups = [
    ...searchTasks(db, guildId, text, actor),
    ...searchProjects(db, guildId, text, actor),
    ...searchClients(db, guildId, text, actor),
    ...searchStaff(db, guildId, text, actor),
    ...searchAssets(db, guildId, text, actor),
    ...searchEnquiries(db, guildId, text, actor),
    ...searchEvidence(db, guildId, text, actor),
  ];

  return {
    ok: true,
    query: text,
    total: groups.length,
    results: groups.slice(0, limit),
    byKind: Object.values(KINDS).reduce((out, kind) => {
      out[kind] = groups.filter((row) => row.kind === kind).length;
      return out;
    }, {}),
  };
}

module.exports = {
  KINDS,
  KIND_ICONS,
  searchTasks,
  searchProjects,
  searchClients,
  searchStaff,
  searchAssets,
  searchEnquiries,
  searchEvidence,
  everything,
};
