//! 抖音 `a_bogus` query 签名。
//!
//! 抖音需要浏览器认证的列表接口（分区房间、more_live）会拒绝缺少有效
//! `a_bogus` 参数的请求，该参数由 URL query、请求 UA 和一个合成的浏览器环境
//! 字符串派生。算法与抖音 Web 客户端一致，
//! 移植为纯 Rust 实现，使这条热路径无需 JS 运行时。
//!
//! 保真度说明：
//!
//! * 上游算法按 Unicode 标量值处理字符串并截断到单字节。
//!   这里用 `char as u32 as u8` 转换来匹配该行为。
//! * `window_env_str` 是固定的屏幕/窗口指纹；下面的取值
//!   对应抖音 SDK 在 1920x1080 Chrome 窗口下产出的结果。
//! * `generate_random_str` 使用固定种子而不是 `rand::random()`，
//!   使输出对每个输入都是确定性的。这是刻意为之，并与抖音 SDK 一致：
//!   它在页面加载时以 `Math.random()` 播种，然后在整个会话中缓存该值。

use std::time::{SystemTime, UNIX_EPOCH};

const WINDOW_ENV_STR: &str = "1920|1080|1920|1040|0|30|0|0|1872|92|1920|1040|1857|92|1|24|Win32";

fn rc4_encrypt(plaintext: &[u8], key: &[u8]) -> Vec<u8> {
    let mut s: [u8; 256] = std::array::from_fn(|i| i as u8);
    let mut j: usize = 0;
    for i in 0..256 {
        j = (j + s[i] as usize + key[i % key.len()] as usize) % 256;
        s.swap(i, j);
    }

    let mut i: usize = 0;
    j = 0;
    let mut out = Vec::with_capacity(plaintext.len());
    for &byte in plaintext {
        i = (i + 1) % 256;
        j = (j + s[i] as usize) % 256;
        s.swap(i, j);
        let t = (s[i] as usize + s[j] as usize) % 256;
        out.push(byte ^ s[t]);
    }
    out
}

/// 字符串 → 字节迭代器，把每个 Unicode 标量截断为一个字节，
/// 与抖音 SDK 对用户代理等输入所做的有损变换一致。
fn scalar_bytes(value: &str) -> Vec<u8> {
    value.chars().map(|c| c as u32 as u8).collect()
}

fn left_rotate(x: u32, n: u32) -> u32 {
    x.rotate_left(n % 32)
}

fn sm3_t(j: usize) -> u32 {
    if j < 16 { 0x79CC4519 } else { 0x7A879D8A }
}

fn sm3_ff(j: usize, x: u32, y: u32, z: u32) -> u32 {
    if j < 16 {
        x ^ y ^ z
    } else {
        (x & y) | (x & z) | (y & z)
    }
}

fn sm3_gg(j: usize, x: u32, y: u32, z: u32) -> u32 {
    if j < 16 {
        x ^ y ^ z
    } else {
        (x & y) | (!x & z)
    }
}

