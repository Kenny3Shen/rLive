# 准备 Windows 上 ffmpeg-next 使用的 FFmpeg 开发 SDK 与运行时文件。
# 该 SDK 由固定版本的官方源码构建，只包含 rLive 实际用到的组件，
# 因此头文件、导入库和 DLL 天然保持一致。
#
# 与 macOS/Linux 使用同一组件白名单：录制和下载仅重封装，不转码，
# 只保留参数探测所需解码器。替代过去的 Gyan full_build-shared，
# 不启用 GPL/version3，FFmpeg 许可证保持 LGPL v2.1+。
#
# 视频 parser 负责补尺寸，但 HLS 主流不透传子流 parser 的尺寸，需保留
# H.264/HEVC 探测解码器；AAC parser 不提供 HE-AAC 可信采样率，两个 AAC
# 解码器也仅用于探测，MP3/AC-3 的采样率由对应 parser 填充。
# 缺少任一参数都会让 `avformat_write_header` 以 `EINVAL` 拒绝录制。
# 需要 PowerShell 7；脚本会拒绝在 Windows PowerShell 5.1 上运行。

#Requires -Version 7.0

param(
    [string]$ProjectRoot = (Get-Location).Path,
    [string]$StageDestination = ""
)

$ErrorActionPreference = "Stop"
# 保持「先跑命令再查 $LASTEXITCODE」的写法：置 false 后原生命令写入 stderr
# 不再抛异常，pacman/make/cygpath 的正常进度输出不会中断构建。
$PSNativeCommandUseErrorActionPreference = $false
$ProgressPreference = "SilentlyContinue"
$FfmpegVersion = "9.0.2"
$FfmpegArchiveName = "ffmpeg-$FfmpegVersion.tar.xz"
$FfmpegDownloadUrl = "https://ffmpeg.org/releases/$FfmpegArchiveName"
# 校验官方 tarball 的分离签名后计算得出，签名对应 FFmpeg 发布签名密钥
# FCF986EA15E6E293A5644F10B4322F04D67658D8 <ffmpeg-devel@ffmpeg.org>。
# 与 prepare-macos-ffmpeg.sh、prepare-linux-ffmpeg.sh 中固定的版本一致：
# 三个桌面平台构建同一个上游发布版本。
$FfmpegArchiveSha256 = "8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e"

# configure 对缺失依赖只发警告；下面在 config_components.h 中逐项断言，
# 防止 HTTPS/代理录制、尺寸与采样率探测或 MP4 合并在运行时才失败。
$RequiredComponents = @(
    "HTTPS_PROTOCOL", "TLS_PROTOCOL", "HTTP_PROTOCOL", "FILE_PROTOCOL",
    "CRYPTO_PROTOCOL", "HTTPPROXY_PROTOCOL", "FLV_DEMUXER", "LIVE_FLV_DEMUXER",
    "HLS_DEMUXER", "MPEGTS_DEMUXER", "MOV_DEMUXER", "FLV_MUXER", "MPEGTS_MUXER", "MP4_MUXER",
    "H264_PARSER", "HEVC_PARSER", "AV1_PARSER", "MPEGAUDIO_PARSER",
    "AAC_PARSER", "AAC_LATM_PARSER", "AC3_PARSER",
    "H264_DECODER", "HEVC_DECODER", "AAC_DECODER", "AAC_LATM_DECODER", "EXTRACT_EXTRADATA_BSF"
)

# `--disable-autodetect` 固定 feature 集合；只恢复 HTTPS 录制所需的原生
# schannel。录制/下载只产出三个 av* 库：不编译 swresample，不链接 zlib，
# 请求使用 `Accept-Encoding: identity`，B 站 fMP4 也没有压缩 moov。
# 使用 w32threads，但 MinGW 的 clock_gettime/nanosleep 仍来自 winpthreads；
# 静态链接该支持库与 libgcc，保留单调时钟且无需额外运行时 DLL。
# 这个列表也会写进随 DLL 分发的 SDK README.txt。
$ConfigureOptions = @(
    "--enable-shared --disable-static",
    "--disable-autodetect --enable-schannel --disable-pthreads --enable-w32threads",
    "--extra-ldflags='-static-libgcc' --extra-libs='-Wl,-Bstatic -lwinpthread -Wl,-Bdynamic'",
    "--disable-programs --disable-doc --disable-debug",
    "--disable-avdevice --disable-avfilter --disable-swscale --disable-swresample",
    "--disable-everything",
    "--enable-demuxer=flv,live_flv,hls,mpegts,mov",
    "--enable-muxer=flv,mpegts,mp4",
    "--enable-parser=h264,hevc,av1,aac,aac_latm,ac3,mpegaudio",
    "--enable-decoder=h264,hevc,aac,aac_latm",
    "--enable-bsf=extract_extradata",
    "--enable-protocol=file,http,https,tls,tcp,crypto,httpproxy"
)

