#Requires -Version 7.0

param(
    [string]$ProjectRoot = "D:\dev\rLive",
    [string]$OutputRoot = "",
    [string]$SourceCommit = "",
    [switch]$Force
)

$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false
$ProgressPreference = "SilentlyContinue"

if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
    $OutputRoot = Join-Path $ProjectRoot "src-tauri\target\measurements\rust-2026-11-04"
}
$ProjectFull = [IO.Path]::GetFullPath($ProjectRoot)
if (-not (Test-Path $ProjectFull)) {
    throw "Project root not found: $ProjectFull"
}
Set-Location $ProjectFull
$AllowedMeasurementRoot = [IO.Path]::GetFullPath(
    (Join-Path $ProjectFull "src-tauri\target\measurements")
)
$OutputFull = [IO.Path]::GetFullPath($OutputRoot)
if (-not $OutputFull.StartsWith(
    $AllowedMeasurementRoot + [IO.Path]::DirectorySeparatorChar,
    [StringComparison]::OrdinalIgnoreCase
)) {
    throw "OutputRoot must be below $AllowedMeasurementRoot, got $OutputFull."
}
$current = $OutputFull
while ($current) {
    if (Test-Path -LiteralPath $current) {
        $attributes = (Get-Item -LiteralPath $current -Force).Attributes
        if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Refusing a measurement path that traverses a reparse point: $current"
        }
    }
    if ($current -eq $ProjectFull) {
        break
    }
    $parent = Split-Path $current -Parent
    if ($parent -eq $current) {
        throw "Could not verify that $OutputFull is below $ProjectFull."
    }
    $current = $parent
}

$CargoHome = if ($env:CARGO_HOME) { $env:CARGO_HOME } else { "D:\dev\rust\cargo" }
$RustupHome = if ($env:RUSTUP_HOME) { $env:RUSTUP_HOME } else { "D:\dev\rust\rustup" }
$env:CARGO_HOME = $CargoHome
$env:RUSTUP_HOME = $RustupHome
$env:TEMP = "D:\Temp\rlive-rust-measure"
$env:TMP = $env:TEMP
New-Item -ItemType Directory -Force -Path $env:TEMP | Out-Null

$Vcvars = @(
    "D:\VS\BuildTools\VC\Auxiliary\Build\vcvars64.bat",
    "${env:ProgramFiles}\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat",
    "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $Vcvars) {
    throw "vcvars64.bat not found."
}

