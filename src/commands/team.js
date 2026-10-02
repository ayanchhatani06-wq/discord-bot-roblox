const { CURRENCIES } = require('../domain/money');
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const configRepo = require('../db/repos/config');
const staffRepo = require('../db/repos/staff');
const onboardingRepo = require('../db/repos/onboarding');
const { contextFor } = require('../services/actor');
const profileRoster = require('../services/profileRoster');
const recruiterFee = require('../services/recruiterFee');
const offboarding = require('../services/offboarding');
const { withdrawOffer } = require('../services/offerFlow');
const { notifyUser } = require('../services/notify');
const { CAPABILITIES, assertCan } = require('../domain/permissions');
const { formatTotals } = require('../domain/money');
const { parseDeadlineInput, discordTimestamp } = require('../utils/time');
const { priv } = require('../utils/reply');

const CURRENCY_CHOICES = Object.keys(CURRENCIES).map((code) => ({ name: code, value: code }));

/**
 * Standing in for a leader, and leaving the studio.
 *
 * Both are about people rather than work, which is why they are not on
 * `/change`. Both are also deliberately conservative: a stand-in's powers
 * expire on a stated date without anything having to run, and offboarding
 * reports what somebody leaves behind rather than deleting it.
 */
module.exports = {
  data: new SlashCommandBuilder()
    .setName('team')
    .setDescription('Stand-in leaders, offboarding and who has filled in their profile')
    .addSubcommand((sub) =>
      sub
        .setName('profiles')
        .setDescription('Who has filled in their profile, and what is still missing')
        .addStringOption((opt) =>
          opt.setName('department').setDescription('One department only').setRequired(false).setAutocomplete(true)
        )
        .addBooleanOption((opt) =>
          opt.setName('missing').setDescription('Only show people with something missing').setRequired(false)
        )
    )
    .addSubcommandGroup((group) =>
      group
        .setName('stand-in')
        .setDescription('Somebody covering for a group leader')
        .addSubcommand((sub) =>
          sub
            .setName('grant')
            .setDescription('Let somebody run a department for a stated period')
            .addUserOption((opt) => opt.setName('person').setDescription('Who is covering').setRequired(true))
            .addStringOption((opt) => opt.setName('department').setDescription('Which department').setRequired(true).setAutocomplete(true))
            .addStringOption((opt) => opt.setName('until').setDescription('When it ends, e.g. 2026-10-14 or 2026-10-14 18:00').setRequired(true))
            .addStringOption((opt) => opt.setName('responsibilities').setDescription('What they are covering, in your words').setRequired(true))
            .addStringOption((opt) => opt.setName('from').setDescription('When it starts (default: now)').setRequired(false))
        )
        .addSubcommand((sub) =>
          sub
            .setName('revoke')
            .setDescription('End a stand-in arrangement early')
            .addIntegerOption((opt) => opt.setName('id').setDescription('Number from /team stand-in list').setRequired(true))
        )
        .addSubcommand((sub) =>
          sub
            .setName('list')
            .setDescription('Stand-in arrangements')
            .addBooleanOption((opt) => opt.setName('include-past').setDescription('Include expired and revoked ones').setRequired(false))
        )
    )
    .addSubcommandGroup((group) =>
      group
        .setName('offboard')
        .setDescription('Somebody leaving the studio')
        .addSubcommand((sub) =>
          sub
            .setName('preview')
            .setDescription('What they would leave behind — changes nothing')
            .addUserOption((opt) => opt.setName('person').setDescription('Who is leaving').setRequired(true))
        )
        .addSubcommand((sub) =>
          sub
            .setName('start')
            .setDescription('Record the departure and take them off the boards')
            .addUserOption((opt) => opt.setName('person').setDescription('Who is leaving').setRequired(true))
            .addStringOption((opt) => opt.setName('reason').setDescription('Why, for the record').setRequired(false))
            .addStringOption((opt) => opt.setName('handover').setDescription('Handover notes').setRequired(false))
            .addBooleanOption((opt) => opt.setName('withdraw-offers').setDescription('Also withdraw their unanswered offers (default: yes)').setRequired(false))
        )
        .addSubcommand((sub) =>
          sub
            .setName('complete')
            .setDescription('Mark an offboarding finished once nothing is outstanding')
            .addIntegerOption((opt) => opt.setName('id').setDescription('Number from /team offboard list').setRequired(true))
        )
        .addSubcommand((sub) => sub.setName('list').setDescription('Departures, open ones first'))
    )
    .addSubcommandGroup((group) =>
      group
        .setName('recruited')
        .setDescription('Who brought somebody onto the team, and their one-time introduction fee')
        .addSubcommand((sub) =>
          sub
            .setName('set')
            .setDescription('Record who recruited this person')
            .addUserOption((opt) => opt.setName('person').setDescription('Who joined').setRequired(true))
            .addUserOption((opt) => opt.setName('recruiter').setDescription('Who brought them in').setRequired(true))
        )
        .addSubcommand((sub) =>
          sub
            .setName('clear')
            .setDescription('Remove a recorded recruiter, before any fee is taken')
            .addUserOption((opt) => opt.setName('person').setDescription('Who joined').setRequired(true))
        )
        .addSubcommand((sub) =>
          sub.setName('list').setDescription('Who recruited whom, and whose fee is still to come')
        )
    )
.addSubcommandGroup((group) =>
      group
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
          .addIntegerOption((opt) => opt.setName('id').setDescription('Number from /team recommend list').setRequired(true))
          .addStringOption((opt) =>
            opt.setName('decision').setDescription('Your decision').setRequired(true)
              .addChoices({ name: 'Accept', value: 'accept' }, { name: 'Decline', value: 'decline' })
          )
          .addStringOption((opt) => opt.setName('note').setDescription('A note for the leader who recommended them').setRequired(false))
      )
    )
