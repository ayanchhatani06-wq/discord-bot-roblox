require('dotenv').config();
const path = require('node:path');
const fs = require('node:fs');
const { Client, GatewayIntentBits, Collection } = require('discord.js');
const { getDatabase } = require('./db');

if (!process.env.DISCORD_TOKEN) {
  console.error('Missing DISCORD_TOKEN in your .env file.');
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.commands = new Collection();

function loadCommands() {
  const commandsDir = path.join(__dirname, 'commands');
  if (!fs.existsSync(commandsDir)) return;
  for (const file of fs.readdirSync(commandsDir).filter((f) => f.endsWith('.js'))) {
    const command = require(path.join(commandsDir, file));
    client.commands.set(command.data.name, command);
  }
}

loadCommands();

client.once('ready', () => {
  // Opening the database here surfaces migration problems at start-up rather
  // than on the first command someone runs.
  getDatabase();
  console.log(`Logged in as ${client.user.tag} with ${client.commands.size} command(s).`);
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
    } else if (interaction.isAutocomplete() && command.autocomplete) {
      await command.autocomplete(interaction);
    }
  } catch (error) {
    console.error(`Error handling /${interaction.commandName}:`, error);
    if (!interaction.isChatInputCommand()) return;
    const body = { content: '❌ Something went wrong running that command.', ephemeral: true };
    const respond = interaction.replied || interaction.deferred
      ? interaction.followUp(body)
      : interaction.reply(body);
    await respond.catch(() => {});
  }
});

client.login(process.env.DISCORD_TOKEN);
