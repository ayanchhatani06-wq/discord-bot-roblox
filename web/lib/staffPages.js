const { html, escape, raw, layout } = require('./render');
const { webDate } = require('./clientPages');

/**
 * The staff area.
 *
 * Read-only, deliberately and completely. Every action in this studio —
 * assigning work, approving pay, recording a client decision, releasing files
 * — is a decision with a name attached, and the bot already records who made
 * it. A web page that could do those things would be a second, weaker door to
 * the same decisions, so this one only shows.
 *
 * Money is shown only to somebody the bot would show it to, and the page never
 * works that out for itself: it is told.
 */

function staffShell({ studio, title, body, who, current = null }) {
  return layout({
    studio,
    title,
    nav: [
      { href: '/staff', label: 'Your work', current: current === 'me' },
      { href: '/staff/queue', label: 'Queues', current: current === 'queue' },
      { href: '/staff/sign-out', label: 'Sign out' },
    ],
    body,
    footer: html`
      <p class="muted">Signed in as ${who}</p>
      <p class="muted">Read-only. Everything that changes anything happens in Discord, where it is recorded against a name.</p>
    `,
  });
}

function taskRows(tasks, { showPay = false } = {}) {
  if (tasks.length === 0) return html`<p class="muted">Nothing here.</p>`;

  return raw(`<div class="scroll"><table>
    <thead><tr>
      <th>Task</th><th>State</th><th>Department</th><th>Deadline</th>${showPay ? '<th>Pay</th>' : ''}
    </tr></thead>
    <tbody>${tasks.map((task) => `
      <tr>
        <td><strong>${escape(task.code)}</strong><br>${escape(task.title)}</td>
        <td><span class="pill">${escape(String(task.state).replace(/_/g, ' '))}</span></td>
        <td>${escape(task.departmentName || '—')}</td>
        <td>${task.deadline_utc ? escape(webDate(task.deadline_utc)) : '<span class="muted">none</span>'}</td>
        ${showPay ? `<td>${escape(task.payText || '—')}</td>` : ''}
      </tr>
    `).join('')}</tbody>
  </table></div>`);
}

function signIn({ studio, error = null }) {
  return layout({
    studio,
    title: 'Staff sign in',
    nav: [{ href: '/', label: 'Back to the site' }],
    body: html`
      <section class="panel">
        <h1>Staff sign in</h1>
        <p>
          Ask for a link in Discord with <code>/desk web-link</code>. It is sent to you
          privately, works once, and lasts 30 minutes.
        </p>
        ${error ? html`<p class="error">${error}</p>` : ''}
        <p class="muted">
          There is no password to type here. Your Discord account is the only thing that
          proves who you are, so a link from the bot is the only way in.
        </p>
      </section>
    `,
  });
}

function myWork({ studio, who, offers, active, deadlines, owedText, showPay }) {
  return staffShell({
    studio,
    who,
    current: 'me',
    title: 'Your work',
    body: html`
      <section>
        <h1>Your work</h1>
      </section>

      ${offers.length > 0 ? html`
        <section class="panel">
          <h2>Offers waiting on you (${offers.length})</h2>
          <p class="muted">Accept or decline them in Discord — that is where the terms are recorded.</p>
          ${taskRows(offers)}
        </section>
      ` : ''}

      <section class="panel">
        <h2>In hand (${active.length})</h2>
        ${taskRows(active)}
      </section>

      ${deadlines.length > 0 ? html`
        <section class="panel">
          <h2>Coming up</h2>
          ${taskRows(deadlines)}
        </section>
      ` : ''}

      ${showPay ? html`
        <section class="panel">
          <h2>Your pay</h2>
          <p>Owed to you: <strong>${owedText}</strong></p>
          <p class="muted">Your own figures only. Nobody else's pay appears here or anywhere else you can reach.</p>
        </section>
      ` : ''}
    `,
  });
}

function queues({ studio, who, departments, unassigned, review, awaitingClient, overdue }) {
  return staffShell({
    studio,
    who,
    current: 'queue',
    title: 'Queues',
    body: html`
      <section>
        <h1>Queues</h1>
        <p class="muted">
          ${departments.length > 0
            ? `Your departments: ${departments.join(', ')}.`
            : 'Everything, because you can see the whole studio.'}
        </p>
      </section>

      <section class="panel">
        <h2>Nobody on it (${unassigned.length})</h2>
        ${taskRows(unassigned)}
      </section>

      <section class="panel">
        <h2>Waiting on internal review (${review.length})</h2>
        ${taskRows(review)}
      </section>

      <section class="panel">
        <h2>With the client (${awaitingClient.length})</h2>
        ${taskRows(awaitingClient)}
      </section>

      <section class="panel">
        <h2>Overdue (${overdue.length})</h2>
        ${taskRows(overdue)}
      </section>
    `,
  });
}

module.exports = { staffShell, taskRows, signIn, myWork, queues };
