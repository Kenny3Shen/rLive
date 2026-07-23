use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::db::schema::map_db_err;
use crate::error::AppResult;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HistoryRecord {
    pub site_id: String,
    pub room_id: String,
    pub title: String,
    pub user_name: String,
    pub watched_at: i64,
}

const LIST_LIMIT: i64 = 200;

pub fn list(conn: &Connection) -> AppResult<Vec<HistoryRecord>> {
    let mut stmt = conn
        .prepare(
            "SELECT site_id, room_id, title, user_name, watched_at
             FROM history
             ORDER BY watched_at DESC
             LIMIT ?1",
        )
        .map_err(map_db_err)?;
    let rows = stmt
        .query_map(params![LIST_LIMIT], |row| {
            Ok(HistoryRecord {
                site_id: row.get(0)?,
                room_id: row.get(1)?,
                title: row.get(2)?,
                user_name: row.get(3)?,
                watched_at: row.get(4)?,
            })
        })
        .map_err(map_db_err)?;

    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(map_db_err)?);
    }
    Ok(out)
}

/// Replace row for (site_id, room_id) and keep the latest `watched_at`.
pub fn upsert(conn: &Connection, record: HistoryRecord) -> AppResult<()> {
    conn.execute(
        "INSERT INTO history (site_id, room_id, title, user_name, watched_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(site_id, room_id) DO UPDATE SET
           title = excluded.title,
           user_name = excluded.user_name,
           watched_at = MAX(history.watched_at, excluded.watched_at)",
        params![
            record.site_id,
            record.room_id,
            record.title,
            record.user_name,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::open_in_memory;

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
                watched_at: 20,
            },
        )
        .unwrap();

        let rows = list(&conn).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].room_id, "2");
        assert_eq!(rows[1].room_id, "1");

        // older watched_at must not clobber newer
        upsert(
            &conn,
            HistoryRecord {
                site_id: "bilibili".into(),
                room_id: "2".into(),
                title: "t2-old".into(),
                user_name: "u2".into(),
                watched_at: 5,
            },
        )
        .unwrap();
        let rows = list(&conn).unwrap();
        assert_eq!(rows[0].watched_at, 20);
        assert_eq!(rows[0].title, "t2-old");

        clear(&conn).unwrap();
        assert!(list(&conn).unwrap().is_empty());
    }
}
