use std::collections::HashMap;

use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};

use crate::db::schema::map_db_err;
use crate::error::{AppError, AppResult};
use crate::models::live::PlaybackProtocol;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct IptvFavoriteRecord {
    pub source_id: String,
    pub id: String,
    pub name: String,
    pub group: String,
    pub favorite_group_id: Option<String>,
    pub logo: Option<String>,
    pub url: String,
    pub protocol: Option<PlaybackProtocol>,
    pub headers: HashMap<String, String>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct IptvFavoriteGroupRecord {
    pub id: String,
    pub name: String,
}

fn protocol_name(protocol: PlaybackProtocol) -> &'static str {
    match protocol {
        PlaybackProtocol::Flv => "flv",
        PlaybackProtocol::Hls => "hls",
        PlaybackProtocol::MpegTs => "mpeg_ts",
        PlaybackProtocol::Native => "native",
        PlaybackProtocol::Unknown => "unknown",
    }
}

fn parse_protocol(value: Option<String>) -> Option<PlaybackProtocol> {
    match value.as_deref() {
        Some("flv") => Some(PlaybackProtocol::Flv),
        Some("hls") => Some(PlaybackProtocol::Hls),
        Some("mpeg_ts") => Some(PlaybackProtocol::MpegTs),
        Some("native") => Some(PlaybackProtocol::Native),
        Some("unknown") => Some(PlaybackProtocol::Unknown),
        _ => None,
    }
}

fn decode_headers(raw: String) -> AppResult<HashMap<String, String>> {
    serde_json::from_str(&raw)
        .map_err(|error| AppError::new("db_decode_error", format!("IPTV headers: {error}")))
}

fn list_with_filter(
    conn: &Connection,
    source_id: Option<&str>,
) -> AppResult<Vec<IptvFavoriteRecord>> {
    let sql = if source_id.is_some() {
        "SELECT source_id, channel_id, name, group_name, favorite_group_id, logo, channel_url, protocol, headers, updated_at
         FROM iptv_favorites WHERE source_id = ?1 ORDER BY updated_at DESC"
    } else {
        "SELECT source_id, channel_id, name, group_name, favorite_group_id, logo, channel_url, protocol, headers, updated_at
         FROM iptv_favorites ORDER BY updated_at DESC"
    };
    let mut statement = conn.prepare(sql).map_err(map_db_err)?;
    let mut rows = match source_id {
        Some(source_id) => statement.query([source_id]).map_err(map_db_err)?,
        None => statement.query([]).map_err(map_db_err)?,
    };
    let mut favorites = Vec::new();
    while let Some(row) = rows.next().map_err(map_db_err)? {
        favorites.push(IptvFavoriteRecord {
            source_id: row.get(0).map_err(map_db_err)?,
            id: row.get(1).map_err(map_db_err)?,
            name: row.get(2).map_err(map_db_err)?,
            group: row.get(3).map_err(map_db_err)?,
            favorite_group_id: row.get(4).map_err(map_db_err)?,
            logo: row.get(5).map_err(map_db_err)?,
            url: row.get(6).map_err(map_db_err)?,
            protocol: parse_protocol(row.get(7).map_err(map_db_err)?),
            headers: decode_headers(row.get(8).map_err(map_db_err)?)?,
            updated_at: row.get(9).map_err(map_db_err)?,
        });
    }
    Ok(favorites)
}

pub fn list(conn: &Connection, source_id: &str) -> AppResult<Vec<IptvFavoriteRecord>> {
    list_with_filter(conn, Some(source_id))
}

pub fn list_all(conn: &Connection) -> AppResult<Vec<IptvFavoriteRecord>> {
    list_with_filter(conn, None)
}

