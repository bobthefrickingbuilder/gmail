#!/usr/bin/env bash
# Restores a backup made by backup.sh. Stop the backend first.
#   ./scripts/restore.sh backups/20261101-030000.tar.gz
set -euo pipefail
cd "$(dirname "$0")/.."
ARCHIVE=${1:?Usage: restore.sh <backup.tar.gz>}
TMP=$(mktemp -d); tar -xzf "$ARCHIVE" -C "$TMP"; SRC=$(echo "$TMP"/*)
DB=${DATABASE_URL:-sqlite:./backend/data/assistant.sqlite}
if [ -f "$SRC/assistant.sql" ]; then psql "$DB" < "$SRC/assistant.sql"
else FILE=${DB#sqlite:}; mkdir -p "$(dirname "$FILE")"; [ -f "$FILE" ] && mv "$FILE" "$FILE.before-restore.$(date +%s)"; cp "$SRC/assistant.sqlite" "$FILE"; fi
echo "Restored database. Config from the backup is in $SRC/config (copy back only if you want those versions)."
