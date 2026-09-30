const configRepo = require('../db/repos/config');
const staffRepo = require('../db/repos/staff');
const { contextFor } = require('../services/actor');
const desks = require('../services/desks');
const { CAPABILITIES, assertCan } = require('../domain/permissions');
const { register } = require('./router');
const { priv } = require('../utils/reply');

const NAMESPACE = 'go';

/**
 * The buttons under `/go`.
 *
 * They open views, never change anything. A button that acts is a button
 * somebody clicks by accident; every action in this studio stays behind a
 * command that says what it does.
 */
register(NAMESPACE, async (interaction, { action }) => {
  const ctx = contextFor(interaction);
  const { db, guildId, actor, departments } = ctx;
  const userId = interaction.user.id;

  if (action === 'desk') {
    staffRepo.ensureStaff(db, guildId, userId, interaction.member?.displayName || interaction.user.username);
    const desk = desks.buildMyDesk(db, guildId, userId);
    await interaction.reply(priv({ embeds: [desk.embed] }));
    return;
  }

  if (action === 'group') {
    if (actor.leadDepartmentIds.length === 0) {
      await interaction.reply(priv('You do not run a department.'));
      return;
    }

    // Leaders of several departments get the first; the command takes a
    // department option for the rest, and the button says so.
    const department = departments.find((dept) => actor.leadDepartmentIds.includes(dept.id));
    const desk = desks.buildGroupDesk(db, guildId, department);

    await interaction.reply(priv({
      content: actor.leadDepartmentIds.length > 1
        ? `Showing **${department.name}**. For the others: \`/go department:<key>\`.`
        : undefined,
      embeds: [desk.embed],
    }));
    return;
  }

  if (action === 'owner') {
    assertCan(actor, CAPABILITIES.TASK_PAY_APPROVE);
    const desk = desks.buildOwnerDesk(db, guildId);
    await interaction.reply(priv({ embeds: [desk.embed] }));
    return;
  }

  if (action === 'help') {
    const help = require('../commands/help');
    await help.execute(interaction);
    return;
  }

  await interaction.reply(priv('❌ Unknown action.'));
});

module.exports = { NAMESPACE };
