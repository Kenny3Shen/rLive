//! 斗鱼播放签名：`websec/getEncryption` 描述符 + 本地 MD5 链。
//!
//! H5 播放接口 `lapi/live/getH5PlayV1/{rid}` 要求一个由服务端下发的
//! 短时效加密描述符派生的 `auth` 凭据：
//!
//! * 描述符来自 `wgapi/livenc/liveweb/websec/getEncryption?did={did}`，
//!   包含 `key` / `rand_str` / `enc_time` / `enc_data` / `expire_at` / `is_special`；
//! * `secret` 由 `rand_str` 起始，迭代 `enc_time` 次 `md5(secret + key)` 得到；
//! * `auth = md5(secret + key + salt)`，普通房间的 `salt` 是 `roomId + tt`
//!   （`is_special = 1` 时为空）。
//!
//! 描述符在进程内缓存并单飞刷新（tokio Mutex 跨 await 持有），
//! 因此并发进房只会触发一次网络请求。算法参考 pure_live 的
//! `DouyuUtils`，为纯 Rust 实现，不依赖任何 JS 运行时。

use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use md5::{Digest, Md5};
use reqwest::Client;
use serde::Deserialize;
use tokio::sync::Mutex;

use crate::error::{AppError, AppResult};

const ENCRYPTION_URL: &str = "https://www.douyu.com/wgapi/livenc/liveweb/websec/getEncryption";
/// 签名与播放请求共用的浏览器设备 id，与站内搜索请求的兜底 did 一致。
pub(crate) const SIGN_DEVICE_ID: &str = "10000000000000000000000000001501";
/// `getEncryption` 返回的迭代次数字段是服务端控制的；
/// 上限只用于防御格式异常的响应，正常取值为 1。
const MAX_ENC_TIME: i64 = 16;
/// 描述符有效期校验的安全余量：临期描述符直接视为过期并刷新。
const EXPIRY_SAFETY_SECS: i64 = 30;
/// 描述符缓存的最长使用时间，即使服务端给了更长的有效期。
const MAX_CACHE_AGE: Duration = Duration::from_secs(5 * 60);

/// 服务器拒绝签名（HTTP 403 或 `error = -9` 时间戳错误）时使用的错误码。
/// 调用方据此强制刷新描述符并重签一次。
pub(crate) const SIGN_REJECTED_CODE: &str = "douyu_sign_rejected";

/// 服务端下发的加密描述符。
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct EncryptionKey {
    #[serde(default)]
    key: String,
    #[serde(default)]
    rand_str: String,
    #[serde(default)]
    enc_data: String,
    #[serde(default)]
    enc_time: i64,
    #[serde(default)]
    is_special: i64,
    #[serde(default)]
    expire_at: i64,
}

impl EncryptionKey {
    /// 校验描述符字段完整且未临期过期。
    fn is_usable(&self, now_secs: i64, safety_secs: i64) -> bool {
        self.expire_at > now_secs + safety_secs
            && (1..=MAX_ENC_TIME).contains(&self.enc_time)
            && !self.key.is_empty()
            && !self.rand_str.is_empty()
            && !self.enc_data.is_empty()
    }
}

#[derive(Deserialize)]
struct EncryptionResponse {
    #[serde(default)]
    error: i64,
    data: Option<EncryptionKey>,
}

struct CachedEncryptionKey {
    key: EncryptionKey,
    fetched_at: Instant,
}

/// 进程级描述符缓存。站点实例按 IPC 命令创建，
/// 没有它时每个房间详情都要多一次 `getEncryption` 往返。
static ENCRYPTION_KEY_CACHE: Mutex<Option<CachedEncryptionKey>> = Mutex::const_new(None);

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn err(msg: impl Into<String>) -> AppError {
    AppError::new("douyu_sign", msg)
        .with_site("douyu")
        .retryable()
}

