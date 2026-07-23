#!/usr/bin/env bash
# Sync WSL workspace → D:\dev\rLive (/mnt/d/dev/rLive)
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
DEST_MNT="${DEST_MNT:-/mnt/d/dev/rLive}"
DEST_WIN="${DEST_WIN:-D:\\dev\\rLive}"

if [[ ! -d /mnt/d ]]; then
  echo "error: /mnt/d not found (is D: mounted in WSL?)" >&2
  exit 1
fi

mkdir -p "$DEST_MNT"

echo "== sync =="
echo "  from: $SRC"
echo "  to:   $DEST_MNT  ($DEST_WIN)"

# Exclude build caches and VCS noise; keep source + configs.
rsync -a --delete \
  --exclude '.git/' \
  --exclude 'node_modules/' \
  --exclude 'dist/' \
  --exclude 'src-tauri/target/' \
  --exclude '.playwright-cli/' \
  --exclude '.superpowers/' \
  --exclude '.worktrees/' \
  --exclude '*.log' \
  "$SRC/" "$DEST_MNT/"

echo "OK: synced to $DEST_WIN"
