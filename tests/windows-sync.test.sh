#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEST_ROOT="$ROOT/.worktrees/windows-sync-tests"
mkdir -p "$TEST_ROOT"
FIXTURE="$(mktemp -d "$TEST_ROOT/run.XXXXXX")"
trap 'rm -rf "$FIXTURE"' EXIT

source "$ROOT/scripts/sync-to-windows.sh"

SOURCE="$FIXTURE/source"
DESTINATION="$FIXTURE/destination"
mkdir -p "$SOURCE" "$DESTINATION"

git -C "$SOURCE" init --quiet
git -C "$SOURCE" config user.name "rLive sync test"
git -C "$SOURCE" config user.email "sync-test@localhost"
git -C "$SOURCE" config core.excludesFile /dev/null

cat > "$SOURCE/.gitignore" <<'EOF'
/target/
/node_modules/
/.playwright-cli/
/dist/
/build/
/.env.*
!.env.example
*.log
EOF
printf 'current\n' > "$SOURCE/current.txt"
printf 'new source\n' > "$SOURCE/new-source.ts"
printf 'tracked special\n' > "$SOURCE/tracked [draft]?.txt"
printf 'example environment\n' > "$SOURCE/.env.example"
mkdir -p "$SOURCE/scripts" "$SOURCE/src-tauri/gen/android/app"
printf 'current script\n' > "$SOURCE/scripts/current.ps1"
printf 'current android source\n' > "$SOURCE/src-tauri/gen/android/app/current.kt"
git -C "$SOURCE" add \
  .gitignore .env.example current.txt 'tracked [draft]?.txt' \
  scripts/current.ps1 src-tauri/gen/android/app/current.kt

mkdir -p \
  "$SOURCE/target/debug" \
  "$SOURCE/node_modules/pkg" \
  "$SOURCE/.playwright-cli" \
  "$SOURCE/dist" \
  "$SOURCE/build/gpui/windows-runtime-data/logs" \
  "$SOURCE/build/feedback-windows-data/logs" \
  "$SOURCE/src-tauri/gen/android/.gradle" \
  "$SOURCE/src-tauri/gen/android/app/.cxx"
printf 'sender build\n' > "$SOURCE/target/debug/not-for-windows"
printf 'sender dependency\n' > "$SOURCE/node_modules/pkg/package.json"
printf 'sender browser state\n' > "$SOURCE/.playwright-cli/session"
printf 'sender dist\n' > "$SOURCE/dist/tracked-sender.bin"
printf 'sender runtime state\n' > "$SOURCE/build/gpui/windows-runtime-data/state"
printf 'sender runtime log\n' > "$SOURCE/build/gpui/windows-runtime-data/logs/runtime.log"
printf 'sender feedback log\n' > "$SOURCE/build/feedback-windows-data/logs/runtime.log"
printf 'sender gradle\n' > "$SOURCE/src-tauri/gen/android/.gradle/tracked-sender.bin"
printf 'sender native build\n' > "$SOURCE/src-tauri/gen/android/app/.cxx/tracked-sender.bin"
printf 'sender log\n' > "$SOURCE/tracked-sender.log"
git -C "$SOURCE" add --force \
  target/debug/not-for-windows \
  node_modules/pkg/package.json \
  .playwright-cli/session \
  dist/tracked-sender.bin \
  build/gpui/windows-runtime-data/state \
  build/gpui/windows-runtime-data/logs/runtime.log \
  build/feedback-windows-data/logs/runtime.log \
  src-tauri/gen/android/.gradle/tracked-sender.bin \
  src-tauri/gen/android/app/.cxx/tracked-sender.bin \
  tracked-sender.log
git -C "$SOURCE" commit --quiet -m "fixture"

mkdir -p \
  "$DESTINATION/crates/rLive-core/src" \
  "$DESTINATION/target/debug" \
  "$DESTINATION/node_modules/pkg" \
  "$DESTINATION/.playwright-cli" \
  "$DESTINATION/.git" \
  "$DESTINATION/scripts" \
  "$DESTINATION/build/gpui/windows-runtime-data/logs" \
  "$DESTINATION/build/feedback-windows-data/logs" \
  "$DESTINATION/src-tauri/gen/android/.gradle" \
  "$DESTINATION/src-tauri/gen/android/app/.cxx" \
  "$DESTINATION/src-tauri/gen/android/app/build"
