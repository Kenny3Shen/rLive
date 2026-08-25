# Prepare the FFmpeg development SDK and runtime files used by ffmpeg-next on
# Windows. The SDK is built from the pinned official source with only the
# components rLive actually exercises, so headers, import libraries, and DLLs
# stay aligned by construction.
#
# Windows previously downloaded Gyan's `full_build-shared` archive. That build
# turns on 103 `--enable-*` options including `--enable-gpl` and
# `--enable-version3`, which made the four runtime DLLs 116 MB - over 88% of the
# installed application, with avcodec alone above 93 MB - and put the product
# under a GPLv3 compliance audit. rLive never decodes or encodes: recording
# demuxes FLV/HLS/MPEG-TS and remuxes into FLV or MPEG-TS
# (`src-tauri/src/recording_ffmpeg.rs`), so none of that surface is reachable.
# Building the same component whitelist that `prepare-macos-ffmpeg.sh` and
# `prepare-linux-ffmpeg.sh` use brings the DLLs to roughly 2.4 MB, keeps the
# three desktop platforms behaving identically, and leaves the build plain
# `LGPL version 2.1 or later`.

param(
    [string]$ProjectRoot = (Get-Location).Path,
    [string]$StageDestination = ""
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$FfmpegVersion = "9.0.1"
$FfmpegArchiveName = "ffmpeg-$FfmpegVersion.tar.xz"
$FfmpegDownloadUrl = "https://ffmpeg.org/releases/$FfmpegArchiveName"
# Measured from the official tarball after verifying its detached signature
# against the FFmpeg release signing key
# FCF986EA15E6E293A5644F10B4322F04D67658D8 <ffmpeg-devel@ffmpeg.org>.
# Identical to the pins in prepare-macos-ffmpeg.sh and prepare-linux-ffmpeg.sh:
# all three desktop platforms build the same upstream release.
$FfmpegArchiveSha256 = "cf38e0e28c7e5605942c4a77755349b0145804a397af37eb1fb4c77cb237f635"

# Asserted in the generated config_components.h after `configure` runs.
# `configure` downgrades a component whose dependencies are unmet to a warning
# and still exits 0 - a TLS backend it cannot find silently turns
# `--enable-protocol=https` into `CONFIG_HTTPS_PROTOCOL 0`, and the loss would
# surface only at runtime, as a failed HTTPS recording on a user's machine.
$RequiredComponents = @(
    "HTTPS_PROTOCOL", "TLS_PROTOCOL", "HTTP_PROTOCOL", "FILE_PROTOCOL",
    "CRYPTO_PROTOCOL", "FLV_DEMUXER", "LIVE_FLV_DEMUXER", "HLS_DEMUXER",
    "MPEGTS_DEMUXER", "MOV_DEMUXER", "FLV_MUXER", "MPEGTS_MUXER"
)

# `--disable-autodetect` pins the feature set to exactly what is listed here
# instead of whatever happens to be installed, which is what makes the artifact
# reproducible. It also switches off schannel, so TLS is re-enabled explicitly: a
# direct HTTPS recording needs it. schannel is the Windows-native backend and
# links only against secur32/ncrypt/crypt32, so unlike OpenSSL or GnuTLS it adds
# no third-party code to the audit.
#
# swresample is disabled because nothing reaches it: the Gyan full build's
# avcodec imported it for audio resampling, but with the codecs off the import
# tables are just avformat -> avcodec -> avutil, and `ffmpeg-sys-next` links only
# avcodec and avformat.
#
# zlib is deliberately left off, unlike on macOS and Linux where the platform
# already ships it. It would mean pinning and auditing another dependency to
# serve only two paths a live remux cannot reach: QuickTime `cmov` (compressed
# moov) and matroska zlib-compressed tracks. It is a `suggest` in configure, not
# a `deps`, so every required component is still enabled without it.
#
# This list is also written into the SDK's README.txt, which ships beside the
# DLLs, so the notice cannot drift from the build.
$ConfigureOptions = @(
    "--enable-shared --disable-static",
    "--disable-autodetect --enable-schannel",
    "--disable-programs --disable-doc --disable-debug",
    "--disable-avdevice --disable-avfilter --disable-swscale --disable-swresample",
    "--disable-everything",
    "--enable-demuxer=flv,live_flv,hls,mpegts,mov,matroska",
    "--enable-muxer=flv,mpegts",
    "--enable-protocol=file,http,https,tls,tcp,crypto"
)

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
    # Only these three. The Gyan full build's avcodec imported swresample for its
    # audio resampling paths, so that DLL had to ship too; with the codecs
    # disabled nothing references it, `ffmpeg-sys-next` links only avcodec and
    # avformat, and the import tables here are avformat -> avcodec -> avutil.
    foreach ($library in @("avutil", "avcodec", "avformat")) {
        $matches = @(Get-ChildItem $binDirectory -Filter "$library-*.dll" -File -ErrorAction SilentlyContinue)
        if ($matches.Count -ne 1) {
            throw "Expected one $library runtime DLL in $binDirectory, found $($matches.Count)."
        }
        $runtimeFiles += $matches[0]
    }
    return $runtimeFiles
}

