//! B 站视频的观看历史。
//!
//! 与直播历史（`db::history`）并列，但去重维度不同：这里**按作品去重**，
//! 主键是 `(kind, oid)`——UGC 用 bvid、PGC 用 season_id。同一部番剧看了二十集
//! 只占一行，行内记录「最后看到哪一集、看到第几秒」，续播直接读这一行。
//! 若按分集去重，历史列表会被单个长番剧淹没，这不是用户想要的。

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::db::schema::map_db_err;
use crate::error::AppResult;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct VideoHistoryRecord {
    /// 作品类型：`ugc`（普通稿件）或 `pgc`（番剧/影视）。
    pub kind: String,
    /// 作品标识：UGC 为 bvid，PGC 为 season_id。与 `kind` 共同构成主键。
    pub oid: String,
    /// 作品标题（不含分集名）。
    pub title: String,
    /// 作品封面。
    pub cover: String,
    /// UGC 的 UP 主名；PGC 没有单一作者，为空。
    pub author: String,
    /// 最后观看的分 P / 分集标题。单 P 稿件为空。
    pub part_title: String,
    /// 续播用：最后观看分集所属的 bvid（PGC 的每一集也有 bvid）。
    pub bvid: String,
    /// 续播用：取流键 cid。
    pub cid: i64,
    /// 续播用：PGC 的 ep_id；UGC 为空。
    pub ep_id: String,
    /// 评论区的 oid（aid）。取不到时为空。
    pub aid: String,
    /// 该分集已观看到的秒数。
    pub progress: f64,
    /// 该分集总时长秒数。上游未给出时为 0。
    pub duration: f64,
    /// 最后观看时间，Unix 毫秒。
    pub watched_at: i64,
}

const LIST_LIMIT: i64 = 200;

fn map_video_history_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<VideoHistoryRecord> {
    Ok(VideoHistoryRecord {
        kind: row.get(0)?,
        oid: row.get(1)?,
        title: row.get(2)?,
        cover: row.get(3)?,
        author: row.get(4)?,
        part_title: row.get(5)?,
        bvid: row.get(6)?,
        cid: row.get(7)?,
        ep_id: row.get(8)?,
        aid: row.get(9)?,
        progress: row.get(10)?,
        duration: row.get(11)?,
        watched_at: row.get(12)?,
    })
}

pub fn list(conn: &Connection) -> AppResult<Vec<VideoHistoryRecord>> {
    let mut stmt = conn
        .prepare(
            "SELECT kind, oid, title, cover, author, part_title, bvid, cid, ep_id, aid,
                    progress, duration, watched_at
             FROM video_history
             ORDER BY watched_at DESC, kind ASC, oid ASC
             LIMIT ?1",
        )
        .map_err(map_db_err)?;
    let rows = stmt
        .query_map(params![LIST_LIMIT], map_video_history_record)
        .map_err(map_db_err)?;

    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(map_db_err)?);
    }
    Ok(out)
}

/// 查单个作品的观看记录。播放页进入时用它决定是否提示续播；从未看过返回 `None`。
pub fn find(conn: &Connection, kind: &str, oid: &str) -> AppResult<Option<VideoHistoryRecord>> {
    conn.query_row(
        "SELECT kind, oid, title, cover, author, part_title, bvid, cid, ep_id, aid,
                progress, duration, watched_at
         FROM video_history
         WHERE kind = ?1 AND oid = ?2",
        params![kind, oid],
        map_video_history_record,
    )
    .optional()
    .map_err(map_db_err)
}

/// 写入一次观看上报，按 `(kind, oid)` 就地更新。
pub fn upsert(conn: &Connection, record: VideoHistoryRecord) -> AppResult<()> {
    conn.execute(
        "INSERT INTO video_history (
           kind, oid, title, cover, author, part_title, bvid, cid, ep_id, aid,
           progress, duration, watched_at
         )
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
         ON CONFLICT(kind, oid) DO UPDATE SET
           -- 进度直接覆盖，刻意不取 MAX：用户拖回去重看前面的内容时，
           -- 续播位置必须跟着回退，否则「继续播放」会跳到他已经离开的地方。
           progress = excluded.progress,
           -- 时长未知（0）的上报不得抹掉已经拿到的真实时长，
           -- 否则历史列表的进度条会失去分母。
           duration = CASE
             WHEN excluded.duration > 0 THEN excluded.duration
             ELSE video_history.duration
           END,
           -- 心跳式上报可能只带进度不带元数据，空标题不能覆盖已记录的标题。
           title = CASE WHEN excluded.title = '' THEN video_history.title ELSE excluded.title END,
           -- 封面同理：某些接口路径不返回封面，别把已有封面清成空。
           cover = CASE WHEN excluded.cover = '' THEN video_history.cover ELSE excluded.cover END,
           -- 下面这组描述「最后看的是哪一集」，换集时必须整组一起更新，
           -- 因此一律取 excluded：part_title 从有值变空是合法的（同一 oid 内
           -- 不会发生多 P 变单 P，而 UGC/PGC 语义上属于不同 oid，无需保护）。
           author = excluded.author,
           part_title = excluded.part_title,
           bvid = excluded.bvid,
           ep_id = excluded.ep_id,
           aid = excluded.aid,
           cid = excluded.cid,
           -- 时钟回拨时不让历史顺序往前跳。
           watched_at = MAX(video_history.watched_at, excluded.watched_at)",
        params![
            record.kind,
            record.oid,
            record.title,
            record.cover,
            record.author,
            record.part_title,
            record.bvid,
            record.cid,
            record.ep_id,
            record.aid,
            record.progress,
            record.duration,
            record.watched_at,
        ],
    )
    .map_err(map_db_err)?;
    Ok(())
}

