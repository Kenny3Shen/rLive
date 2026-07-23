#!/usr/bin/env bash
# From WSL: sync to D:\dev\rLive then invoke Windows PowerShell build.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST_MNT="${DEST_MNT:-/mnt/d/dev/rLive}"
DEST_WIN="${DEST_WIN:-D:\\dev\\rLive}"
BUNDLES="${BUNDLES:-nsis}"

if ! command -v powershell.exe >/dev/null 2>&1; then
  echo "error: powershell.exe not found (need WSL with Windows interop)" >&2
  exit 1
fi

if [[ ! -d /mnt/d ]]; then
  echo "error: /mnt/d not found" >&2
  exit 1
fi

"$ROOT/scripts/sync-to-windows.sh"

echo "== windows build via powershell.exe =="
echo "  root: $DEST_WIN"
echo "  bundles: $BUNDLES"

# Run the PowerShell script on the Windows side (MSVC/WebView2 toolchain).
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command \
  "Set-Location '$DEST_WIN'; & '.\\scripts\\build-windows.ps1' -ProjectRoot '$DEST_WIN' -Bundles $BUNDLES"

echo "OK: see $DEST_WIN\\src-tauri\\target\\release\\"
