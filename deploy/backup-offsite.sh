#!/usr/bin/env bash
#
# Takes a backup and copies it off this box.
#
# The bot's /setup backup now writes a verified copy to data/backups — on the same
# disk as the database it is protecting. That is not a backup, it is a second
# copy of a file that dies with the disk. This moves it somewhere else and
# throws away the old local ones.
#
# Run it from cron, daily:
#   crontab -e
#   17 3 * * * /home/ubuntu/discord-bot-roblox/deploy/backup-offsite.sh >> /home/ubuntu/setup backup.log 2>&1
#
# Set DESTINATION to anything scp or rclone understands.

set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/data/backups}"
KEEP_LOCAL="${KEEP_LOCAL:-7}"
DESTINATION="${BACKUP_DESTINATION:-}"
EVIDENCE_DIR="${EVIDENCE_DIR:-$APP_DIR/data/evidence}"

STAMP="$(date -u +%Y-%m-%dT%H-%M-%S)"
TARGET="$BACKUP_DIR/studio-$STAMP.sqlite"

mkdir -p "$BACKUP_DIR"

# SQLite's own backup, not cp: a copy taken mid-write produces a file that
# looks fine and is not.
sqlite3 "${DATABASE_FILE:-$APP_DIR/data/setup.db}" ".backup '$TARGET'"

# A backup nobody has opened is a hope. Open it.
if ! sqlite3 "$TARGET" "PRAGMA integrity_check;" | grep -q '^ok$'; then
  echo "$(date -u +%FT%TZ) FAILED: $TARGET did not pass its integrity check" >&2
  rm -f "$TARGET"
  exit 1
fi

SIZE="$(du -h "$TARGET" | cut -f1)"
echo "$(date -u +%FT%TZ) wrote and verified $TARGET ($SIZE)"

# The filed proof lives on disk, not in the database — the database holds only
# each file's hash and path. Without these files a restore comes back with a
# full set of proof records that all read as missing, which looks like the
# proof was deleted. So they travel with the backup.
EVIDENCE_ARCHIVE=""
if [ -d "$EVIDENCE_DIR" ] && [ -n "$(ls -A "$EVIDENCE_DIR" 2>/dev/null)" ]; then
  EVIDENCE_ARCHIVE="$BACKUP_DIR/studio-$STAMP-evidence.tar.gz"
  tar -czf "$EVIDENCE_ARCHIVE" -C "$EVIDENCE_DIR" .
  # Opened, like the database copy: an archive nobody has read is a hope.
  if ! tar -tzf "$EVIDENCE_ARCHIVE" >/dev/null 2>&1; then
    echo "$(date -u +%FT%TZ) FAILED: $EVIDENCE_ARCHIVE did not read back" >&2
    rm -f "$EVIDENCE_ARCHIVE"
    exit 1
  fi
  echo "$(date -u +%FT%TZ) wrote and verified $EVIDENCE_ARCHIVE ($(du -h "$EVIDENCE_ARCHIVE" | cut -f1))"
else
  echo "$(date -u +%FT%TZ) no filed proof to copy"
fi

if [ -n "$DESTINATION" ]; then
  if command -v rclone >/dev/null && [[ "$DESTINATION" == *:* && "$DESTINATION" != *@*:* ]]; then
    rclone copy "$TARGET" "$DESTINATION"
    if [ -n "$EVIDENCE_ARCHIVE" ]; then rclone copy "$EVIDENCE_ARCHIVE" "$DESTINATION"; fi
  else
    scp -q "$TARGET" "$DESTINATION"
    if [ -n "$EVIDENCE_ARCHIVE" ]; then scp -q "$EVIDENCE_ARCHIVE" "$DESTINATION"; fi
  fi
  echo "$(date -u +%FT%TZ) copied to $DESTINATION"
else
  echo "$(date -u +%FT%TZ) WARNING: BACKUP_DESTINATION is not set, so this backup is still on the same disk as the database"
fi

# Old local copies are pruned only after a successful run, so a failing job
# never deletes the last good backup.
ls -1t "$BACKUP_DIR"/studio-*.sqlite 2>/dev/null | tail -n +"$((KEEP_LOCAL + 1))" | xargs -r rm --
ls -1t "$BACKUP_DIR"/studio-*-evidence.tar.gz 2>/dev/null | tail -n +"$((KEEP_LOCAL + 1))" | xargs -r rm --
