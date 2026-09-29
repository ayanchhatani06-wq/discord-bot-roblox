const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const clientsRepo = require('../db/repos/clients');
const configRepo = require('../db/repos/config');
const { contextFor } = require('../services/actor');
const { CAPABILITIES, can } = require('../domain/permissions');
const { priv } = require('../utils/reply');

/**
 * Help is filtered by what the caller can actually do.
 *
 * Showing somebody a command they will be refused is worse than not showing it:
 * it invites them to try, fail, and assume the bot is broken.
 */
const SECTIONS = [
  {
    title: 'Your work',
    applies: () => true,
    lines: [
      ['`/desk me`', 'Everything of yours: offers, assignments, deadlines, pay'],
      ['`/profile me`', 'Timezone, specialties, working hours, availability'],
      ['`/work progress`', 'Post an update on a task you hold'],
      ['`/work submit`', 'Submit finished work for review'],
      ['`/work earnings`', 'Your own pay and payment history'],
      ['`/bonus mine`', 'Your progress towards milestone bonuses'],
      ['`/procedure list`', "Studio procedures, and which you still owe"],
      ['`/trial mine`', 'Your trial briefs, if you are on trial'],
      ['`/time member`', "Someone's current local time"],
      ['`/escalate raise`', 'Raise a concern privately with the owner'],
    ],
  },
  {
    title: 'Running your department',
    applies: (actor) => actor.isOwner || actor.leadDepartmentIds.length > 0,
    lines: [
      ['`/desk group`', 'Your queue, capacity, reviews and deadline risks'],
      ['`/task queue`', 'Unassigned work, with a button to pick an artist'],
      ['`/task assign`', 'Choose the artist and send the offer'],
      ['`/task pay`', 'Propose a figure for the owner to approve'],
      ['`/contrib add`', 'Put a second person on a task, with their own pay'],
      ['`/contrib list`', 'Who is on a task and what each is owed'],
      ['`/review queue`', 'Work waiting on your internal review'],
      ['`/review decide`', 'Request changes, or pass it for the client'],
      ['`/manage reassign`', 'Move work, keeping the original record'],
      ['`/recommend new`', 'Put somebody forward for a trial or promotion'],
    ],
  },
  {
    title: 'Projects and clients',
    applies: (actor) => can(actor, CAPABILITIES.PROJECT_CREATE) || can(actor, CAPABILITIES.PROJECT_EDIT),
    lines: [
      ['`/project create`', 'Start a project'],
      ['`/project bulk`', '"12 models, 4 vfx" becomes routed tasks'],
      ['`/clients create`', 'A client record with authorized accounts'],
      ['`/clients dashboard`', 'Post their dashboard in their channel'],
      ['`/clients preview`', 'See exactly what a client can see'],
      ['`/clients requirements`', 'What this client always asks for'],
      ['`/repeat from`', 'Start a repeat order from a past one'],
      ['`/enquiry new`', 'Record an enquiry that came in elsewhere'],
      ['`/enquiry draft-quote`', 'Draft a quote from your templates'],
      ['`/issues list`', 'Problems clients have reported'],
      ['`/deliver release`', 'Authorize release of finished work'],
      ['`/archive search`', 'Find past files and check portfolio permission'],
    ],
  },
  {
    title: 'Owner only',
    applies: (actor) => actor.isOwner || can(actor, CAPABILITIES.TASK_PAY_APPROVE),
    lines: [
      ['`/desk owner`', 'Everything waiting on a decision from you'],
      ['`/task approve-pay`', 'Approve what an artist is paid'],
      ['`/enquiry approve-quote`', 'Approve a price before it is sent'],
      ['`/review client`', "Record the client's decision"],
      ['`/finance client-receipt`', 'Record money received'],
      ['`/finance pay`', 'Record a payout'],
      ['`/finance ledger`', 'Money in and out, per currency'],
      ['`/finance budget`', 'Committed pay against what the client pays'],
      ['`/contrib pay`', "Set one contributor's pay on a shared task"],
      ['`/bonus pending`', 'Milestones reached and waiting on you'],
      ['`/manage flags`', 'Scope and compensation decisions'],
      ['`/escalate list`', 'Staff concerns raised privately'],
      ['`/trial offer`', 'Send a paid trial brief with written terms'],
      ['`/trial decide`', 'Pass or fail a submitted trial, with feedback'],
      ['`/recommend list`', 'Recommendations waiting on you'],
      ['`/people stand-in grant`', 'Cover for a leader, expiring on a date'],
      ['`/people offboard preview`', 'What somebody would leave behind'],
      ['`/procedure set`', 'Write a procedure everyone must acknowledge'],
      ['`/outreach templates`', 'Client message wording, and what is approved'],
      ['`/outreach replies`', 'Clients waiting on an answer from a person'],
      ['`/outreach queue`', 'Messages waiting to send, held back or failed'],
      ['`/studio setup`', 'Configuration and the setup checklist'],
      ['`/summary now`', 'The management digest'],
    ],
  },
];

module.exports = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('What you can do with this bot'),

  async execute(interaction) {
    const { db, guildId, actor } = contextFor(interaction);
    const config = configRepo.getConfig(db, guildId);

    // Someone who is only a client account gets the client answer, not a staff
    // command list they cannot use.
    const clientProjects = clientsRepo.listProjectsForAccount(db, guildId, interaction.user.id);
    const isStaff = actor.isOwner || actor.capabilities.size > 0 || actor.leadDepartmentIds.length > 0;

    if (clientProjects.length > 0 && !isStaff) {
      await interaction.reply(priv({
        embeds: [new EmbedBuilder()
          .setTitle('Your orders')
          .setColor(0x1abc9c)
          .setDescription(
            'Everything you need is on your order dashboard — progress, previews, approvals, ' +
            'questions and requests.\n\n' +
            clientProjects.map((project) =>
              `**${project.name}**${project.client_channel_id ? ` — in <#${project.client_channel_id}>` : ''}`
            ).join('\n')
          )
          .setFooter({ text: 'If you cannot find the dashboard, ask the studio to repost it.' })],
      }));
      return;
    }

    const visible = SECTIONS.filter((section) => section.applies(actor));
    const embed = new EmbedBuilder()
      .setTitle('What you can do')
      .setColor(0x5865f2)
      .setDescription(
        actor.isOwner
          ? 'You are the studio owner, so everything is available to you.'
          : actor.leadDepartmentIds.length > 0
            ? 'Listed for your role. Department commands work in the departments you lead.'
            : 'Listed for your role. Ask the owner if you need access to more.'
      );

    for (const section of visible) {
      embed.addFields({
        name: section.title,
        value: section.lines.map(([command, description]) => `${command} — ${description}`).join('\n').slice(0, 1024),
        inline: false,
      });
    }

    if (!config?.setup_completed_at) {
      embed.addFields({
        name: '⚠️ Not set up yet',
        value: 'The studio owner should run `/studio setup` first.',
        inline: false,
      });
    }

    embed.setFooter({ text: 'Commands you cannot use are not listed. Start with /desk me.' });
    await interaction.reply(priv({ embeds: [embed] }));
  },
};