# 把 vcvars64 的设置导入当前 PowerShell 进程，保证 cargo 使用 MSVC 的 cl/link。
$vcEnvironment = & cmd.exe /d /s /c "call `"$Vcvars`" >nul && set"
if ($LASTEXITCODE -ne 0) {
    throw "vcvars64.bat failed with exit code $LASTEXITCODE."
}
foreach ($line in $vcEnvironment) {
    if ($line -match "^([^=]+)=(.*)$") {
        Set-Item -Path "Env:$($Matches[1])" -Value $Matches[2]
    }
}

$Rustup = Join-Path $CargoHome "bin\rustup.exe"
if (-not (Test-Path $Rustup)) {
    throw "rustup not found at $Rustup."
}

$FfmpegDir = if ($env:FFMPEG_DIR) { $env:FFMPEG_DIR } else { "D:\dev\FFmpeg" }
$LibclangDir = if ($env:LIBCLANG_PATH) { $env:LIBCLANG_PATH } else { "D:\dev\LLVM-22.1.8\bin" }
$env:FFMPEG_DIR = $FfmpegDir
$env:LIBCLANG_PATH = $LibclangDir
$env:Path = "$CargoHome\bin;$LibclangDir;$FfmpegDir\bin;$env:Path"

$required = @(
    (Join-Path $FfmpegDir "include\libavformat\avformat.h"),
    (Join-Path $FfmpegDir "lib\avformat.lib"),
    (Join-Path $FfmpegDir "bin\avformat-63.dll"),
    (Join-Path $LibclangDir "clang.exe"),
    (Join-Path $LibclangDir "libclang.dll"),
    (Join-Path $ProjectRoot "src-tauri\Cargo.lock"),
    (Join-Path $ProjectRoot "rust-toolchain.toml")
)
foreach ($path in $required) {
    if (-not (Test-Path $path)) {
        throw "Required file not found: $path"
    }
}

if ((Test-Path $OutputFull) -and -not $Force) {
    throw "Measurement output already exists: $OutputRoot. Pass -Force to replace only this measurement directory."
}
if (Test-Path $OutputFull) {
    Remove-Item -Recurse -Force $OutputFull
}
$OutputRoot = $OutputFull
New-Item -ItemType Directory -Force -Path $OutputRoot | Out-Null

$BaselineTarget = Join-Path $OutputRoot "baseline-target"
$OptimizedTarget = Join-Path $OutputRoot "optimized-target"

Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class RustMeasurementNative {
    [StructLayout(LayoutKind.Sequential)]
    private struct FILETIME {
        public uint Low;
        public uint High;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BY_HANDLE_FILE_INFORMATION {
        public uint FileAttributes;
        public FILETIME CreationTime;
        public FILETIME LastAccessTime;
        public FILETIME LastWriteTime;
        public uint VolumeSerialNumber;
        public uint FileSizeHigh;
        public uint FileSizeLow;
        public uint NumberOfLinks;
        public uint FileIndexHigh;
        public uint FileIndexLow;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(
        string fileName,
        uint desiredAccess,
        uint shareMode,
        IntPtr securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandle(
        SafeFileHandle file,
        out BY_HANDLE_FILE_INFORMATION information);

    [StructLayout(LayoutKind.Sequential)]
    private struct FILE_STANDARD_INFO {
        public long AllocationSize;
        public long EndOfFile;
        public uint NumberOfLinks;
        public byte DeletePending;
        public byte Directory;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandleEx(
        SafeFileHandle file,
        int fileInformationClass,
        out FILE_STANDARD_INFO information,
        uint bufferSize);

    public sealed class Metadata {
        public string Identity { get; set; }
        public long AllocationBytes { get; set; }
        public long LogicalBytes { get; set; }
        public uint HardLinkCount { get; set; }
    }

    public static Metadata GetMetadata(string path) {
        using SafeFileHandle handle = CreateFileW(
            path,
            0,
            0x7,
            IntPtr.Zero,
            3,
            0x80,
            IntPtr.Zero);
        if (handle.IsInvalid) {
            throw new Win32Exception(Marshal.GetLastWin32Error(), path);
        }
        if (!GetFileInformationByHandle(handle, out BY_HANDLE_FILE_INFORMATION info)) {
            throw new Win32Exception(Marshal.GetLastWin32Error(), path);
        }
        if (!GetFileInformationByHandleEx(
            handle,
            1,
            out FILE_STANDARD_INFO standard,
            (uint)Marshal.SizeOf<FILE_STANDARD_INFO>())) {
            throw new Win32Exception(Marshal.GetLastWin32Error(), path);
        }
        ulong index = ((ulong)info.FileIndexHigh << 32) | info.FileIndexLow;
        return new Metadata {
            Identity = $"{info.VolumeSerialNumber}:{index}",
            AllocationBytes = standard.AllocationSize,
            LogicalBytes = standard.EndOfFile,
            HardLinkCount = standard.NumberOfLinks
        };
    }
}
"@

function Measure-SingleFile([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force
    $metadata = [RustMeasurementNative]::GetMetadata($item.FullName)
    return [ordered]@{
        logical_bytes = $metadata.LogicalBytes
        allocated_bytes = $metadata.AllocationBytes
        hard_link_count = $metadata.HardLinkCount
    }
}

function Get-SourceTreeSha256([string]$Root) {
    $rootFull = [IO.Path]::GetFullPath($Root)
    $excludedPrefixes = @("target", "gen") | ForEach-Object {
        (Join-Path $rootFull $_) + [IO.Path]::DirectorySeparatorChar
    }
    $records = foreach ($file in Get-ChildItem -LiteralPath $rootFull -Recurse -Force -File) {
        if ($excludedPrefixes | Where-Object {
            $file.FullName.StartsWith($_, [StringComparison]::OrdinalIgnoreCase)
        }) {
            continue
        }
        $relative = [IO.Path]::GetRelativePath($rootFull, $file.FullName).Replace("\", "/")
        $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $file.FullName).Hash.ToLowerInvariant()
        "$relative|$hash"
    }
    $sorted = [string[]]$records
    [Array]::Sort($sorted, [StringComparer]::Ordinal)
    $payload = [Text.Encoding]::UTF8.GetBytes(($sorted -join "`n"))
    return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($payload)).ToLowerInvariant()
}

