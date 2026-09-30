const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { getDatabase } = require('../src/db');
const configRepo = require('../src/db/repos/config');
const clientsRepo = require('../src/db/repos/clients');
const projectsRepo = require('../src/db/repos/projects');
const webRepo = require('../src/db/repos/web');
const enquiriesRepo = require('../src/db/repos/enquiries');
const clientReport = require('../src/services/clientReport');

const httpLib = require('./lib/http');
const content = require('./lib/content');
const pages = require('./lib/pages');
const clientPages = require('./lib/clientPages');
const { errorPage } = require('./lib/render');

/**
 * The studio's website: a second process reading the same database as the bot.
 *
 * It never writes anything the bot depends on except an enquiry, which is the
 * one thing the public is meant to be able to create. Everything else it does
 * is read-only, so a bug here cannot corrupt the studio's records.
 *
 * Client access is checked exactly as it is in Discord: against explicit
 * account or email rows, never derived from anything else.
 */

const PORT = Number(process.env.WEB_PORT || 8080);
const GUILD_ID = process.env.WEB_GUILD_ID || process.env.GUILD_ID || null;
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_COOKIE = 'studio_session';
const SECURE = process.env.WEB_INSECURE !== '1';

const STATIC_TYPES = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

/**
 * A small in-memory limiter for the two routes that cost something: the quote
 * form writes a record, and sign-in issues a login link. Both are unauthenticated,
 * so both need a ceiling or one script can fill the enquiry list overnight.
 */
function createLimiter({ max, windowMs }) {
  const hits = new Map();

  return function allow(key, now = Date.now()) {
    const cutoff = now - windowMs;
    const recent = (hits.get(key) || []).filter((at) => at > cutoff);

    if (recent.length >= max) {
      hits.set(key, recent);
      return false;
    }

    recent.push(now);
    hits.set(key, recent);

    // Keep the map from growing without bound on a long-lived process.
    if (hits.size > 5000) {
      for (const [otherKey, times] of hits) {
        if (times.every((at) => at <= cutoff)) hits.delete(otherKey);
      }
    }
    return true;
  };
}

const quoteLimiter = createLimiter({ max: 5, windowMs: 60 * 60 * 1000 });
const signInLimiter = createLimiter({ max: 5, windowMs: 15 * 60 * 1000 });