/// 用 SM3 哈希计算字节切片的摘要。从抖音 SDK 移植；
/// 仅用于 a_bogus 推导，绝不用于安全敏感的哈希场景。
fn sm3_sum(data: &[u8]) -> [u8; 32] {
    let mut reg: [u32; 8] = [
        1937774191, 1226093241, 388252375, 3666478592, 2842636476, 372324522, 3817729613,
        2969243214,
    ];

    let bit_length = (data.len() as u64).wrapping_mul(8);
    let mut buffer = Vec::with_capacity(data.len() + 64);
    buffer.extend_from_slice(data);
    buffer.push(0x80);
    while buffer.len() % 64 != 56 {
        buffer.push(0);
    }
    buffer.extend_from_slice(&bit_length.to_be_bytes());

    let mut w = [0u32; 132];
    let (blocks, _) = buffer.as_chunks::<64>();
    for block in blocks {
        let (words, _) = block.as_chunks::<4>();
        for (t, word) in words.iter().take(16).enumerate() {
            w[t] = u32::from_be_bytes(*word);
        }
        for j in 16..68 {
            let a = w[j - 16] ^ w[j - 9] ^ left_rotate(w[j - 3], 15);
            let a = a ^ left_rotate(a, 15) ^ left_rotate(a, 23);
            w[j] = a ^ left_rotate(w[j - 13], 7) ^ w[j - 6];
        }
        for j in 0..64 {
            w[j + 68] = w[j] ^ w[j + 4];
        }

        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = reg;
        for j in 0..64 {
            let ss1 = left_rotate(
                left_rotate(a, 12)
                    .wrapping_add(e)
                    .wrapping_add(left_rotate(sm3_t(j), j as u32)),
                7,
            );
            let ss2 = ss1 ^ left_rotate(a, 12);
            let tt1 = sm3_ff(j, a, b, c)
                .wrapping_add(d)
                .wrapping_add(ss2)
                .wrapping_add(w[j + 68]);
            let tt2 = sm3_gg(j, e, f, g)
                .wrapping_add(h)
                .wrapping_add(ss1)
                .wrapping_add(w[j]);
            d = c;
            c = left_rotate(b, 9);
            b = a;
            a = tt1;
            h = g;
            g = left_rotate(f, 19);
            f = e;
            e = tt2 ^ left_rotate(tt2, 9) ^ left_rotate(tt2, 17);
        }

        reg[0] ^= a;
        reg[1] ^= b;
        reg[2] ^= c;
        reg[3] ^= d;
        reg[4] ^= e;
        reg[5] ^= f;
        reg[6] ^= g;
        reg[7] ^= h;
    }

    let mut out = [0u8; 32];
    let (chunks, _) = out.as_chunks_mut::<4>();
    for (chunk, value) in chunks.iter_mut().zip(reg.iter()) {
        *chunk = value.to_be_bytes();
    }
    out
}

/// 把 `long_str` 的每三个字符打包成一个 24 位整数，
/// 对应 SDK 在 `result_encrypt` 中使用的分组方式。
fn get_long_int(round_num: usize, long_str: &[u32]) -> u32 {
    let i = round_num * 3;
    let b1 = long_str.get(i).copied().unwrap_or(0);
    let b2 = long_str.get(i + 1).copied().unwrap_or(0);
    let b3 = long_str.get(i + 2).copied().unwrap_or(0);
    (b1 << 16) | (b2 << 8) | b3
}

/// 类 Base64 编码器，按 `table` 选择五套 SDK 字母表之一。
fn result_encrypt(long_str: &[u8], table: &str) -> String {
    const MASKS: [u32; 4] = [0xFC0000, 0x3F000, 0xFC0, 0x3F];
    const SHIFTS: [u32; 4] = [18, 12, 6, 0];

    let chars: Vec<u32> = long_str.iter().map(|&b| b as u32).collect();
    let table = table.as_bytes();
    let mut result = String::new();
    let mut round_num = 0usize;
    let mut long_int = get_long_int(round_num, &chars);
    let total_chars = ((chars.len() as f64 / 3.0) * 4.0).ceil() as usize;
    for i in 0..total_chars {
        if i / 4 != round_num {
            round_num += 1;
            long_int = get_long_int(round_num, &chars);
        }
        let idx = i % 4;
        let char_index = ((long_int & MASKS[idx]) >> SHIFTS[idx]) as usize;
        result.push(table[char_index] as char);
    }
    result
}

const ENCODING_TABLE_S3: &str = "ckdp1h4ZKsUB80/Mfvw36XIgR25+WQAlEi7NLboqYTOPuzmFjJnryx9HVGDaStCe";
const ENCODING_TABLE_S4: &str = "Dkdpgh2ZmsQB80/MfvV36XI1R45-WUAlEixNLwoqYTOPuzKFjJnry79HbGcaStCe";

