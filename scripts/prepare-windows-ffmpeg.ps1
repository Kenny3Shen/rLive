# Prepare the FFmpeg development SDK and runtime files used by ffmpeg-next on
# Windows. This follows rust-ffmpeg's MSVC CI setup and uses a pinned Gyan
# full_build-shared archive so headers, import libraries, and DLLs stay aligned.

param(
    [string]$ProjectRoot = (Get-Location).Path,
    [string]$StageDestination = ""
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$FfmpegVersion = "9.0.1"
$FfmpegArchiveName = "ffmpeg-$FfmpegVersion-full_build-shared.7z"
$FfmpegDownloadUrl = "https://www.gyan.dev/ffmpeg/builds/packages/$FfmpegArchiveName"
$FfmpegArchiveSha256 = "cb4d5e8db6a3353bffdb2100d3eb4b76733457fa443215e236f57c99f9ffdca4"

function Invoke-NativeCommand(
    [string]$FilePath,
    [string[]]$Arguments,
    [string]$FailureMessage
) {
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    & $FilePath @Arguments
    $exitCode = $LASTEXITCODE
    $ErrorActionPreference = $previousPreference
    if ($exitCode -ne 0) {
        throw "$FailureMessage (exit $exitCode)"
    }
}

function Get-ConfiguredEnvironmentValue([string]$Name) {
    $value = [Environment]::GetEnvironmentVariable($Name, "Process")
    if ($value) {
        return $value
    }

    return [Environment]::GetEnvironmentVariable($Name, "User")
}

function Find-LibClangDirectory {
    $configuredPath = Get-ConfiguredEnvironmentValue "LIBCLANG_PATH"
    if ($configuredPath -and (Test-Path (Join-Path $configuredPath "libclang.dll"))) {
        return [IO.Path]::GetFullPath($configuredPath)
    }

    $candidates = @(
        "D:\dev\LLVM\bin",
        "D:\VS\BuildTools\VC\Tools\Llvm\x64\bin",
        "D:\LLVM\bin",
        (Join-Path $env:LOCALAPPDATA "Programs\LLVM\bin"),
        (Join-Path $env:ProgramFiles "LLVM\bin"),
        (Join-Path ${env:ProgramFiles(x86)} "LLVM\bin")
    )
    $candidates += @(
        Get-ChildItem "${env:ProgramFiles}\Microsoft Visual Studio\2022\*\VC\Tools\Llvm\x64\bin" `
            -Directory -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty FullName
    )

    $clang = Get-Command clang -ErrorAction SilentlyContinue
    if ($clang) {
        $candidates += Split-Path $clang.Source -Parent
    }

    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path (Join-Path $candidate "libclang.dll"))) {
            return [IO.Path]::GetFullPath($candidate)
        }
    }

    throw "libclang.dll not found. Install LLVM/Clang or set LIBCLANG_PATH to its bin directory."
}

function Assert-FfmpegSdk([string]$SdkRoot) {
    $requiredFiles = @(
        "include\libavutil\avutil.h",
        "include\libavcodec\avcodec.h",
        "include\libavformat\avformat.h",
        "lib\avutil.lib",
        "lib\avcodec.lib",
        "lib\avformat.lib",
        "LICENSE",
        "README.txt"
    )
    foreach ($relativePath in $requiredFiles) {
        $path = Join-Path $SdkRoot $relativePath
        if (-not (Test-Path $path)) {
            throw "FFmpeg SDK is incomplete; missing $path"
        }
    }
}

function Get-FfmpegRuntimeFiles([string]$SdkRoot) {
    $binDirectory = Join-Path $SdkRoot "bin"
    $runtimeFiles = @()
    # Gyan's avcodec DLL imports swresample even though rLive does not call the
    # swresample API directly, so it must be distributed with the direct DLLs.
    foreach ($library in @("avutil", "swresample", "avcodec", "avformat")) {
        $matches = @(Get-ChildItem $binDirectory -Filter "$library-*.dll" -File -ErrorAction SilentlyContinue)
        if ($matches.Count -ne 1) {
            throw "Expected one $library runtime DLL in $binDirectory, found $($matches.Count)."
        }
        $runtimeFiles += $matches[0]
    }
    return $runtimeFiles
}

function Get-ManagedFfmpegSdk {
    $cacheDirectory = Join-Path $env:LOCALAPPDATA "rLive\build"
    $archivePath = Join-Path $cacheDirectory $FfmpegArchiveName
    $sdkRoot = Join-Path $cacheDirectory "ffmpeg-$FfmpegVersion-full_build-shared"
    New-Item -ItemType Directory -Force -Path $cacheDirectory | Out-Null

    if (Test-Path $sdkRoot) {
        try {
            Assert-FfmpegSdk $sdkRoot
            return [IO.Path]::GetFullPath($sdkRoot)
        } catch {
            Write-Warning "Removing incomplete managed FFmpeg SDK: $sdkRoot"
            Remove-Item -LiteralPath $sdkRoot -Recurse -Force
        }
    }

    $archiveValid = $false
    if (Test-Path $archivePath) {
        $archiveHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash.ToLowerInvariant()
        $archiveValid = $archiveHash -eq $FfmpegArchiveSha256
        if (-not $archiveValid) {
            Write-Warning "Removing cached FFmpeg archive with an invalid SHA-256: $archivePath"
            Remove-Item -LiteralPath $archivePath -Force
        }
    }

    if (-not $archiveValid) {
        $downloadPath = "$archivePath.download-$([Guid]::NewGuid().ToString('N'))"
        try {
            Write-Host "Downloading FFmpeg $FfmpegVersion shared SDK..."
            [Net.ServicePointManager]::SecurityProtocol = `
                [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
            Invoke-WebRequest -Uri $FfmpegDownloadUrl -OutFile $downloadPath -UseBasicParsing
            $downloadHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $downloadPath).Hash.ToLowerInvariant()
            if ($downloadHash -ne $FfmpegArchiveSha256) {
                throw "FFmpeg archive SHA-256 mismatch. Expected $FfmpegArchiveSha256, got $downloadHash."
            }
            Move-Item -LiteralPath $downloadPath -Destination $archivePath -Force
        } finally {
            if (Test-Path $downloadPath) {
                Remove-Item -LiteralPath $downloadPath -Force
            }
        }
    }

    $tar = Get-Command tar -ErrorAction SilentlyContinue
    if (-not $tar) {
        throw "tar.exe not found. Install a current Windows tar implementation or set FFMPEG_DIR."
    }

    $extractDirectory = Join-Path $cacheDirectory "ffmpeg-extract-$([Guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Force -Path $extractDirectory | Out-Null
    try {
        Invoke-NativeCommand $tar.Source @(
            "-xf", $archivePath,
            "-C", $extractDirectory
        ) "Could not extract the FFmpeg SDK"

        $extractedRoots = @(
            Get-ChildItem $extractDirectory -Directory |
                Where-Object { Test-Path (Join-Path $_.FullName "include\libavformat\avformat.h") }
        )
        if ($extractedRoots.Count -ne 1) {
            throw "Expected one FFmpeg SDK root in the archive, found $($extractedRoots.Count)."
        }
        Assert-FfmpegSdk $extractedRoots[0].FullName
        Move-Item -LiteralPath $extractedRoots[0].FullName -Destination $sdkRoot
    } finally {
        if (Test-Path $extractDirectory) {
            Remove-Item -LiteralPath $extractDirectory -Recurse -Force
        }
    }

    return [IO.Path]::GetFullPath($sdkRoot)
}

