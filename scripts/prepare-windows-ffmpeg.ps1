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
    function Test-DesktopClangDirectory([string]$Candidate) {
        if ([string]::IsNullOrWhiteSpace($Candidate)) {
            return $false
        }
        # The Android NDK clang is a host compiler for Android tooling. Its
        # resource directory does not provide the MSVC desktop headers needed
        # by libquickjs-ng-sys when the target is x86_64-pc-windows-msvc.
        if ($Candidate -match '(?i)[\\/]android-sdk[\\/]|[\\/]ndk[\\/]') {
            return $false
        }
        return (
            (Test-Path (Join-Path $Candidate "libclang.dll")) -and
            (Test-Path (Join-Path $Candidate "clang.exe"))
        )
    }

    # WSL interop can pass a stale process-level value even after the user
    # environment has been updated, so inspect all scopes before fallbacks.
    $configuredPaths = @(
        [Environment]::GetEnvironmentVariable("LIBCLANG_PATH", "Process"),
        [Environment]::GetEnvironmentVariable("LIBCLANG_PATH", "User"),
        [Environment]::GetEnvironmentVariable("LIBCLANG_PATH", "Machine")
    ) | Where-Object { $_ } | Select-Object -Unique

    $candidates = @(
        $configuredPaths
        "D:\dev\LLVM-22.1.8\bin"
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
        if (Test-DesktopClangDirectory $candidate) {
            return [IO.Path]::GetFullPath($candidate)
        }
    }

    throw "clang.exe and libclang.dll not found. Install LLVM/Clang or set LIBCLANG_PATH to its bin directory."
}

function Find-ArchiveExtractor {
    # The pinned SDK ships as a 7-Zip archive, so the extractor must handle
    # LZMA. bsdtar (`tar.exe` on Windows) is built without the LZMA codec on
    # GitHub's windows runners and fails with "LZMA codec is unsupported", so
    # prefer a real 7-Zip and keep tar only as a fallback for hosts that ship a
    # libarchive with LZMA support.
    $sevenZipCandidates = [Collections.Generic.List[string]]::new()
    foreach ($name in @("7z", "7za")) {
        $command = Get-Command $name -ErrorAction SilentlyContinue
        if ($command) {
            $sevenZipCandidates.Add($command.Source)
        }
    }
    foreach ($programFiles in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
        if ($programFiles) {
            $sevenZipCandidates.Add((Join-Path $programFiles "7-Zip\7z.exe"))
        }
    }

    foreach ($candidate in $sevenZipCandidates) {
        if (Test-Path $candidate) {
            return @{
                Kind = "7z"
                Path = [IO.Path]::GetFullPath($candidate)
            }
        }
    }

    $tar = Get-Command tar -ErrorAction SilentlyContinue
    if ($tar) {
        return @{
            Kind = "tar"
            Path = $tar.Source
        }
    }

    throw "No archive extractor found. Install 7-Zip (or a tar with LZMA support), or set FFMPEG_DIR."
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

    $extractor = Find-ArchiveExtractor
    Write-Host "Extracting the FFmpeg SDK with $($extractor.Path)"

    $extractDirectory = Join-Path $cacheDirectory "ffmpeg-extract-$([Guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Force -Path $extractDirectory | Out-Null
    try {
        # `-bso0` silences 7-Zip's file listing while keeping errors on stderr.
        $extractArguments = if ($extractor.Kind -eq "7z") {
            @("x", $archivePath, "-o$extractDirectory", "-y", "-bso0")
        } else {
            @("-xf", $archivePath, "-C", $extractDirectory)
        }
        Invoke-NativeCommand $extractor.Path $extractArguments "Could not extract the FFmpeg SDK"

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
# libquickjs-ng-sys invokes cc-rs with the literal compiler name `clang`.
# LIBCLANG_PATH is used by bindgen, but cc-rs resolves the executable through
# PATH, so expose the same LLVM bin directory to both build steps.
$env:Path = $env:LIBCLANG_PATH + ";" + $env:RLIVE_FFMPEG_RUNTIME_DIR + ";" + $env:Path

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
Write-Host "CLANG_PATH: $(Join-Path $env:LIBCLANG_PATH 'clang.exe')"
