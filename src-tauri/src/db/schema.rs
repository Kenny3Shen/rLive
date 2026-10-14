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
pub const SCHEMA_VERSION: i64 = 6;

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

/// APP 登录凭据与 Web Cookie、可导出设置分离；只允许一个本机账号。
const BILIBILI_APP_AUTH_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS bilibili_app_auth (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  mid TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
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

/// 修剪触发器 DDL：新插入把行数顶过保留上限时，删掉排序最旧的一行。
/// `order` 必须与 `index` 的排序键一致，`INDEXED BY` 保证修剪走的正是索引。
/// `if_not_exists` 供迁移路径在已有库上重放时幂等；新库初始化的 `history`
/// 触发器面对空库，省略该位（与既有 DDL 一致）。
fn prune_trigger_sql(
    table: &str,
    index: &str,
    order: &str,
    limit: i64,
    if_not_exists: &str,
) -> String {
    format!(
        "CREATE TRIGGER {if_not_exists}{table}_prune_after_insert
         AFTER INSERT ON {table}
         BEGIN
           DELETE FROM {table}
           WHERE rowid = (
             SELECT rowid
             FROM {table} INDEXED BY {index}
             ORDER BY {order}
             LIMIT 1 OFFSET {limit}
           );
         END;"
    )
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

    // v3→v6 均为增量建表，保留原有 Cookie、设置及观看历史。
    if (3..SCHEMA_VERSION).contains(&version) {
        let transaction = conn
            .unchecked_transaction()
            .map_err(|error| AppError::new("db_schema_error", error.to_string()))?;
        if version < 4 {
            create_video_history_objects(&transaction)?;
        }
        if version < 5 {
            create_recording_watch_progress_objects(&transaction)?;
        }
        transaction
            .execute_batch(BILIBILI_APP_AUTH_SCHEMA)
            .map_err(map_db_err)?;
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
        .execute_batch(BILIBILI_APP_AUTH_SCHEMA)
        .map_err(map_db_err)?;
    transaction
        .execute_batch(&prune_trigger_sql(
            "history",
            "idx_history_recent_order",
            "watched_at DESC, site_id ASC, room_id ASC",
            HISTORY_RETENTION_LIMIT,
            "",
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
    tx.execute_batch(&prune_trigger_sql(
        "video_history",
        "idx_video_history_recent_order",
        "watched_at DESC, kind ASC, oid ASC",
        VIDEO_HISTORY_RETENTION_LIMIT,
        "IF NOT EXISTS ",
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
    tx.execute_batch(&prune_trigger_sql(
        "recording_watch_progress",
        "idx_recording_watch_progress_recent",
        "watched_at DESC, id ASC",
        RECORDING_WATCH_PROGRESS_RETENTION_LIMIT,
        "IF NOT EXISTS ",
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

    fn version(conn: &Connection) -> i64 {
        conn.pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap()
    }

    #[test]
    fn upgrades_supported_versions_without_losing_existing_data() {
        for old_version in [0, 3, 4, 5, SCHEMA_VERSION] {
            let conn = Connection::open_in_memory().unwrap();
            if old_version == SCHEMA_VERSION {
                initialize_schema(&conn).unwrap();
            } else if old_version > 0 {
                conn.execute_batch(SCHEMA).unwrap();
                if old_version >= 4 {
                    create_video_history_objects(&conn).unwrap();
                }
                if old_version >= 5 {
                    create_recording_watch_progress_objects(&conn).unwrap();
                }
                conn.pragma_update(None, "user_version", old_version)
                    .unwrap();
            }
            if old_version > 0 {
                conn.execute_batch(
                    "INSERT INTO cookies VALUES ('bilibili', 'sentinel', 1);
                     INSERT INTO settings_kv VALUES ('sentinel', 'kept');
                     INSERT INTO history (site_id, room_id, title, user_name, watched_at)
                     VALUES ('bilibili', '1', 'room', 'user', 7);",
                )
                .unwrap();
            }
            initialize_schema(&conn).unwrap();
            assert_eq!(version(&conn), SCHEMA_VERSION, "旧版本 {old_version}");
            conn.execute_batch(
                "INSERT INTO video_history (kind, oid, title, watched_at)
                 VALUES ('ugc', 'BV1', 't', 1);
                 INSERT INTO recording_watch_progress VALUES ('room/recording', 30.5, 600, 1);
                 INSERT INTO bilibili_app_auth VALUES (1, 'a', 'r', '42', 1);",
            )
            .unwrap();
            assert!(
                conn.execute(
                    "INSERT INTO bilibili_app_auth VALUES (2, 'b', 'r', '43', 1)",
                    []
                )
                .is_err()
            );
            if old_version > 0 {
                let saved: (String, String, i64) = conn
                    .query_row(
                        "SELECT cookie, value, watched_at FROM cookies, settings_kv, history",
                        [],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                    )
                    .unwrap();
                assert_eq!(saved, ("sentinel".into(), "kept".into(), 7));
            }
            // 迁移后再次打开不重建表，也不删除已写入的记录。
            initialize_schema(&conn).unwrap();
            let progress: f64 = conn
                .query_row("SELECT progress FROM recording_watch_progress", [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(progress, 30.5);
        }
    }

    #[test]
    fn unsupported_versions_leave_existing_data_untouched() {
        for old_version in [0, 1, 2, SCHEMA_VERSION + 1] {
            let conn = Connection::open_in_memory().unwrap();
            conn.execute_batch(
                "CREATE TABLE sentinel (value TEXT); INSERT INTO sentinel VALUES ('kept');",
            )
            .unwrap();
            conn.pragma_update(None, "user_version", old_version)
                .unwrap();
            assert_eq!(
                initialize_schema(&conn).unwrap_err().code,
                "db_schema_unsupported"
            );
            assert_eq!(version(&conn), old_version);
            let value: String = conn
                .query_row("SELECT value FROM sentinel", [], |row| row.get(0))
                .unwrap();
            assert_eq!(value, "kept");
        }
    }

    #[test]
    fn file_database_uses_bounded_wal_settings() {
        let dir = std::env::temp_dir().join(format!("rlive-db-test-{}", uuid::Uuid::new_v4()));
        {
            let conn = Db::open(dir.join("rlive.db")).unwrap();
            let journal: String = conn
                .pragma_query_value(None, "journal_mode", |row| row.get(0))
                .unwrap();
            assert_eq!(journal, "wal");
            for (pragma, expected) in [
                ("synchronous", 1),
                ("busy_timeout", DB_BUSY_TIMEOUT.as_millis() as i64),
                ("cache_size", -DB_CACHE_SIZE_KIB),
                ("journal_size_limit", DB_JOURNAL_SIZE_LIMIT_BYTES),
            ] {
                let actual: i64 = conn
                    .pragma_query_value(None, pragma, |row| row.get(0))
                    .unwrap();
                assert_eq!(actual, expected, "{pragma}");
            }
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
}
