#!/usr/bin/env bash
# From WSL: sync to the configured Windows mirror then start Tauri development.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT/scripts/windows-sync-config.sh"
load_windows_sync_config "$ROOT"

DEST_MNT="$WINDOWS_SYNC_PATH_MNT"
DEST_WIN="$WINDOWS_SYNC_PATH_WIN"
DEST_PARENT_MNT="$(dirname "$DEST_MNT")"
LOG_MNT="${LOG_MNT:-$DEST_PARENT_MNT/logs}"
TEMP_MNT="${TEMP_MNT:-$DEST_PARENT_MNT/Temp/build}"
LOG_WIN="${LOG_WIN:-$(wslpath -w -- "$LOG_MNT/build-windows-dev.txt")}"
TEMP_WIN="${TEMP_WIN:-$(wslpath -w -- "$TEMP_MNT")}"

"$ROOT/scripts/sync-to-windows.sh"

echo "== windows tauri dev =="
echo "  root: $DEST_WIN"
echo "  log:  $LOG_WIN"

mkdir -p "$LOG_MNT" "$TEMP_MNT"

# Direct PowerShell interop avoids /init's optional preset-file integration;
# callers can still opt into an alternate launcher with INIT explicitly.
INIT="${INIT:-}"
PS_EXE="${PS_EXE:-/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe}"

if [[ ! -x "$PS_EXE" && ! -f "$PS_EXE" ]]; then
  if command -v powershell.exe >/dev/null 2>&1; then
    PS_EXE="$(command -v powershell.exe)"
  else
    echo "error: powershell.exe not found" >&2
    exit 1
  fi
fi

# Wrapper keeps the Windows toolchain setup and the long-running dev process
# in one PowerShell process, while teeing native output into a WSL-readable log.
WRAPPER="$DEST_PARENT_MNT/run-rlive-dev.ps1"
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
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
$llvmPath = [Environment]::GetEnvironmentVariable("LIBCLANG_PATH", "User")
if (-not $llvmPath) { $llvmPath = "D:\dev\LLVM-22.1.8\bin" }
$env:LIBCLANG_PATH = $llvmPath
$env:Path = @(
    "D:\dev\bun\bin",
    "$env:CARGO_HOME\bin",
    $llvmPath,
    $userPath,
    $machinePath
) -join ";"

$vcvars = @(
    "D:\VS\BuildTools\VC\Auxiliary\Build\vcvars64.bat",
    "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat",
    "${env:ProgramFiles}\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $vcvars) { throw "vcvars64.bat not found. Install Visual Studio C++ Build Tools." }

$prepare = Join-Path $ProjectRoot "scripts\prepare-windows-ffmpeg.ps1"
$prepareCode = 0
try {
    & $prepare -ProjectRoot $ProjectRoot *>&1 | Tee-Object -FilePath $LogPath
    if (-not $?) { $prepareCode = 1 }
} catch {
    $prepareCode = 1
    Write-Error $_
}
if ($prepareCode -ne 0) { throw "Windows build environment preparation failed: $prepareCode" }

$env:SHERPA_ONNX_GPU = if ($env:SHERPA_ONNX_GPU) { $env:SHERPA_ONNX_GPU } else { "1" }
$cmd = "call `"$vcvars`" && cd /d `"$ProjectRoot`" && set CARGO_HOME=$env:CARGO_HOME&& set RUSTUP_HOME=$env:RUSTUP_HOME&& set TEMP=$env:TEMP&& set TMP=$env:TMP&& bun install && bun run tauri dev"
Write-Host $cmd
$ErrorActionPreference = "Continue"
cmd.exe /d /c "$cmd 2>&1" | Tee-Object -FilePath $LogPath -Append
$code = $LASTEXITCODE
if ($null -eq $code) { $code = 0 }
Write-Host "TAURI_DEV_EXIT=$code"
exit $code
EOF

ps_dev_args=(-LogPath "$LOG_WIN")

if [[ -x "$INIT" || -f "$INIT" ]]; then
  "$INIT" "$PS_EXE" -NoProfile -ExecutionPolicy Bypass -File "$WRAPPER_WIN" "${ps_dev_args[@]}" -ProjectRoot "$DEST_WIN" -TempPath "$TEMP_WIN"
else
  "$PS_EXE" -NoProfile -ExecutionPolicy Bypass -File "$WRAPPER_WIN" "${ps_dev_args[@]}" -ProjectRoot "$DEST_WIN" -TempPath "$TEMP_WIN"
fi

code=$?
if [[ $code -ne 0 ]]; then
  echo "error: windows tauri dev failed (exit $code). See $LOG_WIN" >&2
  # Best-effort tail for WSL logs
  if [[ -f "$LOG_MNT/build-windows-dev.txt" ]]; then
    tail -c 6000 "$LOG_MNT/build-windows-dev.txt" | tr -d '\000' | tail -40 || true
  fi
  exit "$code"
fi

printf 'Tauri dev process stopped cleanly for %s\n' "$DEST_WIN"
