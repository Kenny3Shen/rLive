#!/usr/bin/env bash
# 构建 macOS 上 `ffmpeg-next` 所链接的静态 FFmpeg 库。
#
# Homebrew 的 FFmpeg 不能用于发布：它是共享构建，其 libavcodec 递归依赖
# 数十个 Homebrew dylib，因此链接它的 DMG 在没有 Homebrew 的 Mac 上无法启动。
# 链接由固定版本官方源码构建的静态库可让应用自包含
# （无需复制 `Frameworks` dylib，也无需重写 install name），
# 产物可复现，并把许可审计范围限定在 FFmpeg 自身。
#
# 只启用 `recording_ffmpeg.rs` 实际用到的能力：它解复用 FLV/HLS/MPEG-TS
# 并重新封装为 FLV 或 MPEG-TS，自身从不解码或编码。比特流过滤器确实由
# `configure` 的 `*_muxer_select` 自动拉入，但解析器和解码器都不是：除
# `ac3_parser` 之外，没有任何启用的封装/解封装器会 select `h264_parser`。
#
# 解析器和音频解码器缺一个，录制就会在写头时以 `EINVAL` 失败，
# 用户看到的就是「写入容器头失败: Invalid argument」。两者补的是不同的参数：
#
# - 解析器补画面尺寸。裸流容器（FLV/MPEG-TS）不在容器层声明尺寸，
#   `avformat_find_stream_info` 只能靠解析器从 H.264 SPS 读出 `width`/`height`。
#   缺失时 `codecpar` 保持 0，而 flv 封装器没有 `AVFMT_NODIMENSIONS`，
#   `avformat_write_header` 直接拒绝（libavformat/mux.c 的 init_muxer）。
# - 音频解码器补采样率。`aac_parser` 刻意不设 `sample_rate`：
#   为兼容 HE-AAC，ADTS 头里的采样率和声道数都不可信
#   （libavcodec/aac_ac3_parser.c 中的注释），所以该值只能由解码器给出。
#   而 init_muxer 对音频轨要求 `sample_rate > 0`，且没有类似
#   `AVFMT_NODIMENSIONS` 的豁免 —— flv 和 mpegts 都会以 `EINVAL` 拒绝。
#   同时 `avformat_find_stream_info` 的 has_codec_parameters 也要求采样率，
#   缺失会让它一直探测到上限，HLS 录制表现为长时间卡在开流阶段。
#
# 解码器只启用音频：视频尺寸由解析器解决，无需解码视频。刻意不含 opus —— 它是
# 三个平台里唯一 `deps="swresample"` 的音频解码器，而 Windows 构建关闭了
# swresample，启用只会被 configure 静默丢掉，反而让三个平台的组件集出现偏差。
#
# 构建结果为 LGPL：刻意不传 `--enable-gpl`，也不启用任何外部编解码库。
set -euo pipefail

FFMPEG_VERSION="9.0.1"
FFMPEG_ARCHIVE="ffmpeg-${FFMPEG_VERSION}.tar.xz"
FFMPEG_URL="https://ffmpeg.org/releases/${FFMPEG_ARCHIVE}"
# 校验官方 tarball 的分离签名后计算得出，签名对应 FFmpeg 发布签名密钥
# FCF986EA15E6E293A5644F10B4322F04D67658D8 <ffmpeg-devel@ffmpeg.org>。
FFMPEG_SHA256="cf38e0e28c7e5605942c4a77755349b0145804a397af37eb1fb4c77cb237f635"

usage() {
  cat >&2 <<'USAGE'
用法: prepare-macos-ffmpeg.sh --arch <arm64|x64> [--prefix <目录>]

构建 pkg-config 可发现的静态 FFmpeg 库，并把 FFMPEG_PREFIX / PKG_CONFIG_PATH
写入 $GITHUB_ENV（存在时）以及标准输出。
USAGE
  exit 2
}

arch=""
prefix=""
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --arch)
      arch="${2:-}"
      shift 2
      ;;
    --prefix)
      prefix="${2:-}"
      shift 2
      ;;
    *)
      usage
      ;;
  esac
done

