const { SlashCommandBuilder } = require('discord.js');
const configRepo = require('../db/repos/config');
const staffRepo = require('../db/repos/staff');
const { contextFor } = require('../services/actor');
const desks = require('../services/desks');
const { buildProfileComponents } = require('../services/profileView');
const { CAPABILITIES, assertCan, can } = require('../domain/permissions');
const { priv } = require('../utils/reply');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('desk')
    .setDescription('Your work in one place')
    .addSubcommand((sub) => sub.setName('me').setDescription('Your offers, assignments, deadlines and pay'))
    .addSubcommand((sub) =>
      sub
        .setName('group')
        .setDescription('Your department: queue, capacity, reviews and risks')
        .addStringOption((opt) => opt.setName('department').setDescription('Which department').setRequired(false).setAutocomplete(true))
    )
    .addSubcommand((sub) => sub.setName('owner').setDescription('Everything waiting on the studio owner')),

  async autocomplete(interaction) {
    const { db, guildId } = contextFor(interaction);
    const query = String(interaction.options.getFocused() || '').toLowerCase();
    const matches = configRepo.listDepartments(db, guildId)
      .filter((dept) => dept.key.includes(query) || dept.name.toLowerCase().includes(query))
      .slice(0, 25);
    await interaction.respond(matches.map((dept) => ({ name: dept.name, value: dept.key })));
  },

  async execute(interaction) {
    const { db, guildId, actor, departments } = contextFor(interaction);
    const sub = interaction.options.getSubcommand();
    const userId = interaction.user.id;

    if (sub === 'me') {
      const staff = staffRepo.ensureStaff(db, guildId, userId, interaction.member?.displayName || interaction.user.username);
      const desk = desks.buildMyDesk(db, guildId, userId);

      await interaction.reply(priv({
        embeds: [desk.embed],
        // The same controls as the profile panel, so availability and timezone
        // are one click away rather than another command.
        components: buildProfileComponents(staff),
      }));
      return;
    }

    if (sub === 'group') {
      const key = interaction.options.getString('department');
      let department = null;

      if (key) {
        department = configRepo.getDepartmentByKey(db, guildId, key);
        if (!department) {
          await interaction.reply(priv('❌ No department with that key.'));
          return;
        }
      } else if (actor.leadDepartmentIds.length > 0) {
        department = departments.find((dept) => dept.id === actor.leadDepartmentIds[0]) || null;
      } else if (actor.isOwner) {
        department = departments[0] || null;
      }

      if (!department) {
        await interaction.reply(priv(
          'You do not lead a department. Name one explicitly if you need to look: `/desk group department:<name>`.'
        ));
        return;
      }

      // Seeing a department's queue and capacity is the leader's job, so it is
      // gated on the same right as handing work out in it.
      assertCan(actor, CAPABILITIES.TASK_OFFER, { departmentId: department.id });

      const desk = desks.buildGroupDesk(db, guildId, department);
      await interaction.reply(priv({ embeds: [desk.embed] }));
      return;
    }

    if (sub === 'owner') {
      assertCan(actor, CAPABILITIES.SUMMARY_VIEW);
      const desk = desks.buildOwnerDesk(db, guildId);
      await interaction.reply(priv({ embeds: [desk.embed] }));
    }
  },
};
