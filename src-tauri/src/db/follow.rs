use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};

use crate::db::schema::map_db_err;
use crate::error::AppResult;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FollowRecord {
    pub site_id: String,
    pub room_id: String,
    pub user_name: String,
    pub face: String,
    pub tag_ids: Vec<String>,
    pub auto_record: bool,
    pub live_status: Option<i32>,
    pub live_started_at: Option<i64>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TagRecord {
    pub id: String,
    pub name: String,
}

/// 一轮关注刷新要落库的单条直播状态。
///
/// 只带探测产出的字段：刷新不拥有 `user_name` / `face` / `tag_ids` /
/// `auto_record`，把它们一并写回只会把网络等待期间的用户修改覆盖掉。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FollowLiveStatusUpdate {
    pub site_id: String,
    pub room_id: String,
    pub live_status: Option<i32>,
    pub live_started_at: Option<i64>,
    pub updated_at: i64,
}

fn encode_tag_ids(tag_ids: &[String]) -> AppResult<String> {
    serde_json::to_string(tag_ids)
        .map_err(|e| crate::error::AppError::new("db_encode_error", format!("tag_ids: {e}")))
}

fn decode_tag_ids(raw: &str) -> AppResult<Vec<String>> {
    if raw.trim().is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str(raw)
        .map_err(|e| crate::error::AppError::new("db_decode_error", format!("tag_ids: {e}")))
}

const FOLLOW_COLUMNS: &str = "site_id, room_id, user_name, face, tag_ids, auto_record, live_status, live_started_at, updated_at";

/// 按可选的 WHERE 子句读关注。子句是本模块内的字面量，不接受调用方输入。
fn query_follows(conn: &Connection, filter: &str) -> AppResult<Vec<FollowRecord>> {
    let sql = format!("SELECT {FOLLOW_COLUMNS} FROM follows {filter} ORDER BY updated_at DESC");
    let mut stmt = conn.prepare(&sql).map_err(map_db_err)?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, bool>(5)?,
                row.get::<_, Option<i32>>(6)?,
                row.get::<_, Option<i64>>(7)?,
                row.get::<_, i64>(8)?,
            ))
        })
        .map_err(map_db_err)?;

    let mut out = Vec::new();
    for row in rows {
        let (
            site_id,
            room_id,
            user_name,
            face,
            tag_ids_raw,
            auto_record,
            live_status,
            live_started_at,
            updated_at,
        ) = row.map_err(map_db_err)?;
        out.push(FollowRecord {
            site_id,
            room_id,
            user_name,
            face,
            tag_ids: decode_tag_ids(&tag_ids_raw)?,
            auto_record,
            live_status,
            live_started_at,
            updated_at,
        });
    }
    Ok(out)
}

pub fn list(conn: &Connection) -> AppResult<Vec<FollowRecord>> {
    query_follows(conn, "")
}

pub fn upsert(conn: &Connection, record: FollowRecord) -> AppResult<()> {
    let tag_ids = encode_tag_ids(&record.tag_ids)?;
    conn.execute(
        "INSERT INTO follows (site_id, room_id, user_name, face, tag_ids, auto_record, live_status, live_started_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(site_id, room_id) DO UPDATE SET
           user_name = excluded.user_name,
           face = excluded.face,
           tag_ids = excluded.tag_ids,
           auto_record = excluded.auto_record,
           live_status = excluded.live_status,
           live_started_at = excluded.live_started_at,
           updated_at = excluded.updated_at",
        params![
            record.site_id,
            record.room_id,
            record.user_name,
            record.face,
            tag_ids,
            record.auto_record,
            record.live_status,
            record.live_started_at,
            record.updated_at,
        ],
    )
    .map_err(map_db_err)?;
    Ok(())
}

pub fn list_auto_record(conn: &Connection) -> AppResult<Vec<FollowRecord>> {
    // 筛选下推 SQL：自动录制通常只占少数，不必把整表解码到内存再过滤。
    query_follows(conn, "WHERE auto_record = 1")
}