function Measure-Tree([string]$Path) {
    if (-not (Test-Path $Path)) {
        return [ordered]@{
            file_count = 0
            unique_file_count = 0
            hardlink_count = 0
            logical_bytes = 0
            allocated_bytes = 0
        }
    }

    $seen = @{}
    $fileCount = 0
    $logicalBytes = [long]0
    $allocatedBytes = [long]0
    foreach ($file in Get-ChildItem -LiteralPath $Path -Recurse -Force -File) {
        $fileCount++
        $logicalBytes += $file.Length
        $metadata = [RustMeasurementNative]::GetMetadata($file.FullName)
        $identity = $metadata.Identity
        if (-not $seen.ContainsKey($identity)) {
            $seen[$identity] = $true
            $allocatedBytes += $metadata.AllocationBytes
        }
    }
    return [ordered]@{
        file_count = $fileCount
        unique_file_count = $seen.Count
        hardlink_count = $fileCount - $seen.Count
        logical_bytes = $logicalBytes
        allocated_bytes = $allocatedBytes
    }
}

function Get-RustVersion([string]$Toolchain) {
    $lines = & $Rustup run $Toolchain rustc -vV 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "rustc for $Toolchain failed with exit code $LASTEXITCODE."
    }
    return ($lines -join "`n")
}

