use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};

use crate::db::schema::map_db_err;
use crate::error::{AppError, AppResult};

pub const BILIBILI_SITE_ID: &str = "bilibili";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct VideoFollowRecord {
    pub site_id: String,
    pub mid: String,
    pub name: String,
    /// 上游没有公开头像时为 None；数据库继续用空字符串表示缺失。
    #[serde(default)]
    pub face: Option<String>,
    pub group_id: Option<String>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct VideoFollowGroupRecord {
    pub id: String,
    pub name: String,
}

/// B 站 UID 以十进制正整数传输；去掉首尾空白和前导零后再作为本地主键。
pub fn normalize_mid(raw: &str) -> AppResult<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty()
        || !trimmed.bytes().all(|byte| byte.is_ascii_digit())
        || trimmed.bytes().all(|byte| byte == b'0')
    {
        return Err(AppError::new(
            "invalid_video_follow",
            "UP 主 UID 必须是正整数",
        ));
    }
    let normalized = trimmed.trim_start_matches('0');
    if normalized.len() > 32 {
        return Err(AppError::new("invalid_video_follow", "UP 主 UID 过长"));
    }
    Ok(normalized.to_owned())
}

pub fn normalize_group_id(raw: Option<&str>) -> Option<String> {
    raw.map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

pub fn normalize_record(mut record: VideoFollowRecord) -> AppResult<VideoFollowRecord> {
    if record.site_id.trim() != BILIBILI_SITE_ID {
        return Err(AppError::new(
            "invalid_video_follow",
            "视频关注目前仅支持 B 站",
        ));
    }
    record.site_id = BILIBILI_SITE_ID.to_owned();
    record.mid = normalize_mid(&record.mid)?;
    record.name = record.name.trim().to_owned();
    record.face = record
        .face
        .map(|face| face.trim().to_owned())
        .filter(|face| !face.is_empty());
    record.group_id = normalize_group_id(record.group_id.as_deref());

    if record.name.is_empty() {
        return Err(AppError::new("invalid_video_follow", "UP 主名称不能为空"));
    }
    if record.name.chars().count() > 128 {
        return Err(AppError::new(
            "invalid_video_follow",
            "UP 主名称不能超过 128 个字符",
        ));
    }
    if record
        .face
        .as_deref()
        .is_some_and(|face| face.chars().count() > 2_048)
    {
        return Err(AppError::new("invalid_video_follow", "UP 主头像地址过长"));
    }
    if record
        .group_id
        .as_deref()
        .is_some_and(|id| id.chars().count() > 64)
    {
        return Err(AppError::new(
            "invalid_video_follow",
            "视频关注分组标识过长",
        ));
    }
    if record.updated_at < 0 {
        return Err(AppError::new(
            "invalid_video_follow",
            "视频关注更新时间无效",
        ));
    }
    if record.updated_at == 0 {
        record.updated_at = chrono::Utc::now().timestamp_millis();
    }
    Ok(record)
}

pub fn normalize_group(mut group: VideoFollowGroupRecord) -> AppResult<VideoFollowGroupRecord> {
    group.id = group.id.trim().to_owned();
    group.name = group.name.trim().to_owned();
    if group.id.is_empty() || group.id.chars().count() > 64 {
        return Err(AppError::new(
            "invalid_video_follow_group",
            "视频关注分组标识无效",
        ));
    }
    if group.name.is_empty() {
        return Err(AppError::new(
            "invalid_video_follow_group",
            "视频关注分组名称不能为空",
        ));
    }
    if group.name.chars().count() > 32 {
        return Err(AppError::new(
            "invalid_video_follow_group",
            "视频关注分组名称不能超过 32 个字符",
        ));
    }
    Ok(group)
}

pub fn group_exists(conn: &Connection, id: &str) -> AppResult<bool> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM video_follow_groups WHERE id = ?1)",
        [id],
        |row| row.get::<_, bool>(0),
    )
    .map_err(map_db_err)
}