.addSubcommandGroup((group) =>
      group
        .setName('trial')
        .setDescription('Paid trial briefs, and deciding them')
      .addSubcommand((sub) =>
        sub
          .setName('offer')
          .setDescription('Write a trial brief and send it')
          .addUserOption((opt) => opt.setName('person').setDescription('Who it is for').setRequired(true))
          .addStringOption((opt) => opt.setName('title').setDescription('Short title for the trial piece').setRequired(true))
          .addStringOption((opt) => opt.setName('brief').setDescription('What they are asked to make').setRequired(true))
          .addStringOption((opt) => opt.setName('terms').setDescription('What is paid, what is expected, what happens after').setRequired(true))
          .addStringOption((opt) => opt.setName('department').setDescription('Which department').setRequired(false).setAutocomplete(true))
          .addStringOption((opt) => opt.setName('pay').setDescription('Trial pay (leave empty only if genuinely unpaid)').setRequired(false))
          .addStringOption((opt) => opt.setName('currency').setDescription('Currency').addChoices(...CURRENCY_CHOICES).setRequired(false))
          .addStringOption((opt) => opt.setName('deadline').setDescription('Deadline, in their timezone, e.g. 2026-10-05 18:00').setRequired(false))
      )
      .addSubcommand((sub) =>
        sub
          .setName('submit')
          .setDescription('Submit your trial work')
          .addStringOption((opt) => opt.setName('code').setDescription('Trial code').setRequired(true).setAutocomplete(true))
          .addStringOption((opt) => opt.setName('links').setDescription('Link(s) to your work').setRequired(true))
          .addStringOption((opt) => opt.setName('note').setDescription('Anything you want noted').setRequired(false))
      )
      .addSubcommand((sub) =>
        sub
          .setName('decide')
          .setDescription('Pass or fail a submitted trial, with feedback')
          .addStringOption((opt) => opt.setName('code').setDescription('Trial code').setRequired(true).setAutocomplete(true))
          .addStringOption((opt) =>
            opt.setName('outcome').setDescription('The decision').setRequired(true)
              .addChoices({ name: 'Passed', value: 'passed' }, { name: 'Not this time', value: 'failed' })
          )
          .addStringOption((opt) => opt.setName('feedback').setDescription('Feedback for them — required either way').setRequired(true))
      )
      .addSubcommand((sub) =>
        sub
          .setName('withdraw')
          .setDescription('Withdraw a trial that has not been decided')
          .addStringOption((opt) => opt.setName('code').setDescription('Trial code').setRequired(true).setAutocomplete(true))
          .addStringOption((opt) => opt.setName('reason').setDescription('Why, for the record').setRequired(true))
      )
      .addSubcommand((sub) =>
        sub
          .setName('list')
          .setDescription('Trials, open by default')
          .addStringOption((opt) =>
            opt.setName('status').setDescription('Which ones').setRequired(false)
              .addChoices(
                { name: 'Open', value: 'open' },
                { name: 'Passed', value: 'passed' },
                { name: 'Not passed', value: 'failed' },
                { name: 'All', value: 'all' }
              )
          )
      )
      .addSubcommand((sub) => sub.setName('mine').setDescription('Your own trial briefs'))
    ),

  async autocomplete(interaction) {
    const { db, guildId } = contextFor(interaction);
    await interaction.respond(configRepo.listDepartments(db, guildId).slice(0, 25)
      .map((dept) => ({ name: dept.name.slice(0, 100), value: String(dept.id) })));
  },

  async execute(interaction) {
    if (interaction.options.getSubcommandGroup() === 'trial') {
      return require('./parts/trial').execute(interaction);
    }

    if (interaction.options.getSubcommandGroup() === 'recommend') {
      return require('./parts/recommend').execute(interaction);
    }

    const { db, guildId, departments, actor } = contextFor(interaction);
    const group = interaction.options.getSubcommandGroup();
    const sub = interaction.options.getSubcommand();
    const userId = interaction.user.id;

    // Read-only, so it sits behind the management view rather than behind
    // staff management, which is for changing people rather than reading them.
    // That is owner and manager by default — group leaders do not hold it. A
    // studio that wants its leaders chasing their own department's profiles
    // grants it with /setup capability rather than being given it unasked.
    if (!group && sub === 'profiles') {
      assertCan(actor, CAPABILITIES.SUMMARY_VIEW);

      const departmentId = interaction.options.getString('department');
      const result = profileRoster.roster(db, guildId, {
        departmentId: departmentId ? Number(departmentId) : undefined,
        onlyIncomplete: interaction.options.getBoolean('missing') === true,
      });

      if (result.total === 0) {
        await interaction.reply(priv('Nobody has a staff profile yet. They each start one with `/profile me`.'));
        return;
      }

      const embed = new EmbedBuilder()
        .setTitle('Profiles')
        .setColor(result.blocked > 0 ? 0xed4245 : result.complete === result.total ? 0x57f287 : 0xfaa61a)
        .setDescription(
          `**${result.complete} of ${result.total}** complete.` +
          `${result.blocked > 0
            ? `\n🔴 **${result.blocked}** missing a timezone or a department — their deadlines read wrong and they appear on no board.`
            : ''}` +
          `${result.hidden > 0 ? `\n_${result.hidden} complete profile(s) hidden._` : ''}`
        );

      // Embeds cap at 1024 characters per field, so the roster is split rather
      // than silently truncated at whoever happens to fall on the boundary.
      const lines = result.people.map((person) => profileRoster.describe(person));
      let chunk = [];
      let length = 0;

      for (const line of lines) {
        if (length + line.length > 1000 || chunk.length >= 8) {
          embed.addFields({ name: '\u200b', value: chunk.join('\n\n'), inline: false });
          chunk = [];
          length = 0;
        }
        chunk.push(line);
        length += line.length + 2;
        if (embed.data.fields?.length >= 20) break;
      }
      if (chunk.length > 0 && (embed.data.fields?.length ?? 0) < 25) {
        embed.addFields({ name: '\u200b', value: chunk.join('\n\n'), inline: false });
      }

      embed.setFooter({ text: 'One person in detail: /profile view member: — they fill theirs in with /profile me' });
      await interaction.reply(priv({ embeds: [embed] }));
      return;
    }

    assertCan(actor, CAPABILITIES.STAFF_MANAGE);
    const departmentName = new Map(departments.map((dept) => [dept.id, dept.name]));

    if (group === 'recruited') {
      if (sub === 'set') {
        const person = interaction.options.getUser('person', true);
        const recruiter = interaction.options.getUser('recruiter', true);

        const result = recruiterFee.setRecruiter(db, guildId, {
          userId: person.id, recruiterUserId: recruiter.id, actorUserId: userId,
        });

        if (!result.ok) {
          const reasons = {
            self: '❌ Somebody cannot have recruited themselves.',
            not_staff: `❌ <@${person.id}> is not on the team yet. They appear once they run \`/profile me\`.`,
            already_paid: `❌ <@${person.id}> has already had their first payout, so the introduction fee is ` +
              'settled. Changing this now would either hand it to the wrong person or take it twice.',
          };
          await interaction.reply(priv(reasons[result.reason] || `❌ ${result.reason}`));
          return;
        }

        const bp = recruiterFee.feeBasisPoints(configRepo.getConfig(db, guildId) || {});
        await interaction.reply(priv(
          `✅ <@${recruiter.id}> recruited <@${person.id}>.\n` +
          `On <@${person.id}>'s **first payout**, a one-time **${bp / 100}%** introduction fee goes to ` +
          `<@${recruiter.id}>. Every task after that is the full amount.\n\n` +
          '_They are told this in the offer itself, before they accept, so the figure they agree to is the ' +
          'figure they can expect._'
        ));
        return;
      }

      if (sub === 'clear') {
        const person = interaction.options.getUser('person', true);
        const result = recruiterFee.clearRecruiter(db, guildId, person.id, userId);

        await interaction.reply(priv(
          result.ok
            ? `✅ <@${person.id}> no longer has a recruiter recorded.`
            : result.reason === 'already_paid'
              ? `❌ The fee on <@${person.id}> has already been taken. The record of what was actually paid stays.`
              : `❌ <@${person.id}> is not on the team.`
        ));
        return;
      }

      if (sub === 'list') {
        const rows = db.prepare(`
          SELECT user_id, display_name, recruited_by, recruited_at, recruiter_fee_taken_at
          FROM staff WHERE guild_id = ? AND recruited_by IS NOT NULL
          ORDER BY recruiter_fee_taken_at IS NOT NULL, recruited_at DESC
        `).all(guildId);

        const waiting = rows.filter((row) => !row.recruiter_fee_taken_at);

        await interaction.reply(priv({
          embeds: [new EmbedBuilder()
            .setTitle('Who recruited whom')
            .setColor(0x5865f2)
            .setDescription(rows.length === 0
              ? '_Nobody has a recruiter recorded. Set one with `/team recruited set`._'
              : rows.map((row) =>
                `${row.recruiter_fee_taken_at ? '✅' : '⏳'} <@${row.user_id}> — recruited by <@${row.recruited_by}>` +
                `\n┗ ${row.recruiter_fee_taken_at
                  ? `fee paid ${discordTimestamp(row.recruiter_fee_taken_at, 'R')}`
                  : 'fee still to come, on their first payout'}`
              ).join('\n').slice(0, 4000))
            .setFooter({ text: `${waiting.length} introduction fee(s) still to come.` })],
        }));
        return;
      }
    }

    if (group === 'stand-in') {
      if (sub === 'list') {
        const includePast = interaction.options.getBoolean('include-past') === true;
        const grants = onboardingRepo.listBackupLeaders(db, guildId, { includeExpired: includePast });

        await interaction.reply(priv({
          embeds: [new EmbedBuilder()
            .setTitle('Stand-in leaders')
            .setColor(0x5865f2)
            .setDescription(grants.map((grant) => {
              const over = grant.revoked_at || grant.expires_at <= Date.now();
              return (
                `${over ? '⚪' : '🟢'} **#${grant.id}** <@${grant.user_id}> — ${departmentName.get(grant.department_id) || 'unknown department'}\n` +
                `┗ ${grant.responsibilities.slice(0, 150)}\n` +
                `┗ ${grant.revoked_at ? `revoked ${discordTimestamp(grant.revoked_at, 'd')}` : `until ${discordTimestamp(grant.expires_at, 'F')}`}`
              );
            }).join('\n').slice(0, 4000) || '_Nobody is standing in._')
            .setFooter({ text: 'Powers end at the stated time by themselves — nothing has to run.' })],
        }));
        return;
      }

      if (sub === 'revoke') {
        const grant = onboardingRepo.revokeBackupLeader(db, guildId, interaction.options.getInteger('id', true), userId);
        if (!grant) {
          await interaction.reply(priv('❌ No open stand-in arrangement with that number.'));
          return;
        }
        await interaction.reply(priv(`✅ <@${grant.user_id}> no longer stands in for ${departmentName.get(grant.department_id) || 'that department'}.`));
        await notifyUser(interaction.client, db, guildId, grant.user_id, {
          content: `Your stand-in cover for **${departmentName.get(grant.department_id) || 'a department'}** has ended.`,
        }).catch(() => null);
        return;
      }

      // grant
      const person = interaction.options.getUser('person', true);
      const departmentId = Number(interaction.options.getString('department', true));
      const department = departments.find((dept) => dept.id === departmentId);
      if (!department) {
        await interaction.reply(priv('❌ Pick a department from the list.'));
        return;
      }

      const yourTimezone = staffRepo.getStaff(db, guildId, userId)?.timezone || 'UTC';
      const until = parseDeadlineInput(interaction.options.getString('until', true), yourTimezone);
      if (!until.ok) {
        await interaction.reply(priv(`❌ Could not read that end date. Use \`YYYY-MM-DD\` or \`YYYY-MM-DD HH:MM\` (24-hour).`));
        return;
      }

      let startsAt = Date.now();
      const fromText = interaction.options.getString('from');
      if (fromText) {
        const from = parseDeadlineInput(fromText, yourTimezone);
        if (!from.ok) {
          await interaction.reply(priv('❌ Could not read that start date. Use `YYYY-MM-DD` or `YYYY-MM-DD HH:MM`.'));
          return;
        }
        startsAt = from.utcMs;
      }

      // An arrangement that ends before it begins would confer nothing and
      // read as a mistake, so it is refused rather than stored.
      if (until.utcMs <= startsAt) {
        await interaction.reply(priv('❌ The end must be after the start.'));
        return;
      }

      const grant = onboardingRepo.grantBackupLeader(db, guildId, {
        departmentId,
        userId: person.id,
        responsibilities: interaction.options.getString('responsibilities', true),
        startsAt,
        expiresAt: until.utcMs,
      }, userId);

      await interaction.reply(priv(
        `✅ **#${grant.id}** — <@${person.id}> stands in for **${department.name}** until ${discordTimestamp(until.utcMs, 'F')}.\n` +
        'They get the same powers a leader has in that department, and only there. ' +
        'It ends by itself at that time — nothing has to run for it to lapse.'
      ));

      await notifyUser(interaction.client, db, guildId, person.id, {
        content:
          `🛡️ You are standing in for **${department.name}** until ${discordTimestamp(until.utcMs, 'F')}.\n` +
          `Covering: ${grant.responsibilities}\n` +
          'You can assign work, propose pay and review submissions in that department. Start with `/go`.',
      }).catch(() => null);
      return;
    }

    // ---- offboarding ----

    if (sub === 'list') {
      const departures = onboardingRepo.listDepartures(db, guildId);
      await interaction.reply(priv({
        embeds: [new EmbedBuilder()
          .setTitle('Departures')
          .setColor(0x5865f2)
          .setDescription(departures.map((departure) => {
            const snapshot = JSON.parse(departure.snapshot_json);
            return (
              `${departure.completed_at ? '✅' : '🟡'} **#${departure.id}** <@${departure.user_id}> — ${discordTimestamp(departure.started_at, 'd')}\n` +
              `┗ ${snapshot.blockers?.length ? snapshot.blockers.join('; ') : 'nothing outstanding at the time'}`
            );
          }).join('\n').slice(0, 4000) || '_Nobody has left._')],
      }));
      return;
    }

    if (sub === 'complete') {
      const departure = onboardingRepo.completeDeparture(db, guildId, interaction.options.getInteger('id', true), userId);
      if (!departure) {
        await interaction.reply(priv('❌ No open departure with that number.'));
        return;
      }
      await interaction.reply(priv(`✅ Departure **#${departure.id}** marked finished. The record is kept.`));
      return;
    }

    const person = interaction.options.getUser('person', true);
    const report = offboarding.buildReport(db, guildId, person.id, departments);

    const embed = new EmbedBuilder()
      .setTitle(`Offboarding · ${report.staff?.display_name || person.username}`)
      .setColor(report.blockers.length > 0 ? 0xfaa61a : 0x57f287)
      .setDescription(report.blockers.length > 0
        ? `**Outstanding:**\n${report.blockers.map((line) => `• ${line}`).join('\n')}`
        : 'Nothing outstanding.');

    if (report.unfinished.length > 0) {
      embed.addFields({
        name: `Unfinished work (${report.unfinished.length})`,
        value: report.unfinished.map((task) =>
          `**${task.code}** ${task.title} — ${task.state.replace(/_/g, ' ')}` +
          `${task.deadline_utc ? ` · due ${discordTimestamp(task.deadline_utc, 'R')}` : ''}`
        ).join('\n').slice(0, 1024),
        inline: false,
      });
    }

    if (report.files.length > 0) {
      embed.addFields({
        name: `Approved work with no files recorded (${report.files.length})`,
        value: report.files.map((task) => `**${task.code}** ${task.title}`).join('\n').slice(0, 1024),
        inline: false,
      });
    }

    if (report.pay.totals.size > 0) {
      embed.addFields({
        name: 'Still owed to them',
        value: `**${formatTotals(report.pay.totals)}**\n` +
          [
            ...report.pay.lines.map((line) => `${line.task.code} — work pay`),
            ...report.pay.shareLines.map((line) => `${line.share.task_code} — ${line.share.recipient_kind} share`),
          ].join('\n').slice(0, 900),
        inline: false,
      });
    }

    if (report.offers.length > 0 || report.standIns.length > 0 || report.trials.length > 0) {
      embed.addFields({
        name: 'Also open',
        value: [
          report.offers.length > 0 ? `${report.offers.length} unanswered offer(s)` : null,
          report.standIns.length > 0 ? `${report.standIns.length} stand-in grant(s)` : null,
          report.trials.length > 0 ? `${report.trials.length} open trial(s)` : null,
          report.led.length > 0 ? `leads live work in: ${report.led.map((dept) => dept.name).join(', ')}` : null,
        ].filter(Boolean).join('\n').slice(0, 1024),
        inline: false,
      });
    }

    if (sub === 'preview') {
      embed.setFooter({ text: 'Nothing has been changed. Run /team offboard start when you are ready.' });
      await interaction.reply(priv({ embeds: [embed] }));
      return;
    }

    // start
    const departure = onboardingRepo.recordDeparture(db, guildId, {
      userId: person.id,
      reason: interaction.options.getString('reason'),
      handoverNote: interaction.options.getString('handover'),
      snapshot: offboarding.snapshotOf(report),
    }, userId);

    // The profile is flagged, never deleted: their submissions, approvals and
    // payment history have to survive them leaving.
    staffRepo.markRemoved(db, guildId, person.id, userId);

    let withdrawn = 0;
    if (interaction.options.getBoolean('withdraw-offers') !== false) {
      for (const offer of report.offers) {
        const result = await withdrawOffer(interaction.client, db, {
          guildId,
          taskId: offer.task_id,
          actorUserId: userId,
          reason: 'The person offered this has left the studio.',
        }).catch(() => null);
        if (result?.ok) withdrawn += 1;
      }
    }

    // Stand-in powers must not outlive the person holding them.
    let revoked = 0;
    for (const grant of report.standIns) {
      if (onboardingRepo.revokeBackupLeader(db, guildId, grant.id, userId)) revoked += 1;
    }

    embed.setFooter({
      text: `Departure #${departure.id} recorded. Nothing was deleted.`,
    });

    await interaction.reply(priv({
      content:
        `✅ <@${person.id}> is recorded as having left. They are off the boards and their profile is flagged, not deleted.\n` +
        `${withdrawn > 0 ? `${withdrawn} unanswered offer(s) withdrawn.\n` : ''}` +
        `${revoked > 0 ? `${revoked} stand-in grant(s) ended.\n` : ''}` +
        `${report.unfinished.length > 0 ? `⚠️ Their ${report.unfinished.length} unfinished task(s) still need somebody — use \`/change reassign\`.\n` : ''}` +
        `${report.pay.totals.size > 0 ? `⚠️ They are still owed **${formatTotals(report.pay.totals)}**. That does not go away.\n` : ''}` +
        `\n_Remove their Discord roles yourself — the bot does not change roles._`,
      embeds: [embed],
    }));
  },
};
