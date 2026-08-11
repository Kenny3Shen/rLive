use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::db::schema::map_db_err;
use crate::error::AppResult;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HistoryRecord {
    pub site_id: String,
    pub room_id: String,
    pub title: String,
    pub user_name: String,
    /// Room cover captured when the room was opened. Empty for records written
    /// by releases that predate the column, and for platforms without a cover.
    #[serde(default)]
    pub cover: String,
    pub watched_at: i64,
}

const LIST_LIMIT: i64 = 200;

fn map_history_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<HistoryRecord> {
    Ok(HistoryRecord {
        site_id: row.get(0)?,
        room_id: row.get(1)?,
        title: row.get(2)?,
        user_name: row.get(3)?,
        cover: row.get(4)?,
        watched_at: row.get(5)?,
    })
}

pub fn list(conn: &Connection) -> AppResult<Vec<HistoryRecord>> {
    let mut stmt = conn
        .prepare(
            "SELECT site_id, room_id, title, user_name, cover, watched_at
             FROM history
             ORDER BY watched_at DESC, site_id ASC, room_id ASC
             LIMIT ?1",
        )
        .map_err(map_db_err)?;
    let rows = stmt
        .query_map(params![LIST_LIMIT], map_history_record)
        .map_err(map_db_err)?;

    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(map_db_err)?);
    }
    Ok(out)
}

pub fn list_for_site(conn: &Connection, site_id: &str) -> AppResult<Vec<HistoryRecord>> {
    let mut stmt = conn
        .prepare(
            "SELECT site_id, room_id, title, user_name, cover, watched_at
             FROM history
             WHERE site_id = ?1
             ORDER BY watched_at DESC, room_id ASC
             LIMIT ?2",
        )
        .map_err(map_db_err)?;
    let rows = stmt
        .query_map(params![site_id, LIST_LIMIT], map_history_record)
        .map_err(map_db_err)?;

    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(map_db_err)?);
    }
    Ok(out)
}

