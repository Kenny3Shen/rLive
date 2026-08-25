#!/usr/bin/env bash
# Build the static FFmpeg libraries `ffmpeg-next` links against on Linux.
#
# The distribution's `libav*-dev` packages cannot be used for a release: their
# version is whatever the build machine happens to ship, they are unpinned and
# unchecksummed, and the resulting binary depends on `libavformat.so.60` and
# friends being present on the user's machine with a compatible soname. Linking
# static archives built from the pinned official source keeps the packages
# self-contained, makes the artifact reproducible, and bounds the license audit
# to FFmpeg itself.
#
# Only what `recording_ffmpeg.rs` actually exercises is enabled: it demuxes
# FLV/HLS/MPEG-TS and remuxes into FLV or MPEG-TS without ever decoding or
# encoding. `configure` pulls in the parsers and bitstream filters those
# muxers/demuxers select on its own, so they are not listed here.
#
# The build is LGPL: `--enable-gpl` is deliberately not passed. OpenSSL is the
# TLS backend rather than GnuTLS on purpose — see the configure call below.
set -euo pipefail

FFMPEG_VERSION="9.0.1"
FFMPEG_ARCHIVE="ffmpeg-${FFMPEG_VERSION}.tar.xz"
FFMPEG_URL="https://ffmpeg.org/releases/${FFMPEG_ARCHIVE}"
# Measured from the official tarball after verifying its detached signature
# against the FFmpeg release signing key
# FCF986EA15E6E293A5644F10B4322F04D67658D8 <ffmpeg-devel@ffmpeg.org>.
# Identical to the pin in prepare-macos-ffmpeg.sh: both platforms build the
# same upstream release.
FFMPEG_SHA256="cf38e0e28c7e5605942c4a77755349b0145804a397af37eb1fb4c77cb237f635"

usage() {
  cat >&2 <<'USAGE'
用法: prepare-linux-ffmpeg.sh [--prefix <目录>]

构建 pkg-config 可发现的静态 FFmpeg 库，并把 FFMPEG_PREFIX / PKG_CONFIG_PATH
写入 $GITHUB_ENV（存在时）以及标准输出。
USAGE
  exit 2
}

prefix=""
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --prefix)
      prefix="${2:-}"
      shift 2
      ;;
    *)
      usage
      ;;
  esac
done

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "prepare-linux-ffmpeg.sh 只能在 Linux 上运行" >&2
  exit 1
fi

if [[ -z "$prefix" ]]; then
  prefix="${XDG_CACHE_HOME:-$HOME/.cache}/rLive/ffmpeg-${FFMPEG_VERSION}-$(uname -m)"
fi
mkdir -p "$prefix"
prefix="$(cd "$prefix" && pwd)"

