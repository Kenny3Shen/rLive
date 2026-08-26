#!/usr/bin/env bash
# 在 Cargo 暂存共享 Sherpa/ONNX 运行时之后再构建 Linux Tauri 包。
# Tauri 会在编译前解析 bundle 资源，因此必须保持两段式流程，
# 而不能静态声明 target/release/*.so*。
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

bundles="deb,rpm,appimage"
# 发布包静态链接 FFmpeg，以免依赖构建机上的 `libav*.so`；
# 本地开发构建仍使用 pkg-config 找到的任意 FFmpeg，
# 所以这里保持按需开启。
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
  # 用逗号连接：`tauri build --features` 只接受一个逗号分隔的列表。
  feature_args=(--features "$(
    IFS=,
    echo "${cargo_features[*]}"
  )")
fi

if ! command -v jq >/dev/null; then
  echo "Linux 打包需要 jq 用于生成运行库配置" >&2
  exit 1
fi

# 先编译：vendored 的 sherpa-onnx-sys 构建脚本只有在 Cargo 链接完应用之后，
# 才会把共享运行时复制到 target/release。
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

# 通用的 bundle.resources 由 DEB、RPM 和 AppImage 共用。把每个绝对路径文件
# 映射到空资源路径，可让 Tauri 将其放入产品专属的 Linux 资源目录
# （`/usr/lib/rLive`）。
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

# `tauri bundle` 需要与上面 `build` 相同的 features：它通过 Cargo 元数据
# 定位已编译的二进制，features 不一致会让它到错误的位置去找。
bun run tauri -- bundle --ci --bundles "$bundles" --config "$runtime_config" \
  ${feature_args[@]+"${feature_args[@]}"}
