const crypto = require('node:crypto');

/**
 * A very small HTTP layer, built on Node's own server.
 *
 * No framework, deliberately. The website is a second process that reads the
 * same database as the bot, and every dependency it takes on is another thing
 * that can be compromised into reading that database. Node's `http` plus about
 * a hundred lines is enough for the pages this site has.
 */

const METHODS = Object.freeze(['GET', 'POST']);

function createRouter() {
  const routes = [];

  function add(method, pattern, handler) {
    // "/client/order/:code" becomes a regex with a named group.
    const names = [];
    const source = pattern
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/:([a-z_]+)/gi, (_, name) => {
        names.push(name);
        return '([^/]+)';
      });

    routes.push({ method, regex: new RegExp(`^${source}/?$`), names, handler });
  }

  return {
    get: (pattern, handler) => add('GET', pattern, handler),
    post: (pattern, handler) => add('POST', pattern, handler),
    match(method, pathname) {
      for (const route of routes) {
        if (route.method !== method) continue;
        const found = route.regex.exec(pathname);
        if (!found) continue;

        const params = {};
        route.names.forEach((name, index) => {
          params[name] = decodeURIComponent(found[index + 1]);
        });
        return { handler: route.handler, params };
      }
      return null;
    },
  };
}

/**
 * Reads a request body, with a hard cap.
 *
 * Without the cap a single request can exhaust the box's memory, and this
 * process shares that box with the bot.
 */
function readBody(request, { limit = 64 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });

    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function parseForm(body) {
  const params = new URLSearchParams(body);
  const result = {};
  for (const [key, value] of params) result[key] = value;
  return result;
}

function parseCookies(header) {
  const jar = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    jar[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return jar;
}

/**
 * Cookie flags chosen for a session cookie carrying a login.
 *
 * HttpOnly so a script cannot read it, SameSite=Lax so it does not ride along
 * with a cross-site POST, and Secure whenever the site is served over HTTPS.
 */
function cookie(name, value, { maxAge = 60 * 60 * 24 * 7, secure = true, path = '/' } = {}) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${path}`,
    `Max-Age=${maxAge}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function clearCookie(name, { secure = true } = {}) {
  return cookie(name, '', { maxAge: 0, secure });
}

/**
 * Headers sent on every response.
 *
 * The content security policy allows nothing but this site's own styles and
 * images: the pages carry no scripts at all, so a policy that forbids them
 * costs nothing and closes the whole category.
 */
function securityHeaders({ secure = true } = {}) {
  const headers = {
    'Content-Security-Policy':
      "default-src 'self'; img-src 'self' data: https:; style-src 'self'; " +
      "script-src 'none'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
  };
  if (secure) headers['Strict-Transport-Security'] = 'max-age=31536000';
  return headers;
}

function send(response, status, body, headers = {}) {
  response.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...headers,
  });
  response.end(body);
}

function redirect(response, location, headers = {}) {
  response.writeHead(302, { Location: location, ...headers });
  response.end();
}

/** Constant-time comparison, so a token cannot be guessed a character at a time. */
function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''));
  const right = Buffer.from(String(b ?? ''));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** Stored hashed, so a leaked database does not hand over live sessions. */
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

module.exports = {
  METHODS,
  createRouter,
  readBody,
  parseForm,
  parseCookies,
  cookie,
  clearCookie,
  securityHeaders,
  send,
  redirect,
  safeEqual,
  randomToken,
  hashToken,
};
