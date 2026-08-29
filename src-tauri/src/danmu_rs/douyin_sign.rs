//! 本地生成抖音 webcast 签名（X-Bogus 风格）。
//!
//! Web IM 的 WSS URL 需要一个由房间 id + 匿名 `user_unique_id` 派生的
//! 短时效 `signature` 查询参数。签名分两步：
//!
//! 1. [`ms_stub`]：固定 webcast 客户端参数拼接后的 MD5；
//! 2. X-Bogus：把 stub 末两字节的 MD5、计数器与随机数打包成 10 字节
//!    负载，校验和后经 RC4 加密，前置 2 字节头后用抖音专用字母表
//!    编码为 16 字符 token。
//!
//! 算法与第一方 Web 客户端一致（移植自 pure_live 的 `xbogus.dart`），
//! 纯本地计算，无需 JS 运行时。

use md5::{Digest, Md5};

use crate::error::{AppError, AppResult};

/// X-Bogus 输出使用的抖音专用 Base64 字母表。
const X_BOGUS_ALPHABET: &[u8] =
    b"Dkdpgh4ZKsQB80/Mfvw36XI1R25+WUAlEi7NLboqYTOPuzmFjJnryx9HVGcaStCe";
/// 标准 Base64 字母表；编码时先按它取 6 位索引，再映射到上表。
const STANDARD_ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
/// 签名负载中固定的两个字节（对空 MD5 的常量引用）。
const EMPTY_MD5_BYTES: [u8; 2] = [0x45, 0x3f];

/// 固定 webcast 客户端参数的 MD5 stub。
pub fn ms_stub(room_id: &str, user_unique_id: &str) -> AppResult<String> {
    validate_numeric_component(room_id, "房间号")?;
    validate_web_id_component(user_unique_id, "用户标识")?;

    // 字段顺序与取值与第一方 Web 客户端一致。
    let sig_params = format!(
        "live_id=1,aid=6383,version_code=180800,webcast_sdk_version=1.3.0,room_id={room_id},sub_room_id=,sub_channel_id=,did_rule=3,user_unique_id={user_unique_id},device_platform=web,device_type=,ac=,identity=audience"
    );
    Ok(hex::encode(Md5::digest(sig_params.as_bytes())))
}

/// 为给定的内部房间 id 与匿名 uid 计算 WSS `signature`。
///
/// 纯本地计算（两条 MD5 + 一次 RC4），耗时在微秒级，
/// 可以直接在调用线程上同步完成。
pub fn get_signature(room_id: &str, user_unique_id: &str) -> AppResult<String> {
    let stub = ms_stub(room_id, user_unique_id)?;
    let (random1, random2) = signature_random_pair();
    Ok(generate_x_bogus(&stub, 1, random1, random2))
}

/// RC4：密钥是单个整数，逐字节参与 KSA（与抖音 SDK 的变体一致）。
fn rc4_encrypt(key: u8, data: &mut [u8]) {
    let mut s: [u8; 256] = std::array::from_fn(|i| i as u8);
    let mut j: usize = 0;
    for i in 0..256 {
        j = (j + s[i] as usize + key as usize) & 0xff;
        s.swap(i, j);
    }

    let mut i: usize = 0;
    j = 0;
    for byte in data.iter_mut() {
        i = (i + 1) & 0xff;
        j = (j + s[i] as usize) & 0xff;
        s.swap(i, j);
        *byte ^= s[(s[i] as usize + s[j] as usize) & 0xff];
    }
}

/// 12 字节输入 → 16 字符输出，字母表映射在
/// 标准 Base64 索引之后再查 X-Bogus 表。
fn encode_x_bogus_base64(data: &[u8; 12]) -> String {
    let mut out = String::with_capacity(16);
    let (chunks, _) = data.as_chunks::<3>();
    for chunk in chunks {
        let (b0, b1, b2) = (chunk[0], chunk[1], chunk[2]);
        let indices = [
            (b0 >> 2) & 0x3f,
            ((b0 << 4) | (b1 >> 4)) & 0x3f,
            ((b1 << 2) | (b2 >> 6)) & 0x3f,
            b2 & 0x3f,
        ];
        for index in indices {
            let standard = STANDARD_ALPHABET[index as usize];
            let mapped = alphabet_lookup(standard);
            out.push(mapped as char);
        }
    }
    out
}

