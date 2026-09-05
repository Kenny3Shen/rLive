//! 本地录制回放的观看进度（断点续播）。
//!
//! 进度刻意不写进录制包自己的 `metadata.json`：那是录制器的产物，有独立的
//! 原子写入与崩溃恢复路径（`METADATA_IO_LOCK` + tmp/bak 换名恢复），回放状态
//! 只是读者侧的附属信息，不该去和录制器争同一把锁——否则回放期间每次上报都
//! 可能排队在录制收尾的元数据落盘后面，甚至混进同一套恢复语义里。
//! 与 `db::video_history` 也分开一张表：本地录像不参与 B 站作品去重，主键是
//! 录制 id 而非 `(kind, oid)`，混用只会让两边的主键互相迁就，还会让本地录制
//! 的进度去挤占观看历史的保留名额。

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::db::schema::map_db_err;
use crate::error::AppResult;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RecordingWatchProgress {
    /// 录制 id，即 `RecordingItem.id`（相对存储根的两级路径）。
    pub id: String,
    /// 已观看位置，秒。
    pub progress: f64,
    /// 录制总时长，秒；未知为 0。
    pub duration: f64,
    /// 最后观看时间，Unix 毫秒。
    pub watched_at: i64,
}

fn map_recording_watch_progress(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<RecordingWatchProgress> {
    Ok(RecordingWatchProgress {
        id: row.get(0)?,
        progress: row.get(1)?,
        duration: row.get(2)?,
        watched_at: row.get(3)?,
    })
}

/// 全量列出各录制的观看进度。刻意不加 LIMIT：录制列表页要一次拿到全部录制的
/// 进度来画卡片上的续播状态；行数由修剪触发器封顶在
/// `RECORDING_WATCH_PROGRESS_RETENTION_LIMIT`，不会无限增长。
pub fn list(conn: &Connection) -> AppResult<Vec<RecordingWatchProgress>> {
    let mut stmt = conn
        .prepare(
            "SELECT id, progress, duration, watched_at
             FROM recording_watch_progress
             ORDER BY watched_at DESC, id ASC",
        )
        .map_err(map_db_err)?;
    let rows = stmt
        .query_map([], map_recording_watch_progress)
        .map_err(map_db_err)?;

    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(map_db_err)?);
    }
    Ok(out)
}

/// 查单个录制的观看进度。回放页进入时用它决定跳回的位置；从未看过返回 `None`。
pub fn find(conn: &Connection, id: &str) -> AppResult<Option<RecordingWatchProgress>> {
    conn.query_row(
        "SELECT id, progress, duration, watched_at
         FROM recording_watch_progress
         WHERE id = ?1",
        params![id],
        map_recording_watch_progress,
    )
    .optional()
    .map_err(map_db_err)
}

/// 写入一次观看上报，按录制 id 就地更新。
pub fn upsert(conn: &Connection, record: RecordingWatchProgress) -> AppResult<()> {
    conn.execute(
        "INSERT INTO recording_watch_progress (id, progress, duration, watched_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(id) DO UPDATE SET
           -- 进度直接覆盖，刻意不取 MAX：用户拖回去重看前面的内容时，
           -- 续播位置必须跟着回退，否则「继续播放」会跳到他已经离开的地方。
           progress = excluded.progress,
           -- 时长未知（0）的上报不得抹掉已经拿到的真实时长，
           -- 否则列表卡片上的进度条会失去分母。
           duration = CASE
             WHEN excluded.duration > 0 THEN excluded.duration
             ELSE recording_watch_progress.duration
           END,
           -- 时钟回拨时不让续播列表的顺序往前跳。
           watched_at = MAX(recording_watch_progress.watched_at, excluded.watched_at)",
        params![
            record.id,
            record.progress,
            record.duration,
            record.watched_at,
        ],
    )
    .map_err(map_db_err)?;
    Ok(())
}

