#!/usr/bin/env bash
# 构建 Linux Tauri 包。ASR 运行库由应用在首次启用字幕时下载，
# 不参与构建，因此这里只需一次 tauri build。
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

bun run tauri -- build --ci --bundles "$bundles" \
  ${feature_args[@]+"${feature_args[@]}"}
