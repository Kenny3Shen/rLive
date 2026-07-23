use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::db::schema::map_db_err;
use crate::error::AppResult;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FollowRecord {
    pub site_id: String,
    pub room_id: String,
    pub user_name: String,
    pub face: String,
    pub tag_ids: Vec<String>,
    pub live_status: Option<i32>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TagRecord {
    pub id: String,
    pub name: String,
}

fn encode_tag_ids(tag_ids: &[String]) -> AppResult<String> {
    serde_json::to_string(tag_ids).map_err(|e| {
        crate::error::AppError::new("db_encode_error", format!("tag_ids: {e}"))
    })
}

fn decode_tag_ids(raw: &str) -> AppResult<Vec<String>> {
    if raw.trim().is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str(raw).map_err(|e| {
        crate::error::AppError::new("db_decode_error", format!("tag_ids: {e}"))
    })
}

pub fn list(conn: &Connection) -> AppResult<Vec<FollowRecord>> {
    let mut stmt = conn
        .prepare(
            "SELECT site_id, room_id, user_name, face, tag_ids, live_status, updated_at
             FROM follows
             ORDER BY updated_at DESC",
        )
        .map_err(map_db_err)?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, Option<i32>>(5)?,
                row.get::<_, i64>(6)?,
            ))
        })
        .map_err(map_db_err)?;

    let mut out = Vec::new();
    for row in rows {
        let (site_id, room_id, user_name, face, tag_ids_raw, live_status, updated_at) =
            row.map_err(map_db_err)?;
        out.push(FollowRecord {
            site_id,
            room_id,
            user_name,
            face,
            tag_ids: decode_tag_ids(&tag_ids_raw)?,
            live_status,
            updated_at,
        });
    }
    Ok(out)
}

pub fn upsert(conn: &Connection, record: FollowRecord) -> AppResult<()> {
    let tag_ids = encode_tag_ids(&record.tag_ids)?;
    conn.execute(
        "INSERT INTO follows (site_id, room_id, user_name, face, tag_ids, live_status, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(site_id, room_id) DO UPDATE SET
           user_name = excluded.user_name,
           face = excluded.face,
           tag_ids = excluded.tag_ids,
           live_status = excluded.live_status,
           updated_at = excluded.updated_at",
        params![
            record.site_id,
            record.room_id,
            record.user_name,
            record.face,
            tag_ids,
            record.live_status,
            record.updated_at,
        ],
    )
    .map_err(map_db_err)?;
    Ok(())
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

pub fn get(conn: &Connection, site_id: &str, room_id: &str) -> AppResult<Option<FollowRecord>> {
    let mut stmt = conn
        .prepare(
            "SELECT site_id, room_id, user_name, face, tag_ids, live_status, updated_at
             FROM follows WHERE site_id = ?1 AND room_id = ?2",
        )
        .map_err(map_db_err)?;
    let row = stmt
        .query_row(params![site_id, room_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, Option<i32>>(5)?,
                row.get::<_, i64>(6)?,
            ))
        })
        .optional()
        .map_err(map_db_err)?;

    match row {
        None => Ok(None),
        Some((site_id, room_id, user_name, face, tag_ids_raw, live_status, updated_at)) => {
            Ok(Some(FollowRecord {
                site_id,
                room_id,
                user_name,
                face,
                tag_ids: decode_tag_ids(&tag_ids_raw)?,
                live_status,
                updated_at,
            }))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::open_in_memory;

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
                live_status: None,
                updated_at: 1,
            },
        )
        .unwrap();
        let rows = list(&conn).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].room_id, "1");
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
                live_status: None,
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
                live_status: Some(1),
                updated_at: 2,
            },
        )
        .unwrap();
        let rows = list(&conn).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].user_name, "new");
        assert_eq!(rows[0].face, "f");
        assert_eq!(rows[0].tag_ids, vec!["t1".to_string()]);
        assert_eq!(rows[0].live_status, Some(1));
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
                live_status: None,
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
                live_status: None,
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
        let follow = get(&conn, "bilibili", "1").unwrap().unwrap();
        assert_eq!(follow.tag_ids, vec!["t1".to_string()]);
        let tags = list_tags(&conn).unwrap();
        assert_eq!(tags.len(), 1);
        assert_eq!(tags[0].name, "Favorites");
    }
}
