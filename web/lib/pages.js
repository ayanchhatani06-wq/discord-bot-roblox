const { html, escape, raw, safeUrl, layout } = require('./render');

/**
 * The public pages.
 *
 * These are shared by the live server and the static export, so the site says
 * the same thing whichever way it is served. Every page is plain HTML with no
 * scripts: there is nothing on a marketing page that needs JavaScript, and a
 * page with none cannot be turned against a visitor.
 */

function navFor(current, { hasPortfolio = true, hasAbout = true } = {}) {
  return [
    { href: '/', label: 'Services', current: current === 'home' },
    ...(hasPortfolio ? [{ href: '/work', label: 'Work', current: current === 'work' }] : []),
    ...(hasAbout ? [{ href: '/about', label: 'About', current: current === 'about' }] : []),
    { href: '/quote', label: 'Request a quote', current: current === 'quote' },
  ];
}

function shell(snapshot, { current, title, description = null, body }) {
  return layout({
    studio: snapshot.studio.name,
    title,
    description,
    nav: navFor(current, {
      hasPortfolio: snapshot.portfolio.length > 0,
      hasAbout: Boolean(snapshot.about),
    }),
    body,
    footer: html`
      <p>${snapshot.studio.name}</p>
      <p class="muted">
        <a href="/quote">Request a quote</a> · <a href="/client">Client sign in</a>
      </p>
    `,
  });
}

/**
 * Turns the owner's plain text into paragraphs.
 *
 * Deliberately not Markdown or HTML: the owner writes text, and text is what
 * is rendered. Blank lines separate paragraphs and that is the whole syntax,
 * which means nothing they type can become markup.
 */
function paragraphs(text) {
  const blocks = String(text ?? '')
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean);

  return raw(blocks.map((block) => `<p>${escape(block)}</p>`).join(''));
}

function home(snapshot) {
  const { studio, services } = snapshot;

  return shell(snapshot, {
    current: 'home',
    title: 'Services',
    description: studio.tagline || `${studio.name} — Roblox development studio.`,
    body: html`
      <section class="hero">
        <h1>${studio.name}</h1>
        ${studio.tagline ? html`<p class="lede">${studio.tagline}</p>` : ''}
        <p><a class="button" href="/quote">Request a quote</a></p>
      </section>

      <section>
        <h2>What we do</h2>
        <div class="grid">
          ${raw(services.map((service) => `
            <article class="card">
              <h3>${escape(service.name)}</h3>
              <p>${escape(service.summary)}</p>
              ${service.detail ? `<p class="muted">${escape(service.detail)}</p>` : ''}
            </article>
          `).join(''))}
        </div>
      </section>

      <section class="panel">
        <h2>How a job runs</h2>
        <ol>
          <li>You tell us what you need. We ask anything that is unclear.</li>
          <li>We quote a price and a deadline. Nothing starts until you agree to both.</li>
          <li>You get a private channel showing progress on every item.</li>
          <li>You approve each item yourself. Nothing is marked approved on your behalf.</li>
          <li>Files are released to you once the work is signed off.</li>
        </ol>
      </section>
    `,
  });
}

function work(snapshot) {
  const { portfolio } = snapshot;

  return shell(snapshot, {
    current: 'work',
    title: 'Work',
    description: `Selected work by ${snapshot.studio.name}.`,
    body: html`
      <section>
        <h1>Work</h1>
        <p class="muted">
          Shown with our clients' permission. Anything a client has not cleared for
          public display is not here.
        </p>

        ${portfolio.length === 0
          ? html`<p>Nothing is cleared for public display yet.</p>`
          : raw(`<div class="grid">${portfolio.map((item) => {
              const url = safeUrl(item.url);
              return `
                <article class="card">
                  <h3>${escape(item.label)}</h3>
                  ${item.department ? `<p class="muted">${escape(item.department)}</p>` : ''}
                  ${url ? `<p><a href="${escape(url)}" rel="noopener noreferrer nofollow" target="_blank">View</a></p>` : ''}
                </article>
              `;
            }).join('')}</div>`)}
      </section>
    `,
  });
}

