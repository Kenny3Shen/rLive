#!/usr/bin/env bash
# From WSL: sync to the configured Windows mirror then invoke the Windows build.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT/scripts/windows-sync-config.sh"
load_windows_sync_config "$ROOT"

DEST_MNT="$WINDOWS_SYNC_PATH_MNT"
DEST_WIN="$WINDOWS_SYNC_PATH_WIN"
DEST_PARENT_MNT="$(dirname "$DEST_MNT")"
LOG_MNT="${LOG_MNT:-$DEST_PARENT_MNT/logs}"
TEMP_MNT="${TEMP_MNT:-$DEST_PARENT_MNT/Temp/build}"
LOG_WIN="${LOG_WIN:-$(wslpath -w -- "$LOG_MNT/build-windows.txt")}"
TEMP_WIN="${TEMP_WIN:-$(wslpath -w -- "$TEMP_MNT")}"

"$ROOT/scripts/sync-to-windows.sh"

echo "== windows build =="
echo "  root: $DEST_WIN"
echo "  log:  $LOG_WIN"

mkdir -p "$LOG_MNT" "$TEMP_MNT"

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
WRAPPER="$DEST_PARENT_MNT/run-rlive-build.ps1"
WRAPPER_WIN="$(wslpath -w -- "$WRAPPER")"
cat > "$WRAPPER" << 'EOF'
param(
    [Parameter(Mandatory=$true)]
    [string]$LogPath,
    [Parameter(Mandatory=$true)]
    [string]$ProjectRoot,
    [Parameter(Mandatory=$true)]
    [string]$TempPath
)

$ErrorActionPreference = "Continue"
$env:CARGO_HOME = if ($env:CARGO_HOME) { $env:CARGO_HOME } else { "D:\dev\rust\cargo" }
$env:RUSTUP_HOME = if ($env:RUSTUP_HOME) { $env:RUSTUP_HOME } else { "D:\dev\rust\rustup" }
$env:TEMP = $TempPath
$env:TMP = $TempPath
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $LogPath),$TempPath | Out-Null
Set-Location $ProjectRoot
& (Join-Path $ProjectRoot "scripts\build-windows.ps1") *>&1 | Tee-Object -FilePath $LogPath
$code = $LASTEXITCODE
if ($null -eq $code) { $code = 0 }
Write-Host "BUILD_EXIT=$code"
exit $code
EOF

ps_build_args=(-LogPath "$LOG_WIN")

if [[ -x "$INIT" || -f "$INIT" ]]; then
  "$INIT" "$PS_EXE" -NoProfile -ExecutionPolicy Bypass -File "$WRAPPER_WIN" "${ps_build_args[@]}" -ProjectRoot "$DEST_WIN" -TempPath "$TEMP_WIN"
else
  "$PS_EXE" -NoProfile -ExecutionPolicy Bypass -File "$WRAPPER_WIN" "${ps_build_args[@]}" -ProjectRoot "$DEST_WIN" -TempPath "$TEMP_WIN"
fi

code=$?
if [[ $code -ne 0 ]]; then
  echo "error: windows build failed (exit $code). See $LOG_WIN" >&2
  # Best-effort tail for WSL logs
  if [[ -f "$LOG_MNT/build-windows.txt" ]]; then
    tail -c 6000 "$LOG_MNT/build-windows.txt" | tr -d '\000' | tail -40 || true
  fi
  exit "$code"
fi

EXE="$DEST_MNT/src-tauri/target/release/rlive.exe"
if [[ ! -f "$EXE" ]]; then
  echo "error: build reported success but EXE missing: $EXE" >&2
  exit 1
fi

printf 'OK: %s\\src-tauri\\target\\release\\rlive.exe (%s bytes)\n' \
  "$DEST_WIN" "$(stat -c%s "$EXE" 2>/dev/null || echo '?')"
