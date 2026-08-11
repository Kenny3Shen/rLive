#!/usr/bin/env bash

# Load and validate the per-machine Windows sync configuration.
# This file is sourced by the sync and WSL build entry points.
load_windows_sync_config() {
  local root="$1"
  local config_file="${RLIVE_WINDOWS_SYNC_CONFIG:-$root/scripts/windows-sync.conf}"

  if [[ ! -r "$config_file" ]]; then
    echo "error: Windows sync config not found: $config_file" >&2
    echo "       copy scripts/windows-sync.conf.example and set WINDOWS_SYNC_PATH" >&2
    return 1
  fi

  # shellcheck source=/dev/null
  source "$config_file"

  if [[ -z "${WINDOWS_SYNC_PATH:-}" ]]; then
    echo "error: WINDOWS_SYNC_PATH is empty in $config_file" >&2
    return 1
  fi

  if ! command -v wslpath >/dev/null 2>&1; then
    echo "error: wslpath is required to resolve WINDOWS_SYNC_PATH" >&2
    return 1
  fi

  local sync_path_mnt
  if ! sync_path_mnt="$(wslpath -u -- "$WINDOWS_SYNC_PATH")"; then
    echo "error: cannot convert WINDOWS_SYNC_PATH to a WSL path: $WINDOWS_SYNC_PATH" >&2
    return 1
  fi
  if ! sync_path_mnt="$(realpath -m -- "$sync_path_mnt")"; then
    echo "error: cannot normalize WINDOWS_SYNC_PATH: $WINDOWS_SYNC_PATH" >&2
    return 1
  fi

  # rsync --delete must never receive a drive root or an arbitrary path.
  if [[ ! "$sync_path_mnt" =~ ^/mnt/[[:alpha:]]/.+ ]]; then
    echo "error: WINDOWS_SYNC_PATH must resolve below a mounted Windows drive: $WINDOWS_SYNC_PATH" >&2
    return 1
  fi

  local drive_letter="${sync_path_mnt#/mnt/}"
  drive_letter="${drive_letter%%/*}"
  local drive_root="/mnt/$drive_letter"
  if [[ ! -d "$drive_root" ]] || ! mountpoint -q "$drive_root"; then
    echo "error: Windows drive is not mounted in WSL: $drive_root" >&2
    return 1
  fi

  WINDOWS_SYNC_PATH_MNT="$sync_path_mnt"
  WINDOWS_SYNC_PATH_WIN="$(wslpath -w -- "$sync_path_mnt")"
  export WINDOWS_SYNC_PATH_MNT WINDOWS_SYNC_PATH_WIN
}