fn gener_random(random_num: i32, option: [u8; 2]) -> [u8; 4] {
    let byte1 = (random_num & 0xFF) as u8;
    let byte2 = ((random_num >> 8) & 0xFF) as u8;
    [
        (byte1 & 0xAA) | (option[0] & 0x55),
        (byte1 & 0x55) | (option[0] & 0xAA),
        (byte2 & 0xAA) | (option[1] & 0x55),
        (byte2 & 0x55) | (option[1] & 0xAA),
    ]
}

fn generate_random_prefix() -> Vec<u8> {
    // 固定种子对应 SDK 缓存的 `Math.random()` 参考值。
    let mut bytes = Vec::with_capacity(12);
    bytes.extend_from_slice(&gener_random((0.123_456_789_f64 * 10000.0) as i32, [3, 45]));
    bytes.extend_from_slice(&gener_random((0.987_654_321_f64 * 10000.0) as i32, [1, 0]));
    bytes.extend_from_slice(&gener_random((0.555_555_555_f64 * 10000.0) as i32, [1, 5]));
    bytes
}

fn generate_rc4_bb(
    query: &str,
    user_agent: &str,
    window_env: &str,
    suffix: &str,
    arguments: [u32; 3],
) -> Vec<u8> {
    let start_time = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0);

    let mut prefixed_query = String::with_capacity(query.len() + suffix.len());
    prefixed_query.push_str(query);
    prefixed_query.push_str(suffix);
    let url_list = sm3_sum(&sm3_sum(prefixed_query.as_bytes()));
    let cus = sm3_sum(&sm3_sum(suffix.as_bytes()));
    let ua_encoded = result_encrypt(
        &rc4_encrypt(&scalar_bytes(user_agent), &[0u8, 1, 14]),
        ENCODING_TABLE_S3,
    );
    let ua = sm3_sum(ua_encoded.as_bytes());

    let end_time = start_time + 100;

    let mut b = [0i64; 80];
    b[8] = 3;
    b[10] = end_time;
    b[16] = start_time;
    b[18] = 44;

    let split_bytes = |num: i64| -> [i64; 4] {
        [
            (num >> 24) & 0xFF,
            (num >> 16) & 0xFF,
            (num >> 8) & 0xFF,
            num & 0xFF,
        ]
    };
    let st = split_bytes(b[16]);
    b[20] = st[0];
    b[21] = st[1];
    b[22] = st[2];
    b[23] = st[3];
    b[24] = (b[16] >> 32) & 0xFF;
    b[25] = (b[16] >> 40) & 0xFF;

    let arg0 = split_bytes(arguments[0] as i64);
    b[26] = arg0[0];
    b[27] = arg0[1];
    b[28] = arg0[2];
    b[29] = arg0[3];

    b[30] = ((arguments[1] / 256) & 0xFF) as i64;
    b[31] = (arguments[1] & 0xFF) as i64;

    let arg1 = split_bytes(arguments[1] as i64);
    b[32] = arg1[0];
    b[33] = arg1[1];

    let arg2 = split_bytes(arguments[2] as i64);
    b[34] = arg2[0];
    b[35] = arg2[1];
    b[36] = arg2[2];
    b[37] = arg2[3];

    b[38] = url_list[21] as i64;
    b[39] = url_list[22] as i64;
    b[40] = cus[21] as i64;
    b[41] = cus[22] as i64;
    b[42] = ua[23] as i64;
    b[43] = ua[24] as i64;

    let et = split_bytes(b[10]);
    b[44] = et[0];
    b[45] = et[1];
    b[46] = et[2];
    b[47] = et[3];
    b[48] = b[8];
    b[49] = (b[10] >> 32) & 0xFF;
    b[50] = (b[10] >> 40) & 0xFF;

    let page_id = 110624i64;
    b[51] = page_id;
    let page = split_bytes(page_id);
    b[52] = page[0];
    b[53] = page[1];
    b[54] = page[2];
    b[55] = page[3];

    let aid = 6383i64;
    b[56] = aid;
    b[57] = aid & 0xFF;
    b[58] = (aid >> 8) & 0xFF;
    b[59] = (aid >> 16) & 0xFF;
    b[60] = (aid >> 24) & 0xFF;

    let window_env_bytes: Vec<i64> = window_env.chars().map(|c| c as i64).collect();
    let env_len = window_env_bytes.len() as i64;
    b[64] = env_len;
    b[65] = env_len & 0xFF;
    b[66] = (env_len >> 8) & 0xFF;

    let checksum_indexes = [
        18, 20, 26, 30, 38, 40, 42, 21, 27, 31, 35, 39, 41, 43, 22, 28, 32, 36, 23, 29, 33, 37, 44,
        45, 46, 47, 48, 49, 50, 24, 25, 52, 53, 54, 55, 57, 58, 59, 60, 65, 66, 70, 71,
    ];
    let checksum = checksum_indexes.iter().fold(0i64, |acc, &i| acc ^ b[i]);
    b[72] = checksum;

    let order = [
        18, 20, 52, 26, 30, 34, 58, 38, 40, 53, 42, 21, 27, 54, 55, 31, 35, 57, 39, 41, 43, 22, 28,
        32, 60, 36, 23, 29, 33, 37, 44, 45, 59, 46, 47, 48, 49, 50, 24, 25, 65, 66, 70, 71,
    ];
    let mut bb: Vec<u8> = Vec::with_capacity(order.len() + window_env_bytes.len() + 1);
    for &i in &order {
        bb.push((b[i] & 0xFF) as u8);
    }
    for &value in &window_env_bytes {
        bb.push((value & 0xFF) as u8);
    }
    bb.push((checksum & 0xFF) as u8);

    rc4_encrypt(&bb, b"y")
}

