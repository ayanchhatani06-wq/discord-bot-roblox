const {
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
} = require('discord.js');
const staffRepo = require('../db/repos/staff');
const configRepo = require('../db/repos/config');
const { contextFor } = require('../services/actor');
const { buildProfileEmbed, buildProfileComponents, missingProfileFields, NAMESPACE } = require('../services/profileView');
const { refreshGuildBoards } = require('../services/staffBoard');
const { notifyLeadersOfAbsence } = require('../services/absence');
const { register, customId } = require('./router');
const {
  isValidTimezone,
  searchTimezones,
  parseClockInput,
  formatClockMinutes,
  normalizeWorkingDays,
  parseDeadlineInput,
  formatDateTimeInZone,
} = require('../utils/time');
const { priv } = require('../utils/reply');
const { declinedSet, withDecline, readAnswer, isDecline } = require('../services/profileAnswers');
const profileRoster = require('../services/profileRoster');
const portfolioImages = require('../services/portfolioImages');

function textInput({ id, label, value, placeholder, required = false, max = 200, style = TextInputStyle.Short }) {
  const input = new TextInputBuilder()
    .setCustomId(id)
    .setLabel(label)
    .setStyle(style)
    .setRequired(required)
    .setMaxLength(max);
  if (placeholder) input.setPlaceholder(placeholder.slice(0, 100));
  if (value !== null && value !== undefined && value !== '') input.setValue(String(value).slice(0, max));
  return new ActionRowBuilder().addComponents(input);
}

function timezoneModal(staff) {
  return new ModalBuilder()
    .setCustomId(customId(NAMESPACE, 'tzModal'))
    .setTitle('Set your timezone')
    .addComponents(
      textInput({
        id: 'timezone',
        label: 'IANA timezone',
        value: staff.timezone,
        placeholder: 'Asia/Karachi, Europe/London, America/Los_Angeles',
        required: true,
        max: 64,
      })
    );
}

/** A box shows "none" again when somebody answered no, so they see their answer. */
function prefill(staff, key) {
  if (staff[key]) return staff[key];
  return declinedSet(staff).has(key) ? 'none' : null;
}

/**
 * The five questions a leader reads first when deciding who gets a job.
 *
 * Role title and experience used to sit behind a separate button, and people
 * filled this form in, saw nothing else asked, and reasonably asked what was
 * left. Discord allows five boxes; these are the five that matter, and the
 * Roblox name — optional, and asked of fewer people — has its own button.
 */
function detailsModal(staff) {
  return new ModalBuilder()
    .setCustomId(customId(NAMESPACE, 'detailsModal'))
    .setTitle('Edit your profile details')
    .addComponents(
      textInput({ id: 'sub_role', label: 'Your title (or "none")', value: prefill(staff, 'sub_role'), placeholder: 'Interior Builder, UI Designer, Terrain Artist', max: 60 }),
      textInput({ id: 'experience', label: 'Experience (or "none")', value: prefill(staff, 'experience'), placeholder: '10+ years, or 2 years with 1 on Roblox', max: 60 }),
      textInput({ id: 'specialties', label: 'Specialties (or "none")', value: prefill(staff, 'specialties'), placeholder: 'Hard-surface models, stylised textures', max: 200 }),
      textInput({ id: 'software', label: 'Software you use (or "none")', value: prefill(staff, 'software'), placeholder: 'Blender, Substance Painter, Roblox Studio', max: 200 }),
      textInput({ id: 'portfolio_url', label: 'Portfolio link (or "none")', value: prefill(staff, 'portfolio_url'), placeholder: 'https://...', max: 300 })
    );
}

function robloxModal(staff) {
  return new ModalBuilder()
    .setCustomId(customId(NAMESPACE, 'robloxModal'))
    .setTitle('Your Roblox name')
    .addComponents(
      textInput({ id: 'roblox_username', label: 'Roblox username (or "none")', value: prefill(staff, 'roblox_username'), max: 64 })
    );
}

