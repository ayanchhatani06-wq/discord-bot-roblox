const { recordAudit } = require('./core');

const KINDS = Object.freeze({ DELIVERABLE: 'deliverable', SOURCE: 'source', PREVIEW: 'preview' });

/**
 * Portfolio permission resolves in one place: an asset's own setting wins, and
 * where it has none the project's applies. Unknown is never treated as allowed
 * — if nobody has recorded permission, the answer is no.
 */
function resolvePortfolioRights(asset, project, { now = Date.now() } = {}) {
  const pick = (assetValue, projectValue) => (assetValue === null || assetValue === undefined ? projectValue : assetValue);

  const staffAllowed = pick(asset?.portfolio_staff_allowed, project?.portfolio_staff_allowed);
  const studioAllowed = pick(asset?.portfolio_studio_allowed, project?.portfolio_studio_allowed);
  const fromUtc = pick(asset?.portfolio_from_utc, project?.portfolio_from_utc);
  const restrictions = asset?.portfolio_restrictions || project?.portfolio_restrictions || null;

  const recorded = staffAllowed !== null && staffAllowed !== undefined
    && studioAllowed !== null && studioAllowed !== undefined;
  const started = !fromUtc || fromUtc <= now;

  return {
    recorded,
    staffAllowed: recorded ? staffAllowed === 1 : false,
    studioAllowed: recorded ? studioAllowed === 1 : false,
    fromUtc: fromUtc ?? null,
    started,
    restrictions,
    // Usable right now, as opposed to permitted in principle later.
    staffUsableNow: recorded && staffAllowed === 1 && started,
    studioUsableNow: recorded && studioAllowed === 1 && started,
    source: asset?.portfolio_staff_allowed === null || asset?.portfolio_staff_allowed === undefined ? 'project' : 'asset',
  };
}

function addAsset(db, guildId, {
  projectId, taskId, submissionId, version = null, label = null, url,
  kind, assetType = null, createdBy, clientReleasedAt = null,
}) {
  return db.prepare(`
    INSERT INTO assets (
      guild_id, project_id, task_id, submission_id, version, label, url, kind,
      asset_type, created_by, created_at, client_released_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING *
  `).get(
    guildId, projectId, taskId, submissionId, version, label, url, kind,
    assetType, createdBy, Date.now(), clientReleasedAt
  );
}

/**
 * Records every link on a submission as an asset, keeping deliverables and
 * internal working files apart so the two can never be confused later.
 */
function recordSubmissionAssets(db, guildId, { submission, task, deliverableLinks, internalLinks = [], assetType = null }) {
  const created = [];
  const kind = submission.kind === 'final' ? KINDS.DELIVERABLE : KINDS.PREVIEW;

  for (const url of deliverableLinks) {
    created.push(addAsset(db, guildId, {
      projectId: task.project_id,
      taskId: task.id,
      submissionId: submission.id,
      version: submission.version,
      url,
      kind,
      assetType,
      createdBy: submission.submitted_by,
    }));
  }

  for (const url of internalLinks) {
    created.push(addAsset(db, guildId, {
      projectId: task.project_id,
      taskId: task.id,
      submissionId: submission.id,
      version: submission.version,
      url,
      kind: KINDS.SOURCE,
      assetType,
      createdBy: submission.submitted_by,
    }));
  }

  return created;
}

/** Source files are never released, whatever else happens to the submission. */
function releaseSubmissionAssets(db, submissionId) {
  const result = db.prepare(`
    UPDATE assets SET client_released_at = ?
    WHERE submission_id = ? AND kind != 'source' AND client_released_at IS NULL
  `).run(Date.now(), submissionId);
  return result.changes;
}

function markDelivered(db, taskId, version) {
  const result = db.prepare(`
    UPDATE assets SET delivered_at = ?
    WHERE task_id = ? AND version = ? AND kind = 'deliverable'
  `).run(Date.now(), taskId, version);
  return result.changes;
}

function listForTask(db, taskId, { kind = null } = {}) {
  if (kind) {
    return db.prepare('SELECT * FROM assets WHERE task_id = ? AND kind = ? ORDER BY version, id').all(taskId, kind);
  }
  return db.prepare('SELECT * FROM assets WHERE task_id = ? ORDER BY version, id').all(taskId);
}

