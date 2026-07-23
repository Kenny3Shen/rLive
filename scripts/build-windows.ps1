# Build rLive Windows bundle (run in Windows PowerShell / Terminal, NOT WSL bash).
# Default project root: D:\dev\rLive
#
# Prerequisites (Windows):
#   - Rust (x86_64-pc-windows-msvc)
#   - Visual Studio Build Tools 2022 (C++ desktop)
#   - WebView2 Runtime
#   - Bun (https://bun.sh)
#   - Optional: NSIS for .exe installer
#
# Usage:
#   cd D:\dev\rLive
#   .\scripts\build-windows.ps1
#   .\scripts\build-windows.ps1 -Bundles nsis
#   .\scripts\build-windows.ps1 -SkipInstall

param(
    [string]$ProjectRoot = "D:\dev\rLive",
    [ValidateSet("nsis", "msi", "all", "none")]
    [string]$Bundles = "nsis",
    [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"

function Assert-Command($Name) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command not found: $Name"
    }
}

Write-Host "== rLive Windows build ==" -ForegroundColor Cyan
Write-Host "ProjectRoot: $ProjectRoot"

if (-not (Test-Path $ProjectRoot)) {
    throw "Project root does not exist: $ProjectRoot"
}

Set-Location $ProjectRoot

Assert-Command cargo
Assert-Command rustc

$rustcHost = (rustc -vV | Select-String "host:").ToString()
Write-Host $rustcHost
if ($rustcHost -notmatch "windows") {
    Write-Warning "rustc host does not look like Windows. Build from Windows PowerShell, not WSL."
}

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    throw "bun not found. Install from https://bun.sh then re-open the terminal."
}

if (-not $SkipInstall) {
    Write-Host "== bun install ==" -ForegroundColor Cyan
    bun install
}

Write-Host "== tauri build ==" -ForegroundColor Cyan
if ($Bundles -eq "none") {
    bunx tauri build --no-bundle
} elseif ($Bundles -eq "all") {
    bunx tauri build
} else {
    bunx tauri build --bundles $Bundles
}

$releaseDir = Join-Path $ProjectRoot "src-tauri\target\release"
$exe = Join-Path $releaseDir "rlive.exe"
$bundleDir = Join-Path $releaseDir "bundle"

Write-Host ""
Write-Host "== outputs ==" -ForegroundColor Green
if (Test-Path $exe) {
    Write-Host "EXE: $exe"
} else {
    Write-Warning "rlive.exe not found under $releaseDir (check build log)"
}
if (Test-Path $bundleDir) {
    Get-ChildItem -Path $bundleDir -Recurse -Include *.exe,*.msi | ForEach-Object {
        Write-Host "BUNDLE: $($_.FullName)"
    }
}

Write-Host "Done." -ForegroundColor Green