/// 把一轮刷新的直播状态用**一个事务**写回，并复用同一条 prepared statement。
///
/// 两条不变量：
///
/// 1. **只写状态字段**。网络等待期间用户可能改了标签或自动录制，
///    整行 `upsert` 会把读取时的旧值写回去。
/// 2. **`UPDATE` 而不是 `INSERT ... ON CONFLICT`**。刷新中途被删除的关注
///    匹配不到行，因此不会被复活；这种“少写一行”不是错误。
///
/// 返回实际更新的行数，供调用方区分“已落库”与“已不存在”。
pub fn apply_live_status_batch(
    conn: &mut Connection,
    updates: &[FollowLiveStatusUpdate],
) -> AppResult<usize> {
    if updates.is_empty() {
        return Ok(0);
    }
    let transaction = conn.transaction().map_err(map_db_err)?;
    let mut applied = 0_usize;
    {
        let mut stmt = transaction
            .prepare(
                "UPDATE follows
                    SET live_status = ?1, live_started_at = ?2, updated_at = ?3
                  WHERE site_id = ?4 AND room_id = ?5",
            )
            .map_err(map_db_err)?;
        for update in updates {
            applied += stmt
                .execute(params![
                    update.live_status,
                    update.live_started_at,
                    update.updated_at,
                    update.site_id,
                    update.room_id,
                ])
                .map_err(map_db_err)?;
        }
    }
    transaction.commit().map_err(map_db_err)?;
    Ok(applied)
}

pub fn remove(conn: &Connection, site_id: &str, room_id: &str) -> AppResult<()> {
    conn.execute(
        "DELETE FROM follows WHERE site_id = ?1 AND room_id = ?2",
        params![site_id, room_id],
    )
    .map_err(map_db_err)?;
    Ok(())
}

pub fn set_tags(
    conn: &Connection,
    site_id: &str,
    room_id: &str,
    tag_ids: &[String],
) -> AppResult<()> {
    let encoded = encode_tag_ids(tag_ids)?;
    let n = conn
        .execute(
            "UPDATE follows SET tag_ids = ?1 WHERE site_id = ?2 AND room_id = ?3",
            params![encoded, site_id, room_id],
        )
        .map_err(map_db_err)?;
    if n == 0 {
        return Err(crate::error::AppError::new(
            "not_found",
            format!("follow {site_id}/{room_id} not found"),
        ));
    }
    Ok(())
}

pub fn set_auto_record(
    conn: &Connection,
    site_id: &str,
    room_id: &str,
    auto_record: bool,
) -> AppResult<()> {
    let n = conn
        .execute(
            "UPDATE follows SET auto_record = ?1 WHERE site_id = ?2 AND room_id = ?3",
            params![auto_record, site_id, room_id],
        )
        .map_err(map_db_err)?;
    if n == 0 {
        return Err(crate::error::AppError::new(
            "not_found",
            format!("follow {site_id}/{room_id} not found"),
        ));
    }
    Ok(())
}

pub fn list_tags(conn: &Connection) -> AppResult<Vec<TagRecord>> {
    let mut stmt = conn
        .prepare("SELECT id, name FROM tags ORDER BY name ASC")
        .map_err(map_db_err)?;
    let rows = stmt
        .query_map([], |row| {
            Ok(TagRecord {
                id: row.get(0)?,
                name: row.get(1)?,
            })
        })
        .map_err(map_db_err)?;

    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(map_db_err)?);
    }
    Ok(out)
}

pub fn upsert_tag(conn: &Connection, tag: TagRecord) -> AppResult<()> {
    conn.execute(
        "INSERT INTO tags (id, name) VALUES (?1, ?2)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name",
        params![tag.id, tag.name],
    )
    .map_err(map_db_err)?;
    Ok(())
}

