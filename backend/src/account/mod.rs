pub mod bilibili_qr;
pub mod douyin_qr;
pub mod douyu_qr;

use rusqlite::{Connection, OptionalExtension, params};

use crate::db::schema::map_db_err;
use crate::error::AppResult;
use crate::models::live::SiteId;

const MAX_ACCOUNT_NAME_CHARS: usize = 128;

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

/// Return a display name carried by a platform's browser Cookie, if that
/// platform provides one.  This intentionally accepts only known name fields
/// rather than attempting to infer an identity from opaque session values.
///
/// The result is suitable for the account-settings summary only.  It does not
/// validate that a session is currently accepted by the upstream platform.
pub fn display_name_from_cookie(site_id: &SiteId, cookie: &str) -> Option<String> {
    let name_keys: &[&str] = match site_id {
        // Bilibili normally needs a profile request because QR-login callback
        // Cookies do not include this optional field.  Keep it as a fallback
        // for browser exports that do include it.
        SiteId::Bilibili => &["DedeUserName"],
        SiteId::Douyu => &["acf_username"],
        SiteId::Huya => &["udb_n"],
        // Some manually exported Douyin Cookies carry one of these fields;
        // do not mistake a numeric login/session token for a display name.
        SiteId::Douyin => &["nickname", "user_name", "username"],
        _ => &[],
    };

    name_keys.iter().find_map(|key| cookie_value(cookie, key))
}

fn cookie_value(cookie: &str, expected_key: &str) -> Option<String> {
    let cookie = cookie.trim();
    let cookie = cookie
        .strip_prefix("Cookie:")
        .or_else(|| cookie.strip_prefix("cookie:"))
        .unwrap_or(cookie);

    cookie
        .split(';')
        .filter_map(|part| part.trim().split_once('='))
        .find(|(key, _)| key.trim().eq_ignore_ascii_case(expected_key))
        .and_then(|(_, value)| normalize_display_name(percent_decode_cookie_value(value.trim())))
}

fn normalize_display_name(value: String) -> Option<String> {
    if value.chars().any(char::is_control) {
        return None;
    }
    let value = value.trim().trim_matches('"').trim();
    (!value.is_empty() && value.chars().count() <= MAX_ACCOUNT_NAME_CHARS).then(|| value.to_owned())
}

/// Decode percent escapes without applying URL-form's `+` → space rule.
/// Browser Cookie values use a literal plus, and several platforms encode
/// Chinese account names with percent escapes.
fn percent_decode_cookie_value(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let high = (bytes[index + 1] as char).to_digit(16);
            let low = (bytes[index + 2] as char).to_digit(16);
            if let (Some(high), Some(low)) = (high, low) {
                decoded.push((high * 16 + low) as u8);
                index += 3;
                continue;
            }
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    String::from_utf8(decoded).unwrap_or_else(|_| value.to_owned())
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

    #[test]
    fn extracts_only_the_known_platform_display_name_fields() {
        assert_eq!(
            display_name_from_cookie(
                &SiteId::Douyu,
                "Cookie: acf_username=%E5%B0%8F%E6%98%8E; acf_stk=secret",
            )
            .as_deref(),
            Some("小明")
        );
        assert_eq!(
            display_name_from_cookie(&SiteId::Huya, "udb_n=%E8%99%8E%E7%89%99+%E7%94%A8%E6%88%B7")
                .as_deref(),
            Some("虎牙+用户")
        );
        assert_eq!(
            display_name_from_cookie(&SiteId::Bilibili, "SESSDATA=secret; DedeUserID=42"),
            None
        );
    }

    #[test]
    fn rejects_blank_or_control_character_cookie_names() {
        assert_eq!(
            display_name_from_cookie(&SiteId::Douyu, "acf_username=%0Ainvalid"),
            None
        );
        assert_eq!(
            display_name_from_cookie(&SiteId::Douyu, "acf_username=   "),
            None
        );
    }
}
