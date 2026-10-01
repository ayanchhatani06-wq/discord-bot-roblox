const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const configRepo = require('../../db/repos/config');
const staffRepo = require('../../db/repos/staff');
const onboardingRepo = require('../../db/repos/onboarding');
const { contextFor } = require('../../services/actor');
const { notifyUser } = require('../../services/notify');
const { CAPABILITIES, can, assertCan, PermissionError } = require('../../domain/permissions');
const { parseAmount, formatAmount, isSupportedCurrency, CURRENCIES } = require('../../domain/money');
const { parseDeadlineInput, discordTimestamp } = require('../../utils/time');
const { customId } = require('../../interactions/router');
const { priv } = require('../../utils/reply');

const { TRIAL_STATES } = onboardingRepo;
const CURRENCY_CHOICES = Object.keys(CURRENCIES).map((code) => ({ name: code, value: code }));

/**
 * Paid trial briefs for people the studio is considering taking on.
 *
 * A trial is an agreement like any other piece of work: the terms are written
 * down before it starts, the person accepts them explicitly, and what they
 * accepted is snapshotted so a later edit cannot rewrite it.
 */

function trialEmbed(trial, { forCandidate = false } = {}) {
  const embed = new EmbedBuilder()
    .setTitle(`${trial.code} · ${trial.title}`)
    .setColor(trial.status === TRIAL_STATES.PASSED ? 0x57f287 : trial.status === TRIAL_STATES.FAILED ? 0xed4245 : 0x5865f2)
    .setDescription(trial.brief.slice(0, 2000))
    .addFields(
      { name: 'Terms', value: trial.terms.slice(0, 1024), inline: false },
      {
        name: 'Pay',
        value: trial.pay_minor === null
          ? '_not set_'
          : formatAmount(trial.pay_minor, trial.pay_currency),
        inline: true,
      },
      {
        name: 'Deadline',
        value: trial.deadline_utc ? discordTimestamp(trial.deadline_utc, 'F') : '_none_',
        inline: true,
      },
      { name: 'Status', value: trial.status.replace(/_/g, ' '), inline: true }
    );

  if (forCandidate) {
    embed.setFooter({ text: 'Accepting records these exact terms. They cannot be changed behind you afterwards.' });
  }
  return embed;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('trial')
    .setDescription('Trial briefs for people the studio is considering')
    .addSubcommand((sub) =>
      sub
        .setName('offer')
        .setDescription('Write a trial brief and send it')
        .addUserOption((opt) => opt.setName('person').setDescription('Who it is for').setRequired(true))
        .addStringOption((opt) => opt.setName('title').setDescription('Short title for the trial piece').setRequired(true))
        .addStringOption((opt) => opt.setName('brief').setDescription('What they are asked to make').setRequired(true))
        .addStringOption((opt) => opt.setName('terms').setDescription('What is paid, what is expected, what happens after').setRequired(true))
        .addStringOption((opt) => opt.setName('department').setDescription('Which department').setRequired(false).setAutocomplete(true))
        .addStringOption((opt) => opt.setName('pay').setDescription('Trial pay (leave empty only if genuinely unpaid)').setRequired(false))
        .addStringOption((opt) => opt.setName('currency').setDescription('Currency').addChoices(...CURRENCY_CHOICES).setRequired(false))
        .addStringOption((opt) => opt.setName('deadline').setDescription('Deadline, in their timezone, e.g. 2026-10-05 18:00').setRequired(false))
    )
    .addSubcommand((sub) =>
      sub
        .setName('submit')
        .setDescription('Submit your trial work')
        .addStringOption((opt) => opt.setName('code').setDescription('Trial code').setRequired(true).setAutocomplete(true))
        .addStringOption((opt) => opt.setName('links').setDescription('Link(s) to your work').setRequired(true))
        .addStringOption((opt) => opt.setName('note').setDescription('Anything you want noted').setRequired(false))
    )
    .addSubcommand((sub) =>
      sub
        .setName('decide')
        .setDescription('Pass or fail a submitted trial, with feedback')
        .addStringOption((opt) => opt.setName('code').setDescription('Trial code').setRequired(true).setAutocomplete(true))
        .addStringOption((opt) =>
          opt.setName('outcome').setDescription('The decision').setRequired(true)
            .addChoices({ name: 'Passed', value: 'passed' }, { name: 'Not this time', value: 'failed' })
        )
        .addStringOption((opt) => opt.setName('feedback').setDescription('Feedback for them — required either way').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('withdraw')
        .setDescription('Withdraw a trial that has not been decided')
        .addStringOption((opt) => opt.setName('code').setDescription('Trial code').setRequired(true).setAutocomplete(true))
        .addStringOption((opt) => opt.setName('reason').setDescription('Why, for the record').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('list')
        .setDescription('Trials, open by default')
        .addStringOption((opt) =>
          opt.setName('status').setDescription('Which ones').setRequired(false)
            .addChoices(
              { name: 'Open', value: 'open' },
              { name: 'Passed', value: 'passed' },
              { name: 'Not passed', value: 'failed' },
              { name: 'All', value: 'all' }
            )
        )
    )
    .addSubcommand((sub) => sub.setName('mine').setDescription('Your own trial briefs')),

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);
    const { db, guildId, actor } = contextFor(interaction);

    if (focused.name === 'department') {
      await interaction.respond(configRepo.listDepartments(db, guildId).slice(0, 25)
        .map((dept) => ({ name: dept.name.slice(0, 100), value: String(dept.id) })));
      return;
    }

    if (focused.name === 'code') {
      // A candidate sees only their own briefs in the picker.
      const mine = !can(actor, CAPABILITIES.STAFF_MANAGE);
      const trials = onboardingRepo.listTrials(db, guildId, {
        status: 'open',
        userId: mine ? interaction.user.id : null,
      });
      await interaction.respond(trials.slice(0, 25).map((trial) => ({
        name: `${trial.code} · ${trial.title} · ${trial.status}`.slice(0, 100),
        value: trial.code,
      })));
    }
  },

  async execute(interaction) {
    const { db, guildId, config, actor } = contextFor(interaction);
    const sub = interaction.options.getSubcommand();
    const userId = interaction.user.id;

    if (sub === 'mine') {
      const trials = onboardingRepo.listTrials(db, guildId, { status: null, userId, limit: 10 });
      await interaction.reply(priv({
        embeds: trials.length === 0
          ? [new EmbedBuilder().setTitle('Your trials').setColor(0x5865f2).setDescription('_You have no trial briefs._')]
          : trials.slice(0, 5).map((trial) => trialEmbed(trial, { forCandidate: true })),
      }));
      return;
    }

    if (sub === 'list') {
      assertCan(actor, CAPABILITIES.STAFF_MANAGE);
      const status = interaction.options.getString('status') || 'open';
      const trials = onboardingRepo.listTrials(db, guildId, { status: status === 'all' ? null : status });

      await interaction.reply(priv({
        embeds: [new EmbedBuilder()
          .setTitle('Trials')
          .setColor(0x5865f2)
          .setDescription(trials.map((trial) =>
            `**${trial.code}** <@${trial.user_id}> — ${trial.title}\n` +
            `┗ ${trial.status.replace(/_/g, ' ')}` +
            `${trial.deadline_utc ? ` · due ${discordTimestamp(trial.deadline_utc, 'R')}` : ''}` +
            `${trial.pay_minor !== null ? ` · ${formatAmount(trial.pay_minor, trial.pay_currency)}` : ''}`
          ).join('\n').slice(0, 4000) || '_Nothing here._')],
      }));
      return;
    }

    if (sub === 'offer') {
      assertCan(actor, CAPABILITIES.STAFF_MANAGE);

      const person = interaction.options.getUser('person', true);
      const payText = interaction.options.getString('pay');
      const currency = interaction.options.getString('currency') || config.default_currency;

      if (payText && !isSupportedCurrency(currency)) {
        await interaction.reply(priv(`❌ Unsupported currency \`${currency}\`.`));
        return;
      }

      // Read in *your* timezone, because a candidate is usually not on the
      // staff list yet and so has none recorded. The brief shows it as a
      // Discord timestamp, which renders in whatever timezone they are in.
      let deadlineUtc = null;
      let deadlineNote = '';
      const deadlineText = interaction.options.getString('deadline');

      if (deadlineText) {
        const yourTimezone = staffRepo.getStaff(db, guildId, userId)?.timezone || 'UTC';
        const parsed = parseDeadlineInput(deadlineText, yourTimezone);

        if (!parsed.ok) {
          await interaction.reply(priv(
            parsed.reason === 'nonexistent_local_time'
              ? `❌ That local time does not exist in \`${yourTimezone}\` because the clocks skip it. Pick another time.`
              : `❌ Could not read "${deadlineText}". Use \`YYYY-MM-DD\` or \`YYYY-MM-DD HH:MM\` (24-hour).`
          ));
          return;
        }

        deadlineUtc = parsed.utcMs;
        deadlineNote = `\nDeadline read as **${parsed.preview}**` +
          `${parsed.impliedEndOfDay ? ' (end of day, since no time was given)' : ''}` +
          `${parsed.ambiguous ? ' — ⚠️ this local time occurs twice; the earlier was used' : ''}.`;
      }

      const departmentRaw = interaction.options.getString('department');
      const trial = onboardingRepo.createTrial(db, guildId, {
        userId: person.id,
        departmentId: departmentRaw ? Number(departmentRaw) : null,
        title: interaction.options.getString('title', true),
        brief: interaction.options.getString('brief', true),
        terms: interaction.options.getString('terms', true),
        payMinor: payText ? parseAmount(payText, currency) : null,
        payCurrency: payText ? currency : null,
        deadlineUtc,
      }, userId);

      const buttons = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(customId('trial', 'accept', String(trial.id)))
          .setLabel('Accept').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(customId('trial', 'decline', String(trial.id)))
          .setLabel('Decline').setStyle(ButtonStyle.Secondary)
      );

      const delivered = await notifyUser(interaction.client, db, guildId, person.id, {
        embeds: [trialEmbed(trial, { forCandidate: true })],
        components: [buttons],
      }).catch(() => ({ delivered: false }));

      await interaction.reply(priv(
        `✅ **${trial.code}** sent to <@${person.id}>.${deadlineNote}\n` +
        `${delivered?.delivered === false ? '⚠️ It could not be delivered — check the fallback channel.' : ''}` +
        `${trial.pay_minor === null ? '\n⚠️ No pay is recorded on this trial. If it is unpaid, say so plainly in the terms.' : ''}`
      ));
      return;
    }

    const trial = onboardingRepo.getTrialByCode(db, guildId, interaction.options.getString('code', true));
    if (!trial) {
      await interaction.reply(priv('❌ No trial with that code.'));
      return;
    }

    if (sub === 'submit') {
      if (trial.user_id !== userId) {
        throw new PermissionError('trial.submit', 'That trial brief is not yours.');
      }

      const updated = onboardingRepo.setTrialStatus(db, guildId, trial.id, TRIAL_STATES.SUBMITTED, {
        from: TRIAL_STATES.ACCEPTED,
        actorUserId: userId,
        columns: {
          submitted_at: Date.now(),
          submission_links: interaction.options.getString('links', true),
          submission_note: interaction.options.getString('note'),
        },
      });

      if (!updated) {
        await interaction.reply(priv(
          trial.status === TRIAL_STATES.OFFERED
            ? `❌ Accept **${trial.code}** first — the accept button is on the brief you were sent.`
            : `❌ **${trial.code}** is ${trial.status.replace(/_/g, ' ')}, so it cannot be submitted.`
        ));
        return;
      }

      await interaction.reply(priv(`✅ Submitted **${trial.code}**. You will be told the decision either way.`));

      if (config?.owner_user_id) {
        await notifyUser(interaction.client, db, guildId, config.owner_user_id, {
          content:
            `📥 <@${userId}> submitted trial **${trial.code} · ${trial.title}**.\n` +
            `${updated.submission_links}\n` +
            `Decide with \`/team trial decide code:${trial.code}\`.`,
        }).catch(() => null);
      }
      return;
    }

    assertCan(actor, CAPABILITIES.STAFF_MANAGE);

    if (sub === 'withdraw') {
      const reason = interaction.options.getString('reason', true);
      const updated = onboardingRepo.setTrialStatus(db, guildId, trial.id, TRIAL_STATES.WITHDRAWN, {
        from: onboardingRepo.OPEN_TRIAL_STATES,
        actorUserId: userId,
        columns: { feedback: reason },
      });

      if (!updated) {
        await interaction.reply(priv(`❌ **${trial.code}** is already ${trial.status.replace(/_/g, ' ')}.`));
        return;
      }

      await interaction.reply(priv(`✅ **${trial.code}** withdrawn. <@${trial.user_id}> has been told.`));
      await notifyUser(interaction.client, db, guildId, trial.user_id, {
        content: `Your trial **${trial.code} · ${trial.title}** has been withdrawn.\nReason: ${reason}`,
      }).catch(() => null);
      return;
    }

    if (sub === 'decide') {
      const outcome = interaction.options.getString('outcome', true);
      const feedback = interaction.options.getString('feedback', true);

      // Deciding a trial nobody submitted would be judging work never handed
      // in, so it is refused rather than recorded.
      const updated = onboardingRepo.setTrialStatus(db, guildId, trial.id, outcome, {
        from: TRIAL_STATES.SUBMITTED,
        actorUserId: userId,
        columns: { feedback, decided_by: userId, decided_at: Date.now() },
      });

      if (!updated) {
        await interaction.reply(priv(
          `❌ **${trial.code}** is ${trial.status.replace(/_/g, ' ')}. Only a submitted trial can be decided.`
        ));
        return;
      }

      await interaction.reply(priv(
        `✅ Recorded: **${trial.code}** ${outcome === 'passed' ? 'passed' : 'did not pass'}. <@${trial.user_id}> has been told.\n` +
        `${outcome === 'passed'
          ? 'Give them their Discord roles yourself — the bot does not grant roles.'
          : ''}` +
        `${trial.pay_minor !== null ? `\n💰 Trial pay of ${formatAmount(trial.pay_minor, trial.pay_currency)} is still owed either way. Record it with \`/pay pay\` once paid.` : ''}`
      ));

      await notifyUser(interaction.client, db, guildId, trial.user_id, {
        content: outcome === 'passed'
          ? `🎉 Your trial **${trial.code} · ${trial.title}** passed.\n> ${feedback.slice(0, 800)}`
          : `Your trial **${trial.code} · ${trial.title}** was not taken further this time.\n> ${feedback.slice(0, 800)}\n` +
            'Thank you for the work you put in.',
      }).catch(() => null);
    }
  },
};
