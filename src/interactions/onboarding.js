const onboardingRepo = require('../db/repos/onboarding');
const { contextFor } = require('../services/actor');
const { notifyUser } = require('../services/notify');
const { formatAmount } = require('../domain/money');
const { register } = require('./router');
const { priv } = require('../utils/reply');

const NAMESPACE = 'proc';
const TRIAL_NAMESPACE = 'trial';

/**
 * Acknowledging a procedure, and accepting or declining a trial brief.
 *
 * Both are agreements, so both record the exact thing agreed to: the procedure
 * version, and a snapshot of the trial terms. Later edits then stand out as
 * changes to something already agreed rather than quietly replacing it.
 */
register(NAMESPACE, async (interaction, { action, args }) => {
  const { db, guildId } = contextFor(interaction);
  const userId = interaction.user.id;

  if (action !== 'ack') {
    await interaction.reply(priv('❌ Unknown procedure action.'));
    return;
  }

  const [procedureId, version] = args;
  const procedure = onboardingRepo.getProcedureById(db, guildId, Number(procedureId));

  if (!procedure) {
    await interaction.reply(priv('❌ That procedure no longer exists.'));
    return;
  }

  // The button carries the version it was shown for. If the text has changed
  // since, acknowledging it would record agreement to something never read.
  if (procedure.version !== Number(version)) {
    await interaction.reply(priv(
      `❌ This button is for version ${version}, but **${procedure.title}** is now at version ${procedure.version}.\n` +
      `Open it again with \`/staff-rules read key:${procedure.key}\` and read the current text.`
    ));
    return;
  }

  const result = onboardingRepo.acknowledge(db, guildId, procedure.id, userId);
  await interaction.reply(priv(
    result.alreadyAcknowledged
      ? `You had already acknowledged **${procedure.title}** v${procedure.version}.`
      : `✅ Recorded: you have read **${procedure.title}** v${procedure.version}.`
  ));
});

register(TRIAL_NAMESPACE, async (interaction, { action, args }) => {
  const { db, guildId, config } = contextFor(interaction);
  const userId = interaction.user.id;
  const trial = onboardingRepo.getTrial(db, guildId, Number(args[0]));

  if (!trial) {
    await interaction.reply(priv('❌ That trial no longer exists.'));
    return;
  }

  // A trial brief is addressed to one person. Nobody else may answer it.
  if (trial.user_id !== userId) {
    await interaction.reply(priv('❌ This trial brief is not yours to answer.'));
    return;
  }

  if (action === 'accept') {
    const terms = JSON.stringify({
      title: trial.title,
      terms: trial.terms,
      pay_minor: trial.pay_minor,
      pay_currency: trial.pay_currency,
      deadline_utc: trial.deadline_utc,
      accepted_at: Date.now(),
    });

    const updated = onboardingRepo.setTrialStatus(db, guildId, trial.id, onboardingRepo.TRIAL_STATES.ACCEPTED, {
      from: onboardingRepo.TRIAL_STATES.OFFERED,
      actorUserId: userId,
      columns: { accepted_at: Date.now(), accepted_terms_json: terms },
    });

    if (!updated) {
      await interaction.reply(priv('This brief has already been answered.'));
      return;
    }

    await interaction.reply(priv(
      `✅ You accepted **${trial.code} · ${trial.title}**.\n` +
      `${trial.pay_minor !== null ? `Agreed: **${formatAmount(trial.pay_minor, trial.pay_currency)}**. ` : ''}` +
      'The terms above are recorded as you accepted them.\n' +
      `Submit your work with \`/trial submit code:${trial.code}\`.`
    ));

    if (config?.owner_user_id) {
      await notifyUser(interaction.client, db, guildId, config.owner_user_id, {
        content: `✅ <@${userId}> accepted trial **${trial.code} · ${trial.title}**.`,
      }).catch(() => null);
    }
    return;
  }

  if (action === 'decline') {
    const updated = onboardingRepo.setTrialStatus(db, guildId, trial.id, onboardingRepo.TRIAL_STATES.DECLINED, {
      from: onboardingRepo.TRIAL_STATES.OFFERED,
      actorUserId: userId,
    });

    if (!updated) {
      await interaction.reply(priv('This brief has already been answered.'));
      return;
    }

    await interaction.reply(priv(`Recorded: you declined **${trial.code}**. Nothing further is expected of you.`));

    if (config?.owner_user_id) {
      await notifyUser(interaction.client, db, guildId, config.owner_user_id, {
        content: `<@${userId}> declined trial **${trial.code} · ${trial.title}**.`,
      }).catch(() => null);
    }
    return;
  }

  await interaction.reply(priv('❌ Unknown trial action.'));
});

module.exports = { NAMESPACE, TRIAL_NAMESPACE };
