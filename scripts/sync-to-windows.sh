#!/usr/bin/env bash
# 把 WSL 工作区同步到配置好的 Windows 镜像目录。
set -euo pipefail

resolve_windows_sync_git_dir() {
  local source_root="$1"
  local git_dir

  if ! git_dir="$(git -C "$source_root" rev-parse --absolute-git-dir 2>/dev/null)"; then
    echo "error: cannot find Git metadata for $source_root" >&2
    return 1
  fi
  if [[ -z "$git_dir" || ! -d "$git_dir" ]]; then
    echo "error: invalid Git metadata directory for $source_root: $git_dir" >&2
    return 1
  fi

  printf '%s\n' "$git_dir"
}

is_windows_sync_source_hidden() {
  local source_file="$1"

  case "$source_file" in
    .git|.git/*|\
    node_modules|node_modules/*|\
    dist|dist/*|\
    build|build/*|\
    target|target/*|\
    .gradle|.gradle/*|\
    .cxx|.cxx/*|\
    src-tauri/target|src-tauri/target/*|\
    src-tauri/gen/android/.gradle|src-tauri/gen/android/.gradle/*|\
    src-tauri/gen/android/build|src-tauri/gen/android/build/*|\
    src-tauri/gen/android/app/.cxx|src-tauri/gen/android/app/.cxx/*|\
    src-tauri/gen/android/app/build|src-tauri/gen/android/app/build/*|\
    src-tauri/gen/android/app/src/main/assets|src-tauri/gen/android/app/src/main/assets/*|\
    src-tauri/gen/android/app/key.properties|\
    src-tauri/gen/android/app/keystore.properties|\
    .playwright-cli|.playwright-cli/*|\
    scripts/windows-sync.conf|\
    .superpowers|.superpowers/*|\
    .worktrees|.worktrees/*|\
    *.log)
      return 0
      ;;
  esac
  return 1
}

# 建立当前 Git 源码白名单。Git 枚举失败时不得继续，否则空的 `- *` 规则
# 会配合 --delete-excluded 清空 Windows 镜像。
build_windows_sync_filter() {
  local source_root="$1"
  local filter_file="$2"
  local git_dir
  local source_list_file
  git_dir="$(resolve_windows_sync_git_dir "$source_root")" || return 1
  if ! source_list_file="$(mktemp "$git_dir/rlive-windows-sync-files.XXXXXX")"; then
    rm -f "$filter_file"
    echo "error: cannot create sync file list under $git_dir" >&2
    return 1
  fi

  if ! git -C "$source_root" ls-files \
    --cached --others --exclude-standard -z > "$source_list_file"; then
    rm -f "$source_list_file"
    rm -f "$filter_file"
    echo "error: cannot enumerate Git source under $source_root" >&2
    return 1
  fi
  if [[ ! -s "$source_list_file" ]]; then
    rm -f "$source_list_file"
    rm -f "$filter_file"
    echo "error: Git source whitelist is empty under $source_root" >&2
    return 1
  fi

  # `P` 只保护 Windows 本地构建缓存；紧接着的 `H` 在 sender 端隐藏同样的
  # 路径，避免被误跟踪的缓存文件被后面的 Git 源码白名单重新放行。
  cat > "$filter_file" <<'FILTERS'
P /.git/
P /.git/***
P /node_modules/
P /node_modules/***
P /dist/
P /dist/***
P /build/
P /build/***
P /target/
P /target/***
P /src-tauri/target/
P /src-tauri/target/***
P /.gradle/
P /.gradle/***
P /.cxx/
P /.cxx/***
P /src-tauri/gen/android/.gradle/
P /src-tauri/gen/android/.gradle/***
P /src-tauri/gen/android/build/
P /src-tauri/gen/android/build/***
P /src-tauri/gen/android/app/.cxx/
P /src-tauri/gen/android/app/.cxx/***
P /src-tauri/gen/android/app/build/
P /src-tauri/gen/android/app/build/***
P /src-tauri/gen/android/app/src/main/assets/
P /src-tauri/gen/android/app/src/main/assets/***
P /src-tauri/gen/android/app/key.properties
P /src-tauri/gen/android/app/keystore.properties
P /.playwright-cli/
P /.playwright-cli/***
P /scripts/windows-sync.conf
P /.superpowers/
P /.superpowers/***
P /.worktrees/
P /.worktrees/***
P *.log
H /.git/
H /.git/***
H /node_modules/
H /node_modules/***
H /dist/
H /dist/***
H /build/
H /build/***
H /target/
H /target/***
H /src-tauri/target/
H /src-tauri/target/***
H /.gradle/
H /.gradle/***
H /.cxx/
H /.cxx/***
H /src-tauri/gen/android/.gradle/
H /src-tauri/gen/android/.gradle/***
H /src-tauri/gen/android/build/
H /src-tauri/gen/android/build/***
H /src-tauri/gen/android/app/.cxx/
H /src-tauri/gen/android/app/.cxx/***
H /src-tauri/gen/android/app/build/
H /src-tauri/gen/android/app/build/***
H /src-tauri/gen/android/app/src/main/assets/
H /src-tauri/gen/android/app/src/main/assets/***
H /src-tauri/gen/android/app/key.properties
H /src-tauri/gen/android/app/keystore.properties
H /.playwright-cli/
H /.playwright-cli/***
H /scripts/windows-sync.conf
H /.superpowers/
H /.superpowers/***
H /.worktrees/
H /.worktrees/***
H *.log
FILTERS

  local invalid_source_file=""
  while IFS= read -r -d '' source_file; do
    if [[ "$source_file" == *$'\n'* || "$source_file" == *$'\r'* ]]; then
      invalid_source_file="$source_file"
      break
    fi
  done < "$source_list_file"
  if [[ -n "$invalid_source_file" ]]; then
    rm -f "$source_list_file"
    rm -f "$filter_file"
    echo "error: newline in Git path is not supported by rsync filters: $invalid_source_file" >&2
    return 1
  fi

  local included_source_count=0
  while IFS= read -r -d '' source_file; do
    [[ -e "$source_root/$source_file" || -L "$source_root/$source_file" ]] || continue
    if is_windows_sync_source_hidden "$source_file"; then
      continue
    fi
    included_source_count=$((included_source_count + 1))

    # rsync 的过滤规则按 glob 解析，文件名中的特殊字符需要转义。
    escaped_file="${source_file//\\/\\\\}"
    escaped_file="${escaped_file//\*/\\*}"
    escaped_file="${escaped_file//\?/\\?}"
    escaped_file="${escaped_file//\[/\\[}"
    parent_dir="$escaped_file"
    while [[ "$parent_dir" == */* ]]; do
      parent_dir="${parent_dir%/*}"
      printf '+ /%s/\n' "$parent_dir" >> "$filter_file"
    done
    printf '+ /%s\n' "$escaped_file" >> "$filter_file"
  done < "$source_list_file"
  rm -f "$source_list_file"

  if ((included_source_count == 0)); then
    rm -f "$filter_file"
    echo "error: no transferable Git source files under $source_root" >&2
    return 1
  fi

  printf '%s\n' '- *' >> "$filter_file"
}

# 同一个核心同时供正式同步和临时仓库回归验证使用。
sync_windows_source() {
  local source_root="$1"
  local destination_root="$2"
  local git_dir
  local filter_file
  git_dir="$(resolve_windows_sync_git_dir "$source_root")" || return 1
  if ! filter_file="$(mktemp "$git_dir/rlive-windows-sync-filter.XXXXXX")"; then
    echo "error: cannot create sync filter under $git_dir" >&2
    return 1
  fi

  if ! build_windows_sync_filter "$source_root" "$filter_file"; then
    rm -f "$filter_file"
    return 1
  fi

  # 源码白名单之外的旧分支文件和已删除文件会被清理；P 规则保护 Windows
  # 上可重新生成或仅本机使用的缓存与配置。
  if ! rsync -a --delete --delete-excluded \
    --filter="merge $filter_file" \
    "$source_root/" "$destination_root/"; then
    rm -f "$filter_file"
    return 1
  fi

  rm -f "$filter_file"
}

main() {
  local source_root
  source_root="$(cd "$(dirname "$0")/.." && pwd)"
  # shellcheck disable=SC1091
  source "$source_root/scripts/windows-sync-config.sh"
  load_windows_sync_config "$source_root"

  local destination_root="$WINDOWS_SYNC_PATH_MNT"
  local destination_windows="$WINDOWS_SYNC_PATH_WIN"
  mkdir -p "$destination_root"

  echo "== sync =="
  echo "  from: $source_root"
  echo "  to:   $destination_root  ($destination_windows)"
  sync_windows_source "$source_root" "$destination_root"
  echo "OK: synced to $destination_windows"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