emit_environment() {
  echo "FFMPEG_PREFIX=$prefix"
  echo "PKG_CONFIG_PATH=$prefix/lib/pkgconfig"
  if [[ -n "${GITHUB_ENV:-}" ]]; then
    # `ffmpeg-sys-next` resolves the libraries through pkg-config, and its
    # `static` feature makes pkg-config emit the `Libs.private` transitive
    # dependencies the archives need.
    {
      echo "FFMPEG_PREFIX=$prefix"
      echo "PKG_CONFIG_PATH=$prefix/lib/pkgconfig"
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
  # A shared build here would defeat the point: the packages would again depend
  # on libraries that are not inside them.
  if compgen -G "$prefix/lib/*.so*" > /dev/null; then
    echo "构建产物包含共享库，静态构建配置有误: $prefix/lib" >&2
    exit 1
  fi
}

# A complete prefix is reused as-is so a warm cache skips the whole build.
if [[ -f "$prefix/lib/libavformat.a" && -f "$prefix/lib/pkgconfig/libavformat.pc" ]]; then
  echo "复用已构建的静态 FFmpeg: $prefix"
  verify_prefix
  emit_environment
  exit 0
fi

# `ffmpeg-sys-next` locates the libraries through pkg-config, and the x86_64
# build needs a nasm-compatible assembler: `configure` treats a missing one as a
# fatal error rather than quietly dropping the hand-written assembly. The
# release workflow installs both through apt, so here only report what is
# missing instead of trying to install it — this script must stay usable by a
# developer who is not running as root.
missing_tools=()
command -v pkg-config > /dev/null || missing_tools+=("pkg-config")
command -v nasm > /dev/null || missing_tools+=("nasm")
command -v make > /dev/null || missing_tools+=("make")
if [[ "${#missing_tools[@]}" -gt 0 ]]; then
  echo "缺少构建工具: ${missing_tools[*]}" >&2
  echo "请先安装，例如: sudo apt-get install --yes ${missing_tools[*]}" >&2
  exit 1
fi

# The TLS backend is a licensing decision, not just a dependency choice.
# `configure` puts `gnutls` in the plain EXTERNAL_LIBRARY_LIST and only rejects
# `openssl` when `--enable-gpl` is also set (configure:7552), so both are
# available to this LGPL build. OpenSSL wins on two counts: Debian's
# `gnutls.pc` declares `Libs.private: -lgmp …` plus nettle/hogweed/libtasn1/
# libidn2/p11-kit, which drags LGPLv3 GMP into a static link and needs every
# one of those archives present, while `libssl.pc` needs only libcrypto; and
# the application already links OpenSSL through reqwest's native-tls, so this
# reuses that backend instead of adding a second TLS implementation.
if ! pkg-config --exists openssl; then
  echo "缺少 OpenSSL 开发包，静态 FFmpeg 需要它作为 TLS 后端" >&2
  echo "请先安装，例如: sudo apt-get install --yes libssl-dev" >&2
  exit 1
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "下载 FFmpeg ${FFMPEG_VERSION} 源码"
curl --proto '=https' --tlsv1.2 --location --fail --silent --show-error \
  --retry 3 --retry-delay 2 --output "$work/$FFMPEG_ARCHIVE" "$FFMPEG_URL"

actual_sha256="$(sha256sum "$work/$FFMPEG_ARCHIVE" | awk '{ print $1 }')"
if [[ "$actual_sha256" != "$FFMPEG_SHA256" ]]; then
  echo "FFmpeg 源码 SHA-256 校验失败" >&2
  echo "  期望: $FFMPEG_SHA256" >&2
  echo "  实际: $actual_sha256" >&2
  exit 1
fi

tar -xf "$work/$FFMPEG_ARCHIVE" -C "$work"
source_dir="$work/ffmpeg-${FFMPEG_VERSION}"
test -f "$source_dir/configure"

echo "编译静态 FFmpeg ${FFMPEG_VERSION} -> $prefix"
(
  cd "$source_dir"
  # `--disable-autodetect` pins the feature set to exactly what is listed here
  # instead of whatever happens to be installed on the runner, which is what
  # makes the artifact reproducible. It also switches off zlib and every TLS
  # backend, both of which are required — mov/matroska probing wants zlib and a
  # direct HTTPS recording needs TLS — so both are re-enabled explicitly.
  ./configure \
    --prefix="$prefix" \
    --enable-static \
    --disable-shared \
    --enable-pic \
    --disable-autodetect \
    --enable-zlib \
    --enable-openssl \
    --disable-programs \
    --disable-doc \
    --disable-debug \
    --disable-avdevice \
    --disable-avfilter \
    --disable-swscale \
    --disable-everything \
    --enable-demuxer=flv,live_flv,hls,mpegts,mov,matroska \
    --enable-muxer=flv,mpegts \
    --enable-protocol=file,http,https,tls,tcp,crypto \
    --pkg-config-flags=--static

  # `configure` downgrades a component whose dependencies are unmet to a warning
  # and still exits 0 — a TLS backend it cannot find turns
  # `--enable-protocol=https` into `CONFIG_HTTPS_PROTOCOL 0`, and the loss would
  # then surface only at runtime, as a failed HTTPS recording on a user's
  # machine. Assert the generated header instead of trusting the exit status.
  for component in \
    HTTPS_PROTOCOL TLS_PROTOCOL HTTP_PROTOCOL FILE_PROTOCOL CRYPTO_PROTOCOL \
    FLV_DEMUXER LIVE_FLV_DEMUXER HLS_DEMUXER MPEGTS_DEMUXER MOV_DEMUXER \
    FLV_MUXER MPEGTS_MUXER; do
    if ! grep -qx "#define CONFIG_${component} 1" config_components.h; then
      echo "FFmpeg configure 未启用 CONFIG_${component}，录制功能会缺失" >&2
      grep -E "^#define CONFIG_${component} " config_components.h >&2 || true
      grep -iE "WARNING: Disabled" ffbuild/config.log >&2 || true
      exit 1
    fi
  done

  make -j"$(nproc)"
  make install
)

verify_prefix
emit_environment