# 这些值不能高于应用自身的构建目标，否则链接器会警告静态库面向的 macOS
# 版本比二进制更新。Tauri 会把 `bundle.macOS.minimumSystemVersion` 写入
# `MACOSX_DEPLOYMENT_TARGET`，默认为 10.13，低于这里的两个值 —— 因此应用
# 按两者中较新的版本构建，二者保持兼容。Apple Silicon 从未在 11.0 之前
# 发布，所以 arm64 切片不可能面向更低版本。
case "$arch" in
  arm64)
    deployment_target="11.0"
    configure_arch="arm64"
    ;;
  x64)
    deployment_target="10.13"
    configure_arch="x86_64"
    ;;
  *)
    usage
    ;;
esac

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "prepare-macos-ffmpeg.sh 只能在 macOS 上运行" >&2
  exit 1
fi

if [[ -z "$prefix" ]]; then
  prefix="${HOME}/Library/Caches/rLive/ffmpeg-${FFMPEG_VERSION}-${arch}"
fi
mkdir -p "$prefix"
prefix="$(cd "$prefix" && pwd)"

emit_environment() {
  echo "FFMPEG_PREFIX=$prefix"
  echo "PKG_CONFIG_PATH=$prefix/lib/pkgconfig"
  if [[ -n "${GITHUB_ENV:-}" ]]; then
    # `ffmpeg-sys-next` 通过 pkg-config 解析库位置，它的 `static` feature
    # 会让 pkg-config 输出静态库所需的 `Libs.private` 传递依赖。
    {
      echo "FFMPEG_PREFIX=$prefix"
      echo "PKG_CONFIG_PATH=$prefix/lib/pkgconfig"
      echo "MACOSX_DEPLOYMENT_TARGET=$deployment_target"
    } >> "$GITHUB_ENV"
  fi
}

verify_prefix() {
  for required in libavformat.a libavcodec.a libavutil.a libswresample.a; do
    if [[ ! -f "$prefix/lib/$required" ]]; then
      echo "静态 FFmpeg 缺少 $required: $prefix/lib" >&2
      exit 1
    fi
  done
  for required in libavformat.pc libavcodec.pc libavutil.pc; do
    if [[ ! -f "$prefix/lib/pkgconfig/$required" ]]; then
      echo "静态 FFmpeg 缺少 $required: $prefix/lib/pkgconfig" >&2
      exit 1
    fi
  done
  # 在这里做共享构建会失去意义：DMG 又会依赖不在包内的库。
  if compgen -G "$prefix/lib/*.dylib" > /dev/null; then
    echo "构建产物包含 dylib，静态构建配置有误: $prefix/lib" >&2
    exit 1
  fi
}

# 完整的 prefix 会被原样复用，因此缓存命中时可跳过整个构建。
if [[ -f "$prefix/lib/libavformat.a" && -f "$prefix/lib/pkgconfig/libavformat.pc" ]]; then
  echo "复用已构建的静态 FFmpeg: $prefix"
  verify_prefix
  emit_environment
  exit 0
fi

# `ffmpeg-sys-next` 通过 pkg-config 定位库，且 x86_64 构建需要与 nasm
# 兼容的汇编器：`configure` 会把缺失汇编器视为致命错误，而不是安静地
# 丢掉手写汇编。运行器上不保证预装这两者，所以缺什么就装什么，
# 而不是在构建中途失败。
# 以字符串而非数组收集：macOS 自带 bash 3.2，在 `set -u` 下展开空数组
# 会中止脚本。
missing_tools=""
command -v pkg-config > /dev/null || missing_tools="$missing_tools pkg-config"
if [[ "$configure_arch" == "x86_64" ]]; then
  command -v nasm > /dev/null || missing_tools="$missing_tools nasm"
fi
if [[ -n "$missing_tools" ]]; then
  if ! command -v brew > /dev/null; then
    echo "缺少构建工具${missing_tools}，且没有可用的 brew 安装它们" >&2
    exit 1
  fi
  echo "安装缺失的构建工具:${missing_tools}"
  # 故意不加引号：这个列表是上面拼好的、以空格分隔的字面 formula 名集合。
  # shellcheck disable=SC2086
  brew install $missing_tools
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "下载 FFmpeg ${FFMPEG_VERSION} 源码"
curl --proto '=https' --tlsv1.2 --location --fail --silent --show-error \
  --retry 3 --retry-delay 2 --output "$work/$FFMPEG_ARCHIVE" "$FFMPEG_URL"

