const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const configRepo = require('../db/repos/config');
const staffRepo = require('../db/repos/staff');
const onboardingRepo = require('../db/repos/onboarding');
const { contextFor } = require('../services/actor');
const { CAPABILITIES, assertCan } = require('../domain/permissions');
const { customId } = require('../interactions/router');
const { discordTimestamp } = require('../utils/time');
const { priv } = require('../utils/reply');

/**
 * Studio procedures and who has acknowledged which version of them.
 *
 * Acknowledgement is bound to a version on purpose. Editing a procedure makes
 * every earlier acknowledgement stale, because agreeing to the old text is not
 * agreeing to the new one — and a record that pretends otherwise is worse than
 * no record at all.
 */

function contextForMember(db, guildId, userId, departments, actor) {
  const staff = staffRepo.getStaff(db, guildId, userId);
  return {
    departmentId: staff?.department_id ?? null,
    isLeader: actor.leadDepartmentIds.length > 0,
  };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('staff-rules')
    .setDescription('Studio procedures and acknowledgements')
    .addSubcommand((sub) => sub.setName('list').setDescription('Procedures that apply to you, and which you still owe'))
    .addSubcommand((sub) =>
      sub
        .setName('read')
        .setDescription('Read one, with a button to acknowledge it')
        .addStringOption((opt) => opt.setName('key').setDescription('Which procedure').setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('set')
        .setDescription('Create a procedure, or replace its text')
        .addStringOption((opt) => opt.setName('key').setDescription('Short id, e.g. file-naming').setRequired(true))
        .addStringOption((opt) => opt.setName('title').setDescription('Its title').setRequired(true))
        .addStringOption((opt) => opt.setName('body').setDescription('The text itself').setRequired(true))
        .addStringOption((opt) =>
          opt.setName('audience').setDescription('Who it applies to').setRequired(false)
            .addChoices(
              { name: 'Everyone', value: 'all' },
              { name: 'Group leaders', value: 'leaders' },
              { name: 'One department', value: 'department' }
            )
        )
        .addStringOption((opt) => opt.setName('department').setDescription('Which department, if audience is a department').setRequired(false).setAutocomplete(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('retire')
        .setDescription('Stop showing a procedure (its acknowledgements are kept)')
        .addStringOption((opt) => opt.setName('key').setDescription('Which procedure').setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('who')
        .setDescription('Who has acknowledged the current version, and who has not')
        .addStringOption((opt) => opt.setName('key').setDescription('Which procedure').setRequired(true).setAutocomplete(true))
    ),

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);
    const { db, guildId } = contextFor(interaction);

    if (focused.name === 'key') {
      await interaction.respond(onboardingRepo.listProcedures(db, guildId, { activeOnly: false })
        .slice(0, 25)
        .map((procedure) => ({ name: `${procedure.key} · ${procedure.title}`.slice(0, 100), value: procedure.key })));
      return;
    }

    if (focused.name === 'department') {
      await interaction.respond(configRepo.listDepartments(db, guildId).slice(0, 25)
        .map((dept) => ({ name: dept.name.slice(0, 100), value: String(dept.id) })));
    }
  },

  async execute(interaction) {
    const { db, guildId, departments, actor } = contextFor(interaction);
    const sub = interaction.options.getSubcommand();
    const userId = interaction.user.id;

    if (sub === 'list') {
      const context = contextForMember(db, guildId, userId, departments, actor);
      const applicable = onboardingRepo.proceduresFor(db, guildId, context);
      const outstanding = applicable.filter((procedure) => !onboardingRepo.hasAcknowledged(db, procedure, userId));

      const embed = new EmbedBuilder()
        .setTitle('Studio procedures')
        .setColor(outstanding.length > 0 ? 0xfaa61a : 0x57f287)
        .setDescription(applicable.map((procedure) => {
          const done = onboardingRepo.hasAcknowledged(db, procedure, userId);
          return `${done ? '✅' : '⬜'} **${procedure.key}** — ${procedure.title} _(v${procedure.version})_`;
        }).join('\n') || '_No procedures apply to you yet._');

      if (outstanding.length > 0) {
        embed.setFooter({ text: `${outstanding.length} still to read. Open one with /staff-rules read key:<key>` });
      }

      await interaction.reply(priv({ embeds: [embed] }));
      return;
    }

    if (sub === 'read') {
      const procedure = onboardingRepo.getProcedure(db, guildId, interaction.options.getString('key', true));
      if (!procedure) {
        await interaction.reply(priv('❌ No procedure with that key.'));
        return;
      }

      const done = onboardingRepo.hasAcknowledged(db, procedure, userId);
      const embed = new EmbedBuilder()
        .setTitle(`${procedure.title} · v${procedure.version}`)
        .setColor(done ? 0x57f287 : 0x5865f2)
        .setDescription(procedure.body.slice(0, 4000))
        .setFooter({
          text: done
            ? 'You have acknowledged this version.'
            : 'Read it, then acknowledge. A later edit will ask you again.',
        });

      const components = done ? [] : [new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(customId('proc', 'ack', String(procedure.id), String(procedure.version)))
          .setLabel('I have read this')
          .setStyle(ButtonStyle.Success)
      )];

      await interaction.reply(priv({ embeds: [embed], components }));
      return;
    }

    if (sub === 'set') {
      assertCan(actor, CAPABILITIES.CONFIG_MANAGE);

      const audience = interaction.options.getString('audience') || 'all';
      const departmentRaw = interaction.options.getString('department');
      const departmentId = departmentRaw ? Number(departmentRaw) : null;

      if (audience === 'department' && !Number.isInteger(departmentId)) {
        await interaction.reply(priv('❌ Pick the department this applies to.'));
        return;
      }

      const { procedure, versionChanged } = onboardingRepo.upsertProcedure(db, guildId, {
        key: interaction.options.getString('key', true),
        title: interaction.options.getString('title', true),
        body: interaction.options.getString('body', true),
        audience,
        departmentId: audience === 'department' ? departmentId : null,
      }, userId);

      await interaction.reply(priv(
        `✅ **${procedure.key}** — ${procedure.title} (v${procedure.version}).\n` +
        (versionChanged
          ? '⚠️ The text changed, so **everybody must acknowledge it again**. Earlier acknowledgements are kept, but they are for the previous version.'
          : '_Nobody needs to acknowledge anything again._')
      ));
      return;
    }

    if (sub === 'retire') {
      assertCan(actor, CAPABILITIES.CONFIG_MANAGE);
      const procedure = onboardingRepo.setProcedureActive(db, guildId, interaction.options.getString('key', true), false, userId);
      if (!procedure) {
        await interaction.reply(priv('❌ No procedure with that key.'));
        return;
      }
      await interaction.reply(priv(`✅ **${procedure.key}** is retired. Who acknowledged it, and when, is kept.`));
      return;
    }

    if (sub === 'who') {
      assertCan(actor, CAPABILITIES.STAFF_MANAGE);

      const procedure = onboardingRepo.getProcedure(db, guildId, interaction.options.getString('key', true));
      if (!procedure) {
        await interaction.reply(priv('❌ No procedure with that key.'));
        return;
      }

      const current = new Map(
        onboardingRepo.acknowledgementsFor(db, guildId, procedure.id)
          .filter((ack) => ack.version === procedure.version)
          .map((ack) => [ack.user_id, ack])
      );

      // Only people the procedure actually applies to are listed as missing,
      // so a leaders-only rule does not make every artist look delinquent.
      //
      // Leadership is a Discord role, which the bot only sees when somebody
      // interacts with it. What it does hold is who each staff member reports
      // to, so the set of leaders is taken from that.
      const staff = staffRepo.listStaff(db, guildId);
      const leaderIds = new Set(staff.map((member) => member.leader_user_id).filter(Boolean));

      const owed = staff.filter((member) => {
        if (procedure.audience === 'all') return true;
        if (procedure.audience === 'department') return member.department_id === procedure.department_id;
        return leaderIds.has(member.user_id);
      });

      const missing = owed.filter((member) => !current.has(member.user_id));

      await interaction.reply(priv({
        embeds: [new EmbedBuilder()
          .setTitle(`${procedure.title} · v${procedure.version}`)
          .setColor(missing.length > 0 ? 0xfaa61a : 0x57f287)
          .addFields(
            {
              name: `Acknowledged (${current.size})`,
              value: [...current.values()].map((ack) => `<@${ack.user_id}> · ${discordTimestamp(ack.acknowledged_at, 'd')}`)
                .join('\n').slice(0, 1024) || '_nobody yet_',
              inline: false,
            },
            {
              name: `Still to read (${missing.length})`,
              value: missing.map((member) => `<@${member.user_id}>`).join(', ').slice(0, 1024) || '_nobody_',
              inline: false,
            }
          )],
      }));
    }
  },
};
