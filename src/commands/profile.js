const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const staffRepo = require('../db/repos/staff');
const configRepo = require('../db/repos/config');
const { contextFor, departmentFromRoles, roleIdsOf } = require('../services/actor');
const { buildProfileEmbed, buildProfileComponents, missingProfileFields } = require('../services/profileView');
const { refreshGuildBoards } = require('../services/staffBoard');
const { notifyLeadersOfAbsence } = require('../services/absence');
const { CAPABILITIES, assertCan } = require('../domain/permissions');
const { isValidTimezone, searchTimezones, formatDateTimeInZone, parseDeadlineInput } = require('../utils/time');
const portfolioImages = require('../services/portfolioImages');
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
    .addSubcommandGroup((group) =>
      group
        .setName('portfolio')
        .setDescription('Pictures of your work, kept on the studio server')
        .addSubcommand((sub) =>
          sub
            .setName('add')
            .setDescription('Add a picture of your work')
            .addAttachmentOption((opt) =>
              opt.setName('image').setDescription('PNG, JPEG, GIF or WebP').setRequired(true)
            )
            .addStringOption((opt) =>
              opt.setName('caption').setDescription('What it is').setRequired(false).setMaxLength(120)
            )
        )
        .addSubcommand((sub) =>
          sub
            .setName('list')
            .setDescription('Your pictures, with their numbers')
        )
        .addSubcommand((sub) =>
          sub
            .setName('remove')
            .setDescription('Remove one of your pictures')
            .addIntegerOption((opt) =>
              opt.setName('id').setDescription('The number from /profile portfolio list').setRequired(true)
            )
        )
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

    if (interaction.options.getSubcommandGroup(false) === 'portfolio') {
      const userId = interaction.user.id;

      if (sub === 'list') {
        const images = portfolioImages.listFor(db, guildId, userId);
        await interaction.reply(priv(
          images.length === 0
            ? 'You have no pictures yet. Add one with `/profile portfolio add`.'
            : `**Your portfolio** — ${images.length} of ${portfolioImages.MAX_PER_PERSON}\n` +
              images.map((image) =>
                `**#${image.id}** ${image.caption || image.filename} · ${Math.round(image.bytes / 1024)} KB`
              ).join('\n') +
              '\n\n_Remove one with `/profile portfolio remove id:`._'
        ));
        return;
      }

      if (sub === 'remove') {
        // Scoped to this user, so one person cannot clear another's portfolio.
        const result = portfolioImages.remove(db, guildId, interaction.options.getInteger('id', true), userId);
        await interaction.reply(priv(result.ok
          ? `🗑️ Removed **${result.image.caption || result.image.filename}**.`
          : '❌ No picture of yours with that number. Check `/profile portfolio list`.'));
        return;
      }

      const attachment = interaction.options.getAttachment('image', true);
      await interaction.deferReply({ flags: priv('').flags });

      const response = await fetch(attachment.url).catch(() => null);
      if (!response?.ok) {
        await interaction.editReply('❌ Could not read that file from Discord. Try uploading it again.');
        return;
      }

      const result = portfolioImages.add(db, guildId, userId, {
        buffer: Buffer.from(await response.arrayBuffer()),
        filename: attachment.name,
        contentType: attachment.contentType,
        caption: interaction.options.getString('caption'),
      }, userId);

      if (!result.ok) {
        const says = {
          empty: 'That file was empty.',
          too_large: `Too big. The limit is ${portfolioImages.MAX_BYTES / 1024 / 1024} MB — crop it or export it smaller.`,
          too_many: `You already have ${portfolioImages.MAX_PER_PERSON} pictures. Remove one first with \`/profile portfolio remove\`.`,
          unsupported_type: 'Pictures only — PNG, JPEG, GIF or WebP.',
        };
        await interaction.editReply(`❌ ${says[result.reason] || 'That file could not be saved.'}`);
        return;
      }

      refreshGuildBoards(interaction.client, db, guildId).catch(() => {});

      await interaction.editReply(
        result.created
          ? `✅ Added **${result.image.caption || result.image.filename}** — picture ${portfolioImages.countFor(db, guildId, userId)} of ${portfolioImages.MAX_PER_PERSON}.\n` +
            '_Kept on the studio server, so it stays up even when the Discord link expires._'
          : 'That picture is already in your portfolio. One copy, not two.'
      );
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
        files: portfolioImages.listFor(db, guildId, staff.user_id)
          .map((image) => {
            const file = portfolioImages.read(db, guildId, image.id);
            return file?.buffer ? new AttachmentBuilder(file.buffer, { name: image.filename }) : null;
          })
          .filter(Boolean),
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
      let absence = { notified: [], activeCount: 0 };
      if (status === staffRepo.AVAILABILITY.AWAY) {
        absence = await notifyLeadersOfAbsence(interaction.client, db, guildId, interaction.user.id, { awayUntil, note });
      }

      await interaction.reply(priv([
        `✅ Availability set to **${label}**.${awayUntil ? ` Back on <t:${Math.floor(awayUntil / 1000)}:D>.` : ''}`,
        absence.activeCount > 0
          ? `You are still holding ${absence.activeCount} task(s); ${absence.notified.length} leader(s) have been told.`
          : null,
        'Nothing is cancelled or reassigned automatically — your leader decides what happens to your work.',
      ].filter((line) => line !== null).join('\n')));
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
