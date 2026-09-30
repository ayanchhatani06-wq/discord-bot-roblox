const { SlashCommandBuilder } = require('discord.js');
const configRepo = require('../db/repos/config');
const staffRepo = require('../db/repos/staff');
const webRepo = require('../db/repos/web');
const { contextFor } = require('../services/actor');
const desks = require('../services/desks');
const { buildProfileComponents } = require('../services/profileView');
const { CAPABILITIES, assertCan, can } = require('../domain/permissions');
const { discordTimestamp } = require('../utils/time');
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
    .addSubcommand((sub) => sub.setName('owner').setDescription('Everything waiting on the studio owner'))
    .addSubcommand((sub) =>
      sub.setName('web-link').setDescription('A one-time link to open your desk in a browser')
    ),

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

    if (sub === 'web-link') {
      // Only ever for the caller. There is no option to make a link for
      // somebody else, because a link is a signed-in session and handing one
      // over would be handing over their account.
      const { randomToken, hashToken } = require('../../web/lib/http');
      const token = randomToken();

      const issued = webRepo.issueLoginToken(db, guildId, {
        staffUserId: userId,
        tokenHash: hashToken(token),
        issuedBy: userId,
      });

      const base = (process.env.WEB_APP_URL || '').replace(/\/$/, '');
      await interaction.reply(priv(
        `${base
          ? `🔗 Open your desk in a browser:\n\`\`\`\n${base}/staff/enter?token=${token}\n\`\`\``
          : `🔗 Your one-time token:\n\`\`\`\n${token}\n\`\`\`\n` +
            '_No `WEB_APP_URL` is configured, so I cannot build the full address. ' +
            'Put it after `/staff/enter?token=` on whatever address the site runs at._'}\n` +
        `It works **once** and expires ${discordTimestamp(issued.expires_at, 'R')}.\n` +
        'The web view is **read-only** — it shows your work but changes nothing. ' +
        'Anybody holding this link is signed in as you, so do not pass it on.'
      ));
      return;
    }

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
