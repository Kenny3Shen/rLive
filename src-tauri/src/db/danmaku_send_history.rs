use rusqlite::{Connection, params};
use serde::Serialize;

use crate::db::schema::map_db_err;
use crate::error::AppResult;

/// 让可复用的输入菜单保持实用，
/// 同时不无限保留用户发出消息的完整记录。
pub const MAX_RECORDS_PER_SITE: i64 = 50;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DanmakuSendHistoryRecord {
    pub site_id: String,
    pub content: String,
    /// 消息发往的房间。不可得时为空。
    pub room_id: String,
    /// 发送时捕获的房间标题，使历史界面无需实时查询即可标示房间。
    /// 未知时为空。
    pub room_title: String,
    /// 与房间标题一起捕获的主播名。平台详情负载未提供时为空。
    pub room_user_name: String,
    pub sent_at: i64,
}

fn map_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<DanmakuSendHistoryRecord> {
    Ok(DanmakuSendHistoryRecord {
        site_id: row.get(0)?,
        content: row.get(1)?,
        room_id: row.get(2)?,
        room_title: row.get(3)?,
        room_user_name: row.get(4)?,
        sent_at: row.get(5)?,
    })
}

pub fn list(conn: &Connection, site_id: &str) -> AppResult<Vec<DanmakuSendHistoryRecord>> {
    let mut stmt = conn
        .prepare(
            "SELECT site_id, content, room_id, room_title, room_user_name, sent_at
             FROM danmaku_send_history
             WHERE site_id = ?1
             ORDER BY sent_at DESC, content ASC
             LIMIT ?2",
        )
        .map_err(map_db_err)?;
    let rows = stmt
        .query_map(params![site_id, MAX_RECORDS_PER_SITE], map_record)
        .map_err(map_db_err)?;

    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(map_db_err)?);
    }
    Ok(out)
}

/// 返回本地记录的全部发出消息，最新的在前。与输入菜单不同，
/// 这里刻意不限定单一平台，
/// 以便历史界面呈现统一的时间线。
pub fn list_all(conn: &Connection) -> AppResult<Vec<DanmakuSendHistoryRecord>> {
    let mut stmt = conn
        .prepare(
            "SELECT site_id, content, room_id, room_title, room_user_name, sent_at
             FROM danmaku_send_history
             ORDER BY sent_at DESC, site_id ASC, content ASC",
        )
        .map_err(map_db_err)?;
    let rows = stmt.query_map([], map_record).map_err(map_db_err)?;

    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(map_db_err)?);
    }
    Ok(out)
}

/// 存储一条经平台确认的发出消息。重复发送同一条消息会把它移到
/// 该平台历史的顶部，而不是产生重复条目。
pub fn record(
    conn: &Connection,
    site_id: &str,
    content: &str,
    room_id: &str,
    room_title: &str,
    room_user_name: &str,
    sent_at: i64,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO danmaku_send_history
           (site_id, content, room_id, room_title, room_user_name, sent_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(site_id, content) DO UPDATE SET
           sent_at = MAX(danmaku_send_history.sent_at, excluded.sent_at),
           -- The stored room is the one the surviving timestamp belongs to, so
           -- an older duplicate send never relabels the newer entry.
           room_id = CASE
             WHEN excluded.sent_at >= danmaku_send_history.sent_at THEN excluded.room_id
             ELSE danmaku_send_history.room_id
           END,
           room_title = CASE
             WHEN excluded.sent_at >= danmaku_send_history.sent_at THEN excluded.room_title
             ELSE danmaku_send_history.room_title
           END,
           room_user_name = CASE
             WHEN excluded.sent_at >= danmaku_send_history.sent_at THEN excluded.room_user_name
             ELSE danmaku_send_history.room_user_name
           END",
        params![
            site_id,
            content,
            room_id,
            room_title,
            room_user_name,
            sent_at
        ],
    )
    .map_err(map_db_err)?;

    // SQLite 的 `LIMIT -1 OFFSET n` 表示第 n 行之后的全部行。
    // 清理查询按平台限定范围，避免 Bilibili 的活跃使用
    // 挤掉用户较少使用的虎牙／斗鱼历史。
    conn.execute(
        "DELETE FROM danmaku_send_history
         WHERE rowid IN (
           SELECT rowid
           FROM danmaku_send_history
           WHERE site_id = ?1
           ORDER BY sent_at DESC, content ASC
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
    fn sends_are_deduplicated_scoped_and_ordered_without_stale_relabeling() {
        let conn = open_in_memory().unwrap();
        for (site, content, room, time) in [
            ("bilibili", "你好", "first", 10),
            ("bilibili", "第二条", "first", 20),
            ("douyu", "你好", "other", 20),
            ("huya", "你好", "other", 20),
            ("bilibili", "你好", "new", 40),
            ("bilibili", "你好", "stale", 5),
        ] {
            record(&conn, site, content, room, room, room, time).unwrap();
        }
        let rows = list(&conn, "bilibili").unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].content, "你好");
        assert_eq!(rows[0].sent_at, 40);
        assert_eq!(
            (
                &*rows[0].room_id,
                &*rows[0].room_title,
                &*rows[0].room_user_name
            ),
            ("new", "new", "new")
        );
        let timeline = list_all(&conn).unwrap();
        assert_eq!(
            timeline
                .iter()
                .map(|r| (&*r.site_id, r.sent_at))
                .collect::<Vec<_>>(),
            [
                ("bilibili", 40),
                ("bilibili", 20),
                ("douyu", 20),
                ("huya", 20)
            ]
        );
        clear(&conn, "bilibili").unwrap();
        assert!(list(&conn, "bilibili").unwrap().is_empty());
        assert_eq!(list_all(&conn).unwrap().len(), 2);
        clear_all(&conn).unwrap();
        assert!(list_all(&conn).unwrap().is_empty());
    }

    #[test]
    fn retention_prunes_oldest_sends_only_within_their_platform() {
        let conn = open_in_memory().unwrap();
        record(&conn, "huya", "保留", "room", "标题", "主播", 0).unwrap();
        for index in 0..=MAX_RECORDS_PER_SITE {
            record(
                &conn,
                "bilibili",
                &index.to_string(),
                "room",
                "标题",
                "主播",
                index,
            )
            .unwrap();
        }
        let rows = list(&conn, "bilibili").unwrap();
        assert_eq!(rows.len(), MAX_RECORDS_PER_SITE as usize);
        assert_eq!(rows.first().unwrap().sent_at, MAX_RECORDS_PER_SITE);
        assert_eq!(rows.last().unwrap().sent_at, 1);
        assert_eq!(list(&conn, "huya").unwrap().len(), 1);
    }
}