/// 标准 Base64 字符 → X-Bogus 字母表字符。
/// 两套字母表等长且按位对应，线性查表足够。
fn alphabet_lookup(standard: u8) -> u8 {
    let index = STANDARD_ALPHABET
        .iter()
        .position(|&c| c == standard)
        .expect("standard base64 byte");
    X_BOGUS_ALPHABET[index]
}

/// `md5(decode(hex))` 的最后两个字节。
fn md5_last_two(hex_str: &str) -> [u8; 2] {
    let mut bytes = [0u8; 16];
    for (i, slot) in bytes.iter_mut().enumerate() {
        *slot = u8::from_str_radix(&hex_str[i * 2..i * 2 + 2], 16).unwrap_or(0);
    }
    let digest = Md5::digest(bytes);
    [digest[14], digest[15]]
}

/// 生成 X-Bogus token。
///
/// * `ms_stub` —— 32 字符的 MD5 hex（[`ms_stub`] 的输出）。
/// * `counter` —— 会话计数器，Web 客户端固定传 1。
/// * `random1` / `random2` —— 随机字节；`random2` 同时充当 RC4 密钥。
///
/// 随机数独立成参使这条路径可以离线单测。
pub(crate) fn generate_x_bogus(ms_stub: &str, counter: u8, random1: u8, random2: u8) -> String {
    let header = 0x40 | (random1 & 0x1f);
    let md5_bytes = md5_last_two(ms_stub);

    let mut payload = [
        counter & 0x3f,
        0,
        1,
        0x0e,
        EMPTY_MD5_BYTES[0],
        EMPTY_MD5_BYTES[1],
        md5_bytes[0],
        md5_bytes[1],
        random2,
        0,
    ];
    let mut checksum = 0u8;
    for byte in payload.iter().take(9) {
        checksum ^= byte;
    }
    payload[9] = checksum;

    rc4_encrypt(random2, &mut payload);

    let mut final_data = [0u8; 12];
    final_data[0] = header;
    final_data[1] = random2;
    final_data[2..].copy_from_slice(&payload);

    encode_x_bogus_base64(&final_data)
}

/// 从系统熵源取一对随机字节。
///
/// `random2` 保持与 Web 客户端相同的 `[0, 254]` 取值域。
/// uuid v4 内部使用加密安全的 getrandom，直接复用其字节。
fn signature_random_pair() -> (u8, u8) {
    let bytes = *uuid::Uuid::new_v4().as_bytes();
    (bytes[0], bytes[1] % 255)
}

fn validate_numeric_component(value: &str, label: &str) -> AppResult<()> {
    if value.is_empty() || value.len() > 32 || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(
            AppError::new("douyin_invalid_room", format!("无效的抖音{label}")).with_site("douyin"),
        );
    }
    Ok(())
}

/// 判断某个 web id 是否可用于签名。
///
/// [`ms_stub`] 用 `,` 和 `=` 拼接字段，WSS query 与 `internal_ext` 又引入
/// `|` 和 `&`，因此任何带分隔符的 id 都会伪造出额外字段。抖音自己的
/// `user_unique_id` 是十进制雪花 id，而浏览器会话的 `s_v_web_id` cookie
/// 更长且包含 `_`、`-` 和 `%` —— 这种形态在这里不可用，
/// 所以调用方必须回退到本地生成的匿名 id，而不是让整个握手失败。
pub fn is_valid_web_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 32 && value.bytes().all(|byte| byte.is_ascii_alphanumeric())
}

