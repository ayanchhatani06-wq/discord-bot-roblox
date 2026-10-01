const { html, escape, raw, safeUrl, layout } = require('./render');
const clientReport = require('../../src/services/clientReport');

/**
 * The client area.
 *
 * Shows exactly what the Discord dashboard shows and nothing more. The rule
 * from the bot carries over unchanged: a client sees their own orders, in
 * buckets that describe progress, and never sees who is doing the work, what
 * anybody is paid, or what is happening internally.
 *
 * The buckets deliberately do not distinguish "nobody has picked this up yet"
 * from "somebody is working on it" — both read as in production. How the
 * studio staffs a job is the studio's business.
 */

const BUCKET_COPY = Object.freeze({
  [clientReport.BUCKETS.IN_PRODUCTION]: 'In production',
  [clientReport.BUCKETS.IN_STUDIO_REVIEW]: 'Being checked by us',
  [clientReport.BUCKETS.AWAITING_YOUR_APPROVAL]: 'Waiting on you',
  [clientReport.BUCKETS.APPROVED_BY_YOU]: 'Approved by you',
  [clientReport.BUCKETS.DELIVERED]: 'Delivered',
  [clientReport.BUCKETS.PAUSED]: 'Paused',
  [clientReport.BUCKETS.CANCELLED]: 'Cancelled',
});

function clientShell({ studio, title, body, signedInAs = null, current = null }) {
  return layout({
    studio,
    title,
    nav: [
      { href: '/client', label: 'Your orders', current: current === 'orders' },
      { href: '/client/sign-out', label: 'Sign out' },
    ],
    body,
    footer: signedInAs
      ? html`<p class="muted">Signed in as ${signedInAs}</p>`
      : html`<p class="muted">${studio}</p>`,
  });
}

/** The sign-in page. Asks for an email and says nothing about whether it matched. */
function signIn({ studio, sent = false, error = null, discordUrl = null, codeNeedsEmail = true }) {
  return layout({
    studio,
    title: 'Client sign in',
    nav: [{ href: '/', label: 'Back to the site' }],
    body: sent
      ? html`
        <section class="panel">
          <h1>Check your messages</h1>
          <p>
            If that address is on one of our orders, a sign-in link is on its way.
            It works once and expires in 30 minutes.
          </p>
          <p class="muted">
            Nothing arrived? The address may not be one we have on file. Ask us in
            your order channel and we will sort it out.
          </p>
        </section>
      `
      : html`
        <section class="panel">
          <h1>Client sign in</h1>
          <p>This is for clients with an order. It shows your orders and nothing else.</p>

          ${error ? html`<p class="error">${error}</p>` : ''}

          ${discordUrl ? html`
            <p><a class="button" href="${safeUrl(discordUrl) || '#'}">Sign in with Discord</a></p>
            <p class="muted">Or, if you are not in our Discord:</p>
          ` : ''}

          <form method="post" action="/client/sign-in">
            <label for="email">The email address we have for you</label>
            <input id="email" name="email" type="email" required maxlength="200" autocomplete="email">
            <button type="submit">Send me a sign-in link</button>
          </form>

          <p class="muted">Or, if we gave you an access code:</p>

          <form method="post" action="/client/code">
            <label for="code">Your access code</label>
            <input id="code" name="code" type="text" required maxlength="40"
                   autocomplete="off" spellcheck="false" placeholder="ABC-0000-0000">
            ${codeNeedsEmail ? html`
              <label for="code-email">And the email address we have for you</label>
              <input id="code-email" name="email" type="email" required maxlength="200" autocomplete="email">
            ` : ''}
            <button type="submit">Sign in with my code</button>
          </form>

          <p class="muted">
            We will not say whether an address is on file — that would tell anybody
            who asks which of our clients you are.
          </p>
        </section>
      `,
  });
}

function orderList({ studio, signedInAs, clientName, projects }) {
  return clientShell({
    studio,
    signedInAs,
    current: 'orders',
    title: 'Your orders',
    body: html`
      <section>
        <h1>Your orders</h1>
        <p class="muted">${clientName}</p>

        ${projects.length === 0
          ? html`<p>You have no orders with us at the moment.</p>`
          : raw(`<div class="grid">${projects.map((entry) => `
              <article class="card">
                <h3><a href="/client/order/${escape(entry.project.id)}">${escape(entry.project.name)}</a></h3>
                <p class="muted">${escape(entry.summary)}</p>
                ${entry.awaiting > 0
                  ? `<p><span class="pill you">${escape(entry.awaiting)} waiting on you</span></p>`
                  : ''}
              </article>
            `).join('')}</div>`)}
      </section>
    `,
  });
}

/**
 * A date a browser can show.
 *
 * The Discord report formats times as Discord timestamps, which render as raw
 * codes anywhere else, so the web pages format their own rather than reusing a
 * string built for a different medium.
 */
function webDate(ms) {
  if (!ms) return 'not recorded';
  return new Date(ms).toISOString().slice(0, 10);
}

/** The same facts as the Discord status line, without Discord's markdown. */
function statusLine(report) {
  if (report.total === 0) return 'This order has no items set up yet.';

  const parts = Object.entries(report.counts)
    .filter(([, count]) => count > 0)
    .map(([bucket, count]) => `${count} ${String(BUCKET_COPY[bucket] || bucket).toLowerCase()}`);

  return `${report.total} item${report.total === 1 ? '' : 's'}: ${parts.join(', ')}.`;
}

function order({ studio, signedInAs, project, report, canApprove }) {
  const buckets = Object.entries(report.counts).filter(([, count]) => count > 0);

  return clientShell({
    studio,
    signedInAs,
    current: 'orders',
    title: project.name,
    body: html`
      <section>
        <p><a href="/client">← Your orders</a></p>
        <h1>${project.name}</h1>
        <p class="lede">${statusLine(report)}</p>
      </section>

      <section class="panel">
        <h2>Where it stands</h2>
        ${buckets.length === 0
          ? html`<p>Nothing on this order yet.</p>`
          : raw(`<table><tbody>${buckets.map(([bucket, count]) =>
              `<tr><th>${escape(BUCKET_COPY[bucket] || bucket)}</th><td>${escape(count)}</td></tr>`
            ).join('')}</tbody></table>`)}
        <p class="muted">Last updated ${webDate(report.lastUpdatedAt)}</p>
      </section>

      ${report.awaitingApproval.length > 0 ? html`
        <section class="panel">
          <h2>Waiting on you</h2>
          <p>
            ${canApprove
              ? 'Look these over and tell us in your order channel whether they are approved.'
              : 'Your account can see these but is not set up to approve them. Whoever approves for you can do it in your order channel.'}
          </p>
          ${raw(`<ul>${report.awaitingApproval.map((item) =>
            `<li>${escape(item.title)}${item.version ? ` <span class="muted">(version ${escape(item.version)})</span>` : ''}</li>`
          ).join('')}</ul>`)}
        </section>
      ` : ''}

      <section class="panel">
        <h2>What happens next</h2>
        <p>${report.nextAction}</p>
      </section>
    `,
  });
}

module.exports = { BUCKET_COPY, webDate, statusLine, clientShell, signIn, orderList, order };
