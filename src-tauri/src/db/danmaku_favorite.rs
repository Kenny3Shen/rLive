use rusqlite::{Connection, params};
use serde::Serialize;

use crate::db::schema::map_db_err;
use crate::error::AppResult;

/// 一条刻意保存、可复用的发送消息。收藏与发送历史刻意相互独立，
/// 因此清空历史绝不会丢弃用户选择保留的消息。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DanmakuFavoriteRecord {
    pub site_id: String,
    pub content: String,
    pub added_at: i64,
}

pub fn list(conn: &Connection, site_id: &str) -> AppResult<Vec<DanmakuFavoriteRecord>> {
    let mut stmt = conn
        .prepare(
            "SELECT site_id, content, added_at
             FROM danmaku_favorites
             WHERE site_id = ?1
             ORDER BY added_at DESC, rowid DESC",
        )
        .map_err(map_db_err)?;
    let rows = stmt
        .query_map(params![site_id], |row| {
            Ok(DanmakuFavoriteRecord {
                site_id: row.get(0)?,
                content: row.get(1)?,
                added_at: row.get(2)?,
            })
        })
        .map_err(map_db_err)?;

    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(map_db_err)?);
    }
    Ok(out)
}

/// 添加收藏，或把已有收藏移到其平台列表顶部。
pub fn upsert(conn: &Connection, site_id: &str, content: &str, added_at: i64) -> AppResult<()> {
    conn.execute(
        "INSERT INTO danmaku_favorites (site_id, content, added_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(site_id, content) DO UPDATE SET
           added_at = MAX(danmaku_favorites.added_at, excluded.added_at)",
        params![site_id, content, added_at],
    )
    .map_err(map_db_err)?;
    Ok(())
}

pub fn remove(conn: &Connection, site_id: &str, content: &str) -> AppResult<()> {
    conn.execute(
        "DELETE FROM danmaku_favorites WHERE site_id = ?1 AND content = ?2",
        params![site_id, content],
    )
    .map_err(map_db_err)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::open_in_memory;

    #[test]
    fn favorites_are_deduplicated_and_scoped_to_their_platform() {
        let conn = open_in_memory().unwrap();
        upsert(&conn, "bilibili", "你好", 10).unwrap();
        upsert(&conn, "bilibili", "第二条", 20).unwrap();
        upsert(&conn, "huya", "你好", 30).unwrap();
        upsert(&conn, "bilibili", "你好", 40).unwrap();

        assert_eq!(
            list(&conn, "bilibili").unwrap(),
            vec![
                DanmakuFavoriteRecord {
                    site_id: "bilibili".into(),
                    content: "你好".into(),
                    added_at: 40,
                },
                DanmakuFavoriteRecord {
                    site_id: "bilibili".into(),
                    content: "第二条".into(),
                    added_at: 20,
                },
            ]
        );
        assert_eq!(
            list(&conn, "huya").unwrap(),
            vec![DanmakuFavoriteRecord {
                site_id: "huya".into(),
                content: "你好".into(),
                added_at: 30,
            }]
        );
    }

    #[test]
    fn removing_a_favorite_does_not_affect_other_platforms() {
        let conn = open_in_memory().unwrap();
        upsert(&conn, "bilibili", "你好", 10).unwrap();
        upsert(&conn, "huya", "你好", 20).unwrap();

        remove(&conn, "bilibili", "你好").unwrap();

        assert!(list(&conn, "bilibili").unwrap().is_empty());
        assert_eq!(list(&conn, "huya").unwrap().len(), 1);
    }
}