pub fn list(conn: &Connection) -> AppResult<Vec<VideoFollowRecord>> {
    let mut stmt = conn
        .prepare(
            "SELECT site_id, mid, name, face, group_id, updated_at
             FROM video_follows
             ORDER BY updated_at DESC, mid ASC",
        )
        .map_err(map_db_err)?;
    let rows = stmt
        .query_map([], |row| {
            Ok(VideoFollowRecord {
                site_id: row.get(0)?,
                mid: row.get(1)?,
                name: row.get(2)?,
                face: normalize_group_id(Some(row.get::<_, String>(3)?.as_str())),
                group_id: row.get(4)?,
                updated_at: row.get(5)?,
            })
        })
        .map_err(map_db_err)?;

    let mut follows = Vec::new();
    for row in rows {
        follows.push(row.map_err(map_db_err)?);
    }
    Ok(follows)
}

pub fn upsert(conn: &Connection, record: VideoFollowRecord) -> AppResult<VideoFollowRecord> {
    let record = normalize_record(record)?;
    if let Some(group_id) = record.group_id.as_deref()
        && !group_exists(conn, group_id)?
    {
        return Err(AppError::new("not_found", "视频关注分组不存在"));
    }

    conn.execute(
        "INSERT INTO video_follows (site_id, mid, name, face, group_id, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(site_id, mid) DO UPDATE SET
           name = excluded.name,
           face = excluded.face,
           group_id = excluded.group_id,
           updated_at = excluded.updated_at",
        params![
            record.site_id,
            record.mid,
            record.name,
            record.face.as_deref().unwrap_or(""),
            record.group_id,
            record.updated_at,
        ],
    )
    .map_err(map_db_err)?;
    Ok(record)
}

pub fn remove(conn: &Connection, site_id: &str, mid: &str) -> AppResult<()> {
    let site_id = site_id.trim();
    if site_id != BILIBILI_SITE_ID {
        return Err(AppError::new(
            "invalid_video_follow",
            "视频关注目前仅支持 B 站",
        ));
    }
    let mid = normalize_mid(mid)?;
    conn.execute(
        "DELETE FROM video_follows WHERE site_id = ?1 AND mid = ?2",
        params![site_id, mid],
    )
    .map_err(map_db_err)?;
    Ok(())
}

pub fn set_group(
    conn: &Connection,
    site_id: &str,
    mid: &str,
    group_id: Option<&str>,
) -> AppResult<()> {
    let site_id = site_id.trim();
    if site_id != BILIBILI_SITE_ID {
        return Err(AppError::new(
            "invalid_video_follow",
            "视频关注目前仅支持 B 站",
        ));
    }
    let mid = normalize_mid(mid)?;
    let group_id = normalize_group_id(group_id);
    if let Some(group_id) = group_id.as_deref()
        && !group_exists(conn, group_id)?
    {
        return Err(AppError::new("not_found", "视频关注分组不存在"));
    }

    let updated = conn
        .execute(
            "UPDATE video_follows SET group_id = ?1 WHERE site_id = ?2 AND mid = ?3",
            params![group_id, site_id, mid],
        )
        .map_err(map_db_err)?;
    if updated == 0 {
        return Err(AppError::new("not_found", "视频关注不存在"));
    }
    Ok(())
}

pub fn list_groups(conn: &Connection) -> AppResult<Vec<VideoFollowGroupRecord>> {
    let mut stmt = conn
        .prepare("SELECT id, name FROM video_follow_groups ORDER BY name ASC, id ASC")
        .map_err(map_db_err)?;
    let rows = stmt
        .query_map([], |row| {
            Ok(VideoFollowGroupRecord {
                id: row.get(0)?,
                name: row.get(1)?,
            })
        })
        .map_err(map_db_err)?;

    let mut groups = Vec::new();
    for row in rows {
        groups.push(row.map_err(map_db_err)?);
    }
    Ok(groups)
}

pub fn upsert_group(
    conn: &Connection,
    group: VideoFollowGroupRecord,
) -> AppResult<VideoFollowGroupRecord> {
    let group = normalize_group(group)?;
    conn.execute(
        "INSERT INTO video_follow_groups (id, name) VALUES (?1, ?2)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name",
        params![group.id, group.name],
    )
    .map_err(map_db_err)?;
    Ok(group)
}