actual_sha256="$(shasum -a 256 "$work/$FFMPEG_ARCHIVE" | awk '{ print $1 }')"
if [[ "$actual_sha256" != "$FFMPEG_SHA256" ]]; then
  echo "FFmpeg 源码 SHA-256 校验失败" >&2
  echo "  期望: $FFMPEG_SHA256" >&2
  echo "  实际: $actual_sha256" >&2
  exit 1
fi

tar -xf "$work/$FFMPEG_ARCHIVE" -C "$work"
source_dir="$work/ffmpeg-${FFMPEG_VERSION}"
test -f "$source_dir/configure"

echo "编译静态 FFmpeg ${FFMPEG_VERSION} ($configure_arch) -> $prefix"
(
  cd "$source_dir"
  # `--disable-autodetect` 把 feature 集合固定为这里列出的内容，而不是取决于
  # 运行器上恰好安装了什么，这正是产物可复现的原因。它同时会关掉 zlib 和
  # Secure Transport，而这两者都是必需的 —— mov/matroska 探测需要 zlib，
  # 直连 HTTPS 录制需要 TLS —— 所以都显式重新启用。
  ./configure \
    --prefix="$prefix" \
    --arch="$configure_arch" \
    --extra-cflags="-arch $configure_arch -mmacosx-version-min=$deployment_target" \
    --extra-ldflags="-arch $configure_arch -mmacosx-version-min=$deployment_target" \
    --enable-static \
    --enable-pic \
    --disable-autodetect \
    --enable-zlib \
    --enable-securetransport \
    --disable-programs \
    --disable-doc \
    --disable-debug \
    --disable-avdevice \
    --disable-avfilter \
    --disable-swscale \
    --disable-everything \
    --enable-demuxer=flv,live_flv,hls,mpegts,mov,matroska \
    --enable-muxer=flv,mpegts \
    --enable-parser=h264,hevc,aac,aac_latm,ac3,mpegaudio,av1,vp9,vvc,opus,flac \
    --enable-decoder=aac,aac_latm,ac3,eac3,mp3,mp2,flac,vorbis \
    --enable-protocol=file,http,https,tls,tcp,crypto,httpproxy \
    --pkg-config-flags=--static

  # `configure` 会把依赖未满足的组件降级为警告并仍以 0 退出 —— 找不到 TLS
  # 后端会把 `--enable-protocol=https` 变成 `CONFIG_HTTPS_PROTOCOL 0`，
  # 而这种缺失只会在运行时暴露，表现为用户 Mac 上 HTTPS 录制失败。
  # httpproxy 同理：HTTPS 录制经代理隧道时（设置里配了 HTTP 代理），
  # libavformat 的 tls 协议会把连接交给 `httpproxy://` 协议建立 CONNECT 隧道，
  # 缺了它录制只会得到一句 "Protocol not found"。
  # 因此断言生成的头文件，而不是相信退出码。
  for component in \
    HTTPS_PROTOCOL TLS_PROTOCOL HTTP_PROTOCOL FILE_PROTOCOL CRYPTO_PROTOCOL \
    HTTPPROXY_PROTOCOL \
    FLV_DEMUXER LIVE_FLV_DEMUXER HLS_DEMUXER MPEGTS_DEMUXER MOV_DEMUXER \
    FLV_MUXER MPEGTS_MUXER \
    H264_PARSER HEVC_PARSER AAC_PARSER AAC_LATM_PARSER AC3_PARSER \
    AAC_DECODER AAC_LATM_DECODER AC3_DECODER EAC3_DECODER MP3_DECODER; do
    if ! grep -qx "#define CONFIG_${component} 1" config_components.h; then
      echo "FFmpeg configure 未启用 CONFIG_${component}，录制功能会缺失" >&2
      grep -E "^#define CONFIG_${component} " config_components.h >&2 || true
      grep -iE "WARNING: Disabled" ffbuild/config.log >&2 || true
      exit 1
    fi
  done

  make -j"$(sysctl -n hw.ncpu)"
  make install
)

verify_prefix
emit_environment
