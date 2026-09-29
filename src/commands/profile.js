const { SlashCommandBuilder } = require('discord.js');
const staffRepo = require('../db/repos/staff');
const configRepo = require('../db/repos/config');
const { contextFor, departmentFromRoles, roleIdsOf } = require('../services/actor');
const { buildProfileEmbed, buildProfileComponents, missingProfileFields } = require('../services/profileView');
const { refreshGuildBoards } = require('../services/staffBoard');
const { CAPABILITIES, assertCan } = require('../domain/permissions');
const { isValidTimezone, searchTimezones, formatDateTimeInZone, parseDeadlineInput } = require('../utils/time');
const { priv } = require('../utils/reply');

/**
 * Creates the staff row if needed and fills in what Discord already knows:
 * display name, and the department implied by their roles.
 */
function syncFromDiscord(db, interaction, departments) {
  const guildId = interaction.guildId;
  const userId = interaction.user.id;
  const displayName = interaction.member?.displayName || interaction.user.displayName || interaction.user.username;

  let staff = staffRepo.ensureStaff(db, guildId, userId, displayName);
  const patch = {};

  if (staff.display_name !== displayName) patch.display_name = displayName;
  if (!staff.department_id) {
    const mapped = departmentFromRoles(roleIdsOf(interaction.member), departments);
    if (mapped) patch.department_id = mapped.id;
  }
  if (Object.keys(patch).length > 0) staff = staffRepo.updateStaff(db, guildId, userId, patch, userId);

  return staff;
}

