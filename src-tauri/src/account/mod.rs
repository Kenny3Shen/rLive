use rusqlite::{params, Connection, OptionalExtension};

use crate::db::schema::map_db_err;
use crate::error::AppResult;
use crate::models::live::SiteId;

/// Load cookie for a site. Returns `None` when unset.
/// Never log the full cookie value.
pub fn get_cookie(conn: &Connection, site_id: &SiteId) -> AppResult<Option<String>> {
    let site = site_id.as_str();
    let mut stmt = conn
        .prepare("SELECT cookie FROM cookies WHERE site_id = ?1")
        .map_err(map_db_err)?;
    let cookie = stmt
        .query_row(params![site], |row| row.get::<_, String>(0))
        .optional()
        .map_err(map_db_err)?;
    Ok(cookie)
}

/// Store cookie for a site (upsert). Empty string is stored as-is; callers may clear instead.
pub fn set_cookie(conn: &Connection, site_id: &SiteId, cookie: &str) -> AppResult<()> {
    let site = site_id.as_str();
    let now = chrono::Utc::now().timestamp();
    // Log only metadata — never the full cookie string.
    tracing::debug!(
        site_id = site,
        cookie_len = cookie.len(),
        "account_set_cookie"
    );
    conn.execute(
        "INSERT INTO cookies (site_id, cookie, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(site_id) DO UPDATE SET
           cookie = excluded.cookie,
           updated_at = excluded.updated_at",
        params![site, cookie, now],
    )
    .map_err(map_db_err)?;
    Ok(())
}

/// Remove cookie row for a site.
pub fn clear_cookie(conn: &Connection, site_id: &SiteId) -> AppResult<()> {
    let site = site_id.as_str();
    tracing::debug!(site_id = site, "account_clear_cookie");
    conn.execute("DELETE FROM cookies WHERE site_id = ?1", params![site])
        .map_err(map_db_err)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::open_in_memory;

    #[test]
    fn cookie_set_get_clear() {
        let conn = open_in_memory().unwrap();
        let site = SiteId::Bilibili;
        assert!(get_cookie(&conn, &site).unwrap().is_none());

        set_cookie(&conn, &site, "SESSDATA=abc; bili_jct=xyz").unwrap();
        let got = get_cookie(&conn, &site).unwrap().unwrap();
        assert_eq!(got, "SESSDATA=abc; bili_jct=xyz");

        clear_cookie(&conn, &site).unwrap();
        assert!(get_cookie(&conn, &site).unwrap().is_none());
    }

    #[test]
    fn cookie_upsert_overwrites() {
        let conn = open_in_memory().unwrap();
        let site = SiteId::Bilibili;
        set_cookie(&conn, &site, "first").unwrap();
        set_cookie(&conn, &site, "second").unwrap();
        assert_eq!(get_cookie(&conn, &site).unwrap().as_deref(), Some("second"));
    }
}
