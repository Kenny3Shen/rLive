#!/usr/bin/env bash
# Fetch Windows libmpv-2.dll (x86_64) and install next to the release EXE.
#
# Usage (from repo root):
#   ./scripts/fetch-libmpv-windows.sh
#   ./scripts/fetch-libmpv-windows.sh --copy-only   # use existing vendor DLL
#
# Destinations:
#   vendor/libmpv-windows/libmpv-2.dll
#   D:\dev\tools\mpv\libmpv-2.dll          (if /mnt/d/dev/tools exists)
#   src-tauri/target/release/libmpv-2.dll  (if release dir exists)
#   /mnt/d/dev/rLive/...                   (Windows mirror, if present)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR="$ROOT/vendor/libmpv-windows"
CACHE="${LIBMPV_CACHE:-/tmp/libmpv-fetch}"
# zhongfly/mpv-winbuild mpv-dev package (contains libmpv-2.dll).
TAG="${LIBMPV_TAG:-2026-07-24-0fb136f685}"
ASSET="${LIBMPV_ASSET:-mpv-dev-x86_64-20260724-git-0fb136f685.7z}"
URL="https://github.com/zhongfly/mpv-winbuild/releases/download/${TAG}/${ASSET}"

mkdir -p "$VENDOR" "$CACHE"

copy_dll() {
  local src="$1"
  local dests=(
    "$VENDOR/libmpv-2.dll"
  )
  if [[ -d "$ROOT/src-tauri/target/release" ]]; then
    dests+=("$ROOT/src-tauri/target/release/libmpv-2.dll")
    dests+=("$ROOT/src-tauri/target/release/mpv-2.dll")
  fi
  if [[ -d /mnt/d/dev/tools ]]; then
    mkdir -p /mnt/d/dev/tools/mpv
    dests+=(/mnt/d/dev/tools/mpv/libmpv-2.dll)
    dests+=(/mnt/d/dev/tools/mpv/mpv-2.dll)
  fi
  if [[ -d /mnt/d/dev/rLive/src-tauri/target/release ]]; then
    dests+=(/mnt/d/dev/rLive/src-tauri/target/release/libmpv-2.dll)
    dests+=(/mnt/d/dev/rLive/src-tauri/target/release/mpv-2.dll)
  fi
  if [[ -d /mnt/d/dev/rLive ]]; then
    mkdir -p /mnt/d/dev/rLive/vendor/libmpv-windows
    dests+=(/mnt/d/dev/rLive/vendor/libmpv-windows/libmpv-2.dll)
  fi

  for d in "${dests[@]}"; do
    mkdir -p "$(dirname "$d")"
    if [[ "$(realpath -m "$src")" != "$(realpath -m "$d")" ]]; then cp -f "$src" "$d"; else echo "OK: $d (already in place)"; fi
    echo "OK: $d ($(stat -c%s "$d") bytes)"
  done
}

if [[ "${1:-}" == "--copy-only" ]]; then
  if [[ ! -f "$VENDOR/libmpv-2.dll" ]]; then
    echo "missing $VENDOR/libmpv-2.dll — run without --copy-only first" >&2
    exit 1
  fi
  copy_dll "$VENDOR/libmpv-2.dll"
  exit 0
fi

if ! command -v 7z >/dev/null 2>&1; then
  echo "7z not found. Install p7zip-full (apt) or 7-Zip." >&2
  exit 1
fi

ARC="$CACHE/$ASSET"
if [[ ! -f "$ARC" ]] || [[ "$(stat -c%s "$ARC")" -lt 1000000 ]]; then
  echo "Downloading $URL"
  curl -L --retry 3 -o "$ARC" "$URL"
fi

OUT="$CACHE/out-$$"
rm -rf "$OUT"
mkdir -p "$OUT"
7z x -y "-o$OUT" "$ARC" >/dev/null
DLL="$(find "$OUT" -name 'libmpv-2.dll' -print -quit)"
if [[ -z "$DLL" ]]; then
  echo "libmpv-2.dll not found inside archive" >&2
  exit 1
fi

cp -f "$DLL" "$VENDOR/libmpv-2.dll"
copy_dll "$VENDOR/libmpv-2.dll"
rm -rf "$OUT"
echo "Done. Restart rlive.exe so LoadLibrary picks up the DLL."
