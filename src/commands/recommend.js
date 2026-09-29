const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const configRepo = require('../db/repos/config');
const onboardingRepo = require('../db/repos/onboarding');
const { contextFor } = require('../services/actor');
const { notifyUser } = require('../services/notify');
const { CAPABILITIES, can, assertCan, PermissionError } = require('../domain/permissions');
const { discordTimestamp } = require('../utils/time');
const { priv } = require('../utils/reply');

/**
 * A leader putting somebody forward.
 *
 * It is a recommendation and nothing more. The bot does not grant Discord
 * roles: whoever the studio allows to hand out roles does that in Discord, and
 * this only records who asked, why, and what was decided.
 */
module.exports = {
  data: new SlashCommandBuilder()
    .setName('recommend')
    .setDescription('Put somebody forward for a trial, a promotion or a leader role')
    .addSubcommand((sub) =>
      sub
        .setName('new')
        .setDescription('Recommend somebody')
        .addUserOption((opt) => opt.setName('person').setDescription('Who you are recommending').setRequired(true))
        .addStringOption((opt) =>
          opt.setName('kind').setDescription('What for').setRequired(true)
            .addChoices(
              { name: 'A trial', value: 'trial' },
              { name: 'Taking them on / promotion', value: 'promotion' },
              { name: 'A group leader role', value: 'leader' }
            )
        )
        .addStringOption((opt) => opt.setName('note').setDescription('Why — what you have seen of their work').setRequired(true))
        .addStringOption((opt) => opt.setName('department').setDescription('Which department').setRequired(false).setAutocomplete(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('list')
        .setDescription('Recommendations waiting on a decision')
        .addStringOption((opt) =>
          opt.setName('status').setDescription('Which ones').setRequired(false)
            .addChoices(
              { name: 'Pending', value: 'pending' },
              { name: 'Accepted', value: 'accepted' },
              { name: 'Declined', value: 'declined' },
              { name: 'All', value: 'all' }
            )
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('decide')
        .setDescription('Accept or decline a recommendation')
        .addIntegerOption((opt) => opt.setName('id').setDescription('Number from /recommend list').setRequired(true))
        .addStringOption((opt) =>
          opt.setName('decision').setDescription('Your decision').setRequired(true)
            .addChoices({ name: 'Accept', value: 'accept' }, { name: 'Decline', value: 'decline' })
        )
        .addStringOption((opt) => opt.setName('note').setDescription('A note for the leader who recommended them').setRequired(false))
    ),

  async autocomplete(interaction) {
    const { db, guildId } = contextFor(interaction);
    await interaction.respond(configRepo.listDepartments(db, guildId).slice(0, 25)
      .map((dept) => ({ name: dept.name.slice(0, 100), value: String(dept.id) })));
  },

  async execute(interaction) {
    const { db, guildId, config, actor } = contextFor(interaction);
    const sub = interaction.options.getSubcommand();
    const userId = interaction.user.id;

    if (sub === 'new') {
      // Anybody who runs a department may recommend. Whether that changes
      // anything is somebody else's decision, which is the point.
      if (!actor.isOwner && actor.leadDepartmentIds.length === 0 && !can(actor, CAPABILITIES.STAFF_MANAGE)) {
        throw new PermissionError(CAPABILITIES.STAFF_MANAGE, 'Only group leaders and managers can recommend somebody.');
      }

      const person = interaction.options.getUser('person', true);
      if (person.id === userId) {
        await interaction.reply(priv('❌ You cannot recommend yourself.'));
        return;
      }

      const departmentRaw = interaction.options.getString('department');
      const recommendation = onboardingRepo.createRecommendation(db, guildId, {
        subjectUserId: person.id,
        kind: interaction.options.getString('kind', true),
        departmentId: departmentRaw ? Number(departmentRaw) : null,
        note: interaction.options.getString('note', true),
      }, userId);

      await interaction.reply(priv(
        `✅ Recorded as recommendation **#${recommendation.id}**.\n` +
        '_A recommendation only. Roles are handed out in Discord by whoever the studio allows._'
      ));

      if (config?.owner_user_id && config.owner_user_id !== userId) {
        await notifyUser(interaction.client, db, guildId, config.owner_user_id, {
          content:
            `👤 <@${userId}> recommends <@${person.id}> for **${recommendation.kind}**.\n` +
            `> ${recommendation.note.slice(0, 800)}\n` +
            `Decide with \`/recommend decide id:${recommendation.id} decision:...\`.`,
        }).catch(() => null);
      }
      return;
    }

    assertCan(actor, CAPABILITIES.STAFF_MANAGE);

    if (sub === 'list') {
      const status = interaction.options.getString('status') || 'pending';
      const rows = onboardingRepo.listRecommendations(db, guildId, { status });

      await interaction.reply(priv({
        embeds: [new EmbedBuilder()
          .setTitle('Recommendations')
          .setColor(0x5865f2)
          .setDescription(rows.map((row) =>
            `**#${row.id}** <@${row.subject_user_id}> for **${row.kind}** — by <@${row.recommended_by}> ${discordTimestamp(row.created_at, 'R')}\n` +
            `┗ ${row.note.slice(0, 200)}${row.status !== 'pending' ? ` · _${row.status}_` : ''}`
          ).join('\n').slice(0, 4000) || '_Nothing here._')],
      }));
      return;
    }

    if (sub === 'decide') {
      const id = interaction.options.getInteger('id', true);
      const accept = interaction.options.getString('decision', true) === 'accept';
      const note = interaction.options.getString('note');

      const decided = onboardingRepo.decideRecommendation(db, guildId, id, { accept, actorUserId: userId, note });
      if (!decided) {
        await interaction.reply(priv(`❌ Recommendation #${id} is not pending — it may already have been decided.`));
        return;
      }

      await interaction.reply(priv(
        `✅ Recommendation **#${decided.id}** ${accept ? 'accepted' : 'declined'}.` +
        `${accept
          ? `\n${decided.kind === 'trial'
            ? `Next: send them a brief with \`/trial offer person:@them\`.`
            : 'Next: give them the Discord role yourself — the bot does not grant roles.'}`
          : ''}`
      ));

      await notifyUser(interaction.client, db, guildId, decided.recommended_by, {
        content:
          `Your recommendation of <@${decided.subject_user_id}> was ${accept ? '**accepted**' : 'declined'}.` +
          `${note ? `\n> ${note.slice(0, 800)}` : ''}`,
      }).catch(() => null);
    }
  },
};
