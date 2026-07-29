use std::path::Path;

use rusqlite::{Connection, OptionalExtension};

use crate::error::{AppError, AppResult};

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
  watched_at INTEGER NOT NULL,
  PRIMARY KEY (site_id, room_id)
);

CREATE TABLE IF NOT EXISTS danmaku_send_history (
  site_id TEXT NOT NULL,
  content TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  PRIMARY KEY (site_id, content)
);

CREATE INDEX IF NOT EXISTS idx_danmaku_send_history_recent
  ON danmaku_send_history (site_id, sent_at DESC);

CREATE TABLE IF NOT EXISTS danmaku_favorites (
  site_id TEXT NOT NULL,
  content TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (site_id, content)
);

CREATE INDEX IF NOT EXISTS idx_danmaku_favorites_recent
  ON danmaku_favorites (site_id, added_at DESC);

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
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| AppError::new("db_io_error", format!("create data dir: {e}")))?;
            }
        }
        let conn =
            Connection::open(path).map_err(|e| AppError::new("db_open_error", e.to_string()))?;
        migrate(&conn)?;
        Ok(conn)
    }
}

#[cfg(test)]
pub fn open_in_memory() -> AppResult<Connection> {
    let conn =
        Connection::open_in_memory().map_err(|e| AppError::new("db_open_error", e.to_string()))?;
    migrate(&conn)?;
    Ok(conn)
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
    Ok(())
}

pub fn map_db_err(err: rusqlite::Error) -> AppError {
    AppError::new("db_error", err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
