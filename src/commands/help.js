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
      ['`/go`', '**Start here.** What is waiting on you right now'],
      ['`/find`', 'Search everything at once when you only half-remember it'],
      ['`/go`', 'Everything of yours: offers, assignments, deadlines, pay'],
      ['`/desk web-link`', 'Open your desk in a browser (read-only)'],
      ['`/profile me`', 'Timezone, specialties, working hours, availability'],
      ['`/my-work progress`', 'Post an update on a task you hold'],
      ['`/my-work submit`', 'Submit finished work for review'],
      ['`/my-work earnings`', 'Your own pay and payment history'],
      ['`/bonuses mine`', 'Your progress towards milestone bonuses'],
      ['`/staff-rules list`', "Studio procedures, and which you still owe"],
      ['`/team trial mine`', 'Your trial briefs, if you are on trial'],
      ['`/time member`', "Someone's current local time"],
      ['`/concern raise`', 'Raise a concern privately with the owner'],
    ],
  },
  {
    title: 'Running your department',
    applies: (actor) => actor.isOwner || actor.leadDepartmentIds.length > 0,
    lines: [
      ['`/go`', 'Your queue, capacity, reviews and deadline risks'],
      ['`/who-is-free`', 'Who has room for more work over the next week'],
      ['`/task queue`', 'Unassigned work, with a button to pick an artist'],
      ['`/task assign`', 'Choose the artist and send the offer'],
      ['`/task pay`', 'Propose a figure for the owner to approve'],
      ['`/task helpers add`', 'Put a second person on a task, with their own pay'],
      ['`/task helpers list`', 'Who is on a task and what each is owed'],
      ['`/review queue`', 'Work waiting on your internal review'],
      ['`/review decide`', 'Request changes, or pass it for the client'],
      ['`/change reassign`', 'Move work, keeping the original record'],
      ['`/team recommend new`', 'Put somebody forward for a trial or promotion'],
    ],
  },
  {
    title: 'Projects and clients',
    applies: (actor) => can(actor, CAPABILITIES.PROJECT_CREATE) || can(actor, CAPABILITIES.PROJECT_EDIT),
    lines: [
      ['`/orders create`', 'Start a project'],
      ['`/orders bulk`', '"12 models, 4 vfx" becomes routed tasks'],
      ['`/clients create`', 'A client record with authorized accounts'],
      ['`/clients dashboard`', 'Post their dashboard in their channel'],
      ['`/clients preview`', 'See exactly what a client can see'],
      ['`/clients requirements`', 'What this client always asks for'],
      ['`/reorder from`', 'Start a repeat order from a past one'],
      ['`/quotes new`', 'Record an enquiry that came in elsewhere'],
      ['`/quotes draft-quote`', 'Draft a quote from your templates'],
      ['`/problems list`', 'Problems clients have reported'],
      ['`/send release`', 'Authorize release of finished work'],
      ['`/files search`', 'Find past files and check portfolio permission'],
      ['`/files roblox-id`', 'Record the Roblox asset ID a file was uploaded as'],
      ['`/proof add`', 'Keep a screenshot as proof — the file itself, not a link'],
      ['`/proof record`', 'The whole record of an order, for a dispute'],
    ],
  },
  {
    title: 'Owner only',
    applies: (actor) => actor.isOwner || can(actor, CAPABILITIES.TASK_PAY_APPROVE),
    lines: [
      ['`/go`', 'Everything waiting on a decision from you'],
      ['`/task approve-pay`', 'Approve what an artist is paid'],
      ['`/quotes approve-quote`', 'Approve a price before it is sent'],
      ['`/review client`', "Record the client's decision"],
      ['`/pay client-receipt`', 'Record money received'],
      ['`/pay pay`', 'Record a payout'],
      ['`/pay ledger`', 'Money in and out, per currency'],
      ['`/pay budget`', 'Committed pay against what the client pays'],
      ['`/pay approve-all`', 'Approve every pay figure your leaders proposed'],
      ['`/pay sent`', 'Payments sent that nobody has confirmed arrived'],
      ['`/pay confirm-received`', 'They say the money actually reached them'],
      ['`/pay mark-failed`', 'It was sent and never arrived — they are owed again'],
      ['`/money-in add`', 'Split what a client owes into named parts'],
      ['`/money-in list`', 'Which parts are covered, and what is still to come'],
      ['`/task helpers pay`', "Set one contributor's pay on a shared task"],
      ['`/bonuses pending`', 'Milestones reached and waiting on you'],
      ['`/change flags`', 'Scope and compensation decisions'],
      ['`/concern list`', 'Staff concerns raised privately'],
      ['`/team trial offer`', 'Send a paid trial brief with written terms'],
      ['`/team trial decide`', 'Pass or fail a submitted trial, with feedback'],
      ['`/team recommend list`', 'Recommendations waiting on you'],
      ['`/team stand-in grant`', 'Cover for a leader, expiring on a date'],
      ['`/team offboard preview`', 'What somebody would leave behind'],
      ['`/staff-rules set`', 'Write a procedure everyone must acknowledge'],
      ['`/messages templates`', 'Client message wording, and what is approved'],
      ['`/messages replies`', 'Clients waiting on an answer from a person'],
      ['`/messages queue`', 'Messages waiting to send, held back or failed'],
      ['`/reports overview`', 'How many tasks match each filter right now'],
      ['`/reports waiting`', 'Whether an order is waiting on us or on the client'],
      ['`/setup auto list`', 'Rules that watch for something and tell somebody'],
      ['`/setup backup now`', 'Take a copy you can actually restore from'],
      ['`/setup doctor`', 'What is quietly misconfigured or stuck'],
      ['`/setup setup`', 'Configuration and the setup checklist'],
      ['`/reports now`', 'The management digest'],
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
        value: 'The studio owner should run `/setup setup` first.',
        inline: false,
      });
    }

    embed.setFooter({ text: 'Commands you cannot use are not listed. Start with /go.' });
    await interaction.reply(priv({ embeds: [embed] }));
  },
};