pub fn upsert(conn: &Connection, favorite: IptvFavoriteRecord) -> AppResult<()> {
    let protocol = favorite.protocol.map(protocol_name);
    let headers = serde_json::to_string(&favorite.headers)
        .map_err(|error| AppError::new("db_encode_error", format!("IPTV headers: {error}")))?;
    conn.execute(
        "INSERT INTO iptv_favorites
           (source_id, channel_url, channel_id, name, group_name, favorite_group_id, logo, protocol, headers, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(source_id, channel_url) DO UPDATE SET
           channel_id = excluded.channel_id,
           name = excluded.name,
           group_name = excluded.group_name,
           favorite_group_id = COALESCE(excluded.favorite_group_id, iptv_favorites.favorite_group_id),
           logo = excluded.logo,
           protocol = excluded.protocol,
           headers = excluded.headers,
           updated_at = excluded.updated_at",
        params![
            favorite.source_id,
            favorite.url,
            favorite.id,
            favorite.name,
            favorite.group,
            favorite.favorite_group_id,
            favorite.logo,
            protocol,
            headers,
            favorite.updated_at,
        ],
    )
    .map_err(map_db_err)?;
    Ok(())
}

pub fn list_groups(conn: &Connection) -> AppResult<Vec<IptvFavoriteGroupRecord>> {
    let mut statement = conn
        .prepare("SELECT id, name FROM iptv_favorite_groups ORDER BY name ASC")
        .map_err(map_db_err)?;
    let rows = statement
        .query_map([], |row| {
            Ok(IptvFavoriteGroupRecord {
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

pub fn upsert_group(conn: &Connection, group: IptvFavoriteGroupRecord) -> AppResult<()> {
    conn.execute(
        "INSERT INTO iptv_favorite_groups (id, name) VALUES (?1, ?2)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name",
        params![group.id, group.name],
    )
    .map_err(map_db_err)?;
    Ok(())
}

pub fn remove_group(conn: &mut Connection, id: &str) -> AppResult<()> {
    let transaction = conn.transaction().map_err(map_db_err)?;
    transaction
        .execute(
            "UPDATE iptv_favorites SET favorite_group_id = NULL WHERE favorite_group_id = ?1",
            [id],
        )
        .map_err(map_db_err)?;
    transaction
        .execute("DELETE FROM iptv_favorite_groups WHERE id = ?1", [id])
        .map_err(map_db_err)?;
    transaction.commit().map_err(map_db_err)?;
    Ok(())
}

pub fn set_group(
    conn: &Connection,
    source_id: &str,
    channel_url: &str,
    group_id: Option<&str>,
) -> AppResult<()> {
    if let Some(group_id) = group_id {
        let exists = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM iptv_favorite_groups WHERE id = ?1)",
                [group_id],
                |row| row.get::<_, bool>(0),
            )
            .map_err(map_db_err)?;
        if !exists {
            return Err(AppError::new("not_found", "IPTV favorite group not found"));
        }
    }

    let updated = conn
        .execute(
            "UPDATE iptv_favorites SET favorite_group_id = ?1
             WHERE source_id = ?2 AND channel_url = ?3",
            params![group_id, source_id, channel_url],
        )
        .map_err(map_db_err)?;
    if updated == 0 {
        return Err(AppError::new("not_found", "IPTV favorite not found"));
    }
    Ok(())
}

pub fn remove(conn: &Connection, source_id: &str, channel_url: &str) -> AppResult<()> {
    conn.execute(
        "DELETE FROM iptv_favorites WHERE source_id = ?1 AND channel_url = ?2",
        params![source_id, channel_url],
    )
    .map_err(map_db_err)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::open_in_memory;

    fn favorite(source_id: &str, url: &str, updated_at: i64) -> IptvFavoriteRecord {
        IptvFavoriteRecord {
            source_id: source_id.into(),
            id: "cctv-news".into(),
            name: "CCTV 新闻".into(),
            group: "新闻".into(),
            favorite_group_id: None,
            logo: Some("https://example.test/logo.png".into()),
            url: url.into(),
            protocol: Some(PlaybackProtocol::Hls),
            headers: HashMap::from([("referer".into(), "https://example.test/".into())]),
            updated_at,
        }
    }

    #[test]
    fn favorites_are_scoped_by_source_and_round_trip_channel_snapshot() {
        let conn = open_in_memory().unwrap();
        upsert(
            &conn,
            favorite("chinese", "https://example.test/live.m3u8", 10),
        )
        .unwrap();
        upsert(
            &conn,
            favorite("mainland", "https://example.test/live.m3u8", 20),
        )
        .unwrap();

        let chinese = list(&conn, "chinese").unwrap();
        assert_eq!(chinese.len(), 1);
        assert_eq!(chinese[0].name, "CCTV 新闻");
        assert_eq!(chinese[0].protocol, Some(PlaybackProtocol::Hls));
        assert_eq!(
            chinese[0].headers.get("referer").map(String::as_str),
            Some("https://example.test/")
        );

        remove(&conn, "chinese", "https://example.test/live.m3u8").unwrap();
        assert!(list(&conn, "chinese").unwrap().is_empty());
        assert_eq!(list(&conn, "mainland").unwrap().len(), 1);
    }

    #[test]
    fn upsert_refreshes_existing_snapshot_without_duplicating_it() {
        let conn = open_in_memory().unwrap();
        let mut original = favorite("chinese", "https://example.test/live.m3u8", 10);
        upsert(&conn, original.clone()).unwrap();
        upsert_group(
            &conn,
            IptvFavoriteGroupRecord {
                id: "news".into(),
                name: "新闻".into(),
            },
        )
        .unwrap();
        set_group(
            &conn,
            "chinese",
            "https://example.test/live.m3u8",
            Some("news"),
        )
        .unwrap();
        original.name = "CCTV 新闻频道".into();
        original.updated_at = 30;
        upsert(&conn, original).unwrap();

        let rows = list_all(&conn).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].name, "CCTV 新闻频道");
        assert_eq!(rows[0].favorite_group_id.as_deref(), Some("news"));
        assert_eq!(rows[0].updated_at, 30);
    }

    #[test]
    fn groups_round_trip_and_removal_moves_channels_to_ungrouped() {
        let mut conn = open_in_memory().unwrap();
        upsert_group(
            &conn,
            IptvFavoriteGroupRecord {
                id: "sports".into(),
                name: "体育".into(),
            },
        )
        .unwrap();
        upsert(
            &conn,
            favorite("chinese", "https://example.test/sports.m3u8", 10),
        )
        .unwrap();
        set_group(
            &conn,
            "chinese",
            "https://example.test/sports.m3u8",
            Some("sports"),
        )
        .unwrap();

        assert_eq!(list_groups(&conn).unwrap()[0].name, "体育");
        assert_eq!(
            list(&conn, "chinese").unwrap()[0]
                .favorite_group_id
                .as_deref(),
            Some("sports")
        );

        remove_group(&mut conn, "sports").unwrap();

        assert!(list_groups(&conn).unwrap().is_empty());
        assert_eq!(list(&conn, "chinese").unwrap()[0].favorite_group_id, None);
    }
}