function Find-Msys2Root {
    # MSYS2 is pre-installed on GitHub's windows runners at C:\msys64 but is
    # deliberately kept off PATH, so probe well-known roots instead of relying on
    # `Get-Command`. The build needs a POSIX shell because FFmpeg's `configure`
    # is a shell script; MinGW-w64 is used rather than FFmpeg's MSVC toolchain
    # because it works without `cl.exe` on PATH and still produces the same
    # `ar`-format import libraries the MSVC target links against today - the
    # previous Gyan SDK was itself a MinGW build shipping that same
    # `.def` + `.lib` + `.dll.a` trio.
    $candidates = [Collections.Generic.List[string]]::new()
    $configured = Get-ConfiguredEnvironmentValue "MSYS2_ROOT"
    if ($configured) {
        $candidates.Add($configured)
    }
    foreach ($root in @("C:\msys64", "D:\msys64", "C:\tools\msys64")) {
        $candidates.Add($root)
    }

    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path (Join-Path $candidate "usr\bin\bash.exe"))) {
            $root = [IO.Path]::GetFullPath($candidate)
            # pacman installs the rest of the toolchain, so a root without it is
            # not usable. Checking here turns what would otherwise be a bare
            # "command not found" from inside a generated script into a message
            # that names the directory that was probed.
            if (-not (Test-Path (Join-Path $root "usr\bin\pacman.exe"))) {
                throw "MSYS2 at $root has no usr\bin\pacman.exe; cannot install the build toolchain."
            }
            return $root
        }
    }

    throw @"
MSYS2 not found. The FFmpeg SDK is built from source and needs MSYS2's shell
plus the MinGW-w64 toolchain. Install it from https://www.msys2.org, or set
MSYS2_ROOT to an existing installation. Set FFMPEG_DIR instead to reuse an
FFmpeg SDK that was prepared elsewhere.
"@
}

# PATH for every MSYS2 invocation below. /etc/profile is what normally assembles
# it, and `--noprofile` skips that, so a bash started here would otherwise
# inherit only the Windows PATH and fail on `pacman: command not found`.
# /mingw64/bin comes first so `configure` probes the MinGW-w64 gcc and nasm that
# will compile the libraries; /usr/bin supplies pacman, make, tar and coreutils.
# The Windows PATH is deliberately not appended: a stray Windows tool ahead of an
# MSYS2 one is exactly the kind of drift this build avoids.
$Msys2PathExport = 'export PATH="/mingw64/bin:/usr/bin:/usr/local/bin"'