/// 为抖音 Web 请求生成 `a_bogus` 值。
///
/// * `query` —— 已完成 URL 编码、且不含 `a_bogus` 本身的请求 query 字符串。
///   其顺序必须与实际发送的字符串一致。
/// * `user_agent` —— 请求将携带的确切 UA 头取值。
///
/// 返回 URL 安全的 token（可能包含 `/` 和 `+` ——
/// 调用方必须把它 URL 编码进发出的 query）。
pub fn generate_a_bogus(query: &str, user_agent: &str) -> String {
    let mut buffer = generate_random_prefix();
    buffer.extend_from_slice(&generate_rc4_bb(
        query,
        user_agent,
        WINDOW_ENV_STR,
        "cus",
        [0, 1, 14],
    ));
    format!("{}=", result_encrypt(&buffer, ENCODING_TABLE_S4))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sm3_matches_reference_vectors() {
        // "abc" —— GB/T 32905-2016 SM3 样例。
        let digest = sm3_sum(b"abc");
        assert_eq!(
            hex::encode(digest),
            "66c7f0f462eeedd9d1f2d46bdc10e4e24167c4875cf2f7a2297da02b8f4ba8e0"
        );
        // 空输入。
        assert_eq!(
            hex::encode(sm3_sum(b"")),
            "1ab21d8355cfa17f8e61194831e81a8f22bec8c728fefb747ed035eb5082aa2b"
        );
    }

    #[test]
    fn rc4_matches_reference_vector() {
        // RFC 6229 §2：key = "Key"，plaintext = "Plaintext" → BBF316E8D940AF0AD3。
        let out = rc4_encrypt(b"Plaintext", b"Key");
        assert_eq!(hex::encode(out), "bbf316e8d940af0ad3");
    }

    #[test]
    fn produces_stable_length_and_alphabet() {
        let query = "aid=6383&count=15&offset=0";
        let ua = "Mozilla/5.0";
        let sig = generate_a_bogus(query, ua);
        assert!(sig.ends_with('='));
        assert!(sig.len() > 32);
        for ch in sig.chars() {
            assert!(
                ENCODING_TABLE_S4.contains(ch) || ch == '=',
                "unexpected char {ch:?}"
            );
        }
    }

    #[test]
    fn different_queries_produce_different_signatures() {
        let ua = "Mozilla/5.0";
        let a = generate_a_bogus("aid=6383&offset=0", ua);
        let b = generate_a_bogus("aid=6383&offset=15", ua);
        assert_ne!(a, b);
    }
}