/// 获取（或复用缓存的）加密描述符。
///
/// tokio Mutex 在网络请求期间保持持有，天然形成单飞刷新：
/// 并发调用者会等待第一个请求完成后直接复用其结果。
async fn encryption_key(client: &Client, force_refresh: bool) -> AppResult<EncryptionKey> {
    let mut cache = ENCRYPTION_KEY_CACHE.lock().await;
    let now = now_secs();
    if !force_refresh
        && let Some(cached) = cache.as_ref()
        && cached.fetched_at.elapsed() < MAX_CACHE_AGE
        && cached.key.is_usable(now, EXPIRY_SAFETY_SECS)
    {
        return Ok(cached.key.clone());
    }
    let key = fetch_encryption_key(client).await?;
    *cache = Some(CachedEncryptionKey {
        key: key.clone(),
        fetched_at: Instant::now(),
    });
    Ok(key)
}

async fn fetch_encryption_key(client: &Client) -> AppResult<EncryptionKey> {
    let url = format!("{ENCRYPTION_URL}?did={SIGN_DEVICE_ID}");
    let text = client
        .get(&url)
        .header("user-agent", super::UA)
        .header("referer", "https://www.douyu.com/")
        .header("cookie", did_cookie())
        .send()
        .await
        .map_err(|e| err(format!("getEncryption 请求失败: {e}")))?
        .text()
        .await
        .map_err(|e| err(format!("getEncryption 响应读取失败: {e}")))?;
    let response: EncryptionResponse =
        serde_json::from_str(&text).map_err(|e| err(format!("getEncryption 响应无效: {e}")))?;
    if response.error != 0 {
        return Err(err(format!("getEncryption 返回错误码 {}", response.error)));
    }
    let key = response
        .data
        .ok_or_else(|| err("getEncryption 未返回加密描述符"))?;
    if !key.is_usable(now_secs(), EXPIRY_SAFETY_SECS) {
        return Err(err("加密描述符不完整或已过期"));
    }
    Ok(key)
}

fn did_cookie() -> String {
    format!("dy_did={SIGN_DEVICE_ID}; acf_did={SIGN_DEVICE_ID}")
}

fn md5_hex(input: &str) -> String {
    hex::encode(Md5::digest(input.as_bytes()))
}

/// 用已验证的描述符构造完整的 `getH5PlayV1` 表单体。
///
/// `timestamp` 是参与 `auth` 盐值的秒级 Unix 时间；
/// 独立成参使这条纯计算路径可以离线单测。
pub(crate) fn build_signed_body(
    key: &EncryptionKey,
    room_id: &str,
    timestamp: i64,
    rate: i64,
    cdn: &str,
    device_id: &str,
) -> AppResult<String> {
    if !key.is_usable(timestamp, 0) {
        return Err(err("加密描述符不完整或已过期"));
    }
    let mut secret = key.rand_str.clone();
    for _ in 0..key.enc_time {
        secret = md5_hex(&format!("{secret}{}", key.key));
    }
    let salt = if key.is_special == 1 {
        String::new()
    } else {
        format!("{room_id}{timestamp}")
    };
    let auth = md5_hex(&format!("{secret}{}{salt}", key.key));
    Ok(format!(
        "enc_data={}&tt={}&did={}&auth={}&cdn={}&rate={rate}&hevc=0&fa=0&ive=0&ver=Douyu_new&iar=0",
        super::urlencoding_encode(&key.enc_data),
        timestamp,
        device_id,
        auth,
        super::urlencoding_encode(cdn),
    ))
}

