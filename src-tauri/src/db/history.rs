use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::db::schema::{HISTORY_RETENTION_LIMIT, map_db_err};
use crate::error::AppResult;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct HistoryRecord {
    pub site_id: String,
    pub room_id: String,
    pub title: String,
    pub user_name: String,
    /// 打开房间时捕获的封面。无封面的平台为空。
    pub cover: String,
    pub watched_at: i64,
}

/// 列表查询的上限对齐修剪触发器：历史页用虚拟列表渲染，行数不再是渲染成本，
/// 另设一个更小的查询上限只会让用户看不到库里明明还留着的记录。触发器把表封在
/// 同一个数字上，因此这里的 `LIMIT` 是 IPC 负载的兜底而不是业务截断。
const LIST_LIMIT: i64 = HISTORY_RETENTION_LIMIT;

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

/// 基于本地观看历史尽力还原房间身份。房间从未被记录时返回 `None`，
/// 调用方可回退到活动播放器提供的元数据，
/// 或仅展示房间号。
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

/// 替换 (site_id, room_id) 对应行并保留最新的 `watched_at`。
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

/// 删除某房间的本地观看记录。历史按站点/房间唯一，
/// 因此当前时间戳刻意不属于命令契约的一部分。
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
    use crate::db::schema::open_in_memory;

    fn record(site: &str, room: &str, watched_at: i64) -> HistoryRecord {
        HistoryRecord {
            site_id: site.into(),
            room_id: room.into(),
            title: room.into(),
            user_name: site.into(),
            cover: "cover".into(),
            watched_at,
        }
    }

    #[test]
    fn revisits_preserve_time_and_artwork_while_history_is_scoped_and_ordered() {
        let conn = open_in_memory().unwrap();
        for (site, room, time) in [
            ("bilibili", "middle", 20),
            ("huya", "newest", 30),
            ("douyu", "oldest", 10),
        ] {
            upsert(&conn, record(site, room, time)).unwrap();
        }
        let mut revisit = record("bilibili", "middle", 5);
        revisit.cover.clear();
        revisit.title = "更新".into();
        upsert(&conn, revisit).unwrap();
        let rows = list(&conn).unwrap();
        assert_eq!(
            rows.iter().map(|r| &*r.room_id).collect::<Vec<_>>(),
            ["newest", "middle", "oldest"]
        );
        assert_eq!((&*rows[1].cover, rows[1].watched_at), ("cover", 20));
        assert_eq!(
            metadata_for_room(&conn, "bilibili", "middle").unwrap(),
            Some(("更新".into(), "bilibili".into()))
        );
        assert!(
            metadata_for_room(&conn, "huya", "middle")
                .unwrap()
                .is_none()
        );
        remove(&conn, "bilibili", "middle").unwrap();
        assert_eq!(list(&conn).unwrap().len(), 2);
        clear(&conn).unwrap();
        assert!(list(&conn).unwrap().is_empty());
    }

    #[test]
    fn global_list_exposes_the_full_retention_window_and_prunes_oldest() {
        let conn = open_in_memory().unwrap();
        upsert(&conn, record("huya", "old", 0)).unwrap();
        for index in 1..HISTORY_RETENTION_LIMIT {
            upsert(&conn, record("bilibili", &index.to_string(), index)).unwrap();
        }
        let rows = list(&conn).unwrap();
        assert_eq!(rows.len() as i64, HISTORY_RETENTION_LIMIT);
        assert_eq!(rows.last().unwrap().room_id, "old");
        assert_eq!(list_for_site(&conn, "huya").unwrap().len(), 1);
        upsert(&conn, record("bilibili", "latest", HISTORY_RETENTION_LIMIT)).unwrap();
        assert_eq!(list(&conn).unwrap().len() as i64, HISTORY_RETENTION_LIMIT);
        assert!(metadata_for_room(&conn, "huya", "old").unwrap().is_none());
        assert_eq!(list(&conn).unwrap()[0].room_id, "latest");
    }
}
