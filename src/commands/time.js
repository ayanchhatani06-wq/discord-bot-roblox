const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const staffRepo = require('../db/repos/staff');
const configRepo = require('../db/repos/config');
const { contextFor } = require('../services/actor');
const { departmentTimeLines } = require('../services/staffBoard');
const {
  formatDateTimeInZone,
  formatOffsetLabel,
  getOffsetMinutes,
  discordTimestamp,
  isWithinWorkingHours,
  isWithinQuietHours,
} = require('../utils/time');
const { priv } = require('../utils/reply');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('time')
    .setDescription("Local times for staff, using each person's own timezone")
    .addSubcommand((sub) =>
      sub
        .setName('member')
        .setDescription("Show a staff member's current local date and time")
        .addUserOption((opt) => opt.setName('member').setDescription('Whose local time to show').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('department')
        .setDescription('Show local times across a department')
        .addStringOption((opt) =>
          opt.setName('department').setDescription('Which department (defaults to yours)').setRequired(false).setAutocomplete(true)
        )
    ),

  async autocomplete(interaction) {
    const { db, guildId } = contextFor(interaction);
    const query = String(interaction.options.getFocused() || '').toLowerCase();
    const matches = configRepo
      .listDepartments(db, guildId)
      .filter((dept) => dept.key.includes(query) || dept.name.toLowerCase().includes(query))
      .slice(0, 25);
    await interaction.respond(matches.map((dept) => ({ name: dept.name, value: dept.key })));
  },

  async execute(interaction) {
    const { db, guildId } = contextFor(interaction);
    const sub = interaction.options.getSubcommand();

    if (sub === 'member') {
      const target = interaction.options.getUser('member', true);
      const staff = staffRepo.getStaff(db, guildId, target.id);

      if (!staff?.timezone) {
        await interaction.reply(priv(
          `<@${target.id}> has not set a timezone yet. They can set one with \`/profile timezone\`.`
        ));
        return;
      }

      const now = new Date();
      const offset = getOffsetMinutes(staff.timezone, now);
      const working = isWithinWorkingHours({
        at: now,
        timeZone: staff.timezone,
        workingDays: staff.working_days,
        workingStartMinute: staff.working_start_minute,
        workingEndMinute: staff.working_end_minute,
      });
      const quiet = isWithinQuietHours({
        at: now,
        timeZone: staff.timezone,
        quietStartMinute: staff.quiet_start_minute,
        quietEndMinute: staff.quiet_end_minute,
      });

      const notes = [
        `${staffRepo.AVAILABILITY_EMOJI[staff.availability]} ${staffRepo.AVAILABILITY_LABELS[staff.availability]}`,
      ];
      if (working === true) notes.push('within usual hours');
      if (working === false) notes.push('outside usual hours');
      if (quiet) notes.push('in quiet hours');

      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setDescription(
          `🕐 <@${target.id}> — **${formatDateTimeInZone(staff.timezone, now)}**\n` +
          `\`${staff.timezone}\` (${formatOffsetLabel(offset)})\n` +
          `${notes.join(' · ')}`
        );

      await interaction.reply(priv({ embeds: [embed] }));
      return;
    }

    const key = interaction.options.getString('department');
    const departments = configRepo.listDepartments(db, guildId);
    let department = null;

    if (key) {
      department = departments.find((dept) => dept.key === key) || null;
      if (!department) {
        await interaction.reply(priv(`❌ No department with key \`${key}\`.`));
        return;
      }
    } else {
      const self = staffRepo.getStaff(db, guildId, interaction.user.id);
      department = self?.department_id ? departments.find((dept) => dept.id === self.department_id) || null : null;
      if (!department) {
        await interaction.reply(priv(
          'You are not in a department yet, so name one: `/time department department:<name>`.'
        ));
        return;
      }
    }

    const staffRows = staffRepo.listStaff(db, guildId, { departmentId: department.id });
    if (staffRows.length === 0) {
      await interaction.reply(priv(`No staff are filed under **${department.name}** yet.`));
      return;
    }

    const now = new Date();
    const lines = departmentTimeLines(staffRows, { now });
    const embed = new EmbedBuilder()
      .setTitle(`${department.name} — local times`)
      .setColor(0x5865f2)
      .setDescription(lines.join('\n').slice(0, 4000))
      .addFields({ name: 'Updated', value: discordTimestamp(now.getTime(), 'T'), inline: true })
      .setFooter({ text: 'Sorted west to east. Availability is self-declared, not Discord presence.' });

    await interaction.reply(priv({ embeds: [embed] }));
  },
};