function ConvertTo-Msys2Path([string]$Msys2Root, [string]$WindowsPath) {
    # MSYS2 needs POSIX paths; cygpath is the only reliable converter for drive
    # letters and UNC roots. cygpath lives in /usr/bin, which --noprofile leaves
    # off PATH, so set it here too.
    $bash = Join-Path $Msys2Root "usr\bin\bash.exe"
    $escaped = $WindowsPath.Replace("\", "\\").Replace('"', '\"')
    $converted = & $bash --noprofile --norc -c "$Msys2PathExport; cygpath -u `"$escaped`"" 2>$null
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($converted)) {
        throw "Could not convert $WindowsPath to an MSYS2 path."
    }
    return $converted.Trim()
}

function Invoke-Msys2Bash([string]$Msys2Root, [string]$Script, [string]$FailureMessage) {
    $bash = Join-Path $Msys2Root "usr\bin\bash.exe"
    # The script is written to a file rather than piped into `bash -s`, because
    # piping appends CRLF to the final line: bash then runs `make install\r` and
    # fails with "No rule to make target". Normalizing every line ending here
    # also makes the build independent of how git checked this file out, since a
    # core.autocrlf checkout would otherwise put a CR on every line of the
    # here-string.
    $scriptPath = Join-Path ([IO.Path]::GetTempPath()) "rlive-msys2-$([Guid]::NewGuid().ToString('N')).sh"
    # PATH is prepended to the script itself rather than wrapped around it with
    # `bash -c ... . script`, which would leak the script's `set -e` and `exit`
    # into the outer shell.
    $normalized = ($Msys2PathExport + "`n" + $Script -replace "`r`n", "`n" -replace "`r", "`n")
    if (-not $normalized.EndsWith("`n")) {
        $normalized += "`n"
    }
    # WriteAllText, not Set-Content: the latter appends a trailing newline of the
    # host's own and would reintroduce CRLF on Windows PowerShell.
    [IO.File]::WriteAllText($scriptPath, $normalized, [Text.UTF8Encoding]::new($false))
    $scriptPosix = ConvertTo-Msys2Path $Msys2Root $scriptPath

    # MSYS2's own launchers set MSYSTEM and re-exec a login shell; calling
    # bash.exe directly avoids `-l` resetting the working directory, so the
    # script always cd's to an absolute path itself. MSYSTEM is still set because
    # the toolchain reads it, but it does not build PATH: /etc/profile does, and
    # --noprofile skips it, leaving bash with the Windows PATH and no /usr/bin.
    # Every MSYS2 command therefore has to be reachable through the PATH set
    # here, or it fails with "command not found".
    $previousMsystem = $env:MSYSTEM
    $previousChere = $env:CHERE_INVOKING
    # `Stop` would turn MSYS2's ordinary progress output on stderr into a
    # terminating NativeCommandError before the build could finish.
    $previousPreference = $ErrorActionPreference
    try {
        $env:MSYSTEM = "MINGW64"
        $env:CHERE_INVOKING = "1"
        $ErrorActionPreference = "Continue"
        # Out-Host, not bare invocation: a PowerShell function returns everything
        # written to the success stream, so the build's stdout would otherwise be
        # collected into the caller's return value. Get-ManagedFfmpegSdk returned
        # the whole pacman and make transcript alongside the SDK path, and
        # Test-Path then choked on "::" as an invalid wildcard.
        & $bash --noprofile --norc $scriptPosix | Out-Host
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousPreference
        $env:MSYSTEM = $previousMsystem
        $env:CHERE_INVOKING = $previousChere
        Remove-Item -LiteralPath $scriptPath -Force -ErrorAction SilentlyContinue
    }
    if ($exitCode -ne 0) {
        throw "$FailureMessage (exit $exitCode)"
    }
}

function Install-Msys2BuildTools([string]$Msys2Root) {
    # The runner image ships MSYS2 with only a minimal package set: no make,
    # nasm, diffutils, or the MinGW-w64 gcc, all of which `configure` needs.
    # nasm in particular is fatal rather than a silent downgrade, so a missing
    # one fails the build loudly.
    # make and diffutils come from the MSYS environment; the compiler, assembler
    # and pkg-config must be the MINGW64 builds so that what `configure` probes
    # is the toolchain that will actually compile the libraries. pkg-config only
    # silences a detection warning here - `--disable-autodetect` means there are
    # no external libraries to find - but a future dependency would otherwise
    # fail to be detected rather than fail loudly.
    $packages = @(
        "make", "diffutils",
        "mingw-w64-x86_64-gcc", "mingw-w64-x86_64-nasm", "mingw-w64-x86_64-pkgconf"
    )
    # Probing is a plain `-c` command rather than a script so that its non-zero
    # "tools missing" exit is not mistaken for a failure by Invoke-Msys2Bash.
    # It must export the same PATH, or every tool looks missing and the install
    # runs on an installation that already has them.
    $probe = "$Msys2PathExport; " +
        'missing=0; command -v make > /dev/null || missing=1; ' +
        'command -v diff > /dev/null || missing=1; ' +
        'for tool in gcc nasm pkg-config; do test -x "/mingw64/bin/$tool.exe" || missing=1; done; ' +
        'exit "$missing"'
    $bash = Join-Path $Msys2Root "usr\bin\bash.exe"
    $previousMsystem = $env:MSYSTEM
    $previousPreference = $ErrorActionPreference
    try {
        $env:MSYSTEM = "MINGW64"
        $ErrorActionPreference = "Continue"
        & $bash --noprofile --norc -c $probe | Out-Null
        $probeExit = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousPreference
        $env:MSYSTEM = $previousMsystem
    }
    if ($probeExit -eq 0) {
        Write-Host "MSYS2 build tools already present"
        return
    }

    Write-Host "Installing MSYS2 build tools: $($packages -join ', ')"
    # -Sy refreshes the package database first: the runner image's is as old as
    # the image, so pacman would otherwise resolve to package versions that have
    # already been dropped from the mirrors and fail on a 404. A full -Syu is
    # avoided on purpose - upgrading the whole installation can replace the
    # running msys-2.0.dll and needs a second pass to finish.
    $install = @"
set -euo pipefail
pacman -Sy --noconfirm --disable-download-timeout
pacman -S --needed --noconfirm --disable-download-timeout $($packages -join ' ')
"@
    Invoke-Msys2Bash $Msys2Root $install "Could not install the MSYS2 build tools"
}

