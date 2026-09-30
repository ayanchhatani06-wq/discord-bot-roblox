#!/usr/bin/env bash
#
# Sets up a fresh Ubuntu box to run the studio bot, and optionally the website.
#
# Safe to run twice: every step checks before it acts, so a re-run after a
# failure picks up where it stopped rather than doubling anything.
#
#   bash deploy/setup-ubuntu.sh
#
# It does NOT write your .env or start anything. Those are deliberate, separate
# steps: the token should go straight from Discord into the file, and nothing
# should start before you have looked at what it is about to run as.

set -euo pipefail

NODE_MAJOR=22
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_USER="${SUDO_USER:-$(id -un)}"

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
note() { printf '    %s\n' "$1"; }

# ---------------------------------------------------------------- swap

say "Swap"
if swapon --show | grep -q '/swapfile'; then
  note "Already on."
elif [ "$(free -m | awk '/^Mem:/ {print $2}')" -ge 3500 ]; then
  note "Skipped: this box has enough memory that swap would not earn its place."
else
  # A 1 GB shape runs out of memory compiling better-sqlite3 without this, and
  # the failure looks like an unrelated compiler error.
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile >/dev/null
  sudo swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
  note "2 GB added, and it survives a reboot."
fi

# ---------------------------------------------------------------- packages

say "System packages"
sudo apt-get update -qq
sudo apt-get install -y -qq git build-essential curl ca-certificates

say "Node.js ${NODE_MAJOR}"
CURRENT="$(node --version 2>/dev/null || echo none)"
if [[ "$CURRENT" == v${NODE_MAJOR}.* ]]; then
  note "Already on ${CURRENT}."
else
  # Pinned to 22 on purpose. better-sqlite3 ships prebuilt binaries for it;
  # on a newer Node there is no prebuild and the install tries to compile,
  # which is slow at best and fails at worst.
  note "Found ${CURRENT}, installing ${NODE_MAJOR}."
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash - >/dev/null
  sudo apt-get install -y -qq nodejs
fi
note "node $(node --version), npm $(npm --version)"

# ---------------------------------------------------------------- app

say "Dependencies"
cd "$APP_DIR"
npm ci --omit=dev 2>/dev/null || npm install --omit=dev
note "Installed into $APP_DIR/node_modules"

say "Data directories"
mkdir -p "$APP_DIR/data" "$APP_DIR/data/backups"
chmod 700 "$APP_DIR/data"
note "The database and backups live in $APP_DIR/data — back that folder up off this box."

# ---------------------------------------------------------------- services

say "Service files"

write_unit() {
  local name="$1" description="$2" exec_start="$3"
  local path="/etc/systemd/system/${name}.service"

  if [ -f "$path" ]; then
    note "${name}: already there, left alone."
    return
  fi

  sudo tee "$path" >/dev/null <<UNIT
[Unit]
Description=${description}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${RUN_USER}
WorkingDirectory=${APP_DIR}
ExecStart=${exec_start}
Restart=always
RestartSec=10
Environment=NODE_ENV=production

# The process needs its own directory and nothing else on the box.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=read-only
ReadWritePaths=${APP_DIR}/data

[Install]
WantedBy=multi-user.target
UNIT
  note "${name}: written."
}

write_unit studio-bot "Studio Operations Bot" "$(command -v node) ${APP_DIR}/src/index.js"
write_unit studio-web "Studio Website" "$(command -v node) ${APP_DIR}/setup web/server.js"

sudo systemctl daemon-reload

# ---------------------------------------------------------------- next

say "Done. Three things left, in this order."

cat <<NEXT

  1. Write your .env — the token goes straight from Discord into this file:

       cp ${APP_DIR}/.env.example ${APP_DIR}/.env
       nano ${APP_DIR}/.env
       chmod 600 ${APP_DIR}/.env

     DISCORD_TOKEN, CLIENT_ID and GUILD_ID are the only three required.

  2. Register the commands, once:

       cd ${APP_DIR} && npm run deploy

  3. Start it:

       sudo systemctl enable --now studio-bot
       journalctl -u studio-bot -f

     The website is optional and separate:

       sudo systemctl enable --now studio-web

  Then in Discord: /setup setup, then /setup doctor.

  Backups: /setup backup now writes to ${APP_DIR}/data/backups — on this same disk.
  Copy them somewhere else, or they do not survive losing the box.

NEXT
