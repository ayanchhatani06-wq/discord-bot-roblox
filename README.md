# Discord Timezone Bot

A Discord bot that lets members register their timezone and keeps a
live-updating embed in a channel showing everyone's current local time,
grouped by timezone.

## Features

- `/timezone set <timezone>` — register your own IANA timezone (autocomplete
  suggests matches as you type, e.g. `America/New_York`, `Europe/London`).
- `/timezone remove` — remove your registered timezone.
- `/timezone view [user]` — check your own or another member's current local
  time on demand.
- `/timezone setchannel <channel>` — (requires **Manage Server**) pick the
  channel where the bot posts and continuously refreshes a pinned embed
  listing every registered member, grouped by timezone, sorted by UTC offset.
  The embed is edited automatically every `UPDATE_INTERVAL_MINUTES` (default:
  every minute) so the times shown are always current — no manual refresh
  needed.

Timezones are stored in a local SQLite database (`data/timezones.db`),
comfortably supporting a few hundred registered members per server.

## Setup

1. **Create a bot application**
   - Go to the [Discord Developer Portal](https://discord.com/developers/applications).
   - Create a new application, then go to the **Bot** tab and copy the token.
   - Under **OAuth2 → URL Generator**, select the `bot` and
     `applications.commands` scopes, and under bot permissions select
     **View Channels**, **Send Messages**, **Embed Links**, and (optionally)
     **Manage Messages** (so the bot can pin its own status embed). Use the
     generated URL to invite the bot to your server.
   - No privileged intents are required.

2. **Configure environment variables**

   ```bash
   cp .env.example .env
   ```

   Fill in:
   - `DISCORD_TOKEN` — your bot token.
   - `CLIENT_ID` — your application's client ID (Developer Portal → General
     Information).
   - `GUILD_ID` — (optional, recommended while developing) your server's ID,
     so slash commands register instantly instead of waiting up to an hour
     for global propagation.
   - `UPDATE_INTERVAL_MINUTES` — how often the live embed refreshes (default `1`).

3. **Install dependencies**

   ```bash
   npm install
   ```

4. **Register the slash commands**

   ```bash
   npm run deploy
   ```

5. **Run the bot**

   ```bash
   npm start
   ```

6. In your server, run `/timezone setchannel #your-channel` (as an admin),
   then have members run `/timezone set` to register themselves. The embed
   in that channel will keep itself up to date automatically.

## Notes

- If a member leaves the server, their entry stays registered but will
  render as an unresolvable mention in the embed; there's currently no
  automatic cleanup on member departure.
- Pinning the status message requires the **Manage Messages** permission in
  that channel; if the bot doesn't have it, the embed still updates, it just
  won't be pinned.
