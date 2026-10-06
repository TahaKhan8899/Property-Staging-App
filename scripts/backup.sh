#!/bin/bash
# Nightly backup of the SQLite DB + uploaded/staged images to the work Google Drive.
# Run by ~/Library/LaunchAgents/com.airenosystems.staging-backup.plist (daily 2am).
#   - DB: consistent online snapshot via sqlite .backup (safe while the server runs in WAL mode),
#     dated copies, last $KEEP kept
#   - uploads/: rsync mirror, only changed files are copied (deletions propagate)
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$HOME/Library/CloudStorage/GoogleDrive-taha@airenosystems.com/My Drive/Backups/Property-Staging-App"
KEEP=7

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*"; }

if [ ! -d "$(dirname "$(dirname "$DEST")")" ]; then
  log "ERROR: Google Drive not mounted at $DEST"
  exit 1
fi
mkdir -p "$DEST/db" "$DEST/uploads"

# launchd fires hourly + at login; only the first run of the day does work. --force to run anyway.
if [ "${1:-}" != "--force" ] && compgen -G "$DEST/db/database_$(date '+%Y-%m-%d')_*.sqlite" > /dev/null; then
  exit 0
fi

# DB snapshot: write locally first, then move, so Drive never syncs a half-written file
STAMP="$(date '+%Y-%m-%d_%H%M')"
TMP="$(mktemp -t staging-db)"
trap 'rm -f "$TMP"' EXIT
/usr/bin/sqlite3 "$APP_DIR/database.sqlite" ".backup '$TMP'"
/usr/bin/sqlite3 "$TMP" "PRAGMA integrity_check;" | grep -qx ok || { log "ERROR: snapshot failed integrity check"; rm -f "$TMP"; exit 1; }
mv "$TMP" "$DEST/db/database_$STAMP.sqlite"
log "DB snapshot: database_$STAMP.sqlite ($(du -h "$DEST/db/database_$STAMP.sqlite" | cut -f1))"

# Images: mirror
/usr/bin/rsync -a --delete "$APP_DIR/server/uploads/" "$DEST/uploads/"
log "uploads/ synced ($(du -sh "$DEST/uploads" | cut -f1))"

# Keep only the newest $KEEP snapshots. Drive's file provider occasionally lists the folder as
# empty right after a write; tolerate that rather than failing (pruning catches up next run).
{ ls -1t "$DEST/db"/database_*.sqlite 2>/dev/null || true; } | tail -n +$((KEEP + 1)) | while read -r old; do
  rm -f "$old"
  log "Pruned $(basename "$old")"
done
log "Backup OK"