function about(snapshot) {
  const page = snapshot.about;

  return shell(snapshot, {
    current: 'about',
    title: page?.title || 'About',
    description: `About ${snapshot.studio.name}.`,
    body: html`
      <section>
        <h1>${page?.title || 'About'}</h1>
        ${page ? paragraphs(page.body) : html`<p>Nothing here yet.</p>`}
      </section>
    `,
  });
}

/**
 * The quote request form.
 *
 * Asks only what is needed to price a job. No prices are shown anywhere on the
 * public site, by the studio's decision: every job is quoted on what it
 * actually involves.
 */
function quote(snapshot, { error = null, values = {} } = {}) {
  const action = snapshot.appUrl ? `${snapshot.appUrl.replace(/\/$/, '')}/quote` : '/quote';

  return shell(snapshot, {
    current: 'quote',
    title: 'Request a quote',
    description: `Ask ${snapshot.studio.name} for a quote.`,
    body: html`
      <section class="panel">
        <h1>Request a quote</h1>
        <p>
          Tell us what you need and we will come back with a price and a deadline.
          We do not publish prices: every job is quoted on what it actually involves.
        </p>

        ${error ? html`<p class="error">${error}</p>` : ''}

        <form method="post" action="${action}">
          <label for="name">Your name or studio</label>
          <input id="name" name="name" required maxlength="120" value="${values.name || ''}">

          <label for="contact">How we reach you</label>
          <input id="contact" name="contact" required maxlength="200"
                 placeholder="Discord username, or an email address"
                 value="${values.contact || ''}">

          <label for="service">What you need</label>
          <select id="service" name="service">
            <option value="">Not sure yet</option>
            ${raw(snapshot.services.map((service) =>
              `<option value="${escape(service.name)}"${values.service === service.name ? ' selected' : ''}>${escape(service.name)}</option>`
            ).join(''))}
          </select>

          <label for="brief">What you are making</label>
          <textarea id="brief" name="brief" required rows="6" maxlength="4000"
                    placeholder="What the project is, how many items, roughly when you need it.">${values.brief || ''}</textarea>

          <label for="budget">Budget, if you have one in mind</label>
          <input id="budget" name="budget" maxlength="120" placeholder="Optional" value="${values.budget || ''}">

          <label for="deadline">When you need it</label>
          <input id="deadline" name="deadline" maxlength="120" placeholder="Optional" value="${values.deadline || ''}">

          <button type="submit">Send</button>
        </form>

        <p class="muted">
          We use what you send here only to answer you. Nothing is shared with anybody else.
        </p>
      </section>
    `,
  });
}

function quoteSent(snapshot, { reference = null } = {}) {
  return shell(snapshot, {
    current: 'quote',
    title: 'Thank you',
    body: html`
      <section class="panel">
        <h1>Got it</h1>
        <p>
          Your request has reached us${reference ? html` as <strong>${reference}</strong>` : ''}.
          We will come back to you with a price and a deadline.
        </p>
        <p><a href="/">Back to the homepage</a></p>
      </section>
    `,
  });
}

/**
 * Shown on the static site, where there is no server to receive a form.
 *
 * Says so plainly rather than rendering a form that silently goes nowhere.
 */
function quoteUnavailable(snapshot, { discordInvite = null } = {}) {
  return shell(snapshot, {
    current: 'quote',
    title: 'Request a quote',
    body: html`
      <section class="panel">
        <h1>Request a quote</h1>
        <p>Tell us what you need and we will come back with a price and a deadline.</p>
        ${discordInvite
          ? html`<p><a class="button" href="${safeUrl(discordInvite) || '#'}">Talk to us on Discord</a></p>`
          : html`<p>Contact us on Discord and we will take it from there.</p>`}
      </section>
    `,
  });
}

module.exports = {
  navFor,
  shell,
  paragraphs,
  home,
  work,
  about,
  quote,
  quoteSent,
  quoteUnavailable,
};
