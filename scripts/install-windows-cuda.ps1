#Requires -Version 7.0

# Install the CUDA Toolkit used by the Windows Sherpa ONNX build.
#
# The network installer downloads only the components listed below. Keep the
# exact Toolkit version pinned: rLive links against the CUDA 12 import
# libraries, and the release workflow verifies nvcc before compiling. The
# default path is shared by local development and CI so both environments
# resolve the same nvcc and runtime DLLs.

param(
    [string]$CudaRoot = "D:\dev\CUDAToolkit"
)

$ErrorActionPreference = "Stop"

$installerUrl = "https://developer.download.nvidia.com/compute/cuda/12.6.3/network_installers/cuda_12.6.3_windows_network.exe"
$expectedHash = "05cd1a726216d83d124b2139464e998520384585d4e9f45bd7ffd902635aab07"
$nvcc = Join-Path $CudaRoot "bin\nvcc.exe"
$cudaBin = Join-Path $CudaRoot "bin"

function Test-ObsoleteCudaPathEntry([string]$Entry) {
    $candidate = $Entry.Trim().Trim('"').TrimEnd("\")
    return $candidate.StartsWith("C:\", [StringComparison]::OrdinalIgnoreCase) -and
        $candidate -match "(?i)(?:^|\\)NVIDIA GPU Computing Toolkit\\CUDA(?:\\|$)"
}

function Set-CudaPath([string]$PathValue, [string]$CudaBin) {
    $seen = [Collections.Generic.HashSet[string]]::new(
        [StringComparer]::OrdinalIgnoreCase
    )
    $entries = @(
        $CudaBin | ForEach-Object {
            [void]$seen.Add($_.TrimEnd("\"))
            $_
        }
        $PathValue -split ";" | ForEach-Object {
            $entry = $_.Trim()
            if (-not $entry -or (Test-ObsoleteCudaPathEntry $entry)) {
                return
            }
            $key = $entry.Trim('"').TrimEnd("\")
            if ($seen.Add($key)) {
                $entry
            }
        }
    )
    return $entries -join ";"
}

$installedVersion = if (Test-Path $nvcc) {
    (& $nvcc --version | Out-String)
} else {
    ""
}
$isExpectedVersion = $installedVersion -match "release 12\.6, V12\.6\.85"

if (-not $isExpectedVersion) {
    $installer = Join-Path ([IO.Path]::GetTempPath()) "cuda_12.6.3_windows_network.exe"
    Invoke-WebRequest -Uri $installerUrl -OutFile $installer
    $hash = (Get-FileHash $installer -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($hash -ne $expectedHash) {
        throw "CUDA installer checksum mismatch: $hash"
    }

    $arguments = @(
        "-s",
        "-n",
        "-path=`"$CudaRoot`"",
        "nvcc_12.6",
        "cudart_12.6",
        "cublas_12.6",
        "cublas_dev_12.6",
        "cufft_12.6",
        "cufft_dev_12.6",
        "curand_12.6",
        "curand_dev_12.6",
        "cusolver_12.6",
        "cusolver_dev_12.6",
        "cusparse_12.6",
        "cusparse_dev_12.6",
        "nvml_dev_12.6",
        "nvrtc_12.6",
        "nvrtc_dev_12.6",
        "visual_studio_integration_12.6"
    )
    $process = Start-Process -FilePath $installer -ArgumentList $arguments `
        -Wait -PassThru
    if ($process.ExitCode -ne 0) {
        throw "CUDA Toolkit installer failed with exit code $($process.ExitCode)"
    }
}

if (-not (Test-Path $nvcc)) {
    throw "CUDA 12.6 nvcc.exe was not installed at $nvcc"
}
$version = (& $nvcc --version | Out-String)
if ($LASTEXITCODE -ne 0 -or $version -notmatch "release 12\.6, V12\.6\.85") {
    throw "Expected CUDA Toolkit 12.6.3 (nvcc V12.6.85), got:`n$version"
}

# `-path` is supported by the installer, but only a successful silent install
# on a clean runner proves it was honored. Verify the ARP entry and nvcc
# location so a fallback to the default C: path fails loudly instead.
$toolkit = @(
    Get-ItemProperty @(
        "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*",
        "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*"
    ) -ErrorAction SilentlyContinue |
        Where-Object { $_.DisplayName -eq "NVIDIA CUDA Toolkit 12.6" } |
        Select-Object -First 1
)
if ($toolkit.Count -eq 0 -or -not $toolkit[0].InstallLocation) {
    throw "The NVIDIA CUDA Toolkit 12.6 ARP entry was not found."
}
if ([IO.Path]::GetFullPath($toolkit[0].InstallLocation.TrimEnd("\")) -ine
    [IO.Path]::GetFullPath($CudaRoot.TrimEnd("\"))) {
    throw "CUDA Toolkit 12.6 is registered at $($toolkit[0].InstallLocation), expected $CudaRoot"
}

# 安装器可能只改了注册表，当前进程仍继承旧的 CUDA_PATH/PATH。先修当前进程，
# 这样紧随其后的构建步骤不依赖用户重新打开终端。
$env:CUDA_PATH = $CudaRoot
$env:CUDA_PATH_V12_6 = $CudaRoot
$env:Path = Set-CudaPath $env:Path $cudaBin

# 旧终端可能把 CUDA_PATH_V11_* 等变量继承进当前进程；它们不能指向新的
# 12.6 工具链，继续保留会误导构建脚本或诊断命令。
Get-ChildItem Env: |
    Where-Object {
        $_.Name -match "^CUDA_PATH_V\d+_\d+$" -and
        $_.Name -ine "CUDA_PATH_V12_6"
    } |
    ForEach-Object {
        Remove-Item "Env:$($_.Name)" -ErrorAction SilentlyContinue
    }

if ($env:GITHUB_ENV) {
    "CUDA_PATH=$CudaRoot" >> $env:GITHUB_ENV
    "CUDA_PATH_V12_6=$CudaRoot" >> $env:GITHUB_ENV
}
if ($env:GITHUB_PATH) {
    "$cudaBin" >> $env:GITHUB_PATH
}

# 本机安装时同时修复用户级 PATH。机器级 PATH 可能存在拼坏的 CUDA 条目
# （`...\bin ...\libnvvp` 被写成一个元素），修复它需要管理员权限；用户级
# 有效条目足以让新终端找到 nvcc，不能因为权限不足静默跳过。
if (-not $env:GITHUB_ACTIONS) {
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $normalizedUserPath = Set-CudaPath $userPath $cudaBin
    [Environment]::SetEnvironmentVariable("CUDA_PATH", $CudaRoot, "User")
    [Environment]::SetEnvironmentVariable("CUDA_PATH_V12_6", $CudaRoot, "User")
    [Environment]::GetEnvironmentVariables("User").Keys |
        Where-Object {
            $_ -match "^CUDA_PATH_V11_\d+$"
        } |
        ForEach-Object {
            [Environment]::SetEnvironmentVariable($_, $null, "User")
        }

    if ($normalizedUserPath -ne $userPath) {
        [Environment]::SetEnvironmentVariable("Path", $normalizedUserPath, "User")
        Write-Host "Set $cudaBin first in the user PATH and removed obsolete C: CUDA entries."

        # 已运行的 Explorer/Windows Terminal 不会因注册表变化自动刷新环境。
        # 广播环境变更，让之后新开的终端读取到更新后的用户 PATH。
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class RliveEnvironmentBroadcast {
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr SendMessageTimeout(
        IntPtr hWnd, uint msg, UIntPtr wParam, string lParam,
        uint flags, uint timeout, out UIntPtr result);

    public static bool Notify() {
        UIntPtr result;
        return SendMessageTimeout(
            new IntPtr(0xffff), 0x001a, UIntPtr.Zero, "Environment",
            0x0002, 5000, out result) != IntPtr.Zero;
    }
}
'@
        if (-not [RliveEnvironmentBroadcast]::Notify()) {
            Write-Warning "Could not broadcast the environment change. Sign out and back in, or open a terminal that reloads the user PATH."
        }
    }

    $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $malformedCudaEntries = @(
        $machinePath -split ";" |
            Where-Object {
                $_ -match "(?i)CUDA" -and
                ($_ -match "\\bin\s+.+\\") -and
                -not (Test-Path -LiteralPath $_)
            }
    )
    if ($malformedCudaEntries.Count -gt 0) {
        Write-Warning "The machine PATH contains malformed CUDA entries: $($malformedCudaEntries -join '; '). The user PATH now points to $cudaBin; repair the machine PATH from an elevated shell if other accounts need nvcc."
    }
}

$resolvedNvcc = Get-Command nvcc -ErrorAction SilentlyContinue
if (-not $resolvedNvcc -or
    [IO.Path]::GetFullPath($resolvedNvcc.Source) -ine [IO.Path]::GetFullPath($nvcc)) {
    throw "nvcc does not resolve to $nvcc. Get-Command nvcc: $($resolvedNvcc.Source)"
}
$pathVersion = (& nvcc -V | Out-String)
if ($LASTEXITCODE -ne 0 -or $pathVersion -notmatch "release 12\.6, V12\.6\.85") {
    throw "nvcc from PATH failed verification:`n$pathVersion"
}

Write-Host "CUDA Toolkit 12.6.3 verified: $nvcc (open a new terminal to inherit the updated environment)"