function refreshBoardsInBackground(interaction, db) {
  refreshGuildBoards(interaction.client, interaction.guildId, db).catch((error) =>
    console.error('Board refresh failed:', error)
  );
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('profile')
    .setDescription('Your studio profile: timezone, availability, specialties and hours')
    .addSubcommand((sub) =>
      sub.setName('me').setDescription('Open your profile to fill in or edit it')
    )
    .addSubcommand((sub) =>
      sub
        .setName('view')
        .setDescription("View a staff member's profile")
        .addUserOption((opt) => opt.setName('member').setDescription('Whose profile to view').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('timezone')
        .setDescription('Set your timezone')
        .addStringOption((opt) =>
          opt
            .setName('timezone')
            .setDescription('IANA timezone, e.g. Asia/Karachi or Europe/London')
            .setRequired(true)
            .setAutocomplete(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('availability')
        .setDescription('Say whether you are accepting work (separate from being online)')
        .addStringOption((opt) =>
          opt
            .setName('status')
            .setDescription('Your availability for new tasks')
            .setRequired(true)
            .addChoices(
              { name: 'Accepting tasks', value: 'accepting' },
              { name: 'At capacity', value: 'at_capacity' },
              { name: 'Away', value: 'away' }
            )
        )
        .addStringOption((opt) =>
          opt.setName('until').setDescription('If away: return date, YYYY-MM-DD (in your timezone)').setRequired(false)
        )
        .addStringOption((opt) =>
          opt.setName('note').setDescription('Optional short note for your leader').setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('assign')
        .setDescription('Put a staff member in a department (managers only)')
        .addUserOption((opt) => opt.setName('member').setDescription('The staff member').setRequired(true))
        .addStringOption((opt) =>
          opt.setName('department').setDescription('Department key').setRequired(true).setAutocomplete(true)
        )
    ),

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);

    if (focused.name === 'timezone') {
      const matches = searchTimezones(focused.value, 25);
      await interaction.respond(matches.map((tz) => ({ name: tz, value: tz })));
      return;
    }

    if (focused.name === 'department') {
      const { db, guildId } = contextFor(interaction);
      const query = String(focused.value || '').toLowerCase();
      const matches = configRepo
        .listDepartments(db, guildId)
        .filter((dept) => dept.key.includes(query) || dept.name.toLowerCase().includes(query))
        .slice(0, 25);
      await interaction.respond(matches.map((dept) => ({ name: dept.name, value: dept.key })));
    }
  },

  async execute(interaction) {
    const { db, guildId, departments, actor } = contextFor(interaction);
    const sub = interaction.options.getSubcommand();

    if (sub === 'me') {
      const staff = syncFromDiscord(db, interaction, departments);
      const department = staff.department_id ? configRepo.getDepartment(db, guildId, staff.department_id) : null;
      const missing = missingProfileFields(staff);

      await interaction.reply(priv({
        content: missing.length > 0
          ? `Your profile still needs: **${missing.join(', ')}**. Use the buttons below.`
          : 'Your profile is complete. Use the buttons below to change anything.',
        embeds: [buildProfileEmbed({
          staff,
          department,
          activeCount: staffRepo.activeTaskCount(db, guildId, staff.user_id),
        })],
        components: buildProfileComponents(staff),
      }));
      return;
    }

    if (sub === 'view') {
      const target = interaction.options.getUser('member', true);
      const staff = staffRepo.getStaff(db, guildId, target.id);
      if (!staff) {
        await interaction.reply(priv(`<@${target.id}> has not set up a studio profile yet.`));
        return;
      }

      const department = staff.department_id ? configRepo.getDepartment(db, guildId, staff.department_id) : null;
      await interaction.reply(priv({
        embeds: [buildProfileEmbed({
          staff,
          department,
          activeCount: staffRepo.activeTaskCount(db, guildId, staff.user_id),
          nextDeadline: staffRepo.nextDeadlines(db, guildId).get(staff.user_id) || null,
        })],
      }));
      return;
    }

    if (sub === 'timezone') {
      const timezone = interaction.options.getString('timezone', true);
      if (!isValidTimezone(timezone)) {
        const suggestions = searchTimezones(timezone, 5);
        await interaction.reply(priv(
          `❌ \`${timezone}\` is not a recognised IANA timezone.${suggestions.length > 0 ? `\nDid you mean: ${suggestions.map((tz) => `\`${tz}\``).join(', ')}?` : ''}\n` +
          'Abbreviations like `PST` are not accepted because they do not describe daylight saving.'
        ));
        return;
      }

      syncFromDiscord(db, interaction, departments);
      staffRepo.setTimezone(db, guildId, interaction.user.id, timezone, interaction.user.id);
      const staff = staffRepo.getStaff(db, guildId, interaction.user.id);
      if (missingProfileFields(staff).length === 0) staffRepo.markOnboarded(db, guildId, staff.user_id);

      await interaction.reply(priv(
        `✅ Timezone set to \`${timezone}\`. Your local time is **${formatDateTimeInZone(timezone)}**.`
      ));
      refreshBoardsInBackground(interaction, db);
      return;
    }

    if (sub === 'availability') {
      const status = interaction.options.getString('status', true);
      const untilText = interaction.options.getString('until');
      const note = interaction.options.getString('note');

      const staff = syncFromDiscord(db, interaction, departments);
      let awayUntil = null;

      if (status === staffRepo.AVAILABILITY.AWAY && untilText) {
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

      staffRepo.setAvailability(db, guildId, interaction.user.id, status, {
        awayUntil,
        note,
        actorUserId: interaction.user.id,
      });

      const label = staffRepo.AVAILABILITY_LABELS[status];
      await interaction.reply(priv(
        `✅ Availability set to **${label}**.${awayUntil ? ` Back on <t:${Math.floor(awayUntil / 1000)}:D>.` : ''}\n` +
        'Your group leader keeps your current tasks — nothing is cancelled or reassigned automatically.'
      ));
      refreshBoardsInBackground(interaction, db);
      return;
    }

    if (sub === 'assign') {
      assertCan(actor, CAPABILITIES.STAFF_MANAGE);

      const target = interaction.options.getUser('member', true);
      const key = interaction.options.getString('department', true);
      const department = configRepo.getDepartmentByKey(db, guildId, key);
      if (!department) {
        await interaction.reply(priv(`❌ No department with key \`${key}\`.`));
        return;
      }

      staffRepo.ensureStaff(db, guildId, target.id, target.displayName || target.username);
      staffRepo.updateStaff(db, guildId, target.id, { department_id: department.id }, interaction.user.id);

      await interaction.reply(priv(`✅ <@${target.id}> is now in **${department.name}**.`));
      refreshBoardsInBackground(interaction, db);
    }
  },
};
