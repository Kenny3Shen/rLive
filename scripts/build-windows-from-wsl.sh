#!/usr/bin/env bash
# From WSL: sync to D:\dev\rLive then invoke Windows PowerShell build.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST_MNT="${DEST_MNT:-/mnt/d/dev/rLive}"
DEST_WIN="${DEST_WIN:-D:\\dev\\rLive}"
LOG_WIN="${LOG_WIN:-D:\\dev\\logs\\build-windows.txt}"

# Optional: pass -BundleNsis to the PS script.
EXTRA_PS_ARGS="${EXTRA_PS_ARGS:-}"
BUNDLE_NSIS="${BUNDLE_NSIS:-0}"
if [[ "$EXTRA_PS_ARGS" == *"-BundleNsis"* ]]; then
  BUNDLE_NSIS=1
fi
case "$BUNDLE_NSIS" in
  0 | 1) ;;
  *)
    echo "error: BUNDLE_NSIS must be 0 or 1" >&2
    exit 1
    ;;
esac

if [[ ! -d /mnt/d ]]; then
  echo "error: /mnt/d not found (is D: mounted in WSL?)" >&2
  exit 1
fi

"$ROOT/scripts/sync-to-windows.sh"

echo "== windows build =="
echo "  root: $DEST_WIN"
echo "  log:  $LOG_WIN"

mkdir -p /mnt/d/dev/logs /mnt/d/Temp/build

# Prefer /init + full PowerShell path (more reliable under some WSL setups).
INIT="${INIT:-/init}"
PS_EXE="${PS_EXE:-/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe}"

if [[ ! -x "$PS_EXE" && ! -f "$PS_EXE" ]]; then
  if command -v powershell.exe >/dev/null 2>&1; then
    PS_EXE="$(command -v powershell.exe)"
  else
    echo "error: powershell.exe not found" >&2
    exit 1
  fi
fi

# Wrapper avoids Stop + native stderr aborting build-windows.ps1 early.
WRAPPER="/mnt/d/dev/run-rlive-build.ps1"
cat > "$WRAPPER" << 'EOF'
param(
    [switch]$BundleNsis
)

$ErrorActionPreference = "Continue"
$env:CARGO_HOME = if ($env:CARGO_HOME) { $env:CARGO_HOME } else { "D:\dev\rust\cargo" }
$env:RUSTUP_HOME = if ($env:RUSTUP_HOME) { $env:RUSTUP_HOME } else { "D:\dev\rust\rustup" }
$env:TEMP = "D:\Temp\build"
$env:TMP = "D:\Temp\build"
New-Item -ItemType Directory -Force -Path "D:\dev\logs","D:\Temp\build" | Out-Null
Set-Location "D:\dev\rLive"
if ($BundleNsis) {
  & ".\scripts\build-windows.ps1" -BundleNsis *>&1 | Tee-Object -FilePath "D:\dev\logs\build-windows.txt"
} else {
  & ".\scripts\build-windows.ps1" *>&1 | Tee-Object -FilePath "D:\dev\logs\build-windows.txt"
}
$code = $LASTEXITCODE
if ($null -eq $code) { $code = 0 }
Write-Host "BUILD_EXIT=$code"
exit $code
EOF

ps_build_args=()
if [[ "$BUNDLE_NSIS" == "1" ]]; then
  ps_build_args=(-BundleNsis)
fi

if [[ -x "$INIT" || -f "$INIT" ]]; then
  "$INIT" "$PS_EXE" -NoProfile -ExecutionPolicy Bypass -File "D:\dev\run-rlive-build.ps1" "${ps_build_args[@]}"
else
  "$PS_EXE" -NoProfile -ExecutionPolicy Bypass -File "D:\dev\run-rlive-build.ps1" "${ps_build_args[@]}"
fi

code=$?
if [[ $code -ne 0 ]]; then
  echo "error: windows build failed (exit $code). See $LOG_WIN" >&2
  # Best-effort tail for WSL logs
  if [[ -f /mnt/d/dev/logs/build-windows.txt ]]; then
    tail -c 6000 /mnt/d/dev/logs/build-windows.txt | tr -d '\000' | tail -40 || true
  fi
  exit "$code"
fi

EXE="$DEST_MNT/src-tauri/target/release/rlive.exe"
if [[ ! -f "$EXE" ]]; then
  echo "error: build reported success but EXE missing: $EXE" >&2
  exit 1
fi

echo "OK: $DEST_WIN\\src-tauri\\target\\release\\rlive.exe ($(stat -c%s "$EXE" 2>/dev/null || echo '?') bytes)"
