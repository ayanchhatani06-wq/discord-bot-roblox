const crypto = require('node:crypto');

/**
 * Signing in with Discord.
 *
 * Optional: the site works without it, and a client who is not in the Discord
 * server always has the email link. This exists because most of the studio's
 * clients already have Discord open, and one click beats waiting for a link.
 *
 * It is off unless `DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET` are both
 * set, so nothing half-configured can half-work.
 *
 * Only `identify` is requested — the account's id. Not their email, not their
 * servers, not their connections. The id is all that is needed to match them
 * against a client's authorised accounts, and asking for more would be asking
 * for something the studio has no use for.
 */

const AUTHORIZE_URL = 'https://discord.com/oauth2/authorize';
const TOKEN_URL = 'https://discord.com/api/oauth2/token';
const USER_URL = 'https://discord.com/api/users/@me';
const SCOPE = 'identify';

function isConfigured(env = process.env) {
  return Boolean(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET && env.WEB_APP_URL);
}

function redirectUri(env = process.env) {
  return `${String(env.WEB_APP_URL || '').replace(/\/$/, '')}/client/discord/callback`;
}

/**
 * The state parameter, signed rather than stored.
 *
 * It carries its own expiry and a signature made with the client secret, so a
 * state this server did not issue cannot be presented back to it, and an old
 * one cannot be replayed a week later. No server-side session is needed before
 * the user has one.
 */
function makeState({ now = Date.now(), ttlMs = 10 * 60 * 1000, env = process.env } = {}) {
  const payload = `${now + ttlMs}.${crypto.randomBytes(16).toString('base64url')}`;
  const signature = crypto
    .createHmac('sha256', env.DISCORD_CLIENT_SECRET)
    .update(payload)
    .digest('base64url');
  return `${payload}.${signature}`;
}

function verifyState(state, { now = Date.now(), env = process.env } = {}) {
  const parts = String(state ?? '').split('.');
  if (parts.length !== 3) return false;

  const [expiry, nonce, signature] = parts;
  const expected = crypto
    .createHmac('sha256', env.DISCORD_CLIENT_SECRET)
    .update(`${expiry}.${nonce}`)
    .digest('base64url');

  const given = Buffer.from(signature);
  const want = Buffer.from(expected);
  if (given.length !== want.length) return false;
  if (!crypto.timingSafeEqual(given, want)) return false;

  return Number(expiry) > now;
}

function authorizeUrl({ state, env = process.env } = {}) {
  const params = new URLSearchParams({
    client_id: env.DISCORD_CLIENT_ID,
    redirect_uri: redirectUri(env),
    response_type: 'code',
    scope: SCOPE,
    state,
    prompt: 'none',
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

/**
 * Exchanges the code for the Discord account id, and nothing else.
 *
 * Returns only the id: no username, no avatar, no email. What the site needs
 * is whether this account is authorised for a client, and that is a lookup
 * against the studio's own records.
 */
async function exchange(code, { env = process.env, fetchImpl = fetch } = {}) {
  const body = new URLSearchParams({
    client_id: env.DISCORD_CLIENT_ID,
    client_secret: env.DISCORD_CLIENT_SECRET,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(env),
  });

  const tokenResponse = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!tokenResponse.ok) return { ok: false, reason: 'token_exchange_failed' };

  const token = await tokenResponse.json();
  if (!token?.access_token) return { ok: false, reason: 'no_access_token' };

  const userResponse = await fetchImpl(USER_URL, {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });

  if (!userResponse.ok) return { ok: false, reason: 'user_lookup_failed' };

  const user = await userResponse.json();
  if (!user?.id) return { ok: false, reason: 'no_user_id' };

  return { ok: true, userId: String(user.id) };
}

module.exports = {
  AUTHORIZE_URL,
  TOKEN_URL,
  USER_URL,
  SCOPE,
  isConfigured,
  redirectUri,
  makeState,
  verifyState,
  authorizeUrl,
  exchange,
};
