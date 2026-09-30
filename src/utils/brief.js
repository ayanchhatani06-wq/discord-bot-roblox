const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { priv } = require('./reply');

const NAMESPACE = 'detail';

const COLOURS = Object.freeze({
  good: 0x57f287,
  warn: 0xfee75c,
  bad: 0xed4245,
  plain: 0x5865f2,
  quiet: 0x99aab5,
});

/**
 * One line, and a button for the rest.
 *
 * The bot used to answer every question with everything it knew, which meant
 * reading a table to find out that the answer was "nothing". The headline is
 * the answer; the button is there for the times you actually want the list.
 *
 * `viewId` names a view registered in services/detailViews, and `args` are
 * passed back to it — so the long version is rebuilt when it is asked for, not
 * frozen at the moment the summary was sent.
 */
function brief({
  title,
  headline,
  tone = 'plain',
  viewId = null,
  args = [],
  buttonLabel = 'Show me',
  emoji = null,
  footer = null,
  extraButtons = [],
}) {
  const embed = new EmbedBuilder()
    .setColor(COLOURS[tone] ?? COLOURS.plain)
    .setDescription(headline);

  if (title) embed.setTitle(title);
  if (footer) embed.setFooter({ text: footer });

  const buttons = [];
  if (viewId) {
    // Discord caps a custom id at 100 characters, and the parts are joined with
    // colons — so an argument containing one would be read as another argument.
    const parts = args.map((arg) => String(arg).replace(/:/g, '_'));
    buttons.push(
      new ButtonBuilder()
        .setCustomId([NAMESPACE, viewId, ...parts].join(':').slice(0, 100))
        .setLabel(buttonLabel)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(emoji || '📋')
    );
  }
  buttons.push(...extraButtons);

  return priv({
    embeds: [embed],
    components: buttons.length > 0 ? [new ActionRowBuilder().addComponents(buttons.slice(0, 5))] : [],
  });
}

/** A count phrased so zero reads as an answer rather than an empty list. */
function count(n, singular, plural = `${singular}s`, none = null) {
  if (n === 0) return none ?? `No ${plural}`;
  return `**${n}** ${n === 1 ? singular : plural}`;
}

module.exports = { brief, count, COLOURS, NAMESPACE };