/// 删除单个作品的观看记录。历史按作品唯一，因此不需要时间戳参与定位。
pub fn remove(conn: &Connection, kind: &str, oid: &str) -> AppResult<()> {
    conn.execute(
        "DELETE FROM video_history WHERE kind = ?1 AND oid = ?2",
        params![kind, oid],
    )
    .map_err(map_db_err)?;
    Ok(())
}

pub fn clear(conn: &Connection) -> AppResult<()> {
    conn.execute("DELETE FROM video_history", [])
        .map_err(map_db_err)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::{VIDEO_HISTORY_RETENTION_LIMIT, open_in_memory};

    fn record(kind: &str, oid: &str, watched_at: i64) -> VideoHistoryRecord {
        VideoHistoryRecord {
            kind: kind.into(),
            oid: oid.into(),
            title: format!("title-{oid}"),
            cover: format!("https://example.com/{oid}.jpg"),
            author: "UP 主".into(),
            part_title: String::new(),
            bvid: oid.into(),
            cid: 1,
            ep_id: String::new(),
            aid: "42".into(),
            progress: 10.0,
            duration: 100.0,
            watched_at,
        }
    }

    #[test]
    fn upsert_list_find_and_remove_roundtrip() {
        let conn = open_in_memory().unwrap();
        upsert(&conn, record("ugc", "BV1", 10)).unwrap();
        upsert(&conn, record("pgc", "BV1", 20)).unwrap();

        let rows = list(&conn).unwrap();
        assert_eq!(rows.len(), 2);
        // 倒序：较新的 pgc 在前。
        assert_eq!(rows[0].kind, "pgc");
        assert_eq!(rows[1].kind, "ugc");

        // 同 oid 不同 kind 是两条独立记录，不得互相干扰。
        assert_eq!(find(&conn, "ugc", "BV1").unwrap().unwrap().watched_at, 10);
        assert_eq!(find(&conn, "pgc", "BV1").unwrap().unwrap().watched_at, 20);
        assert!(find(&conn, "ugc", "BV404").unwrap().is_none());

        remove(&conn, "ugc", "BV1").unwrap();
        let rows = list(&conn).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].kind, "pgc");

        clear(&conn).unwrap();
        assert!(list(&conn).unwrap().is_empty());
    }

    #[test]
    fn revisiting_a_work_updates_progress_and_part_in_place() {
        let conn = open_in_memory().unwrap();
        let mut item = record("pgc", "ss1", 100);
        item.progress = 500.0;
        item.cid = 111;
        item.part_title = "第 5 话".into();
        upsert(&conn, item.clone()).unwrap();

        // 回看前面的分集：进度变小、分集换了，时间戳还比上一次早。
        item.progress = 30.0;
        item.cid = 222;
        item.part_title = "第 1 话".into();
        item.watched_at = 90;
        upsert(&conn, item).unwrap();

        let rows = list(&conn).unwrap();
        assert_eq!(rows.len(), 1, "同一作品必须就地更新而不是新增一行");
        assert_eq!(rows[0].progress, 30.0, "进度必须能回退");
        assert_eq!(rows[0].cid, 222);
        assert_eq!(rows[0].part_title, "第 1 话");
        assert_eq!(rows[0].watched_at, 100, "时钟回拨不该让历史往前跳");
    }

    #[test]
    fn reporting_without_metadata_keeps_the_recorded_title_and_cover() {
        let conn = open_in_memory().unwrap();
        upsert(&conn, record("ugc", "BV1", 10)).unwrap();

        let mut heartbeat = record("ugc", "BV1", 20);
        heartbeat.title = String::new();
        heartbeat.cover = String::new();
        heartbeat.duration = 0.0;
        heartbeat.progress = 66.0;
        upsert(&conn, heartbeat).unwrap();

        let stored = find(&conn, "ugc", "BV1").unwrap().unwrap();
        assert_eq!(stored.title, "title-BV1");
        assert_eq!(stored.cover, "https://example.com/BV1.jpg");
        assert_eq!(stored.duration, 100.0);
        assert_eq!(stored.progress, 66.0);
    }

    #[test]
    fn history_stays_within_the_storage_limit() {
        let conn = open_in_memory().unwrap();
        for index in 0..=VIDEO_HISTORY_RETENTION_LIMIT {
            upsert(&conn, record("ugc", &format!("BV{index:05}"), index)).unwrap();
        }

        let count: i64 = conn
            .query_row("SELECT count(*) FROM video_history", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, VIDEO_HISTORY_RETENTION_LIMIT);
        // 修剪掉的是最旧的那条，最新的必须留着。
        assert!(find(&conn, "ugc", "BV00000").unwrap().is_none());
        assert!(
            find(
                &conn,
                "ugc",
                &format!("BV{VIDEO_HISTORY_RETENTION_LIMIT:05}")
            )
            .unwrap()
            .is_some()
        );
    }
}
