# Build rLive on Windows. Project default: D:\dev\rLive
# Prerequisites: VS Build Tools on D:\VS\BuildTools, Rust on D:\dev\rust, Node on PATH
param(
    [string]$ProjectRoot = "D:\dev\rLive",
    [switch]$BundleNsis
)

$ErrorActionPreference = "Stop"
$env:CARGO_HOME  = if ($env:CARGO_HOME)  { $env:CARGO_HOME }  else { "D:\dev\rust\cargo" }
$env:RUSTUP_HOME = if ($env:RUSTUP_HOME) { $env:RUSTUP_HOME } else { "D:\dev\rust\rustup" }
$env:TEMP = "D:\Temp\build"
$env:TMP  = "D:\Temp\build"
New-Item -ItemType Directory -Force -Path $env:TEMP | Out-Null

$env:Path = "$env:CARGO_HOME\bin;D:\Program Files\nodejs;" +
  [Environment]::GetEnvironmentVariable("Path","Machine") + ";" +
  [Environment]::GetEnvironmentVariable("Path","User")

$vcvars = @(
  "D:\VS\BuildTools\VC\Auxiliary\Build\vcvars64.bat",
  "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $vcvars) { throw "vcvars64.bat not found. Install VS Build Tools (VCTools)." }

Set-Location $ProjectRoot
if (Get-Command bun -EA SilentlyContinue) {
  bun install
  $build = if ($BundleNsis) { "bunx tauri build --bundles nsis" } else { "bunx tauri build --no-bundle" }
} else {
  npm install --no-fund --no-audit
  $build = if ($BundleNsis) { "npx tauri build --bundles nsis" } else { "npx tauri build --no-bundle" }
}

$cmd = "call `"$vcvars`" && cd /d `"$ProjectRoot`" && set CARGO_HOME=$env:CARGO_HOME&& set RUSTUP_HOME=$env:RUSTUP_HOME&& $build"
Write-Host $cmd
cmd.exe /c $cmd
if ($LASTEXITCODE -ne 0) { throw "tauri build failed: $LASTEXITCODE" }

$exe = Join-Path $ProjectRoot "src-tauri\target\release\rlive.exe"
Write-Host "OK: $exe ($((Get-Item $exe).Length) bytes)" -ForegroundColor Green
