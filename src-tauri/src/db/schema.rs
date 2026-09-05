use std::path::Path;
use std::time::Duration;

use rusqlite::Connection;

use crate::error::{AppError, AppResult};

pub const HISTORY_RETENTION_LIMIT: i64 = 2_000;
/// 视频观看历史的保留上限。每行比直播历史更重（封面、标题、分集、进度），
/// 且按作品去重而非按分集，500 条足够覆盖数月的观看记录。
pub const VIDEO_HISTORY_RETENTION_LIMIT: i64 = 500;
/// 本地录制回放进度的保留上限。行很轻（只有 id、进度、时长、时间戳），
/// 上限主要防的是用户在应用外删掉录像目录后留下的孤行——没有可依赖的
/// 扫描联动去清它们，只能靠容量兜底让旧进度最终被汰汰。
pub const RECORDING_WATCH_PROGRESS_RETENTION_LIMIT: i64 = 1_000;
pub const SCHEMA_VERSION: i64 = 5;

const DB_BUSY_TIMEOUT: Duration = Duration::from_secs(5);
const DB_CACHE_SIZE_KIB: i64 = 8 * 1_024;
const DB_JOURNAL_SIZE_LIMIT_BYTES: i64 = 8 * 1_024 * 1_024;

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS follows (
  site_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  user_name TEXT NOT NULL,
  face TEXT NOT NULL DEFAULT '',
  tag_ids TEXT NOT NULL DEFAULT '[]',
  auto_record INTEGER NOT NULL DEFAULT 0,
  live_status INTEGER,
  live_started_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (site_id, room_id)
);

CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS history (
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

CREATE TABLE IF NOT EXISTS danmaku_send_history (
  site_id TEXT NOT NULL,
  content TEXT NOT NULL,
  room_id TEXT NOT NULL DEFAULT '',
  room_title TEXT NOT NULL DEFAULT '',
  room_user_name TEXT NOT NULL DEFAULT '',
  sent_at INTEGER NOT NULL,
  PRIMARY KEY (site_id, content)
);

CREATE INDEX idx_danmaku_send_history_site_recent_order
  ON danmaku_send_history (site_id ASC, sent_at DESC, content ASC);
CREATE INDEX idx_danmaku_send_history_global_recent_order
  ON danmaku_send_history (sent_at DESC, site_id ASC, content ASC);

CREATE TABLE IF NOT EXISTS danmaku_favorites (
  site_id TEXT NOT NULL,
  content TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (site_id, content)
);

CREATE INDEX IF NOT EXISTS idx_danmaku_favorites_recent
  ON danmaku_favorites (site_id, added_at DESC);

CREATE TABLE IF NOT EXISTS iptv_favorites (
  source_id TEXT NOT NULL,
  channel_url TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  name TEXT NOT NULL,
  group_name TEXT NOT NULL DEFAULT '',
  favorite_group_id TEXT,
  logo TEXT,
  protocol TEXT,
  headers TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (source_id, channel_url)
);

CREATE INDEX IF NOT EXISTS idx_iptv_favorites_source_recent
  ON iptv_favorites (source_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS iptv_favorite_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS settings_kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cookies (
  site_id TEXT PRIMARY KEY,
  cookie TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
"#;

/// `video_history` 的建表 DDL 单独成常量：新库初始化与 v3→v4 迁移共用同一份，
/// 两条路径不可能产生结构漂移。
const VIDEO_HISTORY_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS video_history (
  kind TEXT NOT NULL,
  oid TEXT NOT NULL,
  title TEXT NOT NULL,
  cover TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT '',
  part_title TEXT NOT NULL DEFAULT '',
  bvid TEXT NOT NULL DEFAULT '',
  cid INTEGER NOT NULL DEFAULT 0,
  ep_id TEXT NOT NULL DEFAULT '',
  aid TEXT NOT NULL DEFAULT '',
  progress REAL NOT NULL DEFAULT 0,
  duration REAL NOT NULL DEFAULT 0,
  watched_at INTEGER NOT NULL,
  PRIMARY KEY (kind, oid)
);

CREATE INDEX IF NOT EXISTS idx_video_history_recent_order
  ON video_history (watched_at DESC, kind ASC, oid ASC);
"#;

/// `recording_watch_progress` 的建表 DDL 单独成常量：新库初始化与 v4→v5 迁移
/// 共用同一份，两条路径不可能产生结构漂移。
const RECORDING_WATCH_PROGRESS_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS recording_watch_progress (
  id TEXT PRIMARY KEY,
  progress REAL NOT NULL DEFAULT 0,
  duration REAL NOT NULL DEFAULT 0,
  watched_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_recording_watch_progress_recent
  ON recording_watch_progress (watched_at DESC, id ASC);
"#;

pub struct Db;

impl Db {
    pub fn open(path: impl AsRef<Path>) -> AppResult<Connection> {
        let path = path.as_ref();
        if let Some(parent) = path.parent()
            && !parent.as_os_str().is_empty()
        {
            std::fs::create_dir_all(parent)
                .map_err(|e| AppError::new("db_io_error", format!("create data dir: {e}")))?;
        }
        let conn =
            Connection::open(path).map_err(|e| AppError::new("db_open_error", e.to_string()))?;
        initialize_schema(&conn)?;
        configure_file_connection(&conn)?;
        conn.execute_batch("PRAGMA optimize;")
            .map_err(|e| AppError::new("db_optimize_error", e.to_string()))?;
        Ok(conn)
    }
}

fn configure_file_connection(conn: &Connection) -> AppResult<()> {
    conn.busy_timeout(DB_BUSY_TIMEOUT).map_err(map_db_err)?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(map_db_err)?;
    conn.pragma_update(None, "synchronous", "NORMAL")
        .map_err(map_db_err)?;
    conn.pragma_update(None, "cache_size", -DB_CACHE_SIZE_KIB)
        .map_err(map_db_err)?;
    conn.pragma_update(None, "journal_size_limit", DB_JOURNAL_SIZE_LIMIT_BYTES)
        .map_err(map_db_err)?;
    Ok(())
}

#[cfg(test)]
pub fn open_in_memory() -> AppResult<Connection> {
    let conn =
        Connection::open_in_memory().map_err(|e| AppError::new("db_open_error", e.to_string()))?;
    initialize_schema(&conn)?;
    Ok(conn)
}

fn initialize_schema(conn: &Connection) -> AppResult<()> {
    let version: i64 = conn
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(map_db_err)?;
    if version == SCHEMA_VERSION {
        return Ok(());
    }

    // v3/v4→v5 都是纯增量（v3 起补 `video_history`，再补 `recording_watch_progress`），
    // 没有任何破坏性改动。下面的 table_count 分支会拒绝一切非当前版本的库，
    // 所以这里必须做增量迁移：少了它，v3/v4 存量用户升级后都会打不开自己
    // 的数据库。版本再递增时，要在这里补上对应的建表一步。
    if version == 3 || version == 4 {
        let transaction = conn
            .unchecked_transaction()
            .map_err(|error| AppError::new("db_schema_error", error.to_string()))?;
        if version < 4 {
            create_video_history_objects(&transaction)?;
        }
        create_recording_watch_progress_objects(&transaction)?;
        transaction
            .pragma_update(None, "user_version", SCHEMA_VERSION)
            .map_err(|error| AppError::new("db_schema_error", error.to_string()))?;
        return transaction
            .commit()
            .map_err(|error| AppError::new("db_schema_error", error.to_string()));
    }

    let table_count: i64 = conn
        .query_row(
            "SELECT count(*) FROM sqlite_schema
             WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
            [],
            |row| row.get(0),
        )
        .map_err(map_db_err)?;
    if version != 0 || table_count != 0 {
        return Err(AppError::new(
            "db_schema_unsupported",
            format!(
                "数据库格式版本 {version} 不受 rLive 2.0 支持；请先使用旧版本导出配置，再使用新的 2.0 数据库"
            ),
        ));
    }

    let transaction = conn
        .unchecked_transaction()
        .map_err(|error| AppError::new("db_schema_error", error.to_string()))?;
    transaction
        .execute_batch(SCHEMA)
        .map_err(|error| AppError::new("db_schema_error", error.to_string()))?;
    create_video_history_objects(&transaction)?;
    create_recording_watch_progress_objects(&transaction)?;
    transaction
        .execute_batch(&format!(
            "CREATE TRIGGER history_prune_after_insert
             AFTER INSERT ON history
             BEGIN
               DELETE FROM history
               WHERE rowid = (
                 SELECT rowid
                 FROM history INDEXED BY idx_history_recent_order
                 ORDER BY watched_at DESC, site_id ASC, room_id ASC
                 LIMIT 1 OFFSET {HISTORY_RETENTION_LIMIT}
               );
             END;"
        ))
        .map_err(|error| AppError::new("db_schema_error", error.to_string()))?;
    transaction
        .pragma_update(None, "user_version", SCHEMA_VERSION)
        .map_err(|error| AppError::new("db_schema_error", error.to_string()))?;
    transaction
        .commit()
        .map_err(|error| AppError::new("db_schema_error", error.to_string()))
}

/// 建 `video_history` 的表、索引与修剪触发器。新库初始化与 v3→v4 迁移共用此函数，
/// 避免两条路径各写一份 DDL 而逐渐漂移。
fn create_video_history_objects(tx: &Connection) -> AppResult<()> {
    tx.execute_batch(VIDEO_HISTORY_SCHEMA)
        .map_err(|error| AppError::new("db_schema_error", error.to_string()))?;
    tx.execute_batch(&format!(
        "CREATE TRIGGER IF NOT EXISTS video_history_prune_after_insert
         AFTER INSERT ON video_history
         BEGIN
           DELETE FROM video_history
           WHERE rowid = (
             SELECT rowid
             FROM video_history INDEXED BY idx_video_history_recent_order
             ORDER BY watched_at DESC, kind ASC, oid ASC
             LIMIT 1 OFFSET {VIDEO_HISTORY_RETENTION_LIMIT}
           );
         END;"
    ))
    .map_err(|error| AppError::new("db_schema_error", error.to_string()))?;
    Ok(())
}

/// 建 `recording_watch_progress` 的表、索引与修剪触发器。新库初始化与 v4→v5
/// 迁移共用此函数，避免两条路径各写一份 DDL 而逐渐漂移。触发器排序键与
/// 索引一致（`watched_at DESC, id ASC`），`INDEXED BY` 保证修剪走的正是索引。
fn create_recording_watch_progress_objects(tx: &Connection) -> AppResult<()> {
    tx.execute_batch(RECORDING_WATCH_PROGRESS_SCHEMA)
        .map_err(|error| AppError::new("db_schema_error", error.to_string()))?;
    tx.execute_batch(&format!(
        "CREATE TRIGGER IF NOT EXISTS recording_watch_progress_prune_after_insert
         AFTER INSERT ON recording_watch_progress
         BEGIN
           DELETE FROM recording_watch_progress
           WHERE rowid = (
             SELECT rowid
             FROM recording_watch_progress INDEXED BY idx_recording_watch_progress_recent
             ORDER BY watched_at DESC, id ASC
             LIMIT 1 OFFSET {RECORDING_WATCH_PROGRESS_RETENTION_LIMIT}
           );
         END;"
    ))
    .map_err(|error| AppError::new("db_schema_error", error.to_string()))?;
    Ok(())
}

pub fn map_db_err(err: rusqlite::Error) -> AppError {
    AppError::new("db_error", err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn assert_trigger_exists(conn: &Connection, name: &str) {
        let count: i64 = conn
            .query_row(
                &format!(
                    "SELECT count(*) FROM sqlite_master WHERE type = 'trigger' AND name = '{name}'"
                ),
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1, "缺少触发器 {name}");
    }

    #[test]
    fn fresh_database_uses_versioned_schema() {
        let conn = open_in_memory().unwrap();

        let version: i64 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        let columns: Vec<String> = conn
            .prepare("SELECT name FROM pragma_table_info('danmaku_send_history') ORDER BY cid")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();

        assert_eq!(version, SCHEMA_VERSION);
        assert!(columns.iter().any(|column| column == "room_id"));
        assert!(columns.iter().any(|column| column == "room_title"));
        assert!(columns.iter().any(|column| column == "room_user_name"));
        let follow_columns: Vec<String> = conn
            .prepare("SELECT name FROM pragma_table_info('follows') ORDER BY cid")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert!(follow_columns.iter().any(|column| column == "auto_record"));

        let video_columns: Vec<String> = conn
            .prepare("SELECT name FROM pragma_table_info('video_history') ORDER BY cid")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        for expected in ["kind", "oid", "progress", "duration", "watched_at"] {
            assert!(
                video_columns.iter().any(|column| column == expected),
                "video_history 缺少列 {expected}"
            );
        }

        let watch_columns: Vec<String> = conn
            .prepare("SELECT name FROM pragma_table_info('recording_watch_progress') ORDER BY cid")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        for expected in ["id", "progress", "duration", "watched_at"] {
            assert!(
                watch_columns.iter().any(|column| column == expected),
                "recording_watch_progress 缺少列 {expected}"
            );
        }
    }

    #[test]
    fn rejects_old_schema_versions_without_modifying_them() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE follows (
                site_id TEXT NOT NULL,
                room_id TEXT NOT NULL,
                user_name TEXT NOT NULL,
                face TEXT NOT NULL DEFAULT '',
                tag_ids TEXT NOT NULL DEFAULT '[]',
                auto_record INTEGER NOT NULL DEFAULT 0,
                live_status INTEGER,
                live_started_at INTEGER,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (site_id, room_id)
            );
            INSERT INTO follows (site_id, room_id, user_name, updated_at)
            VALUES ('bilibili', '1', 'user', 1);
            PRAGMA user_version = 2;",
        )
        .unwrap();

        let error = initialize_schema(&conn).unwrap_err();
        let count: i64 = conn
            .query_row("SELECT count(*) FROM follows", [], |row| row.get(0))
            .unwrap();

        assert_eq!(error.code, "db_schema_unsupported");
        assert_eq!(count, 1);
    }

    #[test]
    fn migrates_v3_databases_by_adding_the_new_tables() {
        // v3 形态：SCHEMA 里的表齐全，但没有 video_history 与 recording_watch_progress。
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        conn.execute_batch(
            "INSERT INTO history (site_id, room_id, title, user_name, watched_at)
             VALUES ('bilibili', '1', 'room', 'user', 7);
             INSERT INTO settings_kv (key, value) VALUES ('sentinel', 'kept');
             PRAGMA user_version = 3;",
        )
        .unwrap();

        initialize_schema(&conn).unwrap();

        let version: i64 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);

        // 新表可写，说明列与主键都建好了。
        conn.execute(
            "INSERT INTO video_history (kind, oid, title, watched_at) VALUES ('ugc', 'BV1', 't', 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO recording_watch_progress (id, progress, duration, watched_at)
             VALUES ('bilibili_1/user_1', 30, 600, 1)",
            [],
        )
        .unwrap();

        // 迁移不得动存量数据。
        let sentinel: String = conn
            .query_row(
                "SELECT value FROM settings_kv WHERE key = 'sentinel'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(sentinel, "kept");
        let rooms: i64 = conn
            .query_row("SELECT count(*) FROM history", [], |row| row.get(0))
            .unwrap();
        assert_eq!(rooms, 1);

        assert_trigger_exists(&conn, "video_history_prune_after_insert");
        assert_trigger_exists(&conn, "recording_watch_progress_prune_after_insert");
    }

    #[test]
    fn migrates_v4_databases_by_adding_recording_watch_progress() {
        // v4 形态：v3 加上 video_history 的表、索引与修剪触发器。
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        create_video_history_objects(&conn).unwrap();
        conn.execute_batch(
            "INSERT INTO video_history (kind, oid, title, watched_at)
             VALUES ('ugc', 'BV1', 'sentinel', 1);
             PRAGMA user_version = 4;",
        )
        .unwrap();

        initialize_schema(&conn).unwrap();

        let version: i64 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);

        // 新表可写且能原样读回，说明列、主键与索引都建好了。
        conn.execute(
            "INSERT INTO recording_watch_progress (id, progress, duration, watched_at)
             VALUES ('bilibili_1/user_1', 30.5, 600.25, 1)",
            [],
        )
        .unwrap();
        let stored: (f64, f64, i64) = conn
            .query_row(
                "SELECT progress, duration, watched_at
                 FROM recording_watch_progress WHERE id = 'bilibili_1/user_1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(stored, (30.5, 600.25, 1));

        assert_trigger_exists(&conn, "recording_watch_progress_prune_after_insert");

        // v4 已有的 video_history 数据不得被迁移碰动。
        let title: String = conn
            .query_row(
                "SELECT title FROM video_history WHERE kind = 'ugc' AND oid = 'BV1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(title, "sentinel");
    }

    #[test]
    fn rejects_unversioned_existing_database_without_modifying_it() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE follows (
                site_id TEXT NOT NULL,
                room_id TEXT NOT NULL,
                user_name TEXT NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (site_id, room_id)
            );
            INSERT INTO follows (site_id, room_id, user_name, updated_at)
            VALUES ('bilibili', '1', 'user', 1);",
        )
        .unwrap();

        let error = initialize_schema(&conn).unwrap_err();
        let count: i64 = conn
            .query_row("SELECT count(*) FROM follows", [], |row| row.get(0))
            .unwrap();

        assert_eq!(error.code, "db_schema_unsupported");
        assert_eq!(count, 1);
    }

    #[test]
    fn rejects_unknown_schema_version() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "user_version", 99).unwrap();

        let error = initialize_schema(&conn).unwrap_err();

        assert_eq!(error.code, "db_schema_unsupported");
    }

    #[test]
    fn current_schema_reopens_without_changes() {
        let conn = open_in_memory().unwrap();
        conn.execute(
            "INSERT INTO settings_kv (key, value) VALUES ('sentinel', 'kept')",
            [],
        )
        .unwrap();

        initialize_schema(&conn).unwrap();

        let value: String = conn
            .query_row(
                "SELECT value FROM settings_kv WHERE key = 'sentinel'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(value, "kept");
    }

    #[test]
    fn file_database_uses_bounded_wal_settings() {
        let dir = std::env::temp_dir().join(format!("rlive-db-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();

        {
            let conn = Db::open(dir.join("rlive.db")).unwrap();
            let journal_mode: String = conn
                .pragma_query_value(None, "journal_mode", |row| row.get(0))
                .unwrap();
            let synchronous: i64 = conn
                .pragma_query_value(None, "synchronous", |row| row.get(0))
                .unwrap();
            let busy_timeout: i64 = conn
                .pragma_query_value(None, "busy_timeout", |row| row.get(0))
                .unwrap();
            let cache_size: i64 = conn
                .pragma_query_value(None, "cache_size", |row| row.get(0))
                .unwrap();
            let journal_size_limit: i64 = conn
                .pragma_query_value(None, "journal_size_limit", |row| row.get(0))
                .unwrap();

            assert_eq!(journal_mode, "wal");
            assert_eq!(synchronous, 1);
            assert_eq!(busy_timeout, DB_BUSY_TIMEOUT.as_millis() as i64);
            assert_eq!(cache_size, -DB_CACHE_SIZE_KIB);
            assert_eq!(journal_size_limit, DB_JOURNAL_SIZE_LIMIT_BYTES);
        }

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn current_history_indexes_avoid_temporary_sorting() {
        let conn = open_in_memory().unwrap();

        let indexes: Vec<String> = conn
            .prepare(
                "SELECT name FROM sqlite_master
                 WHERE type = 'index' AND name LIKE 'idx_history_%_order'
                 ORDER BY name",
            )
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(
            indexes,
            vec!["idx_history_recent_order", "idx_history_site_recent_order"]
        );

        let plan: Vec<String> = conn
            .prepare(
                "EXPLAIN QUERY PLAN
                 SELECT site_id, room_id, title, user_name, cover, watched_at
                 FROM history
                 ORDER BY watched_at DESC, site_id ASC, room_id ASC
                 LIMIT 200",
            )
            .unwrap()
            .query_map([], |row| row.get(3))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert!(
            plan.iter()
                .any(|detail| detail.contains("idx_history_recent_order"))
        );
        assert!(
            plan.iter()
                .all(|detail| !detail.contains("USE TEMP B-TREE"))
        );
    }

    #[test]
    fn video_history_recent_index_avoids_temporary_sorting() {
        let conn = open_in_memory().unwrap();

        let plan: Vec<String> = conn
            .prepare(
                "EXPLAIN QUERY PLAN
                 SELECT kind, oid, title, cover, author, part_title, bvid, cid, ep_id, aid,
                        progress, duration, watched_at
                 FROM video_history
                 ORDER BY watched_at DESC, kind ASC, oid ASC
                 LIMIT 200",
            )
            .unwrap()
            .query_map([], |row| row.get(3))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert!(
            plan.iter()
                .any(|detail| detail.contains("idx_video_history_recent_order"))
        );
        assert!(
            plan.iter()
                .all(|detail| !detail.contains("USE TEMP B-TREE"))
        );
    }

    #[test]
    fn recording_watch_progress_recent_index_avoids_temporary_sorting() {
        let conn = open_in_memory().unwrap();

        let plan: Vec<String> = conn
            .prepare(
                "EXPLAIN QUERY PLAN
                 SELECT id, progress, duration, watched_at
                 FROM recording_watch_progress
                 ORDER BY watched_at DESC, id ASC",
            )
            .unwrap()
            .query_map([], |row| row.get(3))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert!(
            plan.iter()
                .any(|detail| detail.contains("idx_recording_watch_progress_recent"))
        );
        assert!(
            plan.iter()
                .all(|detail| !detail.contains("USE TEMP B-TREE"))
        );
    }
}
