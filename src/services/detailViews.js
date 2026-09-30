/**
 * The long version of an answer, kept until somebody asks for it.
 *
 * Commands answer with one line and a button. The button needs to rebuild the
 * full view when it is pressed, which means the view has to live somewhere both
 * the command and the button handler can reach — here.
 *
 * Rebuilding rather than storing matters: a view stored at command time would
 * show whatever was true then, and the gap between reading a summary and
 * pressing the button is exactly where a deadline moves or a payment lands.
 * Pressing the button asks the question again.
 */

const views = new Map();

/**
 * @param {string} id      short, stable, and safe in a Discord custom id
 * @param {Function} build (context, args) => message body
 */
function registerView(id, build) {
  if (views.has(id)) throw new Error(`Duplicate detail view: ${id}`);
  if (!/^[a-z0-9.-]{1,40}$/.test(id)) throw new Error(`Bad detail view id: ${id}`);
  views.set(id, build);
}

function getView(id) {
  return views.get(id) || null;
}

function registeredViews() {
  return [...views.keys()];
}

module.exports = { registerView, getView, registeredViews };
