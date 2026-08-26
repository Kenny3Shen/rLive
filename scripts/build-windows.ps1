# 在 Windows 上构建 rLive。请在项目目录下运行本脚本，
# 或显式传入 -ProjectRoot。
#
# 前置条件：
# - VS Build Tools：D:\VS\BuildTools（vcvars64.bat）
# - Rust：D:\dev\rust\{cargo,rustup}（或 CARGO_HOME / RUSTUP_HOME）
# - bun 和/或 Node.js
# - 与 MSVC 兼容的 LLVM/Clang + libclang（自动探测，或设置 LIBCLANG_PATH）
# - 首次构建需要网络（下载已固定版本的共享 FFmpeg SDK）
# - NVIDIA CUDA 11.x + x86-64 cuDNN 8.x 运行时，以及兼容的 NVIDIA 驱动
#
# 用法：
# cd <rLive 项目目录>
# .\scripts\build-windows.ps1

param(
    [string]$ProjectRoot = (Get-Location).Path
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

# --- 工具链 / 缓存的 D: 盘默认路径 ---
$env:CARGO_HOME  = if ($env:CARGO_HOME)  { $env:CARGO_HOME }  else { "D:\dev\rust\cargo" }
$env:RUSTUP_HOME = if ($env:RUSTUP_HOME) { $env:RUSTUP_HOME } else { "D:\dev\rust\rustup" }
$env:TEMP = "D:\Temp\build"
$env:TMP  = "D:\Temp\build"
New-Item -ItemType Directory -Force -Path $env:TEMP | Out-Null

# 确保能找到 bun/cargo/node（新开的 shell 与 winget 安装位置）
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

# 定位 bun.exe（winget 安装的 bunx 可能不是真正的可执行文件）
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
    # rustup 首次安装时会把进度输出到 stderr。这里只把它当作诊断查询：
    # 版本查询的偶发失败不应在 cargo 有机会运行之前，
    # 就中断真正的 Tauri 构建。
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $rustcInfo = & rustc -vV 2>&1
    $rustcCode = $LASTEXITCODE
    $ErrorActionPreference = $prevEap
    if ($rustcCode -eq 0) {
        $rustcHost = $rustcInfo | Select-String "^host:" | Select-Object -First 1
        if ($rustcHost) {
            Write-Host $rustcHost.ToString()
        }
    } else {
        Write-Warning "rustc could not report its host before the build (exit $rustcCode)."
    }
} else {
    Write-Warning "rustc not on PATH (expected under $env:CARGO_HOME\bin)"
}

Set-Location $ProjectRoot

# 之前的 `tauri dev` 或手动启动可能仍映射着目标可执行文件
# （以及它的 sherpa-onnx/ONNX Runtime DLL）。Windows 无法替换已加载的二进制，
# 因此在 Cargo 暂存新的运行时文件之前，只结束由当前检出目录构建出的
# rLive 实例；target 目录之外已安装的副本不受影响。
$projectTargetRoot = [IO.Path]::GetFullPath((Join-Path $ProjectRoot "src-tauri\target"))
$projectProcesses = @(Get-Process -Name "rlive" -ErrorAction SilentlyContinue | Where-Object {
    try {
        $_.Path -and
            [IO.Path]::GetFullPath($_.Path).StartsWith(
                $projectTargetRoot,
                [StringComparison]::OrdinalIgnoreCase
            )
    } catch {
        $false
    }
})
if ($projectProcesses.Count -gt 0) {
    Write-Host "Stopping $($projectProcesses.Count) project rLive process(es) before build..."
    $stopDeadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        $stillRunning = @(
            $projectProcesses |
                Where-Object { Get-Process -Id $_.Id -ErrorAction SilentlyContinue }
        )
        if ($stillRunning.Count -eq 0) {
            break
        }
        $stillRunning | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $stopDeadline)

    $stillRunning = @(
        $projectProcesses |
            Where-Object { Get-Process -Id $_.Id -ErrorAction SilentlyContinue }
    )
    if ($stillRunning.Count -gt 0) {
        $processIds = ($stillRunning | ForEach-Object { $_.Id }) -join ", "
        throw "Could not stop project rLive process(es) before build: $processIds"
    }
}

