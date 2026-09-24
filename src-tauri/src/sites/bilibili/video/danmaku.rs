//! VOD 分段弹幕纯协议处理：段号计算与 seg.so protobuf 解码。
//!
//! 分段请求留在父模块，复用现有 protobuf 读取器解析响应。

use crate::danmu_rs::{ProtoReader, ProtoValue};
use crate::error::AppResult;
use crate::models::video::DanmakuItem;

use super::video_err;

/// 单条弹幕正文的字节上限，防止异常长文本进入渲染层。
const MAX_DANMAKU_CONTENT: usize = 512;

/// VOD 弹幕分段长度：6 分钟。
const DANMAKU_SEGMENT_MILLIS: i64 = 360_000;

// ---------------------------------------------------------------------------
// VOD 弹幕：seg.so protobuf
// ---------------------------------------------------------------------------

/// 段号：6 分钟一段，从 1 开始。
pub fn danmaku_segment_index(position_millis: i64) -> i64 {
    position_millis.max(0) / DANMAKU_SEGMENT_MILLIS + 1
}

/// 解码 `DmSegMobileReply`。
///
/// 手写解码而不引 protobuf 运行时：只需要读一层嵌套里的 7 个标量字段，
/// 为此拉入代码生成与运行时依赖并不划算。
///
/// 解码器必须**跳过未知字段**：实测单条 elem 会出现 13/20/21 等 schema 之外的
/// 字段，上游随时可能再加。遇到不认识的编号就按 wire type 跳过，
/// 否则每次上游扩展字段都会让弹幕整段解析失败。
pub fn decode_danmaku_segment(bytes: &[u8]) -> AppResult<Vec<DanmakuItem>> {
    let mut reader = ProtoReader::new(bytes);
    let mut items = Vec::new();
    while let Some((field, value)) = reader
        .next_field()
        .map_err(|e| video_err(format!("弹幕 protobuf: {e}")))?
    {
        // 顶层只关心 elems = 1；state / ai_flag / segment_rules 等一律跳过。
        if let (1, ProtoValue::Bytes(elem)) = (field, value)
            && let Some(item) = decode_danmaku_elem(elem)?
        {
            items.push(item);
        }
    }
    Ok(items)
}

