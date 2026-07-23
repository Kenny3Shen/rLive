#!/usr/bin/env bash
# Real-machine smoke for rLive phase-1 (Bilibili + mpv + shell).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="${HOME}/.local/bin:${PATH}"
export DISPLAY="${DISPLAY:-:0}"

echo "== mpv =="
command -v mpv
mpv --version | head -1

echo "== unit + ignored live smokes =="
cd "$ROOT/src-tauri"
cargo test --lib -q
cargo test --lib -- --ignored --nocapture

echo "== frontend typecheck/build =="
cd "$ROOT"
bun run build

echo "OK: smoke finished"
