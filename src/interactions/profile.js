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

function detailsModal(staff) {
  return new ModalBuilder()
    .setCustomId(customId(NAMESPACE, 'detailsModal'))
    .setTitle('Edit your profile details')
    .addComponents(
      textInput({ id: 'specialties', label: 'Specialties', value: staff.specialties, placeholder: 'Hard-surface models, stylised textures', max: 200 }),
      textInput({ id: 'software', label: 'Software you use', value: staff.software, placeholder: 'Blender, Substance Painter', max: 200 }),
      textInput({ id: 'portfolio_url', label: 'Portfolio link', value: staff.portfolio_url, placeholder: 'https://...', max: 300 }),
      textInput({ id: 'roblox_username', label: 'Roblox username (optional)', value: staff.roblox_username, max: 64 })
    );
}

function hoursModal(staff) {
  return new ModalBuilder()
    .setCustomId(customId(NAMESPACE, 'hoursModal'))
    .setTitle('Working and quiet hours')
    .addComponents(
      textInput({ id: 'working_days', label: 'Working days', value: staff.working_days, placeholder: 'mon,tue,wed,thu,fri', max: 40 }),
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
  const missing = missingProfileFields(staff);

  const body = {
    content: `${message}${missing.length > 0 ? `\nStill missing: **${missing.join(', ')}**.` : ''}`,
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
          `❌ \`${timezone}\` is not a recognised IANA timezone.` +
          `${suggestions.length > 0 ? `\nDid you mean: ${suggestions.map((tz) => `\`${tz}\``).join(', ')}?` : ''}\n` +
          'Abbreviations such as `PST` are rejected because they carry no daylight-saving rules.'
        ));
        return;
      }

      staffRepo.setTimezone(db, guildId, userId, timezone, userId);
      markOnboardedIfComplete(db, guildId, userId);
      refreshBoards(interaction, db);
      await showPanel(interaction, ctx, `✅ Timezone set to \`${timezone}\` — **${formatDateTimeInZone(timezone)}** for you right now.`);
      return;
    }

    case 'detailsModal': {
      const patch = {
        specialties: interaction.fields.getTextInputValue('specialties').trim() || null,
        software: interaction.fields.getTextInputValue('software').trim() || null,
        portfolio_url: interaction.fields.getTextInputValue('portfolio_url').trim() || null,
        roblox_username: interaction.fields.getTextInputValue('roblox_username').trim() || null,
      };

      if (patch.portfolio_url && !/^https?:\/\//i.test(patch.portfolio_url)) {
        await interaction.reply(priv('❌ The portfolio link must start with http:// or https://'));
        return;
      }

      staffRepo.updateStaff(db, guildId, userId, patch, userId);
      markOnboardedIfComplete(db, guildId, userId);
      refreshBoards(interaction, db);
      await showPanel(interaction, ctx, '✅ Profile details updated.');
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

      staffRepo.updateStaff(db, guildId, userId, patch, userId);
      refreshBoards(interaction, db);
      await showPanel(interaction, ctx, '✅ Hours updated. They are read in your own timezone.');
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

      await showPanel(interaction, ctx,
        '✅ Marked away. Your leader will be told about your active tasks — nothing is cancelled or reassigned automatically.'
      );
      return;
    }

    default:
      await interaction.reply(priv('❌ Unknown profile action.'));
  }
});

module.exports = { NAMESPACE };