/**
 * Reads a box that may not be there.
 *
 * Somebody with an old panel open can still submit the form it opened, which
 * has a different set of boxes; discord.js throws on a missing one. Undefined
 * means "not asked", which is different from blank, which means "cleared".
 */
function field(interaction, id) {
  try {
    return interaction.fields.getTextInputValue(id);
  } catch {
    return undefined;
  }
}

/**
 * Turns submitted boxes into one update, "no" answers included.
 *
 * The decline list is threaded through each answer in turn so two boxes in the
 * same form both land, rather than the second overwriting the first.
 */
function answersPatch(staff, keys, interaction, { validate = {} } = {}) {
  const patch = {};
  const problems = [];
  let running = { profile_declined: staff.profile_declined };

  for (const key of keys) {
    const raw = field(interaction, key);
    if (raw === undefined) continue;

    const { value, declined } = readAnswer(raw);
    if (value && validate[key]) {
      const problem = validate[key](value);
      if (problem) { problems.push(problem); continue; }
    }

    patch[key] = value;
    running = { profile_declined: withDecline(running, key, declined) };
  }

  patch.profile_declined = running.profile_declined;
  return { patch, problems };
}

function hoursModal(staff) {
  return new ModalBuilder()
    .setCustomId(customId(NAMESPACE, 'hoursModal'))
    .setTitle('Working and quiet hours')
    .addComponents(
      textInput({ id: 'working_days', label: 'Working days (or "none")', value: staff.working_days || (declinedSet(staff).has('hours') ? 'none' : null), placeholder: 'mon,tue,wed,thu,fri — or none for no fixed hours', max: 40 }),
      textInput({ id: 'working_start', label: 'Start time (24h, your timezone)', value: formatClockMinutes(staff.working_start_minute), placeholder: '09:00', max: 5 }),
      textInput({ id: 'working_end', label: 'End time (24h, your timezone)', value: formatClockMinutes(staff.working_end_minute), placeholder: '17:00', max: 5 }),
      textInput({ id: 'quiet_start', label: 'Quiet hours start (optional)', value: formatClockMinutes(staff.quiet_start_minute), placeholder: '22:00', max: 5 }),
      textInput({ id: 'quiet_end', label: 'Quiet hours end (optional)', value: formatClockMinutes(staff.quiet_end_minute), placeholder: '07:00', max: 5 })
    );
}

function awayModal(staff) {
  return new ModalBuilder()
    .setCustomId(customId(NAMESPACE, 'awayModal'))
    .setTitle('Mark yourself away')
    .addComponents(
      textInput({ id: 'until', label: 'Return date (YYYY-MM-DD, optional)', placeholder: '2026-10-20', max: 10 }),
      textInput({
        id: 'note',
        label: 'Note for your leader (optional)',
        value: staff.away_note,
        placeholder: 'Exams until the 20th',
        max: 200,
        style: TextInputStyle.Paragraph,
      })
    );
}

async function showPanel(interaction, { db, guildId }, message) {
  const staff = staffRepo.getStaff(db, guildId, interaction.user.id);
  const department = staff.department_id ? configRepo.getDepartment(db, guildId, staff.department_id) : null;
  // The whole list, not just the two fields that break routing: somebody who
  // has filled in a form and is told nothing else is missing reasonably
  // believes they are done, and then asks why the roster disagrees.
  const person = profileRoster.assess(staff, { pictures: portfolioImages.countFor(db, guildId, staff.user_id) });
  const steps = profileRoster.nextSteps(person);

  const body = {
    content: `${message}${steps ? `\n\n**Still to fill in:**\n${steps}` : '\n\n🟢 **Your profile is complete.**'}`.slice(0, 2000),
    embeds: [buildProfileEmbed({
      staff,
      department,
      activeCount: staffRepo.activeTaskCount(db, guildId, staff.user_id),
    })],
    components: buildProfileComponents(staff),
  };

  // The panel is always an ephemeral message the caller already owns, so it is
  // updated in place rather than stacking replies.
  if (interaction.isModalSubmit() || interaction.isButton()) {
    if (interaction.message) {
      await interaction.update(body).catch(async () => {
        await interaction.reply(priv(body)).catch(() => null);
      });
      return;
    }
  }
  await interaction.reply(priv(body));
}