$ProjectRoot = [IO.Path]::GetFullPath($ProjectRoot)
$configuredFfmpegDirectory = Get-ConfiguredEnvironmentValue "FFMPEG_DIR"
if ($configuredFfmpegDirectory) {
    $ffmpegRoot = [IO.Path]::GetFullPath($configuredFfmpegDirectory)
    $env:FFMPEG_DIR = $ffmpegRoot
    Write-Host "Using FFmpeg SDK from FFMPEG_DIR: $ffmpegRoot"
} else {
    $ffmpegRoot = Get-ManagedFfmpegSdk
    $env:FFMPEG_DIR = $ffmpegRoot
    Write-Host "Using managed FFmpeg SDK: $ffmpegRoot"
}

Assert-FfmpegSdk $ffmpegRoot
$runtimeFiles = @(Get-FfmpegRuntimeFiles $ffmpegRoot)
$licenseSource = Join-Path $ffmpegRoot "LICENSE"
$readmeSource = Join-Path $ffmpegRoot "README.txt"

$env:LIBCLANG_PATH = Find-LibClangDirectory
$env:RLIVE_FFMPEG_RUNTIME_DIR = Join-Path $ffmpegRoot "bin"
$env:Path = $env:RLIVE_FFMPEG_RUNTIME_DIR + ";" + $env:Path

if ($StageDestination) {
    $StageDestination = [IO.Path]::GetFullPath($StageDestination)
    New-Item -ItemType Directory -Force -Path $StageDestination | Out-Null
    Get-ChildItem $StageDestination -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^(avutil|avcodec|avformat|swresample)-[0-9]+\.dll$' } |
        Remove-Item -Force
    foreach ($runtimeFile in $runtimeFiles) {
        Copy-Item $runtimeFile.FullName (Join-Path $StageDestination $runtimeFile.Name) -Force
    }
    Copy-Item $licenseSource (Join-Path $StageDestination "FFmpeg-LICENSE.txt") -Force
    Copy-Item $readmeSource (Join-Path $StageDestination "FFmpeg-README.txt") -Force
    Write-Host "Staged FFmpeg runtime files in $StageDestination"
}

Write-Host "FFMPEG_DIR: $env:FFMPEG_DIR"
Write-Host "LIBCLANG_PATH: $env:LIBCLANG_PATH"
