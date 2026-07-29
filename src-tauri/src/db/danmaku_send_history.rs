use rusqlite::{Connection, params};
use serde::Serialize;

use crate::db::schema::map_db_err;
use crate::error::AppResult;

/// Keep the reusable composer menu useful without retaining an unbounded
/// transcript of a user's outgoing messages.
pub const MAX_RECORDS_PER_SITE: i64 = 50;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DanmakuSendHistoryRecord {
    pub site_id: String,
    pub content: String,
    pub sent_at: i64,
}

pub fn list(conn: &Connection, site_id: &str) -> AppResult<Vec<DanmakuSendHistoryRecord>> {
    let mut stmt = conn
        .prepare(
            "SELECT site_id, content, sent_at
             FROM danmaku_send_history
             WHERE site_id = ?1
             ORDER BY sent_at DESC, rowid DESC
             LIMIT ?2",
        )
        .map_err(map_db_err)?;
    let rows = stmt
        .query_map(params![site_id, MAX_RECORDS_PER_SITE], |row| {
            Ok(DanmakuSendHistoryRecord {
                site_id: row.get(0)?,
                content: row.get(1)?,
                sent_at: row.get(2)?,
            })
        })
        .map_err(map_db_err)?;

    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(map_db_err)?);
    }
    Ok(out)
}

/// Returns every locally recorded outgoing message, newest first. Unlike the
/// composer menu this is intentionally not filtered to a single platform so
/// the history screen can present one chronological timeline.
pub fn list_all(conn: &Connection) -> AppResult<Vec<DanmakuSendHistoryRecord>> {
    let mut stmt = conn
        .prepare(
            "SELECT site_id, content, sent_at
             FROM danmaku_send_history
             ORDER BY sent_at DESC, rowid DESC",
        )
        .map_err(map_db_err)?;
    let rows = stmt
        .query_map([], |row| {
            Ok(DanmakuSendHistoryRecord {
                site_id: row.get(0)?,
                content: row.get(1)?,
                sent_at: row.get(2)?,
            })
        })
        .map_err(map_db_err)?;

    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(map_db_err)?);
    }
    Ok(out)
}

/// Store one platform-confirmed outgoing message. Reusing a message moves it
/// to the top of that platform's history instead of duplicating the entry.
pub fn record(conn: &Connection, site_id: &str, content: &str, sent_at: i64) -> AppResult<()> {
    conn.execute(
        "INSERT INTO danmaku_send_history (site_id, content, sent_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(site_id, content) DO UPDATE SET
           sent_at = MAX(danmaku_send_history.sent_at, excluded.sent_at)",
        params![site_id, content, sent_at],
    )
    .map_err(map_db_err)?;

    // SQLite's `LIMIT -1 OFFSET n` means every row after the first n. Scope
    // the pruning query to the platform so active Bilibili usage never evicts
    // the user's smaller Huya/Douyu history.
    conn.execute(
        "DELETE FROM danmaku_send_history
         WHERE rowid IN (
           SELECT rowid
           FROM danmaku_send_history
           WHERE site_id = ?1
           ORDER BY sent_at DESC, rowid DESC
           LIMIT -1 OFFSET ?2
         )",
        params![site_id, MAX_RECORDS_PER_SITE],
    )
    .map_err(map_db_err)?;
    Ok(())
}

pub fn clear(conn: &Connection, site_id: &str) -> AppResult<()> {
    conn.execute(
        "DELETE FROM danmaku_send_history WHERE site_id = ?1",
        params![site_id],
    )
    .map_err(map_db_err)?;
    Ok(())
}

pub fn clear_all(conn: &Connection) -> AppResult<()> {
    conn.execute("DELETE FROM danmaku_send_history", [])
        .map_err(map_db_err)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::open_in_memory;

    #[test]
    fn records_deduplicate_per_platform_and_keep_the_latest_timestamp() {
        let conn = open_in_memory().unwrap();
        record(&conn, "bilibili", "你好", 10).unwrap();
        record(&conn, "bilibili", "第二条", 20).unwrap();
        record(&conn, "douyu", "你好", 30).unwrap();
        record(&conn, "bilibili", "你好", 40).unwrap();

        assert_eq!(
            list(&conn, "bilibili").unwrap(),
            vec![
                DanmakuSendHistoryRecord {
                    site_id: "bilibili".into(),
                    content: "你好".into(),
                    sent_at: 40,
                },
                DanmakuSendHistoryRecord {
                    site_id: "bilibili".into(),
                    content: "第二条".into(),
                    sent_at: 20,
                },
            ]
        );
        assert_eq!(
            list(&conn, "douyu").unwrap(),
            vec![DanmakuSendHistoryRecord {
                site_id: "douyu".into(),
                content: "你好".into(),
                sent_at: 30,
            }]
        );
    }

    #[test]
    fn keeps_a_bounded_history_for_each_platform() {
        let conn = open_in_memory().unwrap();
        for index in 0..=MAX_RECORDS_PER_SITE {
            record(&conn, "bilibili", &format!("弹幕 {index}"), index).unwrap();
        }

        let records = list(&conn, "bilibili").unwrap();
        assert_eq!(records.len(), MAX_RECORDS_PER_SITE as usize);
        assert_eq!(
            records.first().map(|record| record.content.as_str()),
            Some("弹幕 50")
        );
        assert_eq!(
            records.last().map(|record| record.content.as_str()),
            Some("弹幕 1")
        );
    }

    #[test]
    fn clearing_one_platform_leaves_other_platforms_intact() {
        let conn = open_in_memory().unwrap();
        record(&conn, "bilibili", "你好", 10).unwrap();
        record(&conn, "huya", "晚上好", 20).unwrap();

        clear(&conn, "bilibili").unwrap();

        assert!(list(&conn, "bilibili").unwrap().is_empty());
        assert_eq!(list(&conn, "huya").unwrap().len(), 1);
    }

    #[test]
    fn lists_all_platforms_in_reverse_chronological_order() {
        let conn = open_in_memory().unwrap();
        record(&conn, "bilibili", "第一条", 10).unwrap();
        record(&conn, "huya", "第二条", 20).unwrap();
        record(&conn, "douyu", "第三条", 20).unwrap();

        assert_eq!(
            list_all(&conn).unwrap(),
            vec![
                DanmakuSendHistoryRecord {
                    site_id: "douyu".into(),
                    content: "第三条".into(),
                    sent_at: 20,
                },
                DanmakuSendHistoryRecord {
                    site_id: "huya".into(),
                    content: "第二条".into(),
                    sent_at: 20,
                },
                DanmakuSendHistoryRecord {
                    site_id: "bilibili".into(),
                    content: "第一条".into(),
                    sent_at: 10,
                },
            ]
        );
    }

    #[test]
    fn clearing_all_platforms_removes_every_record() {
        let conn = open_in_memory().unwrap();
        record(&conn, "bilibili", "你好", 10).unwrap();
        record(&conn, "huya", "晚上好", 20).unwrap();

        clear_all(&conn).unwrap();

        assert!(list_all(&conn).unwrap().is_empty());
    }
}
