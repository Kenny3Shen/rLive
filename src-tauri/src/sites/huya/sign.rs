//! 虎牙播放地址 anticode 签名与其编码规则。

use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use md5::{Digest, Md5};
use percent_encoding::percent_decode_str;

pub(super) fn process_anticode(anticode: &str, uid: &str, stream_name: &str) -> String {
    let mut query: HashMap<String, String> = HashMap::new();
    for part in anticode.split('&') {
        if let Some((k, v)) = part.split_once('=') {
            query.insert(k.to_string(), v.to_string());
        }
    }
    query.insert("t".into(), "103".into());
    query.insert("ctype".into(), "tars_mobile".into());

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let ws_time = format!("{:x}", now + 21600);
    let seq_id = format!("{}", now * 1000 + uid.parse::<u64>().unwrap_or(0));

    let fm_raw = query.get("fm").cloned().unwrap_or_default();
    let fm_decoded = percent_decode(&fm_raw);
    let fm_bytes = base64_decode(&fm_decoded).unwrap_or_default();
    let fm = String::from_utf8_lossy(&fm_bytes);
    let ws_secret_prefix = fm.split('_').next().unwrap_or("");
    let ctype = query
        .get("ctype")
        .cloned()
        .unwrap_or_else(|| "tars_mobile".into());
    let t = query.get("t").cloned().unwrap_or_else(|| "103".into());
    let fs = query.get("fs").cloned().unwrap_or_default();

    let ws_secret_hash = md5_hex(&format!("{seq_id}|{ctype}|{t}"));
    let ws_secret = md5_hex(&format!(
        "{ws_secret_prefix}_{uid}_{stream_name}_{ws_secret_hash}_{ws_time}"
    ));
    let uuid = format!("{}", (now % 10_000_000_000) * 1000 % 0xffff_ffff);

    format!(
        "wsSecret={ws_secret}&wsTime={ws_time}&seqid={seq_id}&ctype={ctype}&ver=1&fs={fs}&dMod=mseh-0&sdkPcdn=1_1&uid={uid}&uuid={uuid}&t={t}&sv=202411221719&sdk_sid=1732862566708&a_block=0"
    )
}

fn md5_hex(s: &str) -> String {
    let mut h = Md5::new();
    h.update(s.as_bytes());
    hex::encode(h.finalize())
}

fn percent_decode(s: &str) -> String {
    percent_decode_str(&s.replace('+', " "))
        .decode_utf8_lossy()
        .into_owned()
}

fn base64_decode(s: &str) -> Option<Vec<u8>> {
    // 输入来自 `percent_decode`（`+` → 空格），可能带空白；与原手写实现一致：
    // 忽略空白、剥除所有 `=`、丢弃非零 trailing bits。
    const LENIENT: GeneralPurpose = GeneralPurpose::new(
        &base64::alphabet::STANDARD,
        GeneralPurposeConfig::new()
            .with_decode_padding_mode(DecodePaddingMode::Indifferent)
            .with_decode_allow_trailing_bits(true),
    );
    let filtered: Vec<u8> = s
        .bytes()
        .filter(|c| !c.is_ascii_whitespace() && *c != b'=')
        .collect();
    LENIENT.decode(filtered).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 等价性锚点：原手写实现把 `+` 解码为空格，截断/非法转义按字面保留。
    #[test]
    fn percent_decode_form_style() {
        assert_eq!(percent_decode("a%20b+c%2Bd"), "a b c+d");
        assert_eq!(percent_decode("%E4%B8%AD"), "中");
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("a%G1b"), "a%G1b");
        assert_eq!(percent_decode("a%2"), "a%2");
    }

    /// 等价性锚点：原手写实现忽略空白与 `=`、丢弃非零 trailing bits。
    #[test]
    fn base64_decode_lenient_like_handwritten() {
        assert_eq!(base64_decode("QQ==").as_deref(), Some(b"A".as_slice()));
        assert_eq!(
            base64_decode("U3RyZWFt").as_deref(),
            Some(b"Stream".as_slice())
        );
        // `fm` 先经 percent_decode（`+` → 空格），空白必须被忽略。
        assert_eq!(base64_decode("QSBJ").as_deref(), Some(b"A I".as_slice()));
        assert_eq!(
            base64_decode("U3Ry\nZWFt =").as_deref(),
            Some(b"Stream".as_slice())
        );
        // 2 字符块的余数位被丢弃而不是报错。
        assert_eq!(base64_decode("QR").as_deref(), Some(b"A".as_slice()));
        assert_eq!(base64_decode("!!"), None);
    }
}