Write-Step "prepare FFmpeg SDK"
$ffmpegPrepare = Join-Path $ProjectRoot "scripts\prepare-windows-ffmpeg.ps1"
if (-not (Test-Path $ffmpegPrepare)) {
    throw "FFmpeg preparation script not found: $ffmpegPrepare"
}
& $ffmpegPrepare `
    -ProjectRoot $ProjectRoot `
    -StageDestination (Join-Path $ProjectRoot "src-tauri\target\release")

$env:SHERPA_ONNX_GPU = if ($env:SHERPA_ONNX_GPU) { $env:SHERPA_ONNX_GPU } else { "1" }
if ($env:SHERPA_ONNX_GPU -eq "0") {
    Write-Host "ASR native backend: CPU-only override (SHERPA_ONNX_GPU=0)"
} else {
    Write-Host "ASR native backend: CUDA-capable shared runtime (provider auto-selects CUDA/CPU)"
}

# 优先使用 package.json 脚本提供的本地 CLI："tauri": "tauri"
# （winget 版 bun 通常没有 bunx.exe，`bun x tauri` 也可能定位不到该二进制）
$tauriArgs = "build --no-bundle"

if ($bunCmd) {
    Write-Step "bun install"
    # Bun 会把正常的依赖解析进度写入 stderr。在本脚本默认的 Stop 策略下，
    # PowerShell 会把这些输出变成终止性的 NativeCommandError，
    # 让 Bun 无法跑完。
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    & bun install
    $installCode = $LASTEXITCODE
    $ErrorActionPreference = $prevEap
    if ($installCode -ne 0) { throw "bun install failed: $installCode" }

    # 6
    # 快照原生可用性，使延迟到来的桥失败无法改变滑动路由。
    $buildInner = "bun run tauri -- $tauriArgs"
    Write-Host "Using: $buildInner"
} else {
    Write-Step "npm install (bun not found)"
    $npm = Get-Command npm -ErrorAction SilentlyContinue
    if (-not $npm) { throw "Neither bun nor npm found on PATH." }
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    & npm install --no-fund --no-audit
    $installCode = $LASTEXITCODE
    $ErrorActionPreference = $prevEap
    if ($installCode -ne 0) { throw "npm install failed: $installCode" }
    $buildInner = "npx tauri $tauriArgs"
    Write-Host "Using: $buildInner"
}

Write-Step "tauri build (via vcvars64)"
$cmd = "call `"$vcvars`" && cd /d `"$ProjectRoot`" && set CARGO_HOME=$env:CARGO_HOME&& set RUSTUP_HOME=$env:RUSTUP_HOME&& set TEMP=$env:TEMP&& set TMP=$env:TMP&& $buildInner"
Write-Host $cmd
# bun/cargo 把进度写入 stderr；在 $ErrorActionPreference=Stop 下这会变成
# 终止性的 NativeCommandError，在构建完成前中止流程。
$prevEap = $ErrorActionPreference
$ErrorActionPreference = "Continue"
# Tauri、Bun 和 Cargo 都用 stderr 输出正常进度。让 cmd.exe 在 PowerShell
# 看到之前先合并两个流；在 PowerShell 侧写 `2>&1` 在 Windows PowerShell 5
# 中仍会产生 NativeCommandError 记录。
$cmdWithMergedStderr = "$cmd 2>&1"
cmd.exe /c $cmdWithMergedStderr
$buildCode = $LASTEXITCODE
$ErrorActionPreference = $prevEap
if ($buildCode -ne 0) { throw "tauri build failed: $buildCode" }

$exe = Join-Path $ProjectRoot "src-tauri\target\release\rlive.exe"
if (-not (Test-Path $exe)) {
    throw "Build reported success but EXE missing: $exe"
}

$releaseDirectory = Split-Path $exe -Parent
foreach ($library in @("avutil", "avcodec", "avformat")) {
    $runtimeDlls = @(Get-ChildItem $releaseDirectory -Filter "$library-*.dll" -File)
    if ($runtimeDlls.Count -ne 1) {
        throw "Build requires one staged $library runtime DLL, found $($runtimeDlls.Count)."
    }
}
if (-not (Test-Path (Join-Path $releaseDirectory "FFmpeg-LICENSE.txt"))) {
    throw "FFmpeg license file was not staged beside rlive.exe."
}
if (-not (Test-Path (Join-Path $releaseDirectory "FFmpeg-README.txt"))) {
    throw "FFmpeg build information was not staged beside rlive.exe."
}


Write-Host ""
Write-Host "OK: $exe ($((Get-Item $exe).Length) bytes)" -ForegroundColor Green
