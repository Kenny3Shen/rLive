#!/usr/bin/env bash
# 对 Android arm64 的 librlive_lib.so 做最终动态符号断言。
set -euo pipefail
# readelf 的 Machine 字段依赖固定英文输出，避免本地化翻译影响断言。
export LC_ALL=C

if [[ "$#" -ne 1 ]]; then
  echo "用法: bash scripts/verify-android-native-symbols.sh <librlive_lib.so>" >&2
  exit 2
fi

elf="$1"
if [[ ! -f "$elf" ]]; then
  echo "ELF 文件不存在: $elf" >&2
  exit 2
fi

machine="$(readelf --file-header --wide "$elf" | awk '/^  Machine:/ { sub(/^ *Machine: */, ""); print }')"
if [[ "$machine" != "AArch64" ]]; then
  echo "期望 AArch64 ELF，实际 Machine=${machine:-未知}: $elf" >&2
  exit 1
fi

# BIND_NOW 会在 System.loadLibrary 时解析所有非 weak 的 UND 符号；这些
# __aarch64_* helper 应由 NDK compiler-rt 静态定义，不能留在系统库里碰运气。
unresolved="$(readelf --dyn-syms --wide "$elf" | awk '
  $7 == "UND" && $5 != "WEAK" && $8 ~ /^__aarch64_/ { print $8 }
' | sort -u)"

if [[ -n "$unresolved" ]]; then
  echo "Android arm64 DSO 存在强未定义 AArch64 outline atomic helper：" >&2
  printf '%s\n' "$unresolved" | sed 's/^/  /' >&2
  exit 1
fi

echo "Android arm64 DSO 符号检查通过：$elf"
