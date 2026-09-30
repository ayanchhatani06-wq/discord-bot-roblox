const { contextFor } = require('../services/actor');
const { getView } = require('../services/detailViews');
const { register } = require('./router');
const { NAMESPACE } = require('../utils/brief');
const { priv } = require('../utils/reply');

/**
 * The "Show me" button under a one-line answer.
 *
 * It re-asks the question rather than unpacking something stored, so what comes
 * back is true now — not true when the summary was sent. It only ever reads:
 * every action in this studio stays behind a command that says what it does,
 * so a button nobody meant to press cannot change anything.
 *
 * The custom id is `detail:<view id>:<args...>`, and the router has already
 * split it by the time this runs.
 */
register(NAMESPACE, async (interaction, { action, args }) => {
  const build = getView(action);
  if (!build) {
    // A button from before a restart that renamed the view. Say what happened
    // rather than failing silently.
    await interaction.reply(priv('❌ That view is no longer available. Run the command again.'));
    return;
  }

  const context = contextFor(interaction);
  const body = await build(context, args, interaction);

  if (!body) {
    await interaction.reply(priv('Nothing to show.'));
    return;
  }

  await interaction.reply(priv(body));
});

module.exports = { NAMESPACE };
