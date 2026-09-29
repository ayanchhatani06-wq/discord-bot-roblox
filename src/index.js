require('dotenv').config();
const path = require('node:path');
const fs = require('node:fs');
const { Client, GatewayIntentBits, Collection } = require('discord.js');
const { getDatabase } = require('./db');
const router = require('./interactions/router');
const boardScheduler = require('./services/boardScheduler');
const jobs = require('./services/jobs');
const { replyPrivate } = require('./utils/reply');

if (!process.env.DISCORD_TOKEN) {
  console.error('Missing DISCORD_TOKEN in your .env file.');
  process.exit(1);
}

// GuildMembers is a privileged intent (enable it on the Bot tab of the
// developer portal). A staff directory has to know when somebody leaves the
// server, otherwise the boards keep listing people who are gone.
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
client.commands = new Collection();

function loadDirectory(directory, onFile) {
  if (!fs.existsSync(directory)) return;
  for (const file of fs.readdirSync(directory).filter((f) => f.endsWith('.js'))) {
    onFile(require(path.join(directory, file)), file);
  }
}

loadDirectory(path.join(__dirname, 'commands'), (command, file) => {
  if (!command?.data?.name) {
    console.warn(`Skipping ${file}: no command data exported.`);
    return;
  }
  client.commands.set(command.data.name, command);
});

// Requiring each interactions module registers its component handlers with the
// router as a side effect; router.js itself has nothing to register.
loadDirectory(path.join(__dirname, 'interactions'), () => {});

client.once('ready', () => {
  const db = getDatabase();
  console.log(`Logged in as ${client.user.tag}.`);
  console.log(`Commands: ${[...client.commands.keys()].join(', ') || 'none'}`);
  console.log(`Component namespaces: ${router.registeredNamespaces().join(', ') || 'none'}`);
  jobs.startAll(client, db);
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const command = client.commands.get(interaction.commandName);
      if (!command) return;
      if (!interaction.inGuild()) {
        await replyPrivate(interaction, 'This command only works inside a server.');
        return;
      }
      await command.execute(interaction);
      return;
    }

    if (interaction.isAutocomplete()) {
      const command = client.commands.get(interaction.commandName);
      if (command?.autocomplete) await command.autocomplete(interaction);
      return;
    }

    if (interaction.isButton() || interaction.isAnySelectMenu() || interaction.isModalSubmit()) {
      // Deliberately not restricted to guilds: task offers are answered from
      // DMs, and those handlers recover the guild from the offer itself.
      await router.route(interaction);
    }
  } catch (error) {
    if (interaction.isAutocomplete()) {
      console.error(`Autocomplete failed for /${interaction.commandName}:`, error);
      return;
    }
    await router.reportError(interaction, error, `/${interaction.commandName || interaction.customId}`);
  }
});

const staffRepo = require('./db/repos/staff');

client.on('guildMemberRemove', (member) => {
  // Their profile is flagged, not deleted: submissions, approvals and payment
  // records must survive somebody leaving.
  try {
    const db = getDatabase();
    if (staffRepo.getStaff(db, member.guild.id, member.id)) {
      staffRepo.markRemoved(db, member.guild.id, member.id);
      boardScheduler.invalidate(member.guild.id);
    }
  } catch (error) {
    console.error('Failed to mark departing member as removed:', error);
  }
});

process.on('unhandledRejection', (error) => console.error('Unhandled promise rejection:', error));

client.login(process.env.DISCORD_TOKEN);