/// 删除单个录制的观看进度。`recording_delete` 删掉录像后调它清掉对应行，
/// 不让已不存在的录制在列表页留下续播残影。
pub fn remove(conn: &Connection, id: &str) -> AppResult<()> {
    conn.execute(
        "DELETE FROM recording_watch_progress WHERE id = ?1",
        params![id],
    )
    .map_err(map_db_err)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::{RECORDING_WATCH_PROGRESS_RETENTION_LIMIT, open_in_memory};

    fn record(id: &str, watched_at: i64) -> RecordingWatchProgress {
        RecordingWatchProgress {
            id: id.into(),
            progress: 10.0,
            duration: 100.0,
            watched_at,
        }
    }

    #[test]
    fn upsert_find_list_and_remove_roundtrip() {
        let conn = open_in_memory().unwrap();
        upsert(&conn, record("bilibili_10001/user_1700000000", 10)).unwrap();
        upsert(&conn, record("douyu_2/user_1800000000", 20)).unwrap();

        let rows = list(&conn).unwrap();
        assert_eq!(rows.len(), 2);
        // 倒序：较新的 douyu 在前。
        assert_eq!(rows[0].id, "douyu_2/user_1800000000");
        assert_eq!(rows[1].id, "bilibili_10001/user_1700000000");

        assert_eq!(
            find(&conn, "bilibili_10001/user_1700000000")
                .unwrap()
                .unwrap()
                .watched_at,
            10
        );
        assert!(find(&conn, "huya_3/user_404").unwrap().is_none());

        remove(&conn, "bilibili_10001/user_1700000000").unwrap();
        let rows = list(&conn).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "douyu_2/user_1800000000");
    }

    #[test]
    fn rewinding_overwrites_the_saved_position() {
        let conn = open_in_memory().unwrap();
        let mut item = record("bilibili_10001/user_1700000000", 20);
        item.progress = 600.0;
        upsert(&conn, item.clone()).unwrap();

        // 拖回前面重看：续播位置必须跟着回退。
        item.progress = 120.0;
        upsert(&conn, item).unwrap();

        let rows = list(&conn).unwrap();
        assert_eq!(rows.len(), 1, "同一录制必须就地更新而不是新增一行");
        assert_eq!(rows[0].progress, 120.0);
    }

    #[test]
    fn reporting_without_duration_keeps_the_known_duration() {
        let conn = open_in_memory().unwrap();
        upsert(&conn, record("bilibili_10001/user_1700000000", 10)).unwrap();

        let mut heartbeat = record("bilibili_10001/user_1700000000", 20);
        heartbeat.duration = 0.0;
        heartbeat.progress = 66.0;
        upsert(&conn, heartbeat).unwrap();

        let stored = find(&conn, "bilibili_10001/user_1700000000")
            .unwrap()
            .unwrap();
        assert_eq!(stored.duration, 100.0);
        assert_eq!(stored.progress, 66.0);
    }

    #[test]
    fn progress_rows_stay_within_the_storage_limit() {
        let conn = open_in_memory().unwrap();
        for index in 0..=(RECORDING_WATCH_PROGRESS_RETENTION_LIMIT + 4) {
            upsert(&conn, record(&format!("room_{index:05}"), index)).unwrap();
        }

        // 上限 + 5 行插入后，触发器把最旧的 5 行修剪掉了。
        assert_eq!(
            list(&conn).unwrap().len() as i64,
            RECORDING_WATCH_PROGRESS_RETENTION_LIMIT
        );
        assert!(find(&conn, "room_00000").unwrap().is_none());
        assert!(find(&conn, "room_00004").unwrap().is_none());
        // 边界：第 6 旧的那行开始保留，最新的当然也在。
        assert!(find(&conn, "room_00005").unwrap().is_some());
        assert!(
            find(
                &conn,
                &format!("room_{:05}", RECORDING_WATCH_PROGRESS_RETENTION_LIMIT + 4)
            )
            .unwrap()
            .is_some()
        );
    }
}