function Invoke-NativeCommand(
    [string]$FilePath,
    [string[]]$Arguments,
    [string]$FailureMessage
) {
    & $FilePath @Arguments
    $exitCode = $LASTEXITCODE
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
        # Android NDK 的 clang 是面向 Android 工具链的宿主编译器。当目标为
        # x86_64-pc-windows-msvc 时，它的资源目录不提供
        # bindgen 所需的 MSVC 桌面头文件。
        if ($Candidate -match '(?i)[\\/]android-sdk[\\/]|[\\/]ndk[\\/]') {
            return $false
        }
        return (
            (Test-Path (Join-Path $Candidate "libclang.dll")) -and
            (Test-Path (Join-Path $Candidate "clang.exe"))
        )
    }

    # 即使用户环境变量已更新，WSL 互操作仍可能传入过期的进程级取值，
    # 因此在回退之前检查所有作用域。
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
    # 只有这三个；`ffmpeg-sys-next` 只链接 avformat、avcodec、avutil。
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
    # GitHub 的 windows 运行器在 C:\msys64 预装了 MSYS2，但刻意不放进 PATH，
    # 因此这里探测常见根目录而不依赖 `Get-Command`。构建需要 POSIX shell，
    # 因为 FFmpeg 的 `configure` 是 shell 脚本；选择 MinGW-w64 而非 FFmpeg 的
    # MSVC 工具链，是因为它无需 PATH 上有 `cl.exe`，且仍能产出当前 MSVC
    # 目标所链接的 `ar` 格式导入库 —— 此前的 Gyan SDK 本身就是 MinGW 构建，
    # 分发的正是同一组 `.def` + `.lib` + `.dll.a`。
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
            # 其余工具链由 pacman 安装，所以缺少它的根目录不可用。在这里检查，
            # 可以把原本来自生成脚本内部的一句
            # "command not found"，变成明确指出所探测目录的提示信息。
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

# 为下面所有 MSYS2 调用准备 PATH。通常由 /etc/profile 负责拼装，而
# `--noprofile` 会跳过它，所以在这里启动的 bash 否则只会继承 Windows 的
# PATH，并因 `pacman: command not found` 失败。/mingw64/bin 放在最前，
# 让 `configure` 探测到将真正编译这些库的 MinGW-w64 gcc 与 nasm；
# /usr/bin 提供 pacman、make、tar 和 coreutils。刻意不追加 Windows PATH：
# 让某个 Windows 工具排在 MSYS2 工具之前，正是本构建要避免的偏差。
$Msys2PathExport = 'export PATH="/mingw64/bin:/usr/bin:/usr/local/bin"'

function ConvertTo-Msys2Path([string]$Msys2Root, [string]$WindowsPath) {
    # MSYS2 需要 POSIX 路径，而 cygpath 是处理盘符和 UNC 根目录唯一可靠的
    # 转换工具。cygpath 位于 /usr/bin，而 --noprofile 不会把它加入 PATH，
    # 所以这里也要设置。
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
    # 脚本被写入文件而不是通过管道传给 `bash -s`，因为管道会给最后一行追加
    # CRLF：bash 于是会执行 `make install\r` 并以 "No rule to make target" 失败。
    # 在这里统一规范化换行，也让构建不受本文件的 git 检出方式影响，
    # 否则 core.autocrlf 检出会给 here-string 的每一行都加上 CR。
    $scriptPath = Join-Path ([IO.Path]::GetTempPath()) "rlive-msys2-$([Guid]::NewGuid().ToString('N')).sh"
    # PATH 被前置写入脚本自身，而不是用 `bash -c ... . script` 包在外面，
    # 后者会把脚本里的 `set -e` 和 `exit` 泄漏到外层 shell。
    $normalized = ($Msys2PathExport + "`n" + $Script -replace "`r`n", "`n" -replace "`r", "`n")
    if (-not $normalized.EndsWith("`n")) {
        $normalized += "`n"
    }
    # 用 WriteAllText 而不是 Set-Content：后者会自行追加一个换行，
    # 而 bash 会把那行空内容当成一条命令。
    [IO.File]::WriteAllText($scriptPath, $normalized, [Text.UTF8Encoding]::new($false))
    $scriptPosix = ConvertTo-Msys2Path $Msys2Root $scriptPath

    # MSYS2 自带的启动器会设置 MSYSTEM 并重新执行登录 shell；直接调用
    # bash.exe 可避免 `-l` 重置工作目录，因此脚本始终自己 cd 到绝对路径。
    # 仍然设置 MSYSTEM 是因为工具链会读取它，但它不负责构建 PATH：
    # 那是 /etc/profile 的工作，而 --noprofile 跳过了它，使 bash 只剩
    # Windows PATH 且没有 /usr/bin。所以每个 MSYS2 命令都必须能通过
    # 这里设置的 PATH 找到，否则会以 "command not found" 失败。
    $previousMsystem = $env:MSYSTEM
    $previousChere = $env:CHERE_INVOKING
    try {
        $env:MSYSTEM = "MINGW64"
        $env:CHERE_INVOKING = "1"
        # 使用 Out-Host 而不是直接调用：PowerShell 函数会返回写入成功流的所有内容，
        # 否则构建的 stdout 会被收集进调用方的返回值。Get-ManagedFfmpegSdk 曾把
        # 整个 pacman 与 make 的输出连同 SDK 路径一起返回，
        # 随后 Test-Path 因 "::" 是无效通配符而报错。
        & $bash --noprofile --norc $scriptPosix | Out-Host
        $exitCode = $LASTEXITCODE
    } finally {
        $env:MSYSTEM = $previousMsystem
        $env:CHERE_INVOKING = $previousChere
        Remove-Item -LiteralPath $scriptPath -Force -ErrorAction SilentlyContinue
    }
    if ($exitCode -ne 0) {
        throw "$FailureMessage (exit $exitCode)"
    }
}

