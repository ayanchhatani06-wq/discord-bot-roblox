# Putting it online

Two things to host, and you probably only want the first today.

- **The bot** — needs a computer that is always on
- **The website** — a free static site now, a live one later when clients need
  to sign in

---

## 1 · The bot

### Get a box

**Pay the $4–5 a month.** Hetzner, DigitalOcean or Vultr, smallest size,
**Ubuntu 24.04**.

Oracle's free tier looks like the obvious answer and is the wrong one here: they
halved the ARM allocation and reclaim idle instances, and this box holds your
studio's payment records. Five dollars is cheaper than reconstructing who was
owed what.

### Set it up

```bash
git clone https://github.com/ayanchhatani06-wq/discord-bot-roblox.git
cd discord-bot-roblox
bash deploy/setup-ubuntu.sh
```

That script does swap, system packages, **Node 22**, dependencies, data
directories and the service files. It is safe to run twice — every step checks
before it acts, so a re-run after a failure picks up where it stopped.

It deliberately does **not** write your `.env` or start anything. The token
should go straight from Discord into the file, and nothing should start before
you have looked at what it is about to run as.

```bash
cp .env.example .env
nano .env          # DISCORD_TOKEN, CLIENT_ID, GUILD_ID — only these three are required
chmod 600 .env

npm run deploy     # registers the commands with Discord, once
sudo systemctl enable --now studio-bot
journalctl -u studio-bot -f       # watch it start; Ctrl-C stops watching, not the bot
```

Then in Discord: `/setup setup`, then `/setup doctor`.

**Node 22, not 24.** `better-sqlite3` has no prebuilt binary for 24, and it will
fail to compile with an error that looks unrelated. The script pins 22 for you;
this matters only if you install Node yourself.

---

## 2 · The website

### The free version — do this one

Static HTML. Services, portfolio, about, contact. No server, no cost.

**Write the content from Discord:**

```
/setup web identity name:Cylops Studio tagline:We build for Roblox
/setup web service key:building title:Building body:…
/setup web publish-service key:building show:true
/setup web page key:about title:About body:…
/setup web publish-page key:about show:true
/setup web status
```

**Generate it:**

```bash
npm run site
```

That writes a folder of plain HTML. Upload it to **InfinityFree, Netlify or
Cloudflare Pages** — all free, all fine for this.

The portfolio only shows what `/files portfolio` permits. No client names, no
prices, no dates.

### The live version — later

Needed only for the client sign-in area and the quote form writing straight into
the bot. It needs the same always-on box.

```bash
# in .env
WEB_PORT=8080
WEB_APP_URL=https://yourdomain.com
TRUST_PROXY=1

sudo systemctl enable --now studio-web
```

Point your domain at the box, then:

```bash
sudo apt install caddy
sudo cp deploy/Caddyfile.example /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile     # your real domain and email
sudo systemctl reload caddy
```

Caddy gets the HTTPS certificate and renews it itself. There is no renewal cron
to forget, which is how most hobby sites end up serving an expired certificate.

**`TRUST_PROXY=1` only with Caddy in front.** Without a proxy, that setting lets
anyone fake their address and walk straight past the rate limiter.

**Test locally first:**

```bash
WEB_INSECURE=1 npm run web        # then open http://localhost:8080
```

`WEB_INSECURE=1` stops cookies being marked Secure so they work over plain http.
**Local testing only** — never on a public site.

### Client sign-in, optional

**Through Discord:** add `DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET` to
`.env`, and add this redirect URL in the Discord Developer Portal:

```
https://yourdomain.com/client/discord/callback
```

**Through email,** for clients not in your Discord: add `SMTP_HOST`, `SMTP_FROM`,
and `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS`. Then `/setup web client-email`.

Without SMTP you can still use `/setup web sign-in-link` — it makes a one-time
link you send them yourself.

---

## 3 · Backups — do not skip this

`/setup backup now` writes to the same disk as the database. That is a second
copy of a file, not a backup: it dies with the disk.

```bash
crontab -e
```

```
17 3 * * * /home/ubuntu/discord-bot-roblox/deploy/backup-offsite.sh >> ~/backup.log 2>&1
```

Set `BACKUP_DESTINATION` in `.env` to somewhere off the box — another server over
scp, or any rclone remote.

The job takes a fresh copy with SQLite's own backup, opens it and runs an
integrity check, tars up the filed proof, reads that archive back, copies both
off the box, and **only then** deletes old local copies. A failing job can never
delete your last good backup.

It needs the sqlite3 command line tool: `sudo apt install sqlite3`.

**Both files matter.** The database holds each screenshot's hash and path, not
its bytes. Restore the database without the evidence archive and every piece of
proof reads as missing — which looks exactly like somebody deleted it.

---

## 4 · Keeping it running

```bash
sudo systemctl status studio-bot      # is it up
journalctl -u studio-bot -n 100       # last 100 lines
sudo systemctl restart studio-bot     # after changing .env
```

Both services restart themselves if they crash and come back after a reboot.

### Updating

```bash
cd discord-bot-roblox
git pull
npm install
npm run deploy                        # only if commands changed
sudo systemctl restart studio-bot
```

Migrations apply themselves on start. **Take a backup before updating** — not
because it usually goes wrong, but because the one time it does is the time you
did not.

---

## If something is quietly wrong

`/setup doctor` first, always. It finds the failures that come with no error
message: no fallback channel set so offers vanish silently, staff with no
timezone so their deadlines land hours out, a client with orders but nobody
authorised to approve them.

Run it after any setup change, and once a month regardless.