pub fn remove_tag(conn: &mut Connection, id: &str) -> AppResult<()> {
    let transaction = conn.transaction().map_err(map_db_err)?;
    let mut follows = list(&transaction)?;
    for follow in &mut follows {
        if !follow.tag_ids.iter().any(|tag_id| tag_id == id) {
            continue;
        }
        follow.tag_ids.retain(|tag_id| tag_id != id);
        set_tags(
            &transaction,
            &follow.site_id,
            &follow.room_id,
            &follow.tag_ids,
        )?;
    }
    transaction
        .execute("DELETE FROM tags WHERE id = ?1", params![id])
        .map_err(map_db_err)?;
    transaction.commit().map_err(map_db_err)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::open_in_memory;

    fn follow(room_id: &str, auto_record: bool) -> FollowRecord {
        FollowRecord {
            site_id: "bilibili".into(),
            room_id: room_id.into(),
            user_name: format!("主播{room_id}"),
            face: "face".into(),
            tag_ids: vec!["keep".into()],
            auto_record,
            live_status: Some(0),
            live_started_at: None,
            updated_at: 1,
        }
    }

    fn status_update(room_id: &str) -> FollowLiveStatusUpdate {
        FollowLiveStatusUpdate {
            site_id: "bilibili".into(),
            room_id: room_id.into(),
            live_status: Some(1),
            live_started_at: Some(1_704_067_200_000),
            updated_at: 42,
        }
    }

    fn fetch(conn: &Connection, room_id: &str) -> Option<FollowRecord> {
        list(conn)
            .unwrap()
            .into_iter()
            .find(|record| record.room_id == room_id)
    }

    #[test]
    fn live_status_batch_writes_only_status_fields() {
        let mut conn = open_in_memory().unwrap();
        upsert(&conn, follow("1", false)).unwrap();

        let applied = apply_live_status_batch(&mut conn, &[status_update("1")]).unwrap();

        assert_eq!(applied, 1);
        let stored = fetch(&conn, "1").unwrap();
        assert_eq!(stored.live_status, Some(1));
        assert_eq!(stored.live_started_at, Some(1_704_067_200_000));
        assert_eq!(stored.updated_at, 42);
        // 刷新不拥有这些字段，不得因为一次状态写入而动它们。
        assert_eq!(stored.user_name, "主播1");
        assert_eq!(stored.face, "face");
        assert_eq!(stored.tag_ids, vec!["keep".to_string()]);
        assert!(!stored.auto_record);
    }

    #[test]
    fn live_status_batch_keeps_user_edits_made_during_the_network_wait() {
        let mut conn = open_in_memory().unwrap();
        upsert(&conn, follow("1", false)).unwrap();
        // 读取与写回之间用户改了标签和自动录制。
        set_tags(&conn, "bilibili", "1", &["changed".to_string()]).unwrap();
        set_auto_record(&conn, "bilibili", "1", true).unwrap();

        apply_live_status_batch(&mut conn, &[status_update("1")]).unwrap();

        let stored = fetch(&conn, "1").unwrap();
        assert_eq!(stored.tag_ids, vec!["changed".to_string()]);
        assert!(stored.auto_record);
        assert_eq!(stored.live_status, Some(1));
    }

    #[test]
    fn live_status_batch_never_resurrects_a_deleted_follow() {
        let mut conn = open_in_memory().unwrap();
        upsert(&conn, follow("1", false)).unwrap();
        upsert(&conn, follow("2", false)).unwrap();
        // 网络等待期间用户删掉了其中一个。
        remove(&conn, "bilibili", "1").unwrap();

        let applied =
            apply_live_status_batch(&mut conn, &[status_update("1"), status_update("2")]).unwrap();

        // 已删除的那条只是匹配不到行，不是错误，也不得被重新插入。
        assert_eq!(applied, 1);
        assert!(fetch(&conn, "1").is_none());
        assert_eq!(fetch(&conn, "2").unwrap().live_status, Some(1));
        assert_eq!(list(&conn).unwrap().len(), 1);
    }

    #[test]
    fn live_status_batch_is_atomic_and_tolerates_an_empty_round() {
        let mut conn = open_in_memory().unwrap();
        upsert(&conn, follow("1", false)).unwrap();

        assert_eq!(apply_live_status_batch(&mut conn, &[]).unwrap(), 0);
        assert_eq!(fetch(&conn, "1").unwrap().updated_at, 1);

        // 事务失败时整轮回滚：用一个不可写的连接验证没有部分写入。
        let mut readonly = open_in_memory().unwrap();
        upsert(&readonly, follow("1", false)).unwrap();
        readonly.pragma_update(None, "query_only", "ON").unwrap();
        let failure = apply_live_status_batch(&mut readonly, &[status_update("1")]);
        assert!(failure.is_err(), "不可写连接应该上报错误");
        readonly.pragma_update(None, "query_only", "OFF").unwrap();
        assert_eq!(fetch(&readonly, "1").unwrap().updated_at, 1);
    }

    #[test]
    fn auto_record_listing_is_filtered_by_sql_and_matches_the_in_memory_filter() {
        let conn = open_in_memory().unwrap();
        upsert(&conn, follow("1", true)).unwrap();
        upsert(&conn, follow("2", false)).unwrap();
        upsert(&conn, follow("3", true)).unwrap();

        let filtered = list_auto_record(&conn).unwrap();
        let expected: Vec<FollowRecord> = list(&conn)
            .unwrap()
            .into_iter()
            .filter(|record| record.auto_record)
            .collect();

        assert_eq!(filtered, expected);
        assert_eq!(filtered.len(), 2);
        assert!(filtered.iter().all(|record| record.auto_record));
    }

    #[test]
    fn upsert_and_list_follow() {
        let conn = open_in_memory().unwrap();
        upsert(
            &conn,
            FollowRecord {
                site_id: "bilibili".into(),
                room_id: "1".into(),
                user_name: "u".into(),
                face: "".into(),
                tag_ids: vec![],
                auto_record: false,
                live_status: None,
                live_started_at: None,
                updated_at: 1,
            },
        )
        .unwrap();
        let rows = list(&conn).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].room_id, "1");
    }

    /// 一轮刷新落库的规模测量，写真实文件库（WAL/NORMAL/busy timeout 同生产）。
    ///
    /// 默认 ignore：绝对耗时依赖机器与磁盘，不适合当断言。手动跑：
    /// `cargo test -p rlive follow_round_trip_scaling --lib -- --ignored --nocapture`
    #[test]
    #[ignore = "规模测量，手动跑"]
    fn follow_round_trip_scaling() {
        use std::time::Instant;

        for count in [100_usize, 1_000, 5_000] {
            let dir =
                std::env::temp_dir().join(format!("rlive-follow-scaling-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            let mut conn = crate::db::schema::Db::open(dir.join("follow.db")).unwrap();
            {
                let transaction = conn.transaction().unwrap();
                for index in 0..count {
                    upsert(&transaction, follow(&index.to_string(), false)).unwrap();
                }
                transaction.commit().unwrap();
            }
            let wal = dir.join("follow.db-wal");
            let wal_before = std::fs::metadata(&wal).map(|m| m.len()).unwrap_or(0);

            let updates: Vec<FollowLiveStatusUpdate> =
                (0..count).map(|i| status_update(&i.to_string())).collect();

            let read_at = Instant::now();
            let rows = list(&conn).unwrap();
            let read_ms = read_at.elapsed().as_secs_f64() * 1000.0;
            assert_eq!(rows.len(), count);

            let batch_at = Instant::now();
            let applied = apply_live_status_batch(&mut conn, &updates).unwrap();
            let batch_ms = batch_at.elapsed().as_secs_f64() * 1000.0;
            assert_eq!(applied, count);
            let wal_after = std::fs::metadata(&wal).map(|m| m.len()).unwrap_or(0);

            // 对照组：改造前的形态是每条一次整行 upsert、每条一次隐式提交。
            let legacy_at = Instant::now();
            for record in &rows {
                upsert(&conn, record.clone()).unwrap();
            }
            let legacy_ms = legacy_at.elapsed().as_secs_f64() * 1000.0;

            println!(
                "count={count} read={read_ms:.1}ms batch={batch_ms:.1}ms legacy={legacy_ms:.1}ms \
                 wal_delta={}KiB",
                (wal_after.saturating_sub(wal_before)) / 1024
            );
            drop(conn);
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[test]
    fn upsert_updates_existing_follow() {
        let conn = open_in_memory().unwrap();
        upsert(
            &conn,
            FollowRecord {
                site_id: "bilibili".into(),
                room_id: "1".into(),
                user_name: "old".into(),
                face: "".into(),
                tag_ids: vec![],
                auto_record: false,
                live_status: None,
                live_started_at: None,
                updated_at: 1,
            },
        )
        .unwrap();
        upsert(
            &conn,
            FollowRecord {
                site_id: "bilibili".into(),
                room_id: "1".into(),
                user_name: "new".into(),
                face: "f".into(),
                tag_ids: vec!["t1".into()],
                auto_record: true,
                live_status: Some(1),
                live_started_at: Some(1_704_067_200_000),
                updated_at: 2,
            },
        )
        .unwrap();
        let rows = list(&conn).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].user_name, "new");
        assert_eq!(rows[0].face, "f");
        assert_eq!(rows[0].tag_ids, vec!["t1".to_string()]);
        assert!(rows[0].auto_record);
        assert_eq!(rows[0].live_status, Some(1));
        assert_eq!(rows[0].live_started_at, Some(1_704_067_200_000));
        assert_eq!(rows[0].updated_at, 2);
    }

    #[test]
    fn remove_follow() {
        let conn = open_in_memory().unwrap();
        upsert(
            &conn,
            FollowRecord {
                site_id: "bilibili".into(),
                room_id: "1".into(),
                user_name: "u".into(),
                face: "".into(),
                tag_ids: vec![],
                auto_record: false,
                live_status: None,
                live_started_at: None,
                updated_at: 1,
            },
        )
        .unwrap();
        remove(&conn, "bilibili", "1").unwrap();
        assert!(list(&conn).unwrap().is_empty());
    }

    #[test]
    fn set_tags_and_list_tags() {
        let conn = open_in_memory().unwrap();
        upsert(
            &conn,
            FollowRecord {
                site_id: "bilibili".into(),
                room_id: "1".into(),
                user_name: "u".into(),
                face: "".into(),
                tag_ids: vec![],
                auto_record: false,
                live_status: None,
                live_started_at: None,
                updated_at: 1,
            },
        )
        .unwrap();
        upsert_tag(
            &conn,
            TagRecord {
                id: "t1".into(),
                name: "Favorites".into(),
            },
        )
        .unwrap();
        set_tags(&conn, "bilibili", "1", &["t1".into()]).unwrap();
        let follow = list(&conn)
            .unwrap()
            .into_iter()
            .find(|follow| follow.site_id == "bilibili" && follow.room_id == "1")
            .expect("follow must be listed");
        assert_eq!(follow.tag_ids, vec!["t1".to_string()]);
        let tags = list_tags(&conn).unwrap();
        assert_eq!(tags.len(), 1);
        assert_eq!(tags[0].name, "Favorites");
    }

    #[test]
    fn set_and_list_auto_record_follows() {
        let conn = open_in_memory().unwrap();
        upsert(
            &conn,
            FollowRecord {
                site_id: "bilibili".into(),
                room_id: "1".into(),
                user_name: "u".into(),
                face: "".into(),
                tag_ids: vec![],
                auto_record: false,
                live_status: None,
                live_started_at: None,
                updated_at: 1,
            },
        )
        .unwrap();

        set_auto_record(&conn, "bilibili", "1", true).unwrap();

        let rows = list_auto_record(&conn).unwrap();
        assert_eq!(rows.len(), 1);
        assert!(rows[0].auto_record);
        set_auto_record(&conn, "bilibili", "1", false).unwrap();
        assert!(list_auto_record(&conn).unwrap().is_empty());
    }

    #[test]
    fn remove_tag_clears_follow_references() {
        let mut conn = open_in_memory().unwrap();
        upsert_tag(
            &conn,
            TagRecord {
                id: "t1".into(),
                name: "Favorites".into(),
            },
        )
        .unwrap();
        upsert(
            &conn,
            FollowRecord {
                site_id: "bilibili".into(),
                room_id: "1".into(),
                user_name: "u".into(),
                face: "".into(),
                tag_ids: vec!["t1".into()],
                auto_record: false,
                live_status: None,
                live_started_at: None,
                updated_at: 1,
            },
        )
        .unwrap();

        remove_tag(&mut conn, "t1").unwrap();

        assert!(list_tags(&conn).unwrap().is_empty());
        assert!(list(&conn).unwrap()[0].tag_ids.is_empty());
    }
}
