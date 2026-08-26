pub mod bilibili_qr;
pub mod douyin_qr;
pub mod douyu_qr;
pub mod huya_qr;

use rusqlite::{Connection, OptionalExtension, params};

use crate::db::schema::map_db_err;
use crate::error::AppResult;
use crate::models::live::SiteId;

const MAX_ACCOUNT_NAME_CHARS: usize = 128;

/// 读取某站点的 cookie。未设置时返回 `None`。
/// 绝不记录完整的 cookie 值。
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

/// 保存某站点的 cookie（upsert）。空字符串按原样存储；调用方可改为清除。
pub fn set_cookie(conn: &Connection, site_id: &SiteId, cookie: &str) -> AppResult<()> {
    let site = site_id.as_str();
    let now = chrono::Utc::now().timestamp();
    // 只记录元数据 —— 绝不记录完整的 cookie 字符串。
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

/// 删除某站点的 cookie 记录行。
pub fn clear_cookie(conn: &Connection, site_id: &SiteId) -> AppResult<()> {
    let site = site_id.as_str();
    tracing::debug!(site_id = site, "account_clear_cookie");
    conn.execute("DELETE FROM cookies WHERE site_id = ?1", params![site])
        .map_err(map_db_err)?;
    Ok(())
}

/// 返回某平台浏览器 Cookie 中携带的显示名（若该平台提供）。
/// 这里刻意只接受已知的名称字段，
/// 而不尝试从不透明的会话值中推断身份。
///
/// 结果仅适用于账号设置页的摘要展示，
/// 并不校验该会话当前是否仍被上游平台接受。
pub fn display_name_from_cookie(site_id: &SiteId, cookie: &str) -> Option<String> {
    let name_keys: &[&str] = match site_id {
        // Bilibili 通常需要额外请求个人资料，因为扫码登录回调的 Cookie 不包含
        // 这个可选字段。这里保留它，作为确实包含该字段的浏览器导出的兜底。
        SiteId::Bilibili => &["DedeUserName"],
        SiteId::Douyu => &["acf_username"],
        SiteId::Huya => &["udb_n", "username"],
        // 部分手动导出的抖音 Cookie 会携带其中某个字段；
        // 不要把数字型的登录/会话 token 误当成显示名。
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

/// 解码百分号转义，但不套用 URL 表单中 `+` → 空格的规则。
/// 浏览器 Cookie 值使用的是字面加号，且多个平台会用百分号转义
/// 编码中文账号名。
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
        // 部分虎牙浏览器导出把显示名放在 `username` 而不是（或同时放在）
        // `udb_n` 中；以 `udb_n` 优先。
        assert_eq!(
            display_name_from_cookie(&SiteId::Huya, "username=%E5%B0%8F%E8%99%8E; yyuid=42")
                .as_deref(),
            Some("小虎")
        );
        assert_eq!(
            display_name_from_cookie(
                &SiteId::Huya,
                "udb_n=%E8%99%8E%E7%89%99; username=%E5%B0%8F%E8%99%8E",
            )
            .as_deref(),
            Some("虎牙")
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
