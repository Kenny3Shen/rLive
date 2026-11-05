#!/usr/bin/env bash
# 构建 macOS 上 `ffmpeg-next` 所链接的静态 FFmpeg 库。
#
# Homebrew 的 FFmpeg 不能用于发布：它是共享构建，其 libavcodec 递归依赖
# 数十个 Homebrew dylib，因此链接它的 DMG 在没有 Homebrew 的 Mac 上无法启动。
# 链接由固定版本官方源码构建的静态库可让应用自包含
# （无需复制 `Frameworks` dylib，也无需重写 install name），
# 产物可复现，并把许可审计范围限定在 FFmpeg 自身。
#
# 只启用录制与视频下载所需能力：FLV/HLS/MPEG-TS 解复用后重封装为
# FLV/MPEG-TS，B 站 DASH 的本地 MOV/fMP4 轨合并为 MP4，均不转码。
# 封装/解封装依赖的 BSF 由 configure 自动选中；视频 parser 供
# `avformat_find_stream_info` 从 H.264/HEVC/AV1 序列头补出画面尺寸，
# HLS 主流不透传子流 parser 的尺寸，需 H.264/HEVC 解码器参与探测；
# AAC parser 不提供 HE-AAC 可信采样率，两个 AAC 解码器同样仅用于探测。
# extract_extradata 从帧中提取封装所需序列头，不转码。
# FLV/MP3 与 AC-3 的采样率由 mpegaudio/ac3 parser 填充。
# 不需要播放器解码、Matroska、zlib 或 swresample；录制请求明确使用
# `Accept-Encoding: identity`，B 站 fMP4 也没有压缩 moov。
# 构建结果为 LGPL：不传 `--enable-gpl`，也不启用外部编解码库。
set -euo pipefail

FFMPEG_VERSION="9.0.2"
# 组件白名单变化时递增，避免复用缺少新能力的同版本 SDK。
FFMPEG_CONFIG_VERSION="4-minimal"
FFMPEG_ARCHIVE="ffmpeg-${FFMPEG_VERSION}.tar.xz"
FFMPEG_URL="https://ffmpeg.org/releases/${FFMPEG_ARCHIVE}"
# 校验官方 tarball 的分离签名后计算得出，签名对应 FFmpeg 发布签名密钥
# FCF986EA15E6E293A5644F10B4322F04D67658D8 <ffmpeg-devel@ffmpeg.org>。
FFMPEG_SHA256="8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e"

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
config_stamp="$prefix/.rlive-config-version"

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
  for required in libavformat.a libavcodec.a libavutil.a; do
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

# 旧 SDK 即使文件齐全，也可能包含不同组件集；仅复用相同配置的缓存。
if [[ -f "$prefix/lib/libavformat.a" && -f "$prefix/lib/pkgconfig/libavformat.pc" \
  && "$(cat "$config_stamp" 2>/dev/null || true)" == "$FFMPEG_CONFIG_VERSION" ]]; then
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
  # `--disable-autodetect` 固定 feature 集合；只显式恢复 HTTPS 录制所需的
  # macOS 原生 Secure Transport。
  ./configure \
    --prefix="$prefix" \
    --arch="$configure_arch" \
    --extra-cflags="-arch $configure_arch -mmacosx-version-min=$deployment_target" \
    --extra-ldflags="-arch $configure_arch -mmacosx-version-min=$deployment_target" \
    --enable-static \
    --enable-pic \
    --disable-autodetect \
    --enable-securetransport \
    --disable-programs \
    --disable-doc \
    --disable-debug \
    --disable-avdevice \
    --disable-avfilter \
    --disable-swscale \
    --disable-swresample \
    --disable-everything \
    --enable-demuxer=flv,live_flv,hls,mpegts,mov \
    --enable-muxer=flv,mpegts,mp4 \
    --enable-parser=h264,hevc,av1,aac,aac_latm,ac3,mpegaudio \
    --enable-decoder=h264,hevc,aac,aac_latm \
    --enable-bsf=extract_extradata \
    --enable-protocol=file,http,https,tls,tcp,crypto,httpproxy \
    --pkg-config-flags=--static

  # configure 对缺失依赖只发警告，因此断言生成头文件，防止运行时才暴露
  # HTTPS/代理录制、FLV 尺寸探测、AAC 采样率探测或 MP4 合并能力缺失。
  for component in \
    HTTPS_PROTOCOL TLS_PROTOCOL HTTP_PROTOCOL FILE_PROTOCOL CRYPTO_PROTOCOL \
    HTTPPROXY_PROTOCOL \
    FLV_DEMUXER LIVE_FLV_DEMUXER HLS_DEMUXER MPEGTS_DEMUXER MOV_DEMUXER \
    FLV_MUXER MPEGTS_MUXER MP4_MUXER \
    H264_PARSER HEVC_PARSER AV1_PARSER MPEGAUDIO_PARSER \
    AAC_PARSER AAC_LATM_PARSER AC3_PARSER \
    H264_DECODER HEVC_DECODER AAC_DECODER AAC_LATM_DECODER EXTRACT_EXTRADATA_BSF; do
    if ! grep -qx "#define CONFIG_${component} 1" config_components.h; then
      echo "FFmpeg configure 未启用 CONFIG_${component}，录制或下载功能会缺失" >&2
      grep -E "^#define CONFIG_${component} " config_components.h >&2 || true
      grep -iE "WARNING: Disabled" ffbuild/config.log >&2 || true
      exit 1
    fi
  done

  make -j"$(sysctl -n hw.ncpu)"
  make install
)

verify_prefix
printf '%s\n' "$FFMPEG_CONFIG_VERSION" > "$config_stamp"
emit_environment