fn validate_web_id_component(value: &str, label: &str) -> AppResult<()> {
    if !is_valid_web_id(value) {
        return Err(
            AppError::new("douyin_invalid_room", format!("无效的抖音{label}")).with_site("douyin"),
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ms_stub_matches_simple_live_fixture() {
        let stub = ms_stub("1234567890", "9876543210").unwrap();
        assert_eq!(stub, "52dc322647fb611bdd1aa4b230fd7d17");
    }

    #[test]
    fn ms_stub_rejects_non_numeric_ids() {
        assert!(ms_stub("12ab", "1").is_err());
        assert!(ms_stub("1", "uid-x").is_err());
        assert!(ms_stub("", "1").is_err());
    }

    #[test]
    fn ms_stub_accepts_alphanumeric_session_web_ids() {
        // `s_v_web_id` 兜底值是字母数字混合的；
        // 签名输入既接受它们，也接受数字型的 `user_unique_id`。
        assert!(ms_stub("1234567890", "deadbeef1234").is_ok());
        assert!(ms_stub("1234567890", "7392091211001140287").is_ok());
        assert!(ms_stub("1234567890", "1|with-pipe").is_err());
    }

    /// 真实的 `s_v_web_id` cookie 比雪花 id 长得多，且带有 `_`/`-`/`%`，
    /// 因此绝不可能用于签名。调用方依赖这个判定函数，
    /// 在走到 [`ms_stub`] 之前完成回退。
    #[test]
    fn session_cookie_shaped_web_ids_are_rejected() {
        assert!(!is_valid_web_id(
            "verify_m9x0k1a2_HqLpZzXk_8T1c_4Vd2_Wm5NpQrStUvW"
        ));
        assert!(!is_valid_web_id("verify_m9x0k1a2"));
        assert!(!is_valid_web_id("0123456789012345678901234567890123"));
        assert!(!is_valid_web_id(""));
        assert!(is_valid_web_id("7392091211001140287"));
        assert!(is_valid_web_id("deadbeef1234"));
    }

    /// 参考向量来自独立实现（Python 移植，已通过抖音 webcast
    /// 服务器线上握手验证）对同一组输入的计算结果。
    #[test]
    fn x_bogus_matches_reference_vectors() {
        // ms_stub("1234567890", "9876543210") == "52dc322647fb611bdd1aa4b230fd7d17"
        let stub = "52dc322647fb611bdd1aa4b230fd7d17";
        assert_eq!(generate_x_bogus(stub, 1, 0x00, 0x00), "fDpl4KiMGEi/SROO");
        assert_eq!(generate_x_bogus(stub, 1, 0xff, 0xfe), "1eVnhJc1lIlwXIJl");
        assert_eq!(generate_x_bogus(stub, 1, 0x2a, 0x5c), "wbniVBAr5L9XNJFK");
        // 计数器参与首字节与校验和。
        assert_eq!(generate_x_bogus(stub, 2, 0x00, 0x00), "fDpW4KiMGEi/SROT");
    }

    /// X-Bogus 结构上只会产出 16 个字母表字符：12 字节恰好四组、无填充，
    /// 字母表不含 `-` 与 `=`，因此旧 QuickJS 方案里的“重试到干净签名”
    /// 循环在这里不再必要。
    #[test]
    fn x_bogus_output_is_always_clean() {
        let stub = ms_stub("1234567890", "9876543210").unwrap();
        for random1 in [0u8, 1, 42, 128, 200, 255] {
            for random2 in [0u8, 1, 99, 200, 254] {
                let signature = generate_x_bogus(&stub, 1, random1, random2);
                assert_eq!(signature.len(), 16);
                assert!(signature.bytes().all(|b| X_BOGUS_ALPHABET.contains(&b)));
                assert!(!signature.contains(['-', '=']));
            }
        }
    }

    #[test]
    fn get_signature_returns_non_empty_clean_token() {
        let signature = get_signature("1234567890", "9876543210").expect("signature");
        assert_eq!(signature.len(), 16);
        assert!(signature.bytes().all(|b| X_BOGUS_ALPHABET.contains(&b)));
        let again = get_signature("1234567890", "9876543210").expect("signature again");
        assert_eq!(again.len(), 16);
    }
}
