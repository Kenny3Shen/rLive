#!/usr/bin/env bash
# Sync the WSL workspace to the configured Windows mirror.
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
source "$SRC/scripts/windows-sync-config.sh"
load_windows_sync_config "$SRC"

DEST_MNT="$WINDOWS_SYNC_PATH_MNT"
DEST_WIN="$WINDOWS_SYNC_PATH_WIN"

mkdir -p "$DEST_MNT"

echo "== sync =="
echo "  from: $SRC"
echo "  to:   $DEST_MNT  ($DEST_WIN)"

# Exclude build caches and VCS noise; keep source + configs. Android's Gradle
# intermediates can contain multi-gigabyte APKs and are regenerated locally.
rsync -a --delete \
  --exclude '.git/' \
  --exclude 'node_modules/' \
  --exclude 'dist/' \
  --exclude 'src-tauri/target/' \
  --exclude 'src-tauri/gen/android/.gradle/' \
  --exclude 'src-tauri/gen/android/build/' \
  --exclude 'src-tauri/gen/android/app/.cxx/' \
  --exclude 'src-tauri/gen/android/app/build/' \
  --exclude 'src-tauri/gen/android/app/src/main/assets/' \
  --exclude 'src-tauri/gen/android/app/key.properties' \
  --exclude 'src-tauri/gen/android/app/keystore.properties' \
  --exclude '.playwright-cli/' \
  --exclude 'scripts/windows-sync.conf' \
  --exclude '.superpowers/' \
  --exclude '.worktrees/' \
  --exclude '*.log' \
  "$SRC/" "$DEST_MNT/"

echo "OK: synced to $DEST_WIN"
