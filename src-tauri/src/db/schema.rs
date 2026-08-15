use std::path::Path;
use std::time::Duration;

use rusqlite::{Connection, OptionalExtension};

use crate::error::{AppError, AppResult};

pub const HISTORY_RETENTION_LIMIT: i64 = 2_000;

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

CREATE TABLE IF NOT EXISTS danmaku_send_history (
  site_id TEXT NOT NULL,
  content TEXT NOT NULL,
  room_id TEXT NOT NULL DEFAULT '',
  room_title TEXT NOT NULL DEFAULT '',
  room_user_name TEXT NOT NULL DEFAULT '',
  sent_at INTEGER NOT NULL,
  PRIMARY KEY (site_id, content)
);

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
        configure_file_connection(&conn)?;
        migrate(&conn)?;
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
    migrate(&conn)?;
    Ok(conn)
}

/// Add one column to an existing table when an older installation predates it.
/// SQLite has no `ADD COLUMN IF NOT EXISTS`, so the column list is checked
/// first to keep `migrate` safe to run on every launch.
fn add_missing_column(
    conn: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> AppResult<()> {
    let exists = conn
        .query_row(
            "SELECT 1 FROM pragma_table_info(?1) WHERE name = ?2 LIMIT 1",
            [table, column],
            |_| Ok(()),
        )
        .optional()
        .map_err(|e| AppError::new("db_migrate_error", e.to_string()))?
        .is_some();
    if exists {
        return Ok(());
    }
    conn.execute(
        &format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"),
        [],
    )
    .map_err(|e| AppError::new("db_migrate_error", e.to_string()))?;
    Ok(())
}

pub fn migrate(conn: &Connection) -> AppResult<()> {
    conn.execute_batch(SCHEMA)
        .map_err(|e| AppError::new("db_migrate_error", e.to_string()))?;

    // `CREATE TABLE IF NOT EXISTS` does not evolve installations created by
    // older releases. Keep this migration idempotent so an existing follow
    // list gains the cached live-session start timestamp safely.
    let has_live_started_at = conn
        .query_row(
            "SELECT 1 FROM pragma_table_info('follows') WHERE name = ?1 LIMIT 1",
            ["live_started_at"],
            |_| Ok(()),
        )
        .optional()
        .map_err(|e| AppError::new("db_migrate_error", e.to_string()))?
        .is_some();
    if !has_live_started_at {
        conn.execute("ALTER TABLE follows ADD COLUMN live_started_at INTEGER", [])
            .map_err(|e| AppError::new("db_migrate_error", e.to_string()))?;
    }

    // The history screen shows the room cover captured at watch time, and the
    // sent-danmaku list identifies the room and streamer a message went to.
    // Older installations stored none of these fields, so added columns use
    // empty defaults and let the UI retain its legacy fallbacks.
    add_missing_column(conn, "history", "cover", "TEXT NOT NULL DEFAULT ''")?;
    add_missing_column(
        conn,
        "danmaku_send_history",
        "room_id",
        "TEXT NOT NULL DEFAULT ''",
    )?;
    add_missing_column(
        conn,
        "danmaku_send_history",
        "room_title",
        "TEXT NOT NULL DEFAULT ''",
    )?;
    add_missing_column(
        conn,
        "danmaku_send_history",
        "room_user_name",
        "TEXT NOT NULL DEFAULT ''",
    )?;

    // The UI exposes only the recent timeline. Keep a larger local reserve for
    // profile merging while preventing years of unique rooms from growing the
    // database without bound. The trigger prunes inside the inserting
    // transaction, and this one-time-compatible delete also bounds upgrades.
    conn.execute(
        "DELETE FROM history
         WHERE rowid IN (
           SELECT rowid
           FROM history
           ORDER BY watched_at DESC
           LIMIT -1 OFFSET ?1
         )",
        [HISTORY_RETENTION_LIMIT],
    )
    .map_err(|e| AppError::new("db_migrate_error", e.to_string()))?;

    // Replace the older prefix-only indexes. Including deterministic tie
    // breakers lets SQLite satisfy the complete ORDER BY without a temp sort.
    conn.execute_batch(
        "DROP INDEX IF EXISTS idx_history_recent;
         DROP INDEX IF EXISTS idx_history_site_recent;
         DROP INDEX IF EXISTS idx_danmaku_send_history_recent;

         CREATE INDEX IF NOT EXISTS idx_history_recent_order
           ON history (watched_at DESC, site_id ASC, room_id ASC);
         CREATE INDEX IF NOT EXISTS idx_history_site_recent_order
           ON history (site_id ASC, watched_at DESC, room_id ASC);
         CREATE INDEX IF NOT EXISTS idx_danmaku_send_history_site_recent_order
           ON danmaku_send_history (site_id ASC, sent_at DESC, content ASC);
         CREATE INDEX IF NOT EXISTS idx_danmaku_send_history_global_recent_order
           ON danmaku_send_history (sent_at DESC, site_id ASC, content ASC);",
    )
    .map_err(|e| AppError::new("db_migrate_error", e.to_string()))?;

    conn.execute_batch(&format!(
        "CREATE TRIGGER IF NOT EXISTS history_prune_after_insert
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
    .map_err(|e| AppError::new("db_migrate_error", e.to_string()))?;

    let has_iptv_favorite_group_id = conn
        .query_row(
            "SELECT 1 FROM pragma_table_info('iptv_favorites') WHERE name = ?1 LIMIT 1",
            ["favorite_group_id"],
            |_| Ok(()),
        )
        .optional()
        .map_err(|e| AppError::new("db_migrate_error", e.to_string()))?
        .is_some();
    if !has_iptv_favorite_group_id {
        conn.execute(
            "ALTER TABLE iptv_favorites ADD COLUMN favorite_group_id TEXT",
            [],
        )
        .map_err(|e| AppError::new("db_migrate_error", e.to_string()))?;
    }
    Ok(())
}

pub fn map_db_err(err: rusqlite::Error) -> AppError {
    AppError::new("db_error", err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn migrate_adds_live_started_at_to_existing_follows_table() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE follows (
                site_id TEXT NOT NULL,
                room_id TEXT NOT NULL,
                user_name TEXT NOT NULL,
                face TEXT NOT NULL DEFAULT '',
                tag_ids TEXT NOT NULL DEFAULT '[]',
                live_status INTEGER,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (site_id, room_id)
            );",
        )
        .unwrap();

        migrate(&conn).unwrap();

        let column: Option<String> = conn
            .query_row(
                "SELECT name FROM pragma_table_info('follows') WHERE name = ?1",
                ["live_started_at"],
                |row| row.get(0),
            )
            .optional()
            .unwrap();
        assert_eq!(column.as_deref(), Some("live_started_at"));
    }

    #[test]
    fn migrate_adds_history_cover_and_danmaku_room_columns() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE history (
                site_id TEXT NOT NULL,
                room_id TEXT NOT NULL,
                title TEXT NOT NULL,
                user_name TEXT NOT NULL,
                watched_at INTEGER NOT NULL,
                PRIMARY KEY (site_id, room_id)
            );
            INSERT INTO history (site_id, room_id, title, user_name, watched_at)
              VALUES ('bilibili', '1', 't', 'u', 10);
            CREATE TABLE danmaku_send_history (
                site_id TEXT NOT NULL,
                content TEXT NOT NULL,
                sent_at INTEGER NOT NULL,
                PRIMARY KEY (site_id, content)
            );
            INSERT INTO danmaku_send_history (site_id, content, sent_at)
              VALUES ('bilibili', '你好', 10);",
        )
        .unwrap();

        migrate(&conn).unwrap();

        // Legacy rows survive and read back as the empty fallback the UI shows.
        let cover: String = conn
            .query_row("SELECT cover FROM history WHERE room_id = '1'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(cover, "");
        let (room_id, room_title, room_user_name): (String, String, String) = conn
            .query_row(
                "SELECT room_id, room_title, room_user_name
                 FROM danmaku_send_history WHERE content = '你好'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(room_id, "");
        assert_eq!(room_title, "");
        assert_eq!(room_user_name, "");

        // Running again on an already-migrated database must stay a no-op.
        migrate(&conn).unwrap();
    }

    #[test]
    fn migrate_adds_group_id_to_existing_iptv_favorites_table() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE iptv_favorites (
                source_id TEXT NOT NULL,
                channel_url TEXT NOT NULL,
                channel_id TEXT NOT NULL,
                name TEXT NOT NULL,
                group_name TEXT NOT NULL DEFAULT '',
                logo TEXT,
                protocol TEXT,
                headers TEXT NOT NULL DEFAULT '{}',
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (source_id, channel_url)
            );",
        )
        .unwrap();

        migrate(&conn).unwrap();

        let column: Option<String> = conn
            .query_row(
                "SELECT name FROM pragma_table_info('iptv_favorites') WHERE name = ?1",
                ["favorite_group_id"],
                |row| row.get(0),
            )
            .optional()
            .unwrap();
        assert_eq!(column.as_deref(), Some("favorite_group_id"));
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
    fn migration_prunes_legacy_history_and_installs_ordered_indexes() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(&format!(
            "CREATE TABLE history (
               site_id TEXT NOT NULL,
               room_id TEXT NOT NULL,
               title TEXT NOT NULL,
               user_name TEXT NOT NULL,
               watched_at INTEGER NOT NULL,
               PRIMARY KEY (site_id, room_id)
             );
             WITH RECURSIVE rows(value) AS (
               VALUES(1)
               UNION ALL
               SELECT value + 1 FROM rows WHERE value <= {HISTORY_RETENTION_LIMIT}
             )
             INSERT INTO history (site_id, room_id, title, user_name, watched_at)
             SELECT 'bilibili', printf('room-%05d', value), 'title', 'user', value
             FROM rows;"
        ))
        .unwrap();

        migrate(&conn).unwrap();

        let count: i64 = conn
            .query_row("SELECT count(*) FROM history", [], |row| row.get(0))
            .unwrap();
        let oldest: i64 = conn
            .query_row("SELECT min(watched_at) FROM history", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, HISTORY_RETENTION_LIMIT);
        assert_eq!(oldest, 2);

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
}