fn decode_danmaku_elem(bytes: &[u8]) -> AppResult<Option<DanmakuItem>> {
    let mut reader = ProtoReader::new(bytes);
    let mut progress = 0_i64;
    let mut mode = 0_i32;
    let mut fontsize = 0_i32;
    let mut color = 0_u32;
    let mut content = String::new();
    let mut weight = 0_i32;
    let mut pool = 0_i32;
    while let Some((field, value)) = reader
        .next_field()
        .map_err(|e| video_err(format!("弹幕 elem protobuf: {e}")))?
    {
        match (field, value) {
            // 实测有约 1% 的弹幕省略 progress（proto3 省略零值），按 0 处理。
            (2, ProtoValue::Varint(raw)) => progress = raw as i64,
            (3, ProtoValue::Varint(raw)) => mode = raw as i32,
            (4, ProtoValue::Varint(raw)) => fontsize = raw as i32,
            (5, ProtoValue::Varint(raw)) => color = u32::try_from(raw).unwrap_or(0xff_ffff),
            (7, ProtoValue::Bytes(raw)) => {
                content = String::from_utf8_lossy(raw)
                    .chars()
                    .take(MAX_DANMAKU_CONTENT)
                    .collect();
            }
            (9, ProtoValue::Varint(raw)) => weight = raw as i32,
            (11, ProtoValue::Varint(raw)) => pool = raw as i32,
            _ => {}
        }
    }
    let content = content.trim().to_string();
    if content.is_empty() {
        return Ok(None);
    }
    Ok(Some(DanmakuItem {
        progress,
        // 上游省略这两个字段时按普通滚动弹幕与默认字号渲染，
        // 而不是用 0 —— 0 号模式不存在，0 字号会渲染成看不见的弹幕。
        mode: if mode == 0 { 1 } else { mode },
        fontsize: if fontsize == 0 { 25 } else { fontsize },
        color: if color == 0 { 0xff_ffff } else { color },
        content,
        weight,
        pool,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- protobuf 弹幕 ---

    fn varint(value: u64, out: &mut Vec<u8>) {
        let mut value = value;
        loop {
            let byte = (value & 0x7f) as u8;
            value >>= 7;
            if value == 0 {
                out.push(byte);
                return;
            }
            out.push(byte | 0x80);
        }
    }

    fn tag(field: u32, wire: u8, out: &mut Vec<u8>) {
        varint(u64::from(field) << 3 | u64::from(wire), out);
    }

    fn proto_varint(field: u32, value: u64, out: &mut Vec<u8>) {
        tag(field, 0, out);
        varint(value, out);
    }

    fn proto_bytes(field: u32, value: &[u8], out: &mut Vec<u8>) {
        tag(field, 2, out);
        varint(value.len() as u64, out);
        out.extend_from_slice(value);
    }

    #[test]
    fn danmaku_decoder_reads_scheduling_fields() {
        let mut elem = Vec::new();
        proto_varint(1, 2_190_644_797_575_173_888, &mut elem); // id
        proto_varint(2, 146_927, &mut elem); // progress
        proto_varint(3, 5, &mut elem); // mode 顶部
        proto_varint(4, 25, &mut elem); // fontsize
        proto_varint(5, 16_777_215, &mut elem); // color
        proto_bytes(6, b"e905bd13", &mut elem); // mid_hash
        proto_bytes(7, "喔～".as_bytes(), &mut elem); // content
        proto_varint(9, 11, &mut elem); // weight
        proto_varint(11, 1, &mut elem); // pool

        let mut reply = Vec::new();
        proto_bytes(1, &elem, &mut reply);

        let items = decode_danmaku_segment(&reply).expect("弹幕应解析成功");
        assert_eq!(items.len(), 1);
        let item = &items[0];
        assert_eq!(item.progress, 146_927);
        assert_eq!(item.mode, 5);
        assert_eq!(item.fontsize, 25);
        assert_eq!(item.color, 16_777_215);
        assert_eq!(item.content, "喔～");
        assert_eq!(item.weight, 11);
        assert_eq!(item.pool, 1);
    }

    #[test]
    fn danmaku_decoder_skips_unknown_fields_and_omitted_progress() {
        let mut elem = Vec::new();
        // 实测存在但不在 schema 内的字段：13 varint、20/21 bytes、24 varint。
        proto_varint(13, 1_048_576, &mut elem);
        proto_bytes(20, b"0", &mut elem);
        proto_bytes(21, b"0", &mut elem);
        proto_varint(24, 3, &mut elem);
        proto_varint(26, 41_473_934_959, &mut elem);
        // 未来可能出现的 fixed32 / fixed64，也必须能按 wire type 跳过。
        tag(90, 5, &mut elem);
        elem.extend_from_slice(&[1, 2, 3, 4]);
        tag(91, 1, &mut elem);
        elem.extend_from_slice(&[1, 2, 3, 4, 5, 6, 7, 8]);
        // progress 省略（proto3 零值），必须落到 0 而不是解析失败。
        proto_bytes(7, "无 progress".as_bytes(), &mut elem);

        let mut reply = Vec::new();
        proto_bytes(1, &elem, &mut reply);
        // 顶层同样有 schema 外/不关心的字段，一并跳过。
        proto_varint(2, 0, &mut reply);
        proto_bytes(4, b"\x01", &mut reply);
        proto_bytes(5, b"\x02", &mut reply);
        proto_bytes(6, b"ctx", &mut reply);

        let items = decode_danmaku_segment(&reply).expect("未知字段不得导致解析失败");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].progress, 0);
        assert_eq!(items[0].content, "无 progress");
        // mode / fontsize / color 省略时回落到可见的默认值。
        assert_eq!(items[0].mode, 1);
        assert_eq!(items[0].fontsize, 25);
        assert_eq!(items[0].color, 0xff_ffff);
    }

    #[test]
    fn danmaku_decoder_drops_empty_content_and_rejects_garbage() {
        let mut elem = Vec::new();
        proto_varint(2, 1_000, &mut elem);
        proto_bytes(7, b"   ", &mut elem); // 只有空白，丢弃
        let mut reply = Vec::new();
        proto_bytes(1, &elem, &mut reply);
        assert!(
            decode_danmaku_segment(&reply)
                .expect("应解析成功")
                .is_empty()
        );

        // 截断的 varint 必须报错，而不是静默返回半条弹幕。
        assert!(decode_danmaku_segment(&[0x0a, 0x05, 0x10]).is_err());
    }

    #[test]
    fn danmaku_segment_index_is_six_minute_buckets() {
        assert_eq!(danmaku_segment_index(0), 1);
        assert_eq!(danmaku_segment_index(-500), 1);
        assert_eq!(danmaku_segment_index(359_999), 1);
        assert_eq!(danmaku_segment_index(360_000), 2);
        assert_eq!(danmaku_segment_index(720_001), 3);
    }
}
