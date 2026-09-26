require('dotenv').config();
const path = require('node:path');
const fs = require('node:fs');
const { Client, GatewayIntentBits, Collection } = require('discord.js');
const scheduler = require('./scheduler');

if (!process.env.DISCORD_TOKEN) {
  console.error('Missing DISCORD_TOKEN in your .env file.');
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.commands = new Collection();

const commandsDir = path.join(__dirname, 'commands');
for (const file of fs.readdirSync(commandsDir).filter((f) => f.endsWith('.js'))) {
  const command = require(path.join(commandsDir, file));
  client.commands.set(command.data.name, command);
}

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}.`);
  const intervalMinutes = Number(process.env.UPDATE_INTERVAL_MINUTES) || 1;
  scheduler.start(client, intervalMinutes);
  scheduler.refreshAll(client).catch((err) => console.error('Initial timezone embed refresh failed:', err));
});

client.on('interactionCreate', async (interaction) => {
  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  try {
    if (interaction.isChatInputCommand()) {
      if (!interaction.inGuild()) {
        await interaction.reply({ content: 'This command only works inside a server.', ephemeral: true });
        return;
      }
      await command.execute(interaction);
    } else if (interaction.isAutocomplete()) {
      await command.autocomplete(interaction);
    }
  } catch (error) {
    console.error(`Error handling interaction for /${interaction.commandName}:`, error);
    if (interaction.isChatInputCommand() && (interaction.replied || interaction.deferred)) {
      await interaction.followUp({ content: '❌ Something went wrong running that command.', ephemeral: true }).catch(() => {});
    } else if (interaction.isChatInputCommand()) {
      await interaction.reply({ content: '❌ Something went wrong running that command.', ephemeral: true }).catch(() => {});
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
