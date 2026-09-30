const fs = require('node:fs');
const path = require('node:path');

const { getDatabase } = require('../src/db');
const content = require('./lib/content');
const pages = require('./lib/pages');

/**
 * Renders the public pages to plain files.
 *
 * This exists because free static hosting is everywhere and free Node hosting
 * is not. The marketing site is the part strangers see, it never needs the
 * database at request time, so it can live anywhere that serves text while the
 * client and staff areas stay on the box the bot runs on.
 *
 * The same page functions build both, so the static site and the live site can
 * never drift into saying different things.
 */

const DEFAULT_OUT = path.join(__dirname, '..', 'data', 'site');

/**
 * Sub-folders with an index.html, rather than /work.html.
 *
 * A static host serves /work/ from /work/index.html, so the addresses match
 * the live server exactly and links do not have to differ between the two.
 */
function write(outDir, route, body) {
  const target = route === '/'
    ? path.join(outDir, 'index.html')
    : path.join(outDir, route.replace(/^\//, ''), 'index.html');

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body, 'utf8');
  return target;
}

function copyAssets(outDir) {
  const from = path.join(__dirname, 'public');
  if (!fs.existsSync(from)) return [];

  const copied = [];
  for (const name of fs.readdirSync(from)) {
    const source = path.join(from, name);
    if (!fs.statSync(source).isFile()) continue;
    fs.copyFileSync(source, path.join(outDir, name));
    copied.push(name);
  }
  return copied;
}

/**
 * `appUrl` is where the quote form should post.
 *
 * Without it there is no server to receive a form, so the quote page says to
 * get in touch instead of rendering a form that silently goes nowhere.
 */
function exportSite(db, guildId, { outDir = DEFAULT_OUT, appUrl = null, discordInvite = null, siteUrl = null } = {}) {
  const snapshot = content.publicSnapshot(db, guildId, { appUrl });
  fs.mkdirSync(outDir, { recursive: true });

  const written = [
    write(outDir, '/', pages.home(snapshot)),
    write(outDir, '/work', pages.work(snapshot)),
    write(outDir, '/about', pages.about(snapshot)),
    write(outDir, '/quote', appUrl
      ? pages.quote(snapshot)
      : pages.quoteUnavailable(snapshot, { discordInvite })),
  ];

  const assets = copyAssets(outDir);

  // Crawlers should find the public pages and nothing else. The static site has
  // no client area at all, but saying so costs nothing and stays true if the
  // same file is ever served in front of the live app.
  fs.writeFileSync(
    path.join(outDir, 'robots.txt'),
    ['User-agent: *', 'Disallow: /client', 'Disallow: /staff', 'Allow: /', ''].join('\n'),
    'utf8'
  );

  if (siteUrl) {
    const base = siteUrl.replace(/\/$/, '');
    const routes = ['/', '/work', '/about', '/quote'];
    fs.writeFileSync(
      path.join(outDir, 'sitemap.xml'),
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
      routes.map((route) => `  <url><loc>${base}${route}</loc></url>`).join('\n') +
      '\n</urlset>\n',
      'utf8'
    );
  }

  // Static hosts have no router, so a missing address needs its own file.
  fs.writeFileSync(
    path.join(outDir, '404.html'),
    require('./lib/render').errorPage({
      studio: snapshot.studio.name,
      status: 404,
      title: 'Not found',
      message: 'There is nothing at that address.',
    }),
    'utf8'
  );

  return {
    outDir,
    pages: written.length,
    assets,
    services: snapshot.services.length,
    portfolio: snapshot.portfolio.length,
    placeholderServices: snapshot.services.some((service) => service.placeholder),
    hasAbout: Boolean(snapshot.about),
    quoteForm: Boolean(appUrl),
    sitemap: Boolean(siteUrl),
  };
}

if (require.main === module) {
  const guildId = process.env.WEB_GUILD_ID || process.env.GUILD_ID;
  if (!guildId) {
    console.error('Set WEB_GUILD_ID (or GUILD_ID) so the export knows which studio to render.');
    process.exit(1);
  }

  const result = exportSite(getDatabase(), guildId, {
    outDir: process.env.SITE_OUT || DEFAULT_OUT,
    appUrl: process.env.WEB_APP_URL || null,
    discordInvite: process.env.DISCORD_INVITE || null,
    siteUrl: process.env.SITE_URL || null,
  });

  console.log(`Wrote ${result.pages} page(s) and ${result.assets.length} asset(s) to ${result.outDir}`);
  console.log(`Services: ${result.services}${result.placeholderServices ? ' (still the department placeholders — write your own with /web service)' : ''}`);
  console.log(`Portfolio: ${result.portfolio} item(s) cleared for public display`);
  if (!result.hasAbout) console.log('No About page written yet — add one with /web page.');
  if (!result.quoteForm) console.log('No WEB_APP_URL set, so the quote page points at Discord instead of a form.');
  console.log('Upload the contents of that folder to your static host.');
}

module.exports = { DEFAULT_OUT, write, copyAssets, exportSite };
