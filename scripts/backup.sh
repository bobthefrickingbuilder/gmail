#!/usr/bin/env bash
# Backs up the database (consistent SQLite snapshot) + config to backups/<timestamp>.tar.gz
#   ./scripts/backup.sh                      (home server, SQLite)
#   DATABASE_URL=postgres://… ./scripts/backup.sh   (uses pg_dump)
# Restore: see docs/INSTALL.md → "Backup and restore".
set -euo pipefail
cd "$(dirname "$0")/.."
TS=$(date +%Y%m%d-%H%M%S)
DEST=${BACKUP_DIR:-backups}/$TS
mkdir -p "$DEST"
DB=${DATABASE_URL:-sqlite:./backend/data/assistant.sqlite}
if [[ "$DB" == postgres* ]]; then
  pg_dump "$DB" > "$DEST/assistant.sql"
else
  FILE=${DB#sqlite:}
  node -e 'const D=require("better-sqlite3"); const db=new D(process.argv[1],{readonly:true}); db.backup(process.argv[2]).then(()=>console.log("sqlite snapshot ok"))' "$FILE" "$DEST/assistant.sqlite"
fi
cp -r config "$DEST/config"
tar -czf "$DEST.tar.gz" -C "$(dirname "$DEST")" "$TS" && rm -rf "$DEST"
chmod 600 "$DEST.tar.gz"
echo "Backup written: $DEST.tar.gz  (contains encrypted tokens; keep ENCRYPTION_KEY separately to restore them)"
# keep the 30 newest
ls -1t "${BACKUP_DIR:-backups}"/*.tar.gz 2>/dev/null | tail -n +31 | xargs -r rm -f
