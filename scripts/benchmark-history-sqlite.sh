#!/usr/bin/env bash
set -euo pipefail

command -v sqlite3 >/dev/null 2>&1 || {
  echo "缺少 sqlite3，无法运行基准。" >&2
  exit 1
}

readonly ROWS="${ROWS:-200000}"
readonly READ_ITERATIONS="${READ_ITERATIONS:-1000}"
readonly WRITE_ITERATIONS="${WRITE_ITERATIONS:-1000}"
readonly RUNS="${RUNS:-5}"
readonly RETENTION_LIMIT=2000

for value in "$ROWS" "$READ_ITERATIONS" "$WRITE_ITERATIONS" "$RUNS"; do
  [[ "$value" =~ ^[1-9][0-9]*$ ]] || {
    echo "ROWS、READ_ITERATIONS、WRITE_ITERATIONS 和 RUNS 必须是正整数。" >&2
    exit 1
  }
done

if (( ROWS < RETENTION_LIMIT || RUNS % 2 == 0 )); then
  echo "ROWS 不能小于 $RETENTION_LIMIT，RUNS 必须是奇数。" >&2
  exit 1
fi

bench_dir=$(mktemp -d /tmp/rlive-sqlite-bench.XXXXXX)
cleanup() {
  case "$bench_dir" in
    /tmp/rlive-sqlite-bench.*) rm -rf -- "$bench_dir" ;;
  esac
}
trap cleanup EXIT

legacy_db="$bench_dir/legacy.db"
optimized_db="$bench_dir/optimized.db"

create_legacy_db() {
  sqlite3 "$legacy_db" >/dev/null <<SQL
PRAGMA journal_mode=DELETE;
PRAGMA synchronous=FULL;
CREATE TABLE history (
  site_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  title TEXT NOT NULL,
  user_name TEXT NOT NULL,
  cover TEXT NOT NULL DEFAULT '',
  watched_at INTEGER NOT NULL,
  PRIMARY KEY (site_id, room_id)
);
CREATE INDEX idx_history_recent ON history (watched_at DESC);
CREATE INDEX idx_history_site_recent ON history (site_id, watched_at DESC);
BEGIN;
WITH RECURSIVE rows(value) AS (
  VALUES(1)
  UNION ALL
  SELECT value + 1 FROM rows WHERE value < $ROWS
)
INSERT INTO history (site_id, room_id, title, user_name, cover, watched_at)
SELECT
  CASE value % 5
    WHEN 0 THEN 'bilibili'
    WHEN 1 THEN 'huya'
    WHEN 2 THEN 'douyu'
    WHEN 3 THEN 'douyin'
    ELSE 'twitch'
  END,
  printf('room-%08d', value),
  printf('直播间标题 %08d', value),
  printf('主播 %06d', value % 10000),
  printf('https://img.example/%08d.jpg', value),
  1700000000000 + value
FROM rows;
COMMIT;
SQL
}

create_optimized_db() {
  local first_row=$((ROWS - RETENTION_LIMIT + 1))
  sqlite3 "$optimized_db" >/dev/null <<SQL
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA cache_size=-8192;
PRAGMA journal_size_limit=8388608;
CREATE TABLE history (
  site_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  title TEXT NOT NULL,
  user_name TEXT NOT NULL,
  cover TEXT NOT NULL DEFAULT '',
  watched_at INTEGER NOT NULL,
  PRIMARY KEY (site_id, room_id)
);
CREATE INDEX idx_history_recent_order
  ON history (watched_at DESC, site_id ASC, room_id ASC);
CREATE INDEX idx_history_site_recent_order
  ON history (site_id ASC, watched_at DESC, room_id ASC);
CREATE TRIGGER history_prune_after_insert
AFTER INSERT ON history
BEGIN
  DELETE FROM history
  WHERE rowid = (
    SELECT rowid
    FROM history INDEXED BY idx_history_recent_order
    ORDER BY watched_at DESC, site_id ASC, room_id ASC
    LIMIT 1 OFFSET $RETENTION_LIMIT
  );
END;
BEGIN;
WITH RECURSIVE rows(value) AS (
  VALUES($first_row)
  UNION ALL
  SELECT value + 1 FROM rows WHERE value < $ROWS
)
INSERT INTO history (site_id, room_id, title, user_name, cover, watched_at)
SELECT
  CASE value % 5
    WHEN 0 THEN 'bilibili'
    WHEN 1 THEN 'huya'
    WHEN 2 THEN 'douyu'
    WHEN 3 THEN 'douyin'
    ELSE 'twitch'
  END,
  printf('room-%08d', value),
  printf('直播间标题 %08d', value),
  printf('主播 %06d', value % 10000),
  printf('https://img.example/%08d.jpg', value),
  1700000000000 + value
FROM rows;
COMMIT;
PRAGMA wal_checkpoint(TRUNCATE);
SQL
}

median() {
  sort -n | sed -n "$((RUNS / 2 + 1))p"
}