function clientIp(request) {
  // Behind a reverse proxy the real address is in the forwarded header; the
  // socket address is used when there is no proxy.
  const forwarded = String(request.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || request.socket.remoteAddress || 'unknown';
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

function sessionFor(db, request) {
  const jar = httpLib.parseCookies(request.headers.cookie);
  const token = jar[SESSION_COOKIE];
  if (!token) return null;

  const session = webRepo.sessionByHash(db, httpLib.hashToken(token));
  if (!session) return null;

  webRepo.touchSession(db, session.id);
  return session;
}

function startSession(db, guildId, { clientId, email, displayName }) {
  const token = httpLib.randomToken();
  webRepo.createSession(db, guildId, {
    tokenHash: httpLib.hashToken(token),
    subjectKind: webRepo.SUBJECTS.CLIENT,
    clientId,
    email,
    displayName,
  });
  return token;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function buildRouter({ db, guildId }) {
  const router = httpLib.createRouter();
  const snapshot = () => content.publicSnapshot(db, guildId, { appUrl: null });

  // ---- public ----

  router.get('/', (_req, res) => httpLib.send(res, 200, pages.home(snapshot())));
  router.get('/work', (_req, res) => httpLib.send(res, 200, pages.work(snapshot())));
  router.get('/about', (_req, res) => httpLib.send(res, 200, pages.about(snapshot())));
  router.get('/quote', (_req, res) => httpLib.send(res, 200, pages.quote(snapshot())));

  router.post('/quote', async (request, response) => {
    const snap = snapshot();

    if (!quoteLimiter(clientIp(request))) {
      httpLib.send(response, 429, pages.quote(snap, {
        error: 'That is a lot of requests from one place. Try again later, or reach us on Discord.',
      }));
      return;
    }

    const form = httpLib.parseForm(await httpLib.readBody(request));
    const name = String(form.name || '').trim();
    const contact = String(form.contact || '').trim();
    const brief = String(form.brief || '').trim();

    if (!name || !contact || !brief) {
      httpLib.send(response, 400, pages.quote(snap, {
        error: 'Please fill in your name, how to reach you, and what you are making.',
        values: form,
      }));
      return;
    }

    // Goes into the same enquiry pipeline as one typed in by staff, so a web
    // request and a Discord request are the same kind of thing from here on.
    const enquiry = enquiriesRepo.createEnquiry(db, guildId, {
      source: 'web',
      contactRef: `${name} — ${contact}`,
      serviceRequest: form.service || 'Not specified',
      budgetText: form.budget || null,
      deadlineText: form.deadline || null,
      notes: brief,
    }, null);

    httpLib.send(response, 200, pages.quoteSent(snap, { reference: enquiry?.code ?? null }));
  });

  // ---- client area ----

  router.get('/client/sign-in', (_req, res) => {
    httpLib.send(res, 200, clientPages.signIn({ studio: snapshot().studio.name }));
  });

  router.post('/client/sign-in', async (request, response) => {
    const studio = snapshot().studio.name;

    if (!signInLimiter(clientIp(request))) {
      httpLib.send(response, 429, clientPages.signIn({
        studio,
        error: 'Too many attempts from here. Wait a little and try again.',
      }));
      return;
    }

    const form = httpLib.parseForm(await httpLib.readBody(request));
    const email = webRepo.normaliseEmail(form.email);
    const match = email ? webRepo.findClientEmail(db, guildId, email) : null;

    if (match) {
      const token = httpLib.randomToken();
      webRepo.issueLoginToken(db, guildId, {
        clientId: match.client_id,
        tokenHash: httpLib.hashToken(token),
        email,
      });
      // Delivery is the studio's job until an email provider is configured;
      // the link is recorded and staff pass it on.
      console.log(`[web] sign-in link for client ${match.client_id}: /client/enter?token=${token}`);
    }

    // The same answer either way. Saying "no such address" would tell anybody
    // who asks which addresses are our clients.
    httpLib.send(response, 200, clientPages.signIn({ studio, sent: true }));
  });

  router.get('/client/enter', (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const token = url.searchParams.get('token');
    const studio = snapshot().studio.name;

    const consumed = token
      ? webRepo.consumeLoginToken(db, httpLib.hashToken(token), { ip: clientIp(request) })
      : null;

    if (!consumed) {
      httpLib.send(response, 400, clientPages.signIn({
        studio,
        error: 'That link has already been used or has expired. Ask us for another.',
      }));
      return;
    }

    const client = clientsRepo.getClient(db, guildId, consumed.client_id);
    const sessionToken = startSession(db, guildId, {
      clientId: consumed.client_id,
      email: consumed.email,
      displayName: client?.display_name ?? null,
    });

    httpLib.redirect(response, '/client', {
      'Set-Cookie': httpLib.cookie(SESSION_COOKIE, sessionToken, { secure: SECURE }),
    });
  });

  router.get('/client/sign-out', (request, response) => {
    const jar = httpLib.parseCookies(request.headers.cookie);
    if (jar[SESSION_COOKIE]) webRepo.revokeSession(db, httpLib.hashToken(jar[SESSION_COOKIE]));
    httpLib.redirect(response, '/', { 'Set-Cookie': httpLib.clearCookie(SESSION_COOKIE, { secure: SECURE }) });
  });

  router.get('/client', (request, response) => {
    const session = sessionFor(db, request);
    if (!session) return httpLib.redirect(response, '/client/sign-in');

    const client = clientsRepo.getClient(db, guildId, session.client_id);
    const projects = clientsRepo.clientOrderHistory(db, guildId, session.client_id).map((project) => {
      const report = clientReport.buildProjectReport(db, guildId, project);
      return {
        project,
        awaiting: report.counts[clientReport.BUCKETS.AWAITING_YOUR_APPROVAL],
        summary: clientPages.statusLine(report),
      };
    });

    return httpLib.send(response, 200, clientPages.orderList({
      studio: snapshot().studio.name,
      signedInAs: session.email || client?.display_name || 'your account',
      clientName: client?.display_name || '',
      projects,
    }));
  });

  router.get('/client/order/:id', (request, response, params) => {
    const session = sessionFor(db, request);
    if (!session) return httpLib.redirect(response, '/client/sign-in');

    const project = projectsRepo.getProject(db, guildId, Number(params.id));

    // The one check that matters: this project must belong to the client this
    // session is for. Without it, changing the number in the address bar would
    // walk somebody through every order the studio has.
    if (!project || project.client_id !== session.client_id) {
      return httpLib.send(response, 404, errorPage({
        studio: snapshot().studio.name,
        status: 404,
        title: 'Not found',
        message: 'That order is not one of yours.',
      }));
    }

    const client = clientsRepo.getClient(db, guildId, session.client_id);
    const account = webRepo.findClientEmail(db, guildId, session.email || '');

    return httpLib.send(response, 200, clientPages.order({
      studio: snapshot().studio.name,
      signedInAs: session.email || client?.display_name || 'your account',
      project,
      report: clientReport.buildProjectReport(db, guildId, project),
      canApprove: account?.can_approve === 1,
    }));
  });

  return router;
}

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------

function serveStatic(pathname, response) {
  // Resolve, then confirm the result is still inside the public directory.
  // Without that check, "../../.env" in a URL reads whatever it likes.
  const resolved = path.resolve(PUBLIC_DIR, `.${pathname}`);
  if (!resolved.startsWith(PUBLIC_DIR + path.sep)) return false;
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return false;

  const type = STATIC_TYPES[path.extname(resolved).toLowerCase()];
  if (!type) return false;

  const body = fs.readFileSync(resolved);
  response.writeHead(200, {
    'Content-Type': type,
    'Content-Length': body.length,
    'Cache-Control': 'public, max-age=3600',
  });
  response.end(body);
  return true;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

function createServer({ db = getDatabase(), guildId = GUILD_ID } = {}) {
  if (!guildId) throw new Error('Set WEB_GUILD_ID (or GUILD_ID) so the site knows which studio it is showing.');

  const router = buildRouter({ db, guildId });

  return http.createServer(async (request, response) => {
    const headers = httpLib.securityHeaders({ secure: SECURE });
    for (const [key, value] of Object.entries(headers)) response.setHeader(key, value);

    try {
      const url = new URL(request.url, 'http://localhost');
      const pathname = url.pathname;

      if (!httpLib.METHODS.includes(request.method)) {
        return httpLib.send(response, 405, 'Method not allowed');
      }

      if (request.method === 'GET' && serveStatic(pathname, response)) return undefined;

      const route = router.match(request.method, pathname);
      if (!route) {
        return httpLib.send(response, 404, errorPage({
          studio: content.studioIdentity(db, guildId).name,
          status: 404,
          title: 'Not found',
          message: 'There is nothing at that address.',
        }));
      }

      return await route.handler(request, response, route.params);
    } catch (error) {
      console.error('[web] request failed:', error);
      // Never send the error itself: a stack trace tells a stranger about the
      // inside of the system.
      if (!response.headersSent) {
        return httpLib.send(response, error.statusCode || 500, errorPage({
          studio: 'Studio',
          status: 500,
          title: 'Something went wrong',
          message: 'That did not work. Please try again, or reach us on Discord.',
        }));
      }
      return response.end();
    }
  });
}

if (require.main === module) {
  const server = createServer();
  server.listen(PORT, () => {
    console.log(`Website listening on http://localhost:${PORT} for guild ${GUILD_ID}.`);
    if (!SECURE) console.log('WEB_INSECURE=1: cookies are not marked Secure. Local testing only.');
  });
}

module.exports = { createServer, createLimiter, buildRouter, SESSION_COOKIE };