/// 为一次 H5 播放请求生成签名表单体。
///
/// 每次调用都基于缓存的描述符重新计算 `auth`（时间戳取当前值），
/// 因此长驻详情页后请求播放也不会因 `tt` 过旧而被 `-9` 拒绝。
pub(crate) async fn get_sign(
    client: &Client,
    room_id: &str,
    rate: i64,
    cdn: &str,
    force_refresh: bool,
) -> AppResult<String> {
    let key = encryption_key(client, force_refresh).await?;
    build_signed_body(&key, room_id, now_secs(), rate, cdn, SIGN_DEVICE_ID)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_key() -> EncryptionKey {
        EncryptionKey {
            key: "CkhDMvVf0AVI8Oe6GIOd324920".into(),
            rand_str: "VHVzZXFmUSrvaiMd".into(),
            enc_data: "eyJhbGdfdmVyIjoxLCJrZXlfdmVyIjoxMzA5fQ==".into(),
            enc_time: 1,
            is_special: 0,
            expire_at: 4_102_444_800,
        }
    }

    #[test]
    fn descriptor_validation_rejects_incomplete_or_stale_values() {
        let key = fixture_key();
        assert!(key.is_usable(1_700_000_000, EXPIRY_SAFETY_SECS));
        // 临期（在安全余量内）视为过期。
        assert!(!key.is_usable(4_102_444_800 - EXPIRY_SAFETY_SECS, EXPIRY_SAFETY_SECS));
        // 迭代次数越界。
        for enc_time in [0, -1, MAX_ENC_TIME + 1] {
            let mut bad = fixture_key();
            bad.enc_time = enc_time;
            assert!(!bad.is_usable(1_700_000_000, 0), "enc_time={enc_time}");
        }
        // 必填字段缺失。
        for field in ["key", "rand_str", "enc_data"] {
            let mut bad = fixture_key();
            match field {
                "key" => bad.key = String::new(),
                "rand_str" => bad.rand_str = String::new(),
                _ => bad.enc_data = String::new(),
            }
            assert!(!bad.is_usable(1_700_000_000, 0), "missing {field}");
        }
    }

    /// 参考向量来自独立实现（Python + 已通过线上验证的 pure_live 算法）
    /// 对同一组输入的计算结果，覆盖 MD5 链、盐值与表单字段顺序。
    #[test]
    fn signed_body_matches_reference_vector() {
        let key = fixture_key();
        let body = build_signed_body(&key, "123", 1_700_000_000, -1, "", SIGN_DEVICE_ID)
            .expect("signed body");
        assert_eq!(
            body,
            format!(
                "enc_data=eyJhbGdfdmVyIjoxLCJrZXlfdmVyIjoxMzA5fQ%3D%3D&tt=1700000000&did={SIGN_DEVICE_ID}&auth=dd2696b1ffa62976447d12ee7b868fc6&cdn=&rate=-1&hevc=0&fa=0&ive=0&ver=Douyu_new&iar=0"
            )
        );
    }

    /// `is_special = 1` 的房间不参与盐值。
    #[test]
    fn special_room_omits_salt() {
        let mut key = fixture_key();
        key.is_special = 1;
        let body = build_signed_body(&key, "123", 1_700_000_000, 0, "hw-h5", "device-x")
            .expect("signed body");
        assert!(body.contains("auth=4bb82cca3bae8bacb1de42c68b3fe881"));
        assert!(body.contains("cdn=hw-h5"));
        assert!(body.contains("rate=0"));
        assert!(body.contains("did=device-x"));
    }

    /// `enc_time` 迭代链在多轮时按定义折叠。
    #[test]
    fn secret_folds_repeated_md5_rounds() {
        let mut key = fixture_key();
        key.enc_time = 3;
        let body = build_signed_body(&key, "7", 1_600_000_000, -1, "", SIGN_DEVICE_ID)
            .expect("signed body");
        assert!(body.contains("auth=ec1366281003b4c6fdf1fee0193c92e5"));
    }

    #[test]
    fn stale_descriptor_fails_the_body_build() {
        let mut key = fixture_key();
        key.expire_at = 100;
        let err = build_signed_body(&key, "1", 1_700_000_000, -1, "", SIGN_DEVICE_ID)
            .expect_err("stale descriptor");
        assert_eq!(err.code, "douyu_sign");
    }
}
