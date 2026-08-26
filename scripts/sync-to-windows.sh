#!/usr/bin/env bash
# 把 WSL 工作区同步到配置好的 Windows 镜像目录。
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

# 排除构建缓存和版本控制噪音，只保留源码与配置。Android 的 Gradle
# 中间产物可能包含数 GB 的 APK，且可在本地重新生成。
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