function Get-FfmpegSource([string]$CacheDirectory) {
    $archivePath = Join-Path $CacheDirectory $FfmpegArchiveName

    if (Test-Path $archivePath) {
        $archiveHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash.ToLowerInvariant()
        if ($archiveHash -eq $FfmpegArchiveSha256) {
            return $archivePath
        }
        Write-Warning "Removing cached FFmpeg source with an invalid SHA-256: $archivePath"
        Remove-Item -LiteralPath $archivePath -Force
    }

    $downloadPath = "$archivePath.download-$([Guid]::NewGuid().ToString('N'))"
    try {
        Write-Host "Downloading FFmpeg $FfmpegVersion source..."
        [Net.ServicePointManager]::SecurityProtocol = `
            [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $FfmpegDownloadUrl -OutFile $downloadPath -UseBasicParsing
        $downloadHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $downloadPath).Hash.ToLowerInvariant()
        if ($downloadHash -ne $FfmpegArchiveSha256) {
            throw "FFmpeg source SHA-256 mismatch. Expected $FfmpegArchiveSha256, got $downloadHash."
        }
        Move-Item -LiteralPath $downloadPath -Destination $archivePath -Force
    } finally {
        if (Test-Path $downloadPath) {
            Remove-Item -LiteralPath $downloadPath -Force
        }
    }

    return $archivePath
}

function Build-FfmpegSdk([string]$Msys2Root, [string]$ArchivePath, [string]$SdkRoot) {
    $buildDirectory = "$SdkRoot.build-$([Guid]::NewGuid().ToString('N'))"
    $stageRoot = "$SdkRoot.stage-$([Guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Force -Path $buildDirectory | Out-Null

    $archivePosix = ConvertTo-Msys2Path $Msys2Root $ArchivePath
    $buildPosix = ConvertTo-Msys2Path $Msys2Root $buildDirectory
    $stagePosix = ConvertTo-Msys2Path $Msys2Root $stageRoot
    $componentList = $RequiredComponents -join " "

    try {
        # One option group per continued line, so a configure failure in the log
        # points at the group that caused it.
        $configureArguments = ($ConfigureOptions | ForEach-Object { "  $_ \" }) -join "`n"
        # PATH is exported by Invoke-Msys2Bash ahead of this script.
        $build = @"
set -euo pipefail

cd "$buildPosix"
echo "Unpacking the FFmpeg $FfmpegVersion source"
tar -xf "$archivePosix"
cd "ffmpeg-$FfmpegVersion"

echo "Building the trimmed FFmpeg $FfmpegVersion -> $stagePosix"
./configure \
$configureArguments
  --prefix="$stagePosix"

for component in $componentList; do
  if ! grep -qx "#define CONFIG_`${component} 1" config_components.h; then
    echo "FFmpeg configure did not enable CONFIG_`${component}; recording would break" >&2
    grep -E "^#define CONFIG_`${component} " config_components.h >&2 || true
    grep -iE "WARNING: Disabled" ffbuild/config.log >&2 || true
    exit 1
  fi
done

# --enable-gpl is never passed, so any of these being set means a dependency
# pulled in a stricter license and the audit conclusion no longer holds.
# configure prints its License: line only to stdout, so assert the generated
# header, which is what the build actually compiles against.
for macro in GPL NONFREE VERSION3 GPLV3 LGPLV3; do
  if ! grep -qx "#define CONFIG_`${macro} 0" config.h; then
    echo "FFmpeg is not LGPL 2.1+: CONFIG_`${macro} is not 0" >&2
    grep -E "^#define CONFIG_(GPL|NONFREE|VERSION3|GPLV3|LGPLV3) " config.h >&2 || true
    exit 1
  fi
done
echo "FFmpeg license: LGPL version 2.1 or later"

make -j"`$(nproc)"
make install
"@
        Invoke-Msys2Bash $Msys2Root $build "Could not build the FFmpeg SDK"

        # FFmpeg installs the MSVC import libraries next to the DLLs in
        # `shlibdir`, but ffmpeg-next's build script looks for them under `lib`,
        # which is also where the Gyan SDK put them.
        $stageBin = Join-Path $stageRoot "bin"
        $stageLib = Join-Path $stageRoot "lib"
        New-Item -ItemType Directory -Force -Path $stageLib | Out-Null
        $importLibraries = @(Get-ChildItem $stageBin -Filter "*.lib" -File -ErrorAction SilentlyContinue)
        if ($importLibraries.Count -lt 1) {
            throw "The FFmpeg build produced no MSVC import libraries in $stageBin."
        }
        foreach ($importLibrary in $importLibraries) {
            Move-Item -LiteralPath $importLibrary.FullName `
                -Destination (Join-Path $stageLib $importLibrary.Name) -Force
        }

        # The notice files the installers ship alongside the DLLs. The upstream
        # tarball has no README.txt, so record what this SDK actually is. Its
        # content is ASCII and is written as such: Set-Content -Encoding utf8
        # emits a BOM on Windows PowerShell 5.1 but not on the pwsh 7 the release
        # workflow uses, and this file is redistributed.
        Copy-Item (Join-Path $buildDirectory "ffmpeg-$FfmpegVersion\COPYING.LGPLv2.1") `
            (Join-Path $stageRoot "LICENSE") -Force
        @"
FFmpeg $FfmpegVersion - built from the official source release for rLive by
scripts/prepare-windows-ffmpeg.ps1.

Licensed under the LGPL version 2.1 or later; --enable-gpl is not used. Only the
demuxers, muxers and protocols rLive's recording needs are enabled, and the
Windows-native schannel backend provides TLS. Source: $FfmpegDownloadUrl
(SHA-256 $FfmpegArchiveSha256).

Configure options:
$($ConfigureOptions -join "`n")

These libraries are linked dynamically, so they can be replaced with your own
build of the same FFmpeg 9.0.1 ABI. The exact source and the options above are
also recorded in the rLive project at https://github.com/Kenny3Shen/rLive.
"@ | Set-Content (Join-Path $stageRoot "README.txt") -Encoding ascii

        Assert-FfmpegSdk $stageRoot
        if (Test-Path $SdkRoot) {
            Remove-Item -LiteralPath $SdkRoot -Recurse -Force
        }
        Move-Item -LiteralPath $stageRoot -Destination $SdkRoot
    } finally {
        foreach ($temporary in @($buildDirectory, $stageRoot)) {
            if (Test-Path $temporary) {
                Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
    }
}

function Get-ManagedFfmpegSdk {
    $cacheDirectory = Join-Path $env:LOCALAPPDATA "rLive\build"
    # The directory name carries the component set, not just the version: a
    # cached full_build-shared SDK from an earlier revision of this script must
    # not satisfy a request for the trimmed one.
    $sdkRoot = Join-Path $cacheDirectory "ffmpeg-$FfmpegVersion-rlive-shared"
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

    $msys2Root = Find-Msys2Root
    Write-Host "Using MSYS2 at $msys2Root"
    Install-Msys2BuildTools $msys2Root
    $archivePath = Get-FfmpegSource $cacheDirectory
    Build-FfmpegSdk $msys2Root $archivePath $sdkRoot

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
    # swresample is matched even though the trimmed SDK no longer produces it:
    # an incremental build over a target directory staged by an earlier revision
    # of this script would otherwise leave that DLL behind for the bundler to
    # pick up.
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
