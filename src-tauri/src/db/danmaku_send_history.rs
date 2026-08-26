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
    fn records_deduplicate_per_platform_and_keep_the_latest_timestamp() {
        let conn = open_in_memory().unwrap();
        record(
            &conn,
            "bilibili",
            "你好",
            "room-1",
            "房间标题",
            "主播甲",
            10,
        )
        .unwrap();
        record(
            &conn,
            "bilibili",
            "第二条",
            "room-1",
            "房间标题",
            "主播甲",
            20,
        )
        .unwrap();
        record(&conn, "douyu", "你好", "room-1", "房间标题", "主播乙", 30).unwrap();
        record(
            &conn,
            "bilibili",
            "你好",
            "room-1",
            "房间标题",
            "主播甲",
            40,
        )
        .unwrap();

        assert_eq!(
            list(&conn, "bilibili").unwrap(),
            vec![
                DanmakuSendHistoryRecord {
                    site_id: "bilibili".into(),
                    content: "你好".into(),
                    room_id: "room-1".into(),
                    room_title: "房间标题".into(),
                    room_user_name: "主播甲".into(),
                    sent_at: 40,
                },
                DanmakuSendHistoryRecord {
                    site_id: "bilibili".into(),
                    content: "第二条".into(),
                    room_id: "room-1".into(),
                    room_title: "房间标题".into(),
                    room_user_name: "主播甲".into(),
                    sent_at: 20,
                },
            ]
        );
        assert_eq!(
            list(&conn, "douyu").unwrap(),
            vec![DanmakuSendHistoryRecord {
                site_id: "douyu".into(),
                content: "你好".into(),
                room_id: "room-1".into(),
                room_title: "房间标题".into(),
                room_user_name: "主播乙".into(),
                sent_at: 30,
            }]
        );
    }

    #[test]
    fn resending_relabels_the_room_only_when_the_newer_send_wins() {
        let conn = open_in_memory().unwrap();
        record(
            &conn,
            "bilibili",
            "你好",
            "room-1",
            "第一个直播间",
            "第一个主播",
            10,
        )
        .unwrap();

        // 较晚出现的重复条目才是留存时间戳所属的那条。
        record(
            &conn,
            "bilibili",
            "你好",
            "room-2",
            "第二个直播间",
            "第二个主播",
            20,
        )
        .unwrap();
        let records = list(&conn, "bilibili").unwrap();
        assert_eq!(records[0].room_id, "room-2");
        assert_eq!(records[0].room_title, "第二个直播间");
        assert_eq!(records[0].room_user_name, "第二个主播");
        assert_eq!(records[0].sent_at, 20);

        // 乱序到达的更早发送不得改写更新的条目。
        record(
            &conn,
            "bilibili",
            "你好",
            "room-3",
            "第三个直播间",
            "第三个主播",
            5,
        )
        .unwrap();
        let records = list(&conn, "bilibili").unwrap();
        assert_eq!(records[0].room_id, "room-2");
        assert_eq!(records[0].room_title, "第二个直播间");
        assert_eq!(records[0].room_user_name, "第二个主播");
        assert_eq!(records[0].sent_at, 20);
    }

    #[test]
    fn keeps_a_bounded_history_for_each_platform() {
        let conn = open_in_memory().unwrap();
        for index in 0..=MAX_RECORDS_PER_SITE {
            record(
                &conn,
                "bilibili",
                &format!("弹幕 {index}"),
                "room-1",
                "房间标题",
                "主播甲",
                index,
            )
            .unwrap();
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
        record(
            &conn,
            "bilibili",
            "你好",
            "room-1",
            "房间标题",
            "主播甲",
            10,
        )
        .unwrap();
        record(&conn, "huya", "晚上好", "room-1", "房间标题", "主播乙", 20).unwrap();

        clear(&conn, "bilibili").unwrap();

        assert!(list(&conn, "bilibili").unwrap().is_empty());
        assert_eq!(list(&conn, "huya").unwrap().len(), 1);
    }

    #[test]
    fn lists_all_platforms_in_reverse_chronological_order() {
        let conn = open_in_memory().unwrap();
        record(
            &conn,
            "bilibili",
            "第一条",
            "room-1",
            "房间标题",
            "主播甲",
            10,
        )
        .unwrap();
        record(&conn, "huya", "第二条", "room-1", "房间标题", "主播乙", 20).unwrap();
        record(&conn, "douyu", "第三条", "room-1", "房间标题", "主播丙", 20).unwrap();

        assert_eq!(
            list_all(&conn).unwrap(),
            vec![
                DanmakuSendHistoryRecord {
                    site_id: "douyu".into(),
                    content: "第三条".into(),
                    room_id: "room-1".into(),
                    room_title: "房间标题".into(),
                    room_user_name: "主播丙".into(),
                    sent_at: 20,
                },
                DanmakuSendHistoryRecord {
                    site_id: "huya".into(),
                    content: "第二条".into(),
                    room_id: "room-1".into(),
                    room_title: "房间标题".into(),
                    room_user_name: "主播乙".into(),
                    sent_at: 20,
                },
                DanmakuSendHistoryRecord {
                    site_id: "bilibili".into(),
                    content: "第一条".into(),
                    room_id: "room-1".into(),
                    room_title: "房间标题".into(),
                    room_user_name: "主播甲".into(),
                    sent_at: 10,
                },
            ]
        );
    }

    #[test]
    fn clearing_all_platforms_removes_every_record() {
        let conn = open_in_memory().unwrap();
        record(
            &conn,
            "bilibili",
            "你好",
            "room-1",
            "房间标题",
            "主播甲",
            10,
        )
        .unwrap();
        record(&conn, "huya", "晚上好", "room-1", "房间标题", "主播乙", 20).unwrap();

        clear_all(&conn).unwrap();

        assert!(list_all(&conn).unwrap().is_empty());
    }
}