/// Best-effort room identity from local watch history. Returns `None` when the
/// room was never recorded, so callers can fall back to the metadata supplied
/// by the active player or show the room id alone.
pub fn metadata_for_room(
    conn: &Connection,
    site_id: &str,
    room_id: &str,
) -> AppResult<Option<(String, String)>> {
    conn.query_row(
        "SELECT title, user_name FROM history WHERE site_id = ?1 AND room_id = ?2",
        params![site_id, room_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .optional()
    .map_err(map_db_err)
}

/// Replace row for (site_id, room_id) and keep the latest `watched_at`.
pub fn upsert(conn: &Connection, record: HistoryRecord) -> AppResult<()> {
    conn.execute(
        "INSERT INTO history (site_id, room_id, title, user_name, cover, watched_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(site_id, room_id) DO UPDATE SET
           title = excluded.title,
           user_name = excluded.user_name,
           -- A revisit whose detail payload carried no cover must not erase the
           -- artwork an earlier visit already recorded.
           cover = CASE WHEN excluded.cover = '' THEN history.cover ELSE excluded.cover END,
           watched_at = MAX(history.watched_at, excluded.watched_at)",
        params![
            record.site_id,
            record.room_id,
            record.title,
            record.user_name,
            record.cover,
            record.watched_at,
        ],
    )
    .map_err(map_db_err)?;
    Ok(())
}

pub fn clear(conn: &Connection) -> AppResult<()> {
    conn.execute("DELETE FROM history", [])
        .map_err(map_db_err)?;
    Ok(())
}

/// Delete one room's local watch record. History is unique per site/room, so
/// the current timestamp is intentionally not part of the command contract.
pub fn remove(conn: &Connection, site_id: &str, room_id: &str) -> AppResult<()> {
    conn.execute(
        "DELETE FROM history WHERE site_id = ?1 AND room_id = ?2",
        params![site_id, room_id],
    )
    .map_err(map_db_err)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::{HISTORY_RETENTION_LIMIT, open_in_memory};

    #[test]
    fn upsert_list_and_clear_history() {
        let conn = open_in_memory().unwrap();
        upsert(
            &conn,
            HistoryRecord {
                site_id: "bilibili".into(),
                room_id: "1".into(),
                title: "t1".into(),
                user_name: "u1".into(),
                cover: String::new(),
                watched_at: 10,
            },
        )
        .unwrap();
        upsert(
            &conn,
            HistoryRecord {
                site_id: "bilibili".into(),
                room_id: "2".into(),
                title: "t2".into(),
                user_name: "u2".into(),
                cover: String::new(),
                watched_at: 20,
            },
        )
        .unwrap();

        let rows = list(&conn).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].room_id, "2");
        assert_eq!(rows[1].room_id, "1");
        assert_eq!(
            metadata_for_room(&conn, "bilibili", "2").unwrap(),
            Some(("t2".into(), "u2".into()))
        );

        // older watched_at must not clobber newer
        upsert(
            &conn,
            HistoryRecord {
                site_id: "bilibili".into(),
                room_id: "2".into(),
                title: "t2-old".into(),
                user_name: "u2".into(),
                cover: String::new(),
                watched_at: 5,
            },
        )
        .unwrap();
        let rows = list(&conn).unwrap();
        assert_eq!(rows[0].watched_at, 20);
        assert_eq!(rows[0].title, "t2-old");

        remove(&conn, "bilibili", "1").unwrap();
        let rows = list(&conn).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].room_id, "2");

        clear(&conn).unwrap();
        assert!(list(&conn).unwrap().is_empty());
    }

    #[test]
    fn global_list_uses_one_limit_and_site_list_remains_available() {
        let conn = open_in_memory().unwrap();
        upsert(
            &conn,
            HistoryRecord {
                site_id: "huya".into(),
                room_id: "huya-room".into(),
                title: "huya".into(),
                user_name: "huya-user".into(),
                cover: String::new(),
                watched_at: 1,
            },
        )
        .unwrap();

        for index in 0..=LIST_LIMIT {
            upsert(
                &conn,
                HistoryRecord {
                    site_id: "bilibili".into(),
                    room_id: format!("bilibili-{index}"),
                    title: format!("title-{index}"),
                    user_name: "bilibili-user".into(),
                    cover: String::new(),
                    watched_at: index + 10,
                },
            )
            .unwrap();
        }

        let rows = list(&conn).unwrap();
        assert_eq!(rows.len(), LIST_LIMIT as usize);
        assert!(rows.iter().all(|record| record.site_id == "bilibili"));

        let huya_rows = list_for_site(&conn, "huya").unwrap();
        assert_eq!(huya_rows.len(), 1);
        assert_eq!(huya_rows[0].room_id, "huya-room");
    }

    #[test]
    fn revisit_without_a_cover_keeps_the_recorded_artwork() {
        let conn = open_in_memory().unwrap();
        let mut record = HistoryRecord {
            site_id: "bilibili".into(),
            room_id: "1".into(),
            title: "t1".into(),
            user_name: "u1".into(),
            cover: "https://example.com/a.jpg".into(),
            watched_at: 10,
        };
        upsert(&conn, record.clone()).unwrap();

        record.cover = String::new();
        record.watched_at = 20;
        upsert(&conn, record.clone()).unwrap();
        assert_eq!(list(&conn).unwrap()[0].cover, "https://example.com/a.jpg");

        record.cover = "https://example.com/b.jpg".into();
        record.watched_at = 30;
        upsert(&conn, record).unwrap();
        assert_eq!(list(&conn).unwrap()[0].cover, "https://example.com/b.jpg");
    }

    #[test]
    fn global_list_mixes_platforms_by_recency() {
        let conn = open_in_memory().unwrap();
        for (site_id, room_id, watched_at) in [
            ("bilibili", "middle", 20),
            ("huya", "newest", 30),
            ("douyu", "oldest", 10),
        ] {
            upsert(
                &conn,
                HistoryRecord {
                    site_id: site_id.into(),
                    room_id: room_id.into(),
                    title: room_id.into(),
                    user_name: site_id.into(),
                    cover: String::new(),
                    watched_at,
                },
            )
            .unwrap();
        }

        let rows = list(&conn).unwrap();
        assert_eq!(
            rows.iter()
                .map(|record| record.room_id.as_str())
                .collect::<Vec<_>>(),
            vec!["newest", "middle", "oldest"]
        );
    }

    #[test]
    fn new_rooms_keep_history_within_the_storage_limit() {
        let conn = open_in_memory().unwrap();
        for index in 0..=HISTORY_RETENTION_LIMIT {
            upsert(
                &conn,
                HistoryRecord {
                    site_id: "bilibili".into(),
                    room_id: format!("room-{index:05}"),
                    title: format!("title-{index}"),
                    user_name: "user".into(),
                    cover: String::new(),
                    watched_at: index,
                },
            )
            .unwrap();
        }

        let count: i64 = conn
            .query_row("SELECT count(*) FROM history", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, HISTORY_RETENTION_LIMIT);
        assert!(
            metadata_for_room(&conn, "bilibili", "room-00000")
                .unwrap()
                .is_none()
        );
        assert!(
            metadata_for_room(
                &conn,
                "bilibili",
                &format!("room-{HISTORY_RETENTION_LIMIT:05}")
            )
            .unwrap()
            .is_some()
        );
    }
}