function refreshBoards(interaction, db) {
  refreshGuildBoards(interaction.client, interaction.guildId, db).catch((error) =>
    console.error('Board refresh failed:', error)
  );
}

function markOnboardedIfComplete(db, guildId, userId) {
  const staff = staffRepo.getStaff(db, guildId, userId);
  if (staff && missingProfileFields(staff).length === 0) staffRepo.markOnboarded(db, guildId, userId);
}

register(NAMESPACE, async (interaction, { action, args }) => {
  const ctx = contextFor(interaction);
  const { db, guildId } = ctx;
  const userId = interaction.user.id;
  const displayName = interaction.member?.displayName || interaction.user.username;
  const staff = staffRepo.ensureStaff(db, guildId, userId, displayName);

  switch (action) {
    case 'tz':
      await interaction.showModal(timezoneModal(staff));
      return;

    case 'details':
      await interaction.showModal(detailsModal(staff));
      return;

    // Older panels carry a 'role' button from when role and experience had a
    // form of their own; they now live in the details form, so send them there.
    case 'role':
      await interaction.showModal(detailsModal(staff));
      return;

    case 'roblox':
      await interaction.showModal(robloxModal(staff));
      return;

    case 'hours':
      await interaction.showModal(hoursModal(staff));
      return;

    case 'away':
      await interaction.showModal(awayModal(staff));
      return;

    case 'avail': {
      const status = args[0];
      staffRepo.setAvailability(db, guildId, userId, status, { actorUserId: userId });
      refreshBoards(interaction, db);
      await showPanel(interaction, ctx, `✅ You are now **${staffRepo.AVAILABILITY_LABELS[status]}**.`);
      return;
    }

    case 'tzModal': {
      const timezone = interaction.fields.getTextInputValue('timezone').trim();
      if (!isValidTimezone(timezone)) {
        const suggestions = searchTimezones(timezone, 5);
        await interaction.reply(priv(
          `❌ \`${timezone}\` is not a timezone I can store.` +
          `${suggestions.length > 0 ? `\nDid you mean: ${suggestions.map((tz) => `\`${tz}\``).join(', ')}?` : ''}\n` +
          '_Tip: type your offset — `GMT+5` — or your city, and pick from the list that appears._\n' +
          'A bare offset is not stored because it carries no daylight-saving rules; the place it belongs to does.'
        ));
        return;
      }

      staffRepo.setTimezone(db, guildId, userId, timezone, userId);
      markOnboardedIfComplete(db, guildId, userId);
      refreshBoards(interaction, db);
      await showPanel(interaction, ctx, `✅ Timezone set to \`${timezone}\` — **${formatDateTimeInZone(timezone)}** for you right now.`);
      return;
    }

    // Every form that sets free-text answers goes through answersPatch, which
    // reads only the boxes the form actually had. That matters for somebody
    // submitting a form an older panel opened, whose boxes differ from today's.
    case 'detailsModal':
    case 'roleModal':
    case 'robloxModal': {
      const { patch, problems } = answersPatch(
        staff,
        ['sub_role', 'experience', 'specialties', 'software', 'portfolio_url', 'roblox_username'],
        interaction,
        {
          validate: {
            portfolio_url: (value) => (/^https?:\/\//i.test(value)
              ? null
              : 'The portfolio link must start with `http://` or `https://` — or write **none** if you don\'t have one.'),
          },
        }
      );

      if (problems.length > 0) {
        await interaction.reply(priv(`❌ ${problems.join('\n')}`));
        return;
      }

      staffRepo.updateStaff(db, guildId, userId, patch, userId);
      markOnboardedIfComplete(db, guildId, userId);
      refreshBoards(interaction, db);
      await showPanel(interaction, ctx, '✅ Saved.');
      return;
    }

    case 'hoursModal': {
      const raw = {
        days: interaction.fields.getTextInputValue('working_days').trim(),
        start: interaction.fields.getTextInputValue('working_start').trim(),
        end: interaction.fields.getTextInputValue('working_end').trim(),
        quietStart: interaction.fields.getTextInputValue('quiet_start').trim(),
        quietEnd: interaction.fields.getTextInputValue('quiet_end').trim(),
      };

      // "no" in the days or start box means no fixed hours — an answer, so the
      // roster stops asking. The time fields stay empty rather than holding the
      // word, because the reminder scheduler reads them and expects a time.
      const noFixedHours = isDecline(raw.days) || isDecline(raw.start);
      if (noFixedHours) {
        raw.days = '';
        raw.start = '';
        raw.end = '';
      }

      const problems = [];
      const patch = {};

      if (raw.days) {
        const days = normalizeWorkingDays(raw.days);
        if (!days || days.length === 0) problems.push('Working days should look like `mon,tue,wed`.');
        else patch.working_days = days.join(',');
      } else {
        patch.working_days = null;
      }

      for (const [key, field, label] of [
        ['working_start_minute', raw.start, 'Start time'],
        ['working_end_minute', raw.end, 'End time'],
        ['quiet_start_minute', raw.quietStart, 'Quiet hours start'],
        ['quiet_end_minute', raw.quietEnd, 'Quiet hours end'],
      ]) {
        if (!field) { patch[key] = null; continue; }
        const minutes = parseClockInput(field);
        if (minutes === null) problems.push(`${label} should be 24-hour HH:MM, e.g. 09:00.`);
        else patch[key] = minutes;
      }

      const onlyOneOf = (a, b) => (patch[a] === null) !== (patch[b] === null);
      if (onlyOneOf('working_start_minute', 'working_end_minute')) {
        problems.push('Give both a start and an end time for working hours, or neither.');
      }
      if (onlyOneOf('quiet_start_minute', 'quiet_end_minute')) {
        problems.push('Give both a start and an end for quiet hours, or neither.');
      }

      if (problems.length > 0) {
        await interaction.reply(priv(`❌ ${problems.join('\n❌ ')}`));
        return;
      }

      patch.profile_declined = withDecline(staff, 'hours', noFixedHours);

      staffRepo.updateStaff(db, guildId, userId, patch, userId);
      refreshBoards(interaction, db);
      await showPanel(interaction, ctx, noFixedHours
        ? '✅ Saved — no fixed hours.'
        : '✅ Hours updated. They are read in your own timezone.');
      return;
    }

    case 'awayModal': {
      const untilText = interaction.fields.getTextInputValue('until').trim();
      const note = interaction.fields.getTextInputValue('note').trim() || null;
      let awayUntil = null;

      if (untilText) {
        if (!staff.timezone) {
          await interaction.reply(priv('❌ Set your timezone first so a return date can be read correctly.'));
          return;
        }
        const parsed = parseDeadlineInput(untilText, staff.timezone);
        if (!parsed.ok) {
          await interaction.reply(priv(`❌ Could not read "${untilText}" as a date. Use YYYY-MM-DD.`));
          return;
        }
        awayUntil = parsed.utcMs;
      }

      staffRepo.setAvailability(db, guildId, userId, staffRepo.AVAILABILITY.AWAY, {
        awayUntil,
        note,
        actorUserId: userId,
      });
      refreshBoards(interaction, db);

      const absence = await notifyLeadersOfAbsence(interaction.client, db, guildId, userId, { awayUntil, note });

      await showPanel(interaction, ctx,
        `✅ Marked away.${absence.activeCount > 0
          ? ` You are still holding ${absence.activeCount} task(s) and ${absence.notified.length} leader(s) have been told.`
          : ''} Nothing is cancelled or reassigned automatically.`
      );
      return;
    }

    default:
      await interaction.reply(priv('❌ Unknown profile action.'));
  }
});

// The form builders and answer reader are exported for the tests that drive
// them with the boxes an old panel would submit.
module.exports = { NAMESPACE, detailsModal, robloxModal, hoursModal, answersPatch, field };