function listForProject(db, projectId, { kind = null } = {}) {
  if (kind) {
    return db.prepare('SELECT * FROM assets WHERE project_id = ? AND kind = ? ORDER BY id').all(projectId, kind);
  }
  return db.prepare('SELECT * FROM assets WHERE project_id = ? ORDER BY id').all(projectId);
}

function getAsset(db, guildId, id) {
  return db.prepare('SELECT * FROM assets WHERE guild_id = ? AND id = ?').get(guildId, id) || null;
}

/**
 * The archive. Filters are applied in SQL where they are cheap and in JS for
 * portfolio permission, which depends on the project fallback.
 */
function search(db, guildId, {
  projectId = null,
  artistUserId = null,
  assetType = null,
  kind = null,
  query = null,
  portfolio = null,
  limit = 50,
} = {}) {
  const clauses = ['a.guild_id = ?'];
  const params = [guildId];

  if (projectId !== null) { clauses.push('a.project_id = ?'); params.push(projectId); }
  if (assetType !== null) { clauses.push('a.asset_type = ?'); params.push(assetType); }
  if (kind !== null) { clauses.push('a.kind = ?'); params.push(kind); }
  if (artistUserId !== null) { clauses.push('t.artist_user_id = ?'); params.push(artistUserId); }
  if (query) {
    clauses.push('(LOWER(a.url) LIKE ? OR LOWER(COALESCE(a.label, \'\')) LIKE ? OR LOWER(t.title) LIKE ?)');
    const like = `%${String(query).toLowerCase()}%`;
    params.push(like, like, like);
  }

  const rows = db.prepare(`
    SELECT a.*, t.title AS task_title, t.code AS task_code, t.artist_user_id,
           p.name AS project_name, p.code AS project_code
    FROM assets a
    LEFT JOIN tasks t ON t.id = a.task_id
    LEFT JOIN projects p ON p.id = a.project_id
    WHERE ${clauses.join(' AND ')}
    ORDER BY a.created_at DESC
    LIMIT ?
  `).all(...params, limit * 2);

  const projectCache = new Map();
  const withRights = rows.map((row) => {
    if (!projectCache.has(row.project_id)) {
      projectCache.set(row.project_id, db.prepare('SELECT * FROM projects WHERE id = ?').get(row.project_id) || null);
    }
    return { ...row, rights: resolvePortfolioRights(row, projectCache.get(row.project_id)) };
  });

  const filtered = portfolio === null
    ? withRights
    : withRights.filter((row) => {
        if (portfolio === 'staff') return row.rights.staffUsableNow;
        if (portfolio === 'studio') return row.rights.studioUsableNow;
        if (portfolio === 'none') return !row.rights.recorded;
        if (portfolio === 'pending') return row.rights.recorded && !row.rights.started;
        return true;
      });

  return filtered.slice(0, limit);
}

function setProjectRights(db, guildId, projectId, {
  staffAllowed, studioAllowed, fromUtc = null, restrictions = null, actorUserId,
}) {
  db.prepare(`
    UPDATE projects SET portfolio_staff_allowed = ?, portfolio_studio_allowed = ?,
      portfolio_from_utc = ?, portfolio_restrictions = ?, portfolio_set_by = ?, portfolio_set_at = ?, updated_at = ?
    WHERE guild_id = ? AND id = ?
  `).run(
    staffAllowed ? 1 : 0, studioAllowed ? 1 : 0, fromUtc, restrictions,
    actorUserId, Date.now(), Date.now(), guildId, projectId
  );

  recordAudit(db, {
    guildId, actorUserId, action: 'portfolio.rights.project', entityType: 'project', entityId: projectId,
    after: { staff: staffAllowed ? 1 : 0, studio: studioAllowed ? 1 : 0, from: fromUtc, restrictions },
  });
}

