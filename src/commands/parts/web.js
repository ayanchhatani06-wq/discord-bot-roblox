const path = require('node:path');
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const configRepo = require('../../db/repos/config');
const clientsRepo = require('../../db/repos/clients');
const webRepo = require('../../db/repos/web');
const clientCodes = require('../../services/clientCodes');
const { contextFor } = require('../../services/actor');
const { CAPABILITIES, assertCan } = require('../../domain/permissions');
const { discordTimestamp } = require('../../utils/time');
const { priv } = require('../../utils/reply');

/**
 * The website, controlled from Discord.
 *
 * Everything the public site says is written here and shown verbatim. Nothing
 * on that site is generated, which is the point: a studio's own words about
 * what it does should be its own words.
 */
module.exports = {
  data: new SlashCommandBuilder()
    .setName('web')
    .setDescription('The studio website: services, pages, client logins and publishing')
    .addSubcommand((sub) =>
      sub
        .setName('identity')
        .setDescription("Your studio's name and tagline, as the site shows them")
        .addStringOption((opt) => opt.setName('name').setDescription('Studio name').setRequired(false).setMaxLength(80))
        .addStringOption((opt) => opt.setName('tagline').setDescription('One line under the name').setRequired(false).setMaxLength(160))
    )
    .addSubcommand((sub) =>
      sub
        .setName('service')
        .setDescription('Write or rewrite one service on the public site')
        .addStringOption((opt) => opt.setName('key').setDescription('Short id, e.g. modelling').setRequired(true))
        .addStringOption((opt) => opt.setName('name').setDescription('How it reads, e.g. 3D Modelling').setRequired(true))
        .addStringOption((opt) => opt.setName('summary').setDescription('One or two sentences').setRequired(true).setMaxLength(400))
        .addStringOption((opt) => opt.setName('detail').setDescription('Anything more').setRequired(false).setMaxLength(800))
        .addIntegerOption((opt) => opt.setName('order').setDescription('Where it sits in the list').setRequired(false))
    )
    .addSubcommand((sub) =>
      sub
        .setName('publish-service')
        .setDescription('Show or hide a service on the public site')
        .addStringOption((opt) => opt.setName('key').setDescription('Service id').setRequired(true).setAutocomplete(true))
        .addBooleanOption((opt) => opt.setName('published').setDescription('Show it?').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('page')
        .setDescription('Write a page, such as About')
        .addStringOption((opt) =>
          opt.setName('key').setDescription('Which page').setRequired(true)
            .addChoices({ name: 'About', value: 'about' }, { name: 'Contact', value: 'contact' })
        )
        .addStringOption((opt) => opt.setName('title').setDescription('Heading').setRequired(true).setMaxLength(100))
        .addStringOption((opt) => opt.setName('body').setDescription('The text. A blank line starts a new paragraph.').setRequired(true).setMaxLength(3500))
    )
    .addSubcommand((sub) =>
      sub
        .setName('publish-page')
        .setDescription('Show or hide a page')
        .addStringOption((opt) =>
          opt.setName('key').setDescription('Which page').setRequired(true)
            .addChoices({ name: 'About', value: 'about' }, { name: 'Contact', value: 'contact' })
        )
        .addBooleanOption((opt) => opt.setName('published').setDescription('Show it?').setRequired(true))
    )
    .addSubcommand((sub) => sub.setName('status').setDescription('What the public site currently shows'))
    .addSubcommand((sub) =>
      sub
        .setName('client-email')
        .setDescription('Let a client sign in to the website with an email address')
        .addStringOption((opt) => opt.setName('client').setDescription('Client').setRequired(true).setAutocomplete(true))
        .addStringOption((opt) => opt.setName('email').setDescription('Their email address').setRequired(true))
        .addBooleanOption((opt) => opt.setName('can-approve').setDescription('May they approve work? (default: no)').setRequired(false))
    )
    .addSubcommand((sub) =>
      sub
        .setName('revoke-email')
        .setDescription("Remove an email address's access")
        .addStringOption((opt) => opt.setName('client').setDescription('Client').setRequired(true).setAutocomplete(true))
        .addStringOption((opt) => opt.setName('email').setDescription('Address to remove').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('sign-in-link')
        .setDescription('Make a one-time sign-in link to send a client yourself')
        .addStringOption((opt) => opt.setName('client').setDescription('Client').setRequired(true).setAutocomplete(true))
        .addStringOption((opt) => opt.setName('email').setDescription('Which of their addresses').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('client-code')
        .setDescription('A code that lets a client sign in for the week')
        .addStringOption((opt) => opt.setName('client').setDescription('Client').setRequired(true).setAutocomplete(true))
        .addStringOption((opt) =>
          opt
            .setName('action')
            .setDescription('What to do (default: issue a new code)')
            .setRequired(false)
            .addChoices(
              { name: 'Issue a new code', value: 'issue' },
              { name: 'Show what they have now', value: 'status' },
              { name: 'Cut their access off now', value: 'revoke' }
            )
        )
        .addIntegerOption((opt) =>
          opt
            .setName('days')
            .setDescription('How long it lasts (default: your studio setting)')
            .setRequired(false)
            .setMinValue(1)
            .setMaxValue(90)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('client-code-settings')
        .setDescription('How client codes work here — run with nothing to see the current ones')
        .addBooleanOption((opt) =>
          opt.setName('require-email').setDescription('Must they also type a known email? (recommended: yes)').setRequired(false)
        )
        .addBooleanOption((opt) =>
          opt.setName('rotate-weekly').setDescription('Mint fresh codes every week on their own?').setRequired(false)
        )
        .addIntegerOption((opt) =>
          opt.setName('days').setDescription('How many days a code lasts').setRequired(false).setMinValue(1).setMaxValue(90)
        )
    ),

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);
    const { db, guildId } = contextFor(interaction);
    const query = String(focused.value || '');

    if (focused.name === 'client') {
      const matches = query
        ? clientsRepo.searchClients(db, guildId, query, 25)
        : clientsRepo.listClients(db, guildId, { limit: 25 });
      await interaction.respond(matches.map((client) => ({
        name: client.display_name.slice(0, 100), value: String(client.id),
      })));
      return;
    }

    await interaction.respond(webRepo.listServices(db, guildId, { publishedOnly: false }).slice(0, 25)
      .map((service) => ({ name: `${service.key} · ${service.name}`.slice(0, 100), value: service.key })));
  },

  async execute(interaction) {
    const { db, guildId, actor } = contextFor(interaction);
    const sub = interaction.options.getSubcommand();
    const userId = interaction.user.id;

    // The site speaks for the studio, so it is the owner's to write.
    assertCan(actor, CAPABILITIES.CONFIG_MANAGE);

    if (sub === 'identity') {
      const name = interaction.options.getString('name');
      const tagline = interaction.options.getString('tagline');

      if (!name && !tagline) {
        const config = configRepo.getConfig(db, guildId);
        await interaction.reply(priv(
          `**${config?.studio_name || '_no name set_'}**\n` +
          `${config?.studio_tagline || '_no tagline set_'}\n\n` +
          'Change either with `/setup web identity name: tagline:`.'
        ));
        return;
      }

      configRepo.updateConfig(db, guildId, {
        ...(name ? { studio_name: name } : {}),
        ...(tagline ? { studio_tagline: tagline } : {}),
      }, userId);

      await interaction.reply(priv(
        `✅ Updated. The site now reads **${name || configRepo.getConfig(db, guildId)?.studio_name}**.\n` +
        '_Re-export the static site for this to reach your public pages._'
      ));
      return;
    }

    if (sub === 'service') {
      const service = webRepo.upsertService(db, guildId, {
        key: interaction.options.getString('key', true),
        name: interaction.options.getString('name', true),
        summary: interaction.options.getString('summary', true),
        detail: interaction.options.getString('detail'),
        sortOrder: interaction.options.getInteger('order') ?? 0,
      }, userId);

      await interaction.reply(priv(
        `✅ **${service.name}** saved${service.published ? '' : ' — and it is **not published yet**'}.\n` +
        `${service.published ? '' : `Show it with \`/setup web publish-service key:${service.key} published:true\`.`}`
      ));
      return;
    }

    if (sub === 'publish-service') {
      const published = interaction.options.getBoolean('published', true);
      const service = webRepo.setServicePublished(db, guildId, interaction.options.getString('key', true), published, userId);

      await interaction.reply(priv(service
        ? `✅ **${service.name}** is now ${published ? 'on the public site' : 'hidden'}.`
        : '❌ No service with that id.'));
      return;
    }

    if (sub === 'page') {
      const page = webRepo.upsertPage(db, guildId, {
        key: interaction.options.getString('key', true),
        title: interaction.options.getString('title', true),
        body: interaction.options.getString('body', true),
      }, userId);

      await interaction.reply(priv(
        `✅ **${page.title}** saved${page.published ? '' : ' as a draft'}.\n` +
        `${page.published ? '' : `Publish it with \`/setup web publish-page key:${page.key} published:true\`.`}\n` +
        '_Your text is shown exactly as written. A blank line starts a new paragraph, and that is the whole formatting._'
      ));
      return;
    }

    if (sub === 'publish-page') {
      const published = interaction.options.getBoolean('published', true);
      const page = webRepo.setPagePublished(db, guildId, interaction.options.getString('key', true), published, userId);

      await interaction.reply(priv(page
        ? `✅ **${page.title}** is now ${published ? 'public' : 'hidden'}.`
        : '❌ That page has not been written yet — use `/setup web page` first.'));
      return;
    }

    if (sub === 'status') {
      const config = configRepo.getConfig(db, guildId);
      const services = webRepo.listServices(db, guildId, { publishedOnly: false });
      const assetsRepo = require('../../db/repos/assets');
      const portfolio = assetsRepo.publishablePortfolio(db, guildId, { limit: 200 });

      const published = services.filter((service) => service.published);
      const about = webRepo.getPage(db, guildId, 'about', { publishedOnly: false });

      await interaction.reply(priv({
        embeds: [new EmbedBuilder()
          .setTitle('Your public site')
          .setColor(0x5865f2)
          .setDescription(
            `**${config?.studio_name || '_no studio name set_'}**\n` +
            `${config?.studio_tagline || '_no tagline_'}`
          )
          .addFields(
            {
              name: 'Services',
              value: services.length === 0
                ? '_None written. The site falls back to your department names until you write your own._'
                : `${published.length} published of ${services.length}\n` +
                  services.map((service) => `${service.published ? '🟢' : '⚪'} ${service.name}`).join('\n').slice(0, 900),
              inline: false,
            },
            {
              name: 'Work shown publicly',
              value: portfolio.length === 0
                ? '_Nothing cleared yet. Clients grant this per project or per file — `/files rights`._'
                : `${portfolio.length} item(s), all with recorded client permission`,
              inline: false,
            },
            {
              name: 'About page',
              value: about ? (about.published ? '🟢 published' : '⚪ written but hidden') : '_not written_',
              inline: true,
            }
          )
          .setFooter({ text: 'Publish changes by re-running the static export, or they stay on this box only.' })],
      }));
      return;
    }

    if (sub === 'client-code-settings') {
      const requireEmail = interaction.options.getBoolean('require-email');
      const rotateWeekly = interaction.options.getBoolean('rotate-weekly');
      const days = interaction.options.getInteger('days');

      if (requireEmail === null && rotateWeekly === null && days === null) {
        const current = clientCodes.settingsFor(configRepo.getConfig(db, guildId) || {});
        await interaction.reply(priv(
          '**How client codes work here**\n' +
          `• Sign-in needs **${current.requireEmail ? 'the code and a known email' : 'the code only'}**\n` +
          `• Fresh codes every week: **${current.rotateWeekly ? 'yes' : 'no'}**\n` +
          `• A code lasts **${current.days} day(s)**\n\n` +
          'Change any of them with `/setup web client-code-settings`.'
        ));
        return;
      }

      configRepo.updateConfig(db, guildId, {
        ...(requireEmail === null ? {} : { client_code_require_email: requireEmail ? 1 : 0 }),
        ...(rotateWeekly === null ? {} : { client_code_rotate_weekly: rotateWeekly ? 1 : 0 }),
        ...(days === null ? {} : { client_code_days: days }),
      }, userId);

      await interaction.reply(priv(
        '✅ Saved.\n' +
        `${requireEmail === false
          ? '⚠️ A code on its own now signs somebody in. Anybody who sees one is that client until it expires.\n'
          : ''}` +
        `${days !== null && days > 30 ? '⚠️ A code lasting over a month is most of the way to a permanent one.\n' : ''}` +
        'Existing codes keep the rules they were issued under until they expire.'
      ));
      return;
    }

    // ---- client sign-in by email ----

    const client = clientsRepo.getClient(db, guildId, Number(interaction.options.getString('client', true)));
    if (!client) {
      await interaction.reply(priv('❌ No client with that name.'));
      return;
    }

    if (sub === 'client-email') {
      const email = interaction.options.getString('email', true);
      const canApprove = interaction.options.getBoolean('can-approve') === true;

      const added = webRepo.addClientEmail(db, guildId, client.id, {
        email,
        canApprove,
      }, userId);

      await interaction.reply(priv(
        `✅ **${added.email}** can now sign in to the website as **${client.display_name}**.\n` +
        `${canApprove
          ? '⚠️ They can also **approve work**. Only give that to somebody who decides for this client.'
          : 'They can see this client\'s orders but not approve anything.'}\n` +
        `Send them a link with \`/setup web sign-in-link client:${client.display_name} email:${added.email}\`.`
      ));
      return;
    }

    if (sub === 'revoke-email') {
      const email = interaction.options.getString('email', true);
      const revoked = webRepo.revokeClientEmail(db, guildId, client.id, email, userId);

      if (!revoked) {
        await interaction.reply(priv('❌ That address does not currently have access.'));
        return;
      }

      // Access removed means access removed now, not when their session lapses.
      const killed = webRepo.revokeSessionsForClient(db, client.id);
      await interaction.reply(priv(
        `✅ **${webRepo.normaliseEmail(email)}** no longer has access.\n` +
        `${killed > 0 ? `${killed} open session(s) for this client were signed out immediately.` : ''}`
      ));
      return;
    }

    if (sub === 'sign-in-link') {
      const email = webRepo.normaliseEmail(interaction.options.getString('email', true));
      const known = webRepo.findClientEmail(db, guildId, email);

      if (!known || known.client_id !== client.id) {
        await interaction.reply(priv(
          `❌ **${email}** is not an address on ${client.display_name}'s record. Add it with \`/setup web client-email\` first.`
        ));
        return;
      }

      const { randomToken, hashToken } = require('../../../web/lib/http');
      const token = randomToken();
      const issued = webRepo.issueLoginToken(db, guildId, {
        clientId: client.id,
        tokenHash: hashToken(token),
        email,
        issuedBy: userId,
      });

      const base = process.env.WEB_APP_URL || 'https://your-site';
      await interaction.reply(priv(
        `🔑 One-time sign-in link for **${client.display_name}** (${email}):\n` +
        `\`\`\`\n${base.replace(/\/$/, '')}/client/enter?token=${token}\n\`\`\`\n` +
        `It works **once** and expires ${discordTimestamp(issued.expires_at, 'R')}.\n` +
        'Send it to them directly. Anybody holding this link is signed in as them, so do not post it anywhere public.'
      ));
      return;
    }

    if (sub === 'client-code') {
      const action = interaction.options.getString('action') || 'issue';
      const config = configRepo.getConfig(db, guildId) || {};
      const settings = clientCodes.settingsFor(config);
      const live = clientCodes.activeFor(db, client.id);

      if (action === 'status') {
        await interaction.reply(priv(
          live
            ? `**${client.display_name}** has a code ending **${live.display_hint}**.\n` +
              `It stops working ${discordTimestamp(live.expires_at, 'R')}.\n` +
              `Used **${live.use_count}** time(s)${live.last_used_at ? `, last ${discordTimestamp(live.last_used_at, 'R')}` : ' — not yet'}.\n\n` +
              '_The code itself is stored hashed and cannot be shown again. Issue a new one if it is lost._'
            : `**${client.display_name}** has no code right now.\n` +
              'Give them one with `/setup web client-code action:issue`.'
        ));
        return;
      }

      if (action === 'revoke') {
        const killed = clientCodes.revokeFor(db, client.id, { by: userId });
        await interaction.reply(priv(
          killed > 0
            ? `✅ **${client.display_name}** can no longer sign in with their code.\n` +
              'It stops working now, not when it would have expired.'
            : `**${client.display_name}** had no live code to revoke.`
        ));
        return;
      }

      const days = interaction.options.getInteger('days') ?? settings.days;
      const emails = webRepo.listClientEmails(db, client.id).filter((row) => !row.revoked_at);

      // Issuing a code they cannot use is a silent dead end, so say so up front
      // rather than after they have sent it on.
      if (settings.requireEmail && emails.length === 0) {
        await interaction.reply(priv(
          `❌ **${client.display_name}** has no email on their record, and sign-in here needs the code **and** a known email.\n` +
          'Add one with `/setup web client-email` first, or turn the requirement off with ' +
          '`/setup web client-code-settings require-email:false` — which I would not.'
        ));
        return;
      }

      const issued = clientCodes.issue(db, guildId, {
        clientId: client.id,
        studioName: config.studio_name,
        issuedBy: userId,
        days,
      });

      await interaction.reply(priv(
        `🔑 Access code for **${client.display_name}**:\n` +
        `\`\`\`\n${issued.code}\n\`\`\`\n` +
        `Works until ${discordTimestamp(issued.expiresAt, 'F')} (${issued.days} day(s)), then stops on its own.\n` +
        `${live ? '♻️ Their previous code stopped working just now.\n' : ''}` +
        `${settings.requireEmail
          ? `They sign in with this **and** one of their addresses: ${emails.map((row) => `\`${row.email}\``).join(', ')}.`
          : '⚠️ This code alone signs them in. Anybody who sees it is them until it expires.'}\n\n` +
        '_Shown once — it is stored hashed. Lost it? Issue another._'
      ));
    }
  },
};