printf 'stale workspace\n' > "$DESTINATION/Cargo.toml"
printf 'stale core\n' > "$DESTINATION/crates/rLive-core/src/lib.rs"
printf 'stale gpui script\n' > "$DESTINATION/scripts/gpui-windows.ps1"
printf 'stale media html\n' > "$DESTINATION/media.html"
printf 'receiver build\n' > "$DESTINATION/target/debug/cache"
printf 'receiver dependency\n' > "$DESTINATION/node_modules/pkg/package.json"
printf 'receiver browser state\n' > "$DESTINATION/.playwright-cli/session"
printf 'receiver git state\n' > "$DESTINATION/.git/local-only"
printf 'receiver runtime state\n' > "$DESTINATION/build/gpui/windows-runtime-data/state"
printf 'receiver runtime log\n' > "$DESTINATION/build/gpui/windows-runtime-data/logs/runtime.log"
printf 'receiver feedback log\n' > "$DESTINATION/build/feedback-windows-data/logs/runtime.log"
printf 'receiver gradle state\n' > "$DESTINATION/src-tauri/gen/android/.gradle/cache"
printf 'receiver native state\n' > "$DESTINATION/src-tauri/gen/android/app/.cxx/cache"
printf 'receiver android state\n' > "$DESTINATION/src-tauri/gen/android/app/build/cache"
printf 'receiver config\n' > "$DESTINATION/scripts/windows-sync.conf"
printf 'receiver log\n' > "$DESTINATION/local.log"

sync_windows_source "$SOURCE" "$DESTINATION"

test "$(cat "$DESTINATION/current.txt")" = "current"
test "$(cat "$DESTINATION/new-source.ts")" = "new source"
test -f "$DESTINATION/tracked [draft]?.txt"
test -f "$DESTINATION/.env.example"
test ! -e "$DESTINATION/Cargo.toml"
test ! -e "$DESTINATION/crates/rLive-core"
test ! -e "$DESTINATION/scripts/gpui-windows.ps1"
test ! -e "$DESTINATION/media.html"

test -f "$DESTINATION/target/debug/cache"
test ! -e "$DESTINATION/target/debug/not-for-windows"
test "$(cat "$DESTINATION/node_modules/pkg/package.json")" = "receiver dependency"
test -f "$DESTINATION/.playwright-cli/session"
test -f "$DESTINATION/.git/local-only"
test ! -e "$DESTINATION/dist/tracked-sender.bin"
test "$(cat "$DESTINATION/build/gpui/windows-runtime-data/state")" = "receiver runtime state"
test "$(cat "$DESTINATION/build/gpui/windows-runtime-data/logs/runtime.log")" = "receiver runtime log"
test "$(cat "$DESTINATION/build/feedback-windows-data/logs/runtime.log")" = "receiver feedback log"
test ! -e "$DESTINATION/src-tauri/gen/android/.gradle/tracked-sender.bin"
test ! -e "$DESTINATION/src-tauri/gen/android/app/.cxx/tracked-sender.bin"
test -f "$DESTINATION/src-tauri/gen/android/.gradle/cache"
test -f "$DESTINATION/src-tauri/gen/android/app/.cxx/cache"
test -f "$DESTINATION/src-tauri/gen/android/app/build/cache"
test -f "$DESTINATION/scripts/windows-sync.conf"
test -f "$DESTINATION/local.log"
test ! -e "$DESTINATION/tracked-sender.log"

rm "$SOURCE/current.txt"
sync_windows_source "$SOURCE" "$DESTINATION"
test ! -e "$DESTINATION/current.txt"
test "$(cat "$DESTINATION/node_modules/pkg/package.json")" = "receiver dependency"

NOT_A_REPOSITORY="$FIXTURE/not-a-repository"
mkdir -p "$NOT_A_REPOSITORY"
printf 'source\n' > "$NOT_A_REPOSITORY/current.txt"
if GIT_CEILING_DIRECTORIES="$FIXTURE" build_windows_sync_filter \
  "$NOT_A_REPOSITORY" "$FIXTURE/unused-filter" 2>/dev/null; then
  echo "expected Git enumeration outside a repository to fail" >&2
  exit 1
fi

DELETED_ONLY_SOURCE="$FIXTURE/deleted-only-source"
DELETED_ONLY_DESTINATION="$FIXTURE/deleted-only-destination"
mkdir -p "$DELETED_ONLY_SOURCE" "$DELETED_ONLY_DESTINATION"
git -C "$DELETED_ONLY_SOURCE" init --quiet
git -C "$DELETED_ONLY_SOURCE" config user.name "rLive sync test"
git -C "$DELETED_ONLY_SOURCE" config user.email "sync-test@localhost"
git -C "$DELETED_ONLY_SOURCE" config core.excludesFile /dev/null
printf 'tracked then deleted\n' > "$DELETED_ONLY_SOURCE/deleted.txt"
git -C "$DELETED_ONLY_SOURCE" add deleted.txt
git -C "$DELETED_ONLY_SOURCE" commit --quiet -m "deleted-only fixture"
rm "$DELETED_ONLY_SOURCE/deleted.txt"
printf 'must survive\n' > "$DELETED_ONLY_DESTINATION/sentinel.txt"

if sync_windows_source \
  "$DELETED_ONLY_SOURCE" "$DELETED_ONLY_DESTINATION" 2>/dev/null; then
  echo "expected an all-deleted tracked source to fail" >&2
  exit 1
fi
test "$(cat "$DELETED_ONLY_DESTINATION/sentinel.txt")" = "must survive"