function Install-Msys2BuildTools([string]$Msys2Root) {
    # 运行器镜像自带的 MSYS2 只有最小包集：没有 make、nasm、diffutils，
    # 也没有 MinGW-w64 gcc，而 `configure` 全都需要。其中 nasm 缺失是致命错误
    # 而非静默降级，因此缺少时会让构建直接失败。
    # make 与 diffutils 来自 MSYS 环境；编译器、汇编器和 pkg-config 必须是
    # MINGW64 版本，这样 `configure` 探测到的就是真正编译这些库的工具链。
    # pkg-config 在这里只是消除一条探测警告 —— `--disable-autodetect` 意味着
    # 没有外部库需要查找 —— 但若将来新增依赖，缺少它会导致依赖探测不到
    # 而不是直接报错。
    $packages = @(
        "make", "diffutils",
        "mingw-w64-x86_64-gcc", "mingw-w64-x86_64-nasm", "mingw-w64-x86_64-pkgconf"
    )
    # 探测使用普通的 `-c` 命令而不是脚本，这样它"工具缺失"时的非零退出
    # 不会被 Invoke-Msys2Bash 当成失败。它必须导出相同的 PATH，
    # 否则所有工具都像缺失，而安装步骤又会在已装好的环境上重跑。
    $probe = "$Msys2PathExport; " +
        'missing=0; command -v make > /dev/null || missing=1; ' +
        'command -v diff > /dev/null || missing=1; ' +
        'for tool in gcc nasm pkg-config; do test -x "/mingw64/bin/$tool.exe" || missing=1; done; ' +
        'exit "$missing"'
    $bash = Join-Path $Msys2Root "usr\bin\bash.exe"
    $previousMsystem = $env:MSYSTEM
    try {
        $env:MSYSTEM = "MINGW64"
        & $bash --noprofile --norc -c $probe | Out-Null
        $probeExit = $LASTEXITCODE
    } finally {
        $env:MSYSTEM = $previousMsystem
    }
    if ($probeExit -eq 0) {
        Write-Host "MSYS2 build tools already present"
        return
    }

    Write-Host "Installing MSYS2 build tools: $($packages -join ', ')"
    # -Sy 会先刷新软件包数据库：运行器镜像里的数据库和镜像一样陈旧，
    # 否则 pacman 会解析到已从镜像站移除的版本并因 404 失败。
    # 刻意不用完整的 -Syu —— 升级整个安装可能替换正在运行的 msys-2.0.dll，
    # 并需要第二轮才能完成。
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
        # 每个续行放一组选项，这样 configure 失败时日志能指向出问题的那一组。
        $configureArguments = ($ConfigureOptions | ForEach-Object { "  $_ \" }) -join "`n"
        # PATH 由 Invoke-Msys2Bash 在本脚本之前导出。
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
    echo "FFmpeg configure did not enable CONFIG_`${component}; recording or downloads would break" >&2
    grep -E "^#define CONFIG_`${component} " config_components.h >&2 || true
    grep -iE "WARNING: Disabled" ffbuild/config.log >&2 || true
    exit 1
  fi
done

# 线程使用 Win32 原生实现；时间函数的 MinGW 支持另行静态链接。
for entry in "HAVE_W32THREADS 1" "HAVE_PTHREADS 0"; do
  if ! grep -qx "#define `$entry" config.h; then
    echo "FFmpeg must use native Win32 threads: #define `$entry is missing" >&2
    grep -E "^#define HAVE_(W32THREADS|PTHREADS) " config.h >&2 || true
    exit 1
  fi
done

# 从不传入 --enable-gpl，所以这些项一旦被设置，就意味着某个依赖引入了
# 更严格的许可，审计结论不再成立。configure 只把 License: 行打印到 stdout，
# 因此断言生成的头文件 —— 那才是构建真正编译时依据的内容。
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

# 在编译 Rust 之前拦截缺失依赖；发布工作流还会检查最终暂存的 DLL。
for library in avutil avcodec avformat; do
  files=("$stagePosix/bin/`$library-"*.dll)
  if [ "`${#files[@]}" -ne 1 ] || [ ! -f "`${files[0]}" ]; then
    echo "Expected one `$library runtime DLL" >&2
    exit 1
  fi
  imports="`$(objdump -p "`${files[0]}" | sed -n 's/.*DLL Name: //p')"
  unexpected="`$(printf '%s\n' "`$imports" | grep -iE '^(libwinpthread|libgcc_s|libstdc\+\+)|^(av|sw)[a-z]+-[0-9]+\.dll`$' | grep -ivE '^(avutil|avcodec|avformat)-[0-9]+\.dll`$' || true)"
  if [ -n "`$unexpected" ]; then
    echo "`$library imports unbundled runtimes: `$unexpected" >&2
    exit 1
  fi
done

# 静态支持库的版权声明随 SDK README 分发，不增加安装包文件白名单。
cp /mingw64/share/licenses/winpthreads/COPYING "$buildPosix/winpthreads-COPYING"
"@
        Invoke-Msys2Bash $Msys2Root $build "Could not build the FFmpeg SDK"

        # FFmpeg 会把 MSVC 导入库安装到 `shlibdir` 中 DLL 的旁边，
        # 但 ffmpeg-next 的构建脚本在 `lib` 下查找，
        # Gyan SDK 也是放在那里的。
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

        # 随 DLL 一起由安装包分发的声明文件。上游 tarball 没有 README.txt，
        # 所以这里记录该 SDK 的实际构成。内容为 ASCII 并按 ASCII 写出，
        # 避免给再分发的文件带上 BOM。
        Copy-Item (Join-Path $buildDirectory "ffmpeg-$FfmpegVersion\COPYING.LGPLv2.1") `
            (Join-Path $stageRoot "LICENSE") -Force
        @"
FFmpeg $FfmpegVersion - built from the official source release for rLive by
scripts/prepare-windows-ffmpeg.ps1.

Licensed under the LGPL version 2.1 or later; --enable-gpl is not used. Only the
demuxers, muxers and protocols rLive's recording and downloads need are enabled, and the
Windows-native schannel backend provides TLS. Source: $FfmpegDownloadUrl
(SHA-256 $FfmpegArchiveSha256).

Configure options:
$($ConfigureOptions -join "`n")

These libraries are linked dynamically, so they can be replaced with your own
build of the same FFmpeg 9.0.2 ABI. The exact source and the options above are
also recorded in the rLive project at https://github.com/Kenny3Shen/rLive.

MinGW winpthreads support for clock_gettime/nanosleep is linked statically.
Its copyright and license notices follow:
"@ | Set-Content (Join-Path $stageRoot "README.txt") -Encoding ascii
        Get-Content (Join-Path $buildDirectory "winpthreads-COPYING") -Raw |
            Add-Content (Join-Path $stageRoot "README.txt") -Encoding ascii

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
    # 目录名携带组件集合：旧版 full/MP4 SDK 不得被当作精简版命中结果。
    $sdkRoot = Join-Path $cacheDirectory "ffmpeg-$FfmpegVersion-rlive-shared-minimal-probe-static-runtime"
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
# LIBCLANG_PATH 供 ffmpeg-next 的 bindgen 使用；cc-rs 通过 PATH 解析
# 可执行文件，因此要把同一个 LLVM bin 目录同时暴露给两个构建步骤。
$env:Path = $env:LIBCLANG_PATH + ";" + $env:RLIVE_FFMPEG_RUNTIME_DIR + ";" + $env:Path

if ($StageDestination) {
    $StageDestination = [IO.Path]::GetFullPath($StageDestination)
    New-Item -ItemType Directory -Force -Path $StageDestination | Out-Null
    # 仍然匹配 swresample，尽管精简后的 SDK 不再产出它：
    # 若在由本脚本早期版本暂存过的 target 目录上做增量构建，
    # 否则会把那个 DLL 留在原处被打包器收进产物。
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