function setAssetRights(db, guildId, assetId, {
  staffAllowed, studioAllowed, fromUtc = null, restrictions = null, actorUserId,
}) {
  db.prepare(`
    UPDATE assets SET portfolio_staff_allowed = ?, portfolio_studio_allowed = ?,
      portfolio_from_utc = ?, portfolio_restrictions = ?, rights_set_by = ?, rights_set_at = ?
    WHERE guild_id = ? AND id = ?
  `).run(
    staffAllowed === null ? null : (staffAllowed ? 1 : 0),
    studioAllowed === null ? null : (studioAllowed ? 1 : 0),
    fromUtc, restrictions, actorUserId, Date.now(), guildId, assetId
  );

  recordAudit(db, {
    guildId, actorUserId, action: 'portfolio.rights.asset', entityType: 'asset', entityId: assetId,
    after: { staff: staffAllowed, studio: studioAllowed, from: fromUtc, restrictions },
  });
  return getAsset(db, guildId, assetId);
}

/**
 * What the public site may show: studio-portfolio assets whose permission has
 * started. Written as one query so the website cannot accidentally widen it.
 */
function publishablePortfolio(db, guildId, { now = Date.now(), limit = 100 } = {}) {
  return search(db, guildId, { kind: KINDS.DELIVERABLE, portfolio: 'studio', limit })
    .filter((row) => row.rights.studioUsableNow && (!row.rights.fromUtc || row.rights.fromUtc <= now));
}

function rightsSummary(db, guildId, projectId) {
  const assets = listForProject(db, projectId);
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);

  let unrecorded = 0;
  let staffOk = 0;
  let studioOk = 0;
  let pending = 0;

  for (const asset of assets) {
    const rights = resolvePortfolioRights(asset, project);
    if (!rights.recorded) unrecorded += 1;
    else if (!rights.started) pending += 1;
    if (rights.staffUsableNow) staffOk += 1;
    if (rights.studioUsableNow) studioOk += 1;
  }

  return { total: assets.length, unrecorded, staffOk, studioOk, pending };
}


/**
 * The Roblox asset ID a file ended up as.
 *
 * A link to a file in Discord and the uploaded asset on Roblox are two different
 * things, and it is the asset ID that matters months later: it is what somebody
 * puts in a script, what proves an upload happened, and what survives the
 * original file being lost. Recorded as digits only, because that is all a
 * Roblox asset ID ever is, and a pasted full URL would otherwise be stored as if
 * it were an ID.
 */
function setRobloxAssetId(db, guildId, assetId, { robloxAssetId, actorUserId }) {
  const asset = getAsset(db, guildId, assetId);
  if (!asset) return { ok: false, reason: 'not_found' };

  // Accepts a bare ID or any URL containing one, and keeps the digits.
  const digits = String(robloxAssetId ?? '').match(/\d{4,}/);
  if (!digits) return { ok: false, reason: 'not_an_id' };

  const updated = db.prepare(`
    UPDATE assets SET roblox_asset_id = ? WHERE guild_id = ? AND id = ? RETURNING *
  `).get(digits[0], guildId, assetId);

  recordAudit(db, {
    guildId, actorUserId, action: 'asset.roblox_id.set',
    entityType: 'task', entityId: asset.task_id,
    before: { roblox_asset_id: asset.roblox_asset_id },
    after: { roblox_asset_id: digits[0] },
  });

  return { ok: true, asset: updated, previous: asset.roblox_asset_id };
}

/** Everything on this order that has been uploaded to Roblox. */
function robloxAssetsForProject(db, guildId, projectId) {
  return db.prepare(`
    SELECT a.*, t.code AS task_code, t.title AS task_title FROM assets a
    LEFT JOIN tasks t ON t.id = a.task_id
    WHERE a.guild_id = ? AND a.roblox_asset_id IS NOT NULL
      AND (a.project_id = ? OR t.project_id = ?)
    ORDER BY a.id
  `).all(guildId, projectId, projectId);
}

module.exports = {
  KINDS,
  resolvePortfolioRights,
  addAsset,
  recordSubmissionAssets,
  releaseSubmissionAssets,
  markDelivered,
  listForTask,
  listForProject,
  getAsset,
  search,
  setProjectRights,
  setAssetRights,
  publishablePortfolio,
  rightsSummary,
  setRobloxAssetId,
  robloxAssetsForProject,
};
