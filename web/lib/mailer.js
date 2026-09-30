const net = require('node:net');
const tls = require('node:tls');

/**
 * Sending a sign-in link by email.
 *
 * Optional, and off unless SMTP settings are present. Without it everything
 * still works: the bot generates the link and a staff member passes it on,
 * which is exactly what `/web sign-in-link` is for. This only removes the
 * manual step.
 *
 * Written against SMTP directly rather than pulling in a mail library. The
 * website is a process with access to the studio's whole database, and one
 * short function that speaks the protocol is a smaller risk than a dependency
 * tree fetched from a registry. It sends one plain-text message to one
 * recipient; it is not a mail client.
 */

const CRLF = '\r\n';

function isConfigured(env = process.env) {
  return Boolean(env.SMTP_HOST && env.SMTP_FROM);
}

function settings(env = process.env) {
  return {
    host: env.SMTP_HOST,
    port: Number(env.SMTP_PORT || 587),
    user: env.SMTP_USER || null,
    pass: env.SMTP_PASS || null,
    from: env.SMTP_FROM,
    // Port 465 is implicit TLS; 587 starts plain and upgrades with STARTTLS.
    implicitTls: Number(env.SMTP_PORT || 587) === 465,
  };
}

/**
 * Header values are folded onto one line and stripped of CR and LF.
 *
 * Without this, a newline in a display name or subject would let somebody add
 * their own headers — a second Bcc, a different From. The studio controls both
 * values today, but a header injection that only works "if somebody later
 * passes user input here" is a trap left for the next person.
 */
function headerValue(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
}

function buildMessage({ from, to, subject, body }) {
  return [
    `From: ${headerValue(from)}`,
    `To: ${headerValue(to)}`,
    `Subject: ${headerValue(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    `Date: ${new Date().toUTCString()}`,
    '',
    // A line that is only a dot ends the data in SMTP, so it is escaped.
    String(body).replace(/\r?\n/g, CRLF).replace(/^\./gm, '..'),
    '',
  ].join(CRLF);
}

/** One SMTP conversation, as a sequence of expected replies. */
function converse(socket, steps) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let index = 0;
    let settled = false;

    const done = (error, value) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners('data');
      if (error) reject(error);
      else resolve(value);
    };

    socket.setEncoding('utf8');
    socket.on('error', (error) => done(error));
    socket.on('close', () => done(new Error('The mail server closed the connection early.')));

    socket.on('data', (chunk) => {
      buffer += chunk;

      // A reply is complete when its last line has a space after the code
      // rather than a hyphen, which is how SMTP marks continuations.
      const lines = buffer.split(CRLF).filter(Boolean);
      const last = lines[lines.length - 1];
      if (!last || /^\d{3}-/.test(last)) return;

      const code = Number(last.slice(0, 3));
      const step = steps[index];
      buffer = '';

      if (!step.expect.includes(code)) {
        done(new Error(`The mail server said: ${last}`));
        return;
      }

      index += 1;
      if (index >= steps.length) {
        done(null, true);
        return;
      }

      const next = steps[index];
      if (next.upgrade) {
        done(null, { upgrade: true, remaining: steps.slice(index) });
        return;
      }
      if (next.send !== undefined) socket.write(next.send + CRLF);
    });
  });
}

/**
 * Sends one message.
 *
 * Returns a result rather than throwing, because a failure to send a sign-in
 * link is not an emergency — the staff can always hand it over — and the
 * caller should say so plainly rather than the request collapsing.
 */
async function send({ to, subject, body }, { env = process.env, timeoutMs = 15000 } = {}) {
  if (!isConfigured(env)) return { ok: false, reason: 'not_configured' };

  const config = settings(env);
  const message = buildMessage({ from: config.from, to, subject, body });

  const auth = config.user
    ? [
      { send: 'AUTH LOGIN', expect: [334] },
      { send: Buffer.from(config.user).toString('base64'), expect: [334] },
      { send: Buffer.from(config.pass || '').toString('base64'), expect: [235] },
    ]
    : [];

  const conversation = [
    { expect: [220] },
    { send: 'EHLO studio', expect: [250] },
    ...(config.implicitTls ? [] : [{ send: 'STARTTLS', expect: [220] }, { upgrade: true }]),
    ...(config.implicitTls ? [{ send: 'EHLO studio', expect: [250] }] : []),
    ...auth,
    { send: `MAIL FROM:<${headerValue(config.from)}>`, expect: [250] },
    { send: `RCPT TO:<${headerValue(to)}>`, expect: [250, 251] },
    { send: 'DATA', expect: [354] },
    { send: `${message}.`, expect: [250] },
    { send: 'QUIT', expect: [221] },
  ];

  let socket = null;
  try {
    socket = config.implicitTls
      ? tls.connect({ host: config.host, port: config.port, servername: config.host })
      : net.connect({ host: config.host, port: config.port });

    socket.setTimeout(timeoutMs, () => socket.destroy(new Error('The mail server did not answer in time.')));

    const first = await converse(socket, conversation);

    // STARTTLS: the rest of the conversation continues over the upgraded
    // socket. Credentials are never sent before this point.
    if (first && first.upgrade) {
      const secure = tls.connect({ socket, host: config.host, servername: config.host });
      secure.setTimeout(timeoutMs, () => secure.destroy(new Error('The mail server did not answer in time.')));

      const rest = first.remaining.slice(1);
      secure.write(`EHLO studio${CRLF}`);
      await converse(secure, [{ expect: [250] }, ...rest]);
      secure.end();
    } else {
      socket.end();
    }

    return { ok: true };
  } catch (error) {
    socket?.destroy?.();
    return { ok: false, reason: 'send_failed', detail: error.message };
  }
}

function signInEmail({ studio, url, expiresInMinutes = 30 }) {
  return {
    subject: `Your sign-in link for ${studio}`,
    body: [
      `Here is your sign-in link for ${studio}:`,
      '',
      url,
      '',
      `It works once and expires in ${expiresInMinutes} minutes.`,
      '',
      'If you did not ask for this, you can ignore it — the link does nothing until it is opened,',
      'and it only ever shows the orders already associated with your address.',
    ].join('\n'),
  };
}

module.exports = { isConfigured, settings, headerValue, buildMessage, send, signInEmail };
