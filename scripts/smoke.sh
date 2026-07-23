#!/usr/bin/env bash
# Real-machine smoke for rLive phase-1 (Bilibili + mpv + shell).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Prefer system mpv over any user wrapper
export PATH="/usr/bin:/usr/local/bin:${HOME}/.local/bin:${PATH}"
export DISPLAY="${DISPLAY:-:0}"

echo "== mpv =="
command -v mpv
mpv --version | head -1
if [[ -x /usr/bin/mpv ]]; then
  echo "system mpv: /usr/bin/mpv"
fi

echo "== unit + ignored live smokes =="
cd "$ROOT/src-tauri"
cargo test --lib -q
cargo test --lib -- --ignored --nocapture

echo "== frontend typecheck/build =="
cd "$ROOT"
bun run build

echo "OK: smoke finished"
