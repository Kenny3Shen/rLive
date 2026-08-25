#!/usr/bin/env bash
# Build Linux Tauri packages after Cargo has staged the shared Sherpa/ONNX
# runtime. Tauri resolves bundle resources before compiling, so this must stay
# a two-stage flow instead of declaring target/release/*.so* statically.
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

bundles="deb,rpm,appimage"
# Release packages link FFmpeg statically so they do not depend on the build
# machine's `libav*.so`; a local development build keeps using whatever FFmpeg
# pkg-config finds, so this stays opt-in.
cargo_features=()
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --bundles)
      if [[ -z "${2:-}" ]]; then
        echo "缺少 --bundles 的目标列表" >&2
        exit 2
      fi
      bundles="$2"
      shift 2
      ;;
    --ffmpeg-static)
      cargo_features+=("ffmpeg-static")
      shift
      ;;
    *)
      echo "用法: $0 [--bundles deb,rpm,appimage] [--ffmpeg-static]" >&2
      exit 2
      ;;
  esac
done

feature_args=()
if [[ "${#cargo_features[@]}" -gt 0 ]]; then
  # Joined with commas: `tauri build --features` takes one comma-separated list.
  feature_args=(--features "$(
    IFS=,
    echo "${cargo_features[*]}"
  )")
fi

if ! command -v jq >/dev/null; then
  echo "Linux 打包需要 jq 用于生成运行库配置" >&2
  exit 1
fi

# Compile first: the vendored sherpa-onnx-sys build script copies the shared
# runtime into target/release only after Cargo has linked the application.
bun run tauri -- build --ci --no-bundle ${feature_args[@]+"${feature_args[@]}"}

release_dir="$repo_root/src-tauri/target/release"
binary="$release_dir/rlive"
test -x "$binary"
for required in libsherpa-onnx-c-api.so libonnxruntime.so; do
  if [[ ! -f "$release_dir/$required" ]]; then
    echo "缺少 Sherpa ONNX Linux 运行库: $release_dir/$required" >&2
    exit 1
  fi
done
if [[ -e "$release_dir/libonnxruntime_providers_cuda.so" ]]; then
  echo "Linux 构建不得包含 Sherpa ONNX CUDA provider" >&2
  exit 1
fi

runtime_files="$(mktemp)"
runtime_config="$(mktemp --suffix=.json)"
cleanup() {
  rm -f "$runtime_files" "$runtime_config"
}
trap cleanup EXIT

# Generic bundle.resources is shared by DEB, RPM and AppImage. Mapping each
# absolute file to an empty resource path lets Tauri place it under the
# product-specific Linux resource directory (`/usr/lib/rLive`).
find "$release_dir" -maxdepth 1 -type f -name '*.so*' -printf '%p\t%f\n' | sort | \
  jq -Rn '
    [inputs | split("\t") | { key: .[0], value: "" }] | from_entries
  ' > "$runtime_files"
if [[ "$(jq 'length' "$runtime_files")" -eq 0 ]]; then
  echo "未找到可打包的 Linux 共享运行库" >&2
  exit 1
fi

jq -n --slurpfile resources "$runtime_files" \
  '{ bundle: { resources: $resources[0] } }' > "$runtime_config"

# `tauri bundle` requires the same features as the `build` above: it reads the
# Cargo metadata to locate the compiled binary, and a mismatch makes it look in
# the wrong place.
bun run tauri -- bundle --ci --bundles "$bundles" --config "$runtime_config" \
  ${feature_args[@]+"${feature_args[@]}"}
