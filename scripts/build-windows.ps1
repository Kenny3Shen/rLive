# Build rLive on Windows. Default project: D:\dev\rLive
#
# Prerequisites:
#   - VS Build Tools: D:\VS\BuildTools (vcvars64.bat)
#   - Rust: D:\dev\rust\{cargo,rustup}  (or CARGO_HOME / RUSTUP_HOME)
#   - bun and/or Node.js
#
# Usage:
#   cd D:\dev\rLive
#   .\scripts\build-windows.ps1
#   .\scripts\build-windows.ps1 -BundleNsis

param(
    [string]$ProjectRoot = "D:\dev\rLive",
    [switch]$BundleNsis
)

$ErrorActionPreference = "Stop"

function Write-Step([string]$Msg) {
    Write-Host ""
    Write-Host "== $Msg ==" -ForegroundColor Cyan
}

Write-Step "rLive Windows build"
Write-Host "ProjectRoot: $ProjectRoot"

if (-not (Test-Path $ProjectRoot)) {
    throw "Project root not found: $ProjectRoot"
}

# --- D: defaults for toolchain / caches ---
$env:CARGO_HOME  = if ($env:CARGO_HOME)  { $env:CARGO_HOME }  else { "D:\dev\rust\cargo" }
$env:RUSTUP_HOME = if ($env:RUSTUP_HOME) { $env:RUSTUP_HOME } else { "D:\dev\rust\rustup" }
$env:TEMP = "D:\Temp\build"
$env:TMP  = "D:\Temp\build"
New-Item -ItemType Directory -Force -Path $env:TEMP | Out-Null

# Ensure bun/cargo/node are findable (new shells + winget locations)
$extraPath = @(
    "D:\dev\bun\bin",
    "$env:CARGO_HOME\bin",
    "D:\Program Files\nodejs",
    "$env:LOCALAPPDATA\Microsoft\WinGet\Links",
    "$env:USERPROFILE\.bun\bin"
) -join ";"

$env:Path = $extraPath + ";" +
    [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
    [Environment]::GetEnvironmentVariable("Path", "User")

# Resolve bun.exe (winget may not install bunx as a real binary)
$bunCmd = Get-Command bun -ErrorAction SilentlyContinue
if (-not $bunCmd) {
    $candidates = @(
        "D:\dev\bun\bin\bun.exe",
        "$env:USERPROFILE\.bun\bin\bun.exe"
    ) + @(
        Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" -Recurse -Filter "bun.exe" -ErrorAction SilentlyContinue |
            Select-Object -First 3 -ExpandProperty FullName
    )
    foreach ($c in $candidates) {
        if ($c -and (Test-Path $c)) {
            $env:Path = (Split-Path $c -Parent) + ";" + $env:Path
            $bunCmd = Get-Command bun -ErrorAction SilentlyContinue
            break
        }
    }
}

$vcvars = @(
    "D:\VS\BuildTools\VC\Auxiliary\Build\vcvars64.bat",
    "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat",
    "${env:ProgramFiles}\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $vcvars) {
    throw "vcvars64.bat not found. Install VS Build Tools (VCTools) to D:\VS\BuildTools."
}

$rustc = Get-Command rustc -ErrorAction SilentlyContinue
if ($rustc) {
    Write-Host (& rustc -vV | Select-String "^host:").ToString()
} else {
    Write-Warning "rustc not on PATH (expected under $env:CARGO_HOME\bin)"
}

Set-Location $ProjectRoot

# Prefer local CLI via package.json script: "tauri": "tauri"
# (winget bun often has no bunx.exe; `bun x tauri` may not resolve the binary either)
$tauriArgs = if ($BundleNsis) { "build --bundles nsis" } else { "build --no-bundle" }

if ($bunCmd) {
    Write-Step "bun install"
    & bun install
    if ($LASTEXITCODE -ne 0) { throw "bun install failed: $LASTEXITCODE" }

    # bun run <script> -- <args>
    $buildInner = "bun run tauri -- $tauriArgs"
    Write-Host "Using: $buildInner"
} else {
    Write-Step "npm install (bun not found)"
    $npm = Get-Command npm -ErrorAction SilentlyContinue
    if (-not $npm) { throw "Neither bun nor npm found on PATH." }
    & npm install --no-fund --no-audit
    if ($LASTEXITCODE -ne 0) { throw "npm install failed: $LASTEXITCODE" }
    $buildInner = "npx tauri $tauriArgs"
    Write-Host "Using: $buildInner"
}

Write-Step "tauri build (via vcvars64)"
$cmd = "call `"$vcvars`" && cd /d `"$ProjectRoot`" && set CARGO_HOME=$env:CARGO_HOME&& set RUSTUP_HOME=$env:RUSTUP_HOME&& set TEMP=$env:TEMP&& set TMP=$env:TMP&& $buildInner"
Write-Host $cmd
# bun/cargo write progress to stderr; with $ErrorActionPreference=Stop that becomes
# a terminating NativeCommandError and aborts before the build finishes.
$prevEap = $ErrorActionPreference
$ErrorActionPreference = "Continue"
cmd.exe /c $cmd
$buildCode = $LASTEXITCODE
$ErrorActionPreference = $prevEap
if ($buildCode -ne 0) { throw "tauri build failed: $buildCode" }

$exe = Join-Path $ProjectRoot "src-tauri\target\release\rlive.exe"
if (-not (Test-Path $exe)) {
    throw "Build reported success but EXE missing: $exe"
}

# Ensure libmpv runtime sits next to the EXE (required for in-process playback).
Write-Step "libmpv-2.dll next to rlive.exe"
$releaseDir = Split-Path $exe -Parent
$dllCandidates = @(
    (Join-Path $ProjectRoot "vendor\libmpv-windows\libmpv-2.dll"),
    "D:\dev\tools\mpv\libmpv-2.dll"
)
$dllSrc = $dllCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($dllSrc) {
    Copy-Item -Force $dllSrc (Join-Path $releaseDir "libmpv-2.dll")
    Copy-Item -Force $dllSrc (Join-Path $releaseDir "mpv-2.dll")
    Write-Host "OK: copied libmpv from $dllSrc"
} else {
    Write-Warning "libmpv-2.dll not found. Run scripts/fetch-libmpv-windows.sh then rebuild, or playback will fail with libmpv_load_error."
}

Write-Host ""
Write-Host "OK: $exe ($((Get-Item $exe).Length) bytes)" -ForegroundColor Green