function Set-CleanCargoEnvironment([hashtable]$Overrides) {
    $controlled = @(
        "CARGO_INCREMENTAL",
        "CARGO_PROFILE_DEV_OPT_LEVEL",
        "CARGO_PROFILE_DEV_DEBUG",
        "CARGO_PROFILE_DEV_INCREMENTAL",
        "CARGO_PROFILE_TEST_OPT_LEVEL",
        "CARGO_PROFILE_TEST_DEBUG",
        "CARGO_PROFILE_TEST_INCREMENTAL",
        "RUSTFLAGS",
        "CARGO_ENCODED_RUSTFLAGS",
        "RUSTC_WRAPPER",
        "RUSTC_WORKSPACE_WRAPPER"
    )
    $saved = @{}
    foreach ($name in $controlled) {
        $saved[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
        Remove-Item -Path "Env:$name" -ErrorAction SilentlyContinue
    }
    foreach ($entry in $Overrides.GetEnumerator()) {
        [Environment]::SetEnvironmentVariable($entry.Key, [string]$entry.Value, "Process")
    }
    return $saved
}

function Restore-Environment([hashtable]$Saved) {
    foreach ($entry in $Saved.GetEnumerator()) {
        if ($null -eq $entry.Value) {
            Remove-Item -Path "Env:$($entry.Key)" -ErrorAction SilentlyContinue
        } else {
            [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, "Process")
        }
    }
}

function Invoke-CargoBuild(
    [string]$Name,
    [string]$Toolchain,
    [string]$TargetDirectory,
    [hashtable]$EnvironmentOverride
) {
    $logPath = Join-Path $OutputRoot "$Name-build.log"
    $saved = Set-CleanCargoEnvironment $EnvironmentOverride
    $pushed = $false

    try {
        $stopwatch = [Diagnostics.Stopwatch]::StartNew()
        Push-Location (Join-Path $ProjectRoot "src-tauri")
        $pushed = $true
        & $Rustup run $Toolchain cargo build --locked --bin rlive --target-dir $TargetDirectory -j 2 2>&1 |
            Tee-Object -FilePath $logPath | Out-Host
        $exitCode = $LASTEXITCODE
        $stopwatch.Stop()
    } finally {
        if ($pushed) {
            Pop-Location
        }
        Restore-Environment $saved
    }

    if ($exitCode -ne 0) {
        throw "$Name cargo build failed with exit code $exitCode. See $logPath."
    }

    return [ordered]@{
        command = "rustup run $Toolchain cargo build --locked --bin rlive --target-dir <$Name-target> -j 2"
        exit_code = $exitCode
        elapsed_seconds = [Math]::Round($stopwatch.Elapsed.TotalSeconds, 2)
        log = [IO.Path]::GetFileName($logPath)
    }
}

function Get-ConfigHashes {
    return [ordered]@{
        "Cargo.lock" = (Get-FileHash -Algorithm SHA256 (Join-Path $ProjectRoot "src-tauri\Cargo.lock")).Hash
        "Cargo.toml" = (Get-FileHash -Algorithm SHA256 (Join-Path $ProjectRoot "src-tauri\Cargo.toml")).Hash
        "build.rs" = (Get-FileHash -Algorithm SHA256 (Join-Path $ProjectRoot "src-tauri\build.rs")).Hash
        "cargo-config" = (Get-FileHash -Algorithm SHA256 (Join-Path $ProjectRoot "src-tauri\.cargo\config.toml")).Hash
        "rust-toolchain.toml" = (Get-FileHash -Algorithm SHA256 (Join-Path $ProjectRoot "rust-toolchain.toml")).Hash
    }
}

$configHashesBefore = Get-ConfigHashes
$sourceTreeSha256Before = Get-SourceTreeSha256 (Join-Path $ProjectRoot "src-tauri\src")
$allocationCalibration = Measure-SingleFile (Join-Path $ProjectRoot "rust-toolchain.toml")
$shapeSample = Measure-Tree $OutputRoot
foreach ($field in @("file_count", "unique_file_count", "hardlink_count", "logical_bytes", "allocated_bytes")) {
    if (-not $shapeSample.Contains($field)) {
        throw "Measurement result is missing $field."
    }
}
$clVersion = (
    & cl.exe 2>&1 |
        ForEach-Object { $_.ToString() } |
        Select-Object -First 2
) -join "`n"
if ([string]::IsNullOrWhiteSpace($clVersion)) {
    throw "Could not read the MSVC compiler version."
}

$stableVersion = Get-RustVersion "stable"
$nightlyVersion = Get-RustVersion "nightly-2026-11-04"
$stablePartial = Invoke-CargoBuild `
    -Name "baseline" `
    -Toolchain "stable" `
    -TargetDirectory $BaselineTarget `
    -EnvironmentOverride @{
        CARGO_PROFILE_DEV_OPT_LEVEL = "0"
        CARGO_PROFILE_DEV_DEBUG = "2"
        CARGO_PROFILE_DEV_INCREMENTAL = "true"
        CARGO_INCREMENTAL = "1"
        RUSTFLAGS = "-C target-cpu=x86-64-v2"
    }

$baselineMeasure = Measure-Tree $BaselineTarget
$baselineDebug = Join-Path $BaselineTarget "debug"
$baselineExe = Join-Path $baselineDebug "rlive.exe"
$baselinePdb = Join-Path $baselineDebug "rlive.pdb"
$baselineExeBytes = if (Test-Path $baselineExe) { (Get-Item $baselineExe).Length } else { 0 }
$baselinePdbBytes = if (Test-Path $baselinePdb) { (Get-Item $baselinePdb).Length } else { 0 }
$baselineSummary = [ordered]@{
    toolchain = "stable"
    rustc = $stableVersion
    profile = [ordered]@{ opt_level = 0; debug = 2; incremental = $true }
    build = $stablePartial
    target = $baselineMeasure
    exe_bytes = $baselineExeBytes
    pdb_bytes = $baselinePdbBytes
    exe_pdb_bytes = $baselineExeBytes + $baselinePdbBytes
    incremental = Measure-Tree (Join-Path $baselineDebug "incremental")
    deps = Measure-Tree (Join-Path $baselineDebug "deps")
    build_dir = Measure-Tree (Join-Path $baselineDebug "build")
}

$optimizedPartial = Invoke-CargoBuild `
    -Name "optimized" `
    -Toolchain "nightly-2026-11-04" `
    -TargetDirectory $OptimizedTarget `
    -EnvironmentOverride @{
        CARGO_PROFILE_DEV_OPT_LEVEL = "1"
        CARGO_PROFILE_DEV_DEBUG = "0"
        CARGO_PROFILE_DEV_INCREMENTAL = "false"
        CARGO_INCREMENTAL = "0"
        RUSTFLAGS = "-C target-cpu=x86-64-v2"
    }

$optimizedMeasure = Measure-Tree $OptimizedTarget
$optimizedDebug = Join-Path $OptimizedTarget "debug"
$optimizedExe = Join-Path $optimizedDebug "rlive.exe"
$optimizedPdb = Join-Path $optimizedDebug "rlive.pdb"
$optimizedExeBytes = if (Test-Path $optimizedExe) { (Get-Item $optimizedExe).Length } else { 0 }
$optimizedPdbBytes = if (Test-Path $optimizedPdb) { (Get-Item $optimizedPdb).Length } else { 0 }
$optimizedSummary = [ordered]@{
    toolchain = "nightly-2026-11-04"
    rustc = $nightlyVersion
    profile = [ordered]@{ opt_level = 1; debug = 0; incremental = $false }
    build = $optimizedPartial
    target = $optimizedMeasure
    exe_bytes = $optimizedExeBytes
    pdb_bytes = $optimizedPdbBytes
    exe_pdb_bytes = $optimizedExeBytes + $optimizedPdbBytes
    incremental = Measure-Tree (Join-Path $optimizedDebug "incremental")
    deps = Measure-Tree (Join-Path $optimizedDebug "deps")
    build_dir = Measure-Tree (Join-Path $optimizedDebug "build")
}

$testLog = Join-Path $OutputRoot "optimized-test.log"
$testStopwatch = [Diagnostics.Stopwatch]::StartNew()
$testEnvironment = Set-CleanCargoEnvironment @{
    CARGO_PROFILE_TEST_OPT_LEVEL = "1"
    CARGO_PROFILE_TEST_DEBUG = "0"
    CARGO_PROFILE_TEST_INCREMENTAL = "false"
    CARGO_INCREMENTAL = "0"
    RUSTFLAGS = "-C target-cpu=x86-64-v2"
}
$pushed = $false
try {
    Push-Location (Join-Path $ProjectRoot "src-tauri")
    $pushed = $true
    & $Rustup run nightly-2026-11-04 cargo test --locked --lib --target-dir $OptimizedTarget -j 2 2>&1 |
        Tee-Object -FilePath $testLog | Out-Host
    $testExitCode = $LASTEXITCODE
    $testStopwatch.Stop()
} finally {
    if ($pushed) {
        Pop-Location
    }
    Restore-Environment $testEnvironment
}
$testSummaryLine = Get-Content $testLog | Select-String "test result:" | Select-Object -Last 1
$testSummary = if ($testSummaryLine) { $testSummaryLine.Line.Trim() } else { "" }
$optimizedTargetAfterTest = Measure-Tree $OptimizedTarget
$configHashesAfter = Get-ConfigHashes
$sourceTreeSha256After = Get-SourceTreeSha256 (Join-Path $ProjectRoot "src-tauri\src")
if (($configHashesBefore | ConvertTo-Json -Compress) -ne ($configHashesAfter | ConvertTo-Json -Compress)) {
    throw "Cargo configuration changed during measurement."
}
if ($sourceTreeSha256Before -ne $sourceTreeSha256After) {
    throw "Rust source tree changed during measurement."
}
$effectiveSourceCommit = $SourceCommit
if ([string]::IsNullOrWhiteSpace($effectiveSourceCommit) -and (Test-Path (Join-Path $ProjectRoot ".git"))) {
    $effectiveSourceCommit = (& git -C $ProjectRoot rev-parse HEAD).Trim()
}

$result = [ordered]@{
    date = "2026-11-04"
    platform = "x86_64-pc-windows-msvc"
    source_commit = $effectiveSourceCommit
    source_tree_sha256 = $sourceTreeSha256Before
    config_sha256 = $configHashesBefore
    measurement = "Windows 逻辑字节为每个文件的 Length 总和；实际分配字节按卷序列号和文件索引去重硬链接后，使用 FILE_STANDARD_INFO.AllocationSize 统计。"
    environment = [ordered]@{
        powershell = $PSVersionTable.PSVersion.ToString()
        compiler = $clVersion
        ffmpeg_dir = $FfmpegDir
        libclang_path = $LibclangDir
        jobs = 2
        target_cpu_rustflag = "-C target-cpu=x86-64-v2（从 src-tauri 启动，并显式设置 RUSTFLAGS）"
        allocation_calibration = $allocationCalibration
        nightly_install_note = "官方 dist 下载恢复后 rustup 仍缺 cargo/rust-std；停止该单一安装进程后，使用 RsProxy 镜像重新安装同一 nightly-2026-11-04 minimal。安装耗时不计入构建耗时。"
    }
    baseline = $baselineSummary
    optimized = $optimizedSummary
    comparison = [ordered]@{
        target_logical_reduction_percent = if ($baselineMeasure.logical_bytes -gt 0) { [Math]::Round((1 - $optimizedMeasure.logical_bytes / $baselineMeasure.logical_bytes) * 100, 4) } else { $null }
        target_allocated_reduction_percent = if ($baselineMeasure.allocated_bytes -gt 0) { [Math]::Round((1 - $optimizedMeasure.allocated_bytes / $baselineMeasure.allocated_bytes) * 100, 4) } else { $null }
        exe_reduction_percent = if ($baselineSummary.exe_bytes -gt 0) { [Math]::Round((1 - $optimizedSummary.exe_bytes / $baselineSummary.exe_bytes) * 100, 4) } else { $null }
        pdb_reduction_percent = if ($baselineSummary.pdb_bytes -gt 0) { [Math]::Round((1 - $optimizedSummary.pdb_bytes / $baselineSummary.pdb_bytes) * 100, 4) } else { $null }
        exe_pdb_reduction_percent = if (($baselineSummary.exe_bytes + $baselineSummary.pdb_bytes) -gt 0) { [Math]::Round((1 - ($optimizedSummary.exe_bytes + $optimizedSummary.pdb_bytes) / ($baselineSummary.exe_bytes + $baselineSummary.pdb_bytes)) * 100, 4) } else { $null }
    }
    tests = [ordered]@{
        command = "rustup run nightly-2026-11-04 cargo test --locked --lib --target-dir <optimized-target> -j 2"
        exit_code = $testExitCode
        failed = $testExitCode -ne 0
        elapsed_seconds = [Math]::Round($testStopwatch.Elapsed.TotalSeconds, 2)
        summary = $testSummary
        target_after_test = $optimizedTargetAfterTest
        log = [IO.Path]::GetFileName($testLog)
    }
    known_limitations = @(
        "本脚本只测量构建与 Rust 库测试，不构建 release、Tauri 安装包，也不启动 GUI。",
        "测试失败时仍会先写出构建统计 JSON，再以测试退出码结束。"
    )
}

$jsonPath = Join-Path $OutputRoot "rust-target-windows-2026-11-04.json"
$json = $result | ConvertTo-Json -Depth 12
$roundTrip = $json | ConvertFrom-Json
if ($null -eq $roundTrip.baseline.target.logical_bytes -or $null -eq $roundTrip.optimized.target.allocated_bytes) {
    throw "Measurement JSON shape check failed."
}
$json | Set-Content -Path $jsonPath -Encoding utf8NoBOM
$json
Write-Host ""
Write-Host "Measurement written to $jsonPath" -ForegroundColor Green
if ($testExitCode -ne 0) {
    Write-Error "optimized cargo test failed with exit code $testExitCode. See $testLog." -ErrorAction Continue
    exit $testExitCode
}
