/**
 * Page rendering.
 *
 * Everything written into a page goes through `escape`. There is no template
 * engine and no way to interpolate raw text by accident: `html` is a tagged
 * template that escapes every value, and the only way past it is `raw()`, which
 * is used solely for fragments this file built itself.
 */

const RAW = Symbol('raw');

function escape(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object' && value[RAW]) return value.text;

  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function raw(text) {
  return { [RAW]: true, text: String(text) };
}

function html(strings, ...values) {
  return raw(strings.reduce((out, part, index) => {
    const value = values[index - 1];
    const rendered = Array.isArray(value) ? value.map(escape).join('') : escape(value);
    return out + rendered + part;
  }));
}

/**
 * A URL safe to put in an href.
 *
 * Anything that is not plainly http(s) is dropped rather than rendered, which
 * closes `javascript:` links arriving from stored data.
 */
function safeUrl(value) {
  const text = String(value ?? '').trim();
  if (!/^https?:\/\//i.test(text)) return null;
  return text;
}

function layout({ title, description = null, body, nav = [], footer = null, studio = 'Studio' }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} · ${escape(studio)}</title>
${description ? `<meta name="description" content="${escape(description)}">` : ''}
<link rel="stylesheet" href="/style.css">
</head>
<body>
<header class="site">
  <a class="brand" href="/">${escape(studio)}</a>
  <nav>${nav.map((item) => `<a href="${escape(item.href)}"${item.current ? ' aria-current="page"' : ''}>${escape(item.label)}</a>`).join('')}</nav>
</header>
<main>
${escape(body)}
</main>
<footer class="site">
${footer ? escape(footer) : `<p>${escape(studio)}</p>`}
</footer>
</body>
</html>`;
}

/** A page for something that went wrong, in the same shell as everything else. */
function errorPage({ status, title, message, studio = 'Studio' }) {
  return layout({
    studio,
    title,
    body: html`
      <section class="panel">
        <h1>${title}</h1>
        <p>${message}</p>
        <p><a href="/">Back to the homepage</a></p>
      </section>
    `,
  });
}

module.exports = { escape, raw, html, safeUrl, layout, errorPage };