pub fn remove_group(conn: &mut Connection, id: &str) -> AppResult<()> {
    let transaction = conn.transaction().map_err(map_db_err)?;
    transaction
        .execute(
            "UPDATE video_follows SET group_id = NULL WHERE group_id = ?1",
            [id],
        )
        .map_err(map_db_err)?;
    transaction
        .execute("DELETE FROM video_follow_groups WHERE id = ?1", [id])
        .map_err(map_db_err)?;
    transaction.commit().map_err(map_db_err)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::open_in_memory;

    fn follow(mid: &str, group_id: Option<&str>) -> VideoFollowRecord {
        VideoFollowRecord {
            site_id: BILIBILI_SITE_ID.into(),
            mid: mid.into(),
            name: "测试 UP".into(),
            face: Some("https://example.test/face.jpg".into()),
            group_id: group_id.map(str::to_owned),
            updated_at: 10,
        }
    }

    #[test]
    fn normalizes_mid_and_rejects_non_positive_values() {
        assert_eq!(normalize_mid(" 000123 ").unwrap(), "123");
        for invalid in [
            "",
            "0",
            "000",
            "-1",
            "+1",
            "12a",
            "123456789012345678901234567890123",
        ] {
            assert_eq!(
                normalize_mid(invalid).unwrap_err().code,
                "invalid_video_follow",
                "{invalid}"
            );
        }
    }

    #[test]
    fn upsert_round_trips_snapshot_and_deduplicates_by_normalized_mid() {
        let conn = open_in_memory().unwrap();
        let first = upsert(&conn, follow("00042", None)).unwrap();
        assert_eq!(first.mid, "42");

        let mut refreshed = follow("42", None);
        refreshed.name = "更新后的 UP".into();
        refreshed.face = Some("https://example.test/new.jpg".into());
        refreshed.updated_at = 20;
        upsert(&conn, refreshed).unwrap();

        let follows = list(&conn).unwrap();
        assert_eq!(follows.len(), 1);
        assert_eq!(follows[0].mid, "42");
        assert_eq!(follows[0].name, "更新后的 UP");
        assert_eq!(
            follows[0].face.as_deref(),
            Some("https://example.test/new.jpg")
        );
    }

    #[test]
    fn empty_or_missing_avatar_round_trips_as_none() {
        let conn = open_in_memory().unwrap();
        let mut missing = follow("42", None);
        missing.face = None;
        upsert(&conn, missing).unwrap();

        let mut blank = follow("43", None);
        blank.face = Some("   ".into());
        upsert(&conn, blank).unwrap();

        let follows = list(&conn).unwrap();
        assert!(follows.iter().all(|follow| follow.face.is_none()));
    }

    #[test]
    fn groups_round_trip_and_removal_moves_uploads_to_ungrouped() {
        let mut conn = open_in_memory().unwrap();
        upsert_group(
            &conn,
            VideoFollowGroupRecord {
                id: "g1".into(),
                name: "科技".into(),
            },
        )
        .unwrap();
        upsert(&conn, follow("42", Some("g1"))).unwrap();
        assert_eq!(list_groups(&conn).unwrap()[0].name, "科技");
        assert_eq!(list(&conn).unwrap()[0].group_id.as_deref(), Some("g1"));

        remove_group(&mut conn, "g1").unwrap();
        assert!(list_groups(&conn).unwrap().is_empty());
        assert_eq!(list(&conn).unwrap()[0].group_id, None);
    }

    #[test]
    fn unknown_group_is_rejected_for_follow_and_group_assignment() {
        let conn = open_in_memory().unwrap();
        assert_eq!(
            upsert(&conn, follow("42", Some("missing")))
                .unwrap_err()
                .code,
            "not_found"
        );
        upsert(&conn, follow("42", None)).unwrap();
        assert_eq!(
            set_group(&conn, BILIBILI_SITE_ID, "42", Some("missing"))
                .unwrap_err()
                .code,
            "not_found"
        );
        assert_eq!(
            set_group(&conn, BILIBILI_SITE_ID, "99", None)
                .unwrap_err()
                .code,
            "not_found"
        );
    }
}
