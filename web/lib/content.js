const configRepo = require('../../src/db/repos/config');
const webRepo = require('../../src/db/repos/web');
const assetsRepo = require('../../src/db/repos/assets');

/**
 * What the public site is allowed to know.
 *
 * This is the whole read surface of the public pages. Anything not gathered
 * here cannot reach a public page, which makes "could a stranger see X?" a
 * question with one place to look rather than a search through templates.
 *
 * Nothing here is generated. Services and page text are what the owner wrote;
 * the portfolio is only work a client explicitly permitted.
 */

/** Departments make sensible default services before the owner writes their own. */
function defaultServicesFrom(departments) {
  return departments.map((department, index) => ({
    key: department.key,
    name: department.name,
    summary: `${department.name} work for Roblox experiences.`,
    detail: null,
    sort_order: index,
    published: 1,
    placeholder: true,
  }));
}

function studioIdentity(db, guildId) {
  const config = configRepo.getConfig(db, guildId);
  return {
    name: config?.studio_name || 'Studio',
    tagline: config?.studio_tagline || null,
  };
}

/**
 * The services shown publicly.
 *
 * Falls back to the studio's departments so the site is never empty on day
 * one, and marks those as placeholders so the owner can see what is their own
 * writing and what is a stand-in.
 */
function services(db, guildId, { includeUnpublished = false } = {}) {
  const written = webRepo.listServices(db, guildId, { publishedOnly: !includeUnpublished });
  if (written.length > 0) return written;
  return defaultServicesFrom(configRepo.listDepartments(db, guildId));
}

/**
 * The portfolio.
 *
 * Drawn only from `publishablePortfolio`, which is the single query that knows
 * which assets a client permitted the studio to show, and from when. Unrecorded
 * permission is never treated as permission.
 */
function portfolio(db, guildId, { limit = 60 } = {}) {
  const departments = new Map(configRepo.listDepartments(db, guildId).map((d) => [d.id, d.name]));
  const departmentOf = db.prepare('SELECT department_id FROM tasks WHERE id = ?');

  return assetsRepo.publishablePortfolio(db, guildId, { limit }).map((asset) => {
    const departmentId = asset.task_id ? departmentOf.get(asset.task_id)?.department_id ?? null : null;

    return {
      id: asset.id,
      // The asset's own label, or the task's title. Never the file path: a
      // path can carry a client's name or an internal codename.
      label: asset.label || asset.task_title || 'Untitled',
      url: asset.url,
      department: departments.get(departmentId) || null,
      // Deliberately no client name, no project code, no price and no dates.
      // The client permitted the work to be shown, not their identity or
      // what they paid for it.
    };
  });
}

function page(db, guildId, key) {
  return webRepo.getPage(db, guildId, key);
}

/**
 * Everything a public page could need, gathered once.
 *
 * The static export and the live server both read this, so the two can never
 * drift into showing different things.
 */
function publicSnapshot(db, guildId, { appUrl = null } = {}) {
  return {
    studio: studioIdentity(db, guildId),
    services: services(db, guildId),
    portfolio: portfolio(db, guildId),
    about: page(db, guildId, 'about'),
    contact: page(db, guildId, 'contact'),
    // Where a quote form should post. Null means there is no live app to post
    // to, and the page says so instead of rendering a form that goes nowhere.
    appUrl,
    generatedAt: Date.now(),
  };
}

module.exports = {
  defaultServicesFrom,
  studioIdentity,
  services,
  portfolio,
  page,
  publicSnapshot,
};