measure_reads() {
  local db=$1
  local setup=$2
  local query=$3
  local samples=()
  local run start_ns end_ns query_index

  for ((run = 1; run <= RUNS; run++)); do
    start_ns=$(date +%s%N)
    {
      printf '%s\n' "$setup"
      for ((query_index = 0; query_index < READ_ITERATIONS; query_index++)); do
        printf '%s\n' "$query"
      done
    } | sqlite3 "$db" >/dev/null
    end_ns=$(date +%s%N)
    samples+=("$(((end_ns - start_ns) / 1000000))")
  done

  printf '%s\n' "${samples[@]}" | median
}

measure_writes() {
  local source_db=$1
  local setup=$2
  local samples=()
  local run start_ns end_ns write_index write_db

  for ((run = 1; run <= RUNS; run++)); do
    write_db="$bench_dir/write-$run.db"
    cp "$source_db" "$write_db"
    start_ns=$(date +%s%N)
    {
      printf '%s\n' "$setup"
      for ((write_index = 1; write_index <= WRITE_ITERATIONS; write_index++)); do
        printf "INSERT INTO history(site_id,room_id,title,user_name,cover,watched_at) VALUES('bilibili','bench-%d-%d','title','user','',1800000000000+%d) ON CONFLICT(site_id,room_id) DO UPDATE SET watched_at=MAX(history.watched_at,excluded.watched_at);\n" \
          "$run" "$write_index" "$write_index"
      done
    } | sqlite3 "$write_db" >/dev/null
    end_ns=$(date +%s%N)
    samples+=("$(((end_ns - start_ns) / 1000000))")
    rm -f -- "$write_db" "$write_db-wal" "$write_db-shm"
  done

  printf '%s\n' "${samples[@]}" | median
}

print_metric() {
  local label=$1
  local before_ms=$2
  local after_ms=$3
  local operations=$4
  awk -v label="$label" -v before="$before_ms" -v after="$after_ms" -v operations="$operations" \
    'BEGIN {
      reduction = before > 0 ? (before - after) * 100 / before : 0;
      printf "%-20s %10.3f %10.3f %9.1f%%\n", label, before / operations, after / operations, reduction;
    }'
}

echo "正在构造 SQLite 历史记录基准库……"
create_legacy_db
create_optimized_db

legacy_recent_query="SELECT site_id,room_id,title,user_name,cover,watched_at FROM history ORDER BY watched_at DESC LIMIT 200;"
optimized_recent_query="SELECT site_id,room_id,title,user_name,cover,watched_at FROM history ORDER BY watched_at DESC,site_id ASC,room_id ASC LIMIT 200;"
legacy_site_query="SELECT site_id,room_id,title,user_name,cover,watched_at FROM history WHERE site_id='bilibili' ORDER BY watched_at DESC LIMIT 200;"
optimized_site_query="SELECT site_id,room_id,title,user_name,cover,watched_at FROM history WHERE site_id='bilibili' ORDER BY watched_at DESC,room_id ASC LIMIT 200;"

legacy_recent=$(measure_reads "$legacy_db" "PRAGMA cache_size=-2000;" "$legacy_recent_query")
optimized_recent=$(measure_reads "$optimized_db" "PRAGMA cache_size=-8192;" "$optimized_recent_query")
legacy_site=$(measure_reads "$legacy_db" "PRAGMA cache_size=-2000;" "$legacy_site_query")
optimized_site=$(measure_reads "$optimized_db" "PRAGMA cache_size=-8192;" "$optimized_site_query")
legacy_writes=$(measure_writes "$legacy_db" "PRAGMA synchronous=FULL;")
optimized_writes=$(measure_writes "$optimized_db" "PRAGMA synchronous=NORMAL; PRAGMA journal_size_limit=8388608;")

legacy_rows=$(sqlite3 -readonly "$legacy_db" "SELECT count(*) FROM history;")
optimized_rows=$(sqlite3 -readonly "$optimized_db" "SELECT count(*) FROM history;")
legacy_bytes=$(stat -c %s "$legacy_db")
optimized_bytes=$(stat -c %s "$optimized_db")

printf '\n数据规模：模拟累计 %s 条记录，读取 %s 次，独立写入 %s 次，取 %s 轮中位数。\n' \
  "$ROWS" "$READ_ITERATIONS" "$WRITE_ITERATIONS" "$RUNS"
printf '%-20s %10s %10s %10s\n' "指标（单次）" "优化前/ms" "优化后/ms" "耗时下降"
print_metric "最近 200 条" "$legacy_recent" "$optimized_recent" "$READ_ITERATIONS"
print_metric "站点最近 200 条" "$legacy_site" "$optimized_site" "$READ_ITERATIONS"
print_metric "单条 UPSERT" "$legacy_writes" "$optimized_writes" "$WRITE_ITERATIONS"

printf '\n%-20s %12s %12s\n' "稳定态存储" "优化前" "优化后"
printf '%-20s %12s %12s\n' "逻辑记录数" "$legacy_rows" "$optimized_rows"
printf '%-20s %12s %12s\n' "数据库文件/bytes" "$legacy_bytes" "$optimized_bytes"
