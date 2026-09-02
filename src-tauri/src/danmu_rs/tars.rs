//! 最小化 TARS 二进制编解码器（仅虎牙 WS 加入／推送解码所用的子集）。

#![allow(dead_code)]

/// TARS 类型标签（枚举序号）。
pub mod ty {
    pub const BYTE: u8 = 0;
    pub const SHORT: u8 = 1;
    pub const INT: u8 = 2;
    pub const LONG: u8 = 3;
    pub const FLOAT: u8 = 4;
    pub const DOUBLE: u8 = 5;
    pub const STRING1: u8 = 6;
    pub const STRING4: u8 = 7;
    pub const MAP: u8 = 8;
    pub const LIST: u8 = 9;
    pub const STRUCT_BEGIN: u8 = 10;
    pub const STRUCT_END: u8 = 11;
    pub const ZERO: u8 = 12;
    pub const SIMPLE_LIST: u8 = 13;
}

#[derive(Debug, Clone, Copy, Default)]
pub struct Head {
    pub typ: u8,
    pub tag: u8,
}

#[derive(Debug)]
pub struct TarsError(pub String);

type Result<T> = std::result::Result<T, TarsError>;

fn err(msg: impl Into<String>) -> TarsError {
    TarsError(msg.into())
}

// ─── 写入器 ───────────────────────────────────────────────────────────────────

#[derive(Default)]
pub struct TarsWriter {
    buf: Vec<u8>,
}

impl TarsWriter {
    pub fn new() -> Self {
        Self { buf: Vec::new() }
    }

    pub fn into_bytes(self) -> Vec<u8> {
        self.buf
    }

    pub fn write_head(&mut self, typ: u8, tag: u8) {
        if tag < 15 {
            self.buf.push((tag << 4) | (typ & 0x0f));
        } else {
            self.buf.push(0xf0 | (typ & 0x0f));
            self.buf.push(tag);
        }
    }

    pub fn write_bool(&mut self, v: bool, tag: u8) {
        self.write_i64(i64::from(v), tag);
    }

    pub fn write_i64(&mut self, n: i64, tag: u8) {
        if (-128..=127).contains(&n) {
            if n == 0 {
                self.write_head(ty::ZERO, tag);
            } else {
                self.write_head(ty::BYTE, tag);
                self.buf.push(n as u8);
            }
            return;
        }
        if (-32768..=32767).contains(&n) {
            self.write_head(ty::SHORT, tag);
            self.buf.extend_from_slice(&(n as i16).to_be_bytes());
            return;
        }
        if (-2_147_483_648..=2_147_483_647).contains(&n) {
            self.write_head(ty::INT, tag);
            self.buf.extend_from_slice(&(n as i32).to_be_bytes());
            return;
        }
        self.write_head(ty::LONG, tag);
        self.buf.extend_from_slice(&n.to_be_bytes());
    }

    pub fn write_string(&mut self, s: &str, tag: u8) {
        let bytes = s.as_bytes();
        if bytes.len() > 255 {
            self.write_head(ty::STRING4, tag);
            self.buf
                .extend_from_slice(&(bytes.len() as u32).to_be_bytes());
            self.buf.extend_from_slice(bytes);
        } else {
            self.write_head(ty::STRING1, tag);
            self.buf.push(bytes.len() as u8);
            self.buf.extend_from_slice(bytes);
        }
    }

    pub fn write_bytes(&mut self, data: &[u8], tag: u8) {
        self.write_head(ty::SIMPLE_LIST, tag);
        self.write_head(ty::BYTE, 0);
        self.write_i64(data.len() as i64, 0);
        self.buf.extend_from_slice(data);
    }

    /// 写入嵌套的 TARS 结构体。结构体 body 共用同一个写入器，
    /// 因此调用方可以用普通的标量辅助函数写它的字段。
    pub fn write_struct(&mut self, tag: u8, write_body: impl FnOnce(&mut Self)) {
        self.write_head(ty::STRUCT_BEGIN, tag);
        write_body(self);
        self.write_head(ty::STRUCT_END, 0);
    }

    /// 写入空向量。虎牙的发送请求包含若干可选向量字段，即使没有 @ 任何人
    /// 或打任何标签，它们在 Web 客户端数据包中也必须存在。
    pub fn write_empty_list(&mut self, tag: u8) {
        self.write_head(ty::LIST, tag);
        self.write_i64(0, 0);
    }

    /// 写入 `map<string, string>`，用于虎牙的 websocket 连接与 WUP 信封。
    /// 条目的 key/value 标签由 TARS 规定。
    pub fn write_map_string_string(&mut self, tag: u8, entries: &[(&str, &str)]) {
        self.write_head(ty::MAP, tag);
        self.write_i64(entries.len() as i64, 0);
        for (key, value) in entries {
            self.write_string(key, 0);
            self.write_string(value, 1);
        }
    }

    /// 写入 `map<string, bytes>`。WUP v3 的 `newdata` map 把每个
    /// 请求/响应字段都存为一个独立序列化的字节缓冲区。
    pub fn write_map_string_bytes(&mut self, tag: u8, entries: &[(&str, &[u8])]) {
        self.write_head(ty::MAP, tag);
        self.write_i64(entries.len() as i64, 0);
        for (key, value) in entries {
            self.write_string(key, 0);
            self.write_bytes(value, 1);
        }
    }
}

// ─── 读取器 ───────────────────────────────────────────────────────────────────

pub struct TarsReader<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> TarsReader<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }

    fn ensure(&self, n: usize) -> Result<()> {
        if self.pos + n > self.data.len() {
            Err(err("unexpected end of buffer"))
        } else {
            Ok(())
        }
    }

    fn read_u8(&mut self) -> Result<u8> {
        self.ensure(1)?;
        let b = self.data[self.pos];
        self.pos += 1;
        Ok(b)
    }

    fn read_exact(&mut self, n: usize) -> Result<&'a [u8]> {
        self.ensure(n)?;
        let s = &self.data[self.pos..self.pos + n];
        self.pos += n;
        Ok(s)
    }

    fn peek_head(&self) -> Result<(Head, usize)> {
        self.ensure(1)?;
        let b = self.data[self.pos];
        let typ = b & 0x0f;
        let mut tag = (b & 0xf0) >> 4;
        let mut consumed = 1usize;
        if tag == 15 {
            self.ensure(2)?;
            tag = self.data[self.pos + 1];
            consumed = 2;
        }
        Ok((Head { typ, tag }, consumed))
    }

    fn read_head(&mut self) -> Result<Head> {
        let (hd, n) = self.peek_head()?;
        self.pos += n;
        Ok(hd)
    }

    fn skip(&mut self, n: usize) -> Result<()> {
        self.ensure(n)?;
        self.pos += n;
        Ok(())
    }

    fn skip_field_with_type(&mut self, typ: u8) -> Result<()> {
        match typ {
            ty::BYTE => self.skip(1),
            ty::SHORT => self.skip(2),
            ty::INT | ty::FLOAT => self.skip(4),
            ty::LONG | ty::DOUBLE => self.skip(8),
            ty::STRING1 => {
                let len = self.read_u8()? as usize;
                self.skip(len)
            }
            ty::STRING4 => {
                let raw = self.read_exact(4)?;
                let len = u32::from_be_bytes([raw[0], raw[1], raw[2], raw[3]]) as usize;
                self.skip(len)
            }
            ty::MAP => {
                let size = self.read_i64(0, true)? as usize;
                for _ in 0..size * 2 {
                    self.skip_field()?;
                }
                Ok(())
            }
            ty::LIST => {
                let size = self.read_i64(0, true)? as usize;
                for _ in 0..size {
                    self.skip_field()?;
                }
                Ok(())
            }
            ty::SIMPLE_LIST => {
                let hd = self.read_head()?;
                if hd.typ != ty::BYTE {
                    return Err(err(format!("simple list elem type {}", hd.typ)));
                }
                let size = self.read_i64(0, true)? as usize;
                self.skip(size)
            }
            ty::STRUCT_BEGIN => self.skip_to_struct_end(),
            ty::STRUCT_END | ty::ZERO => Ok(()),
            _ => Err(err(format!("unknown type {typ}"))),
        }
    }

    fn skip_field(&mut self) -> Result<()> {
        let hd = self.read_head()?;
        self.skip_field_with_type(hd.typ)
    }

    fn skip_to_struct_end(&mut self) -> Result<()> {
        loop {
            let hd = self.read_head()?;
            if hd.typ == ty::STRUCT_END {
                return Ok(());
            }
            self.skip_field_with_type(hd.typ)?;
        }
    }

    fn skip_to_tag(&mut self, tag: u8) -> Result<bool> {
        loop {
            if self.pos >= self.data.len() {
                return Ok(false);
            }
            let (hd, n) = match self.peek_head() {
                Ok(v) => v,
                Err(_) => return Ok(false),
            };
            if tag <= hd.tag || hd.typ == ty::STRUCT_END {
                return Ok(tag == hd.tag);
            }
            self.pos += n;
            self.skip_field_with_type(hd.typ)?;
        }
    }

    pub fn read_i64(&mut self, tag: u8, required: bool) -> Result<i64> {
        if !self.skip_to_tag(tag)? {
            if required {
                return Err(err(format!("required int tag {tag} missing")));
            }
            return Ok(0);
        }
        let hd = self.read_head()?;
        match hd.typ {
            ty::ZERO => Ok(0),
            ty::BYTE => {
                let b = self.read_u8()? as i8;
                Ok(i64::from(b))
            }
            ty::SHORT => {
                let raw = self.read_exact(2)?;
                Ok(i64::from(i16::from_be_bytes([raw[0], raw[1]])))
            }
            ty::INT => {
                let raw = self.read_exact(4)?;
                Ok(i64::from(i32::from_be_bytes([
                    raw[0], raw[1], raw[2], raw[3],
                ])))
            }
            ty::LONG => {
                let raw = self.read_exact(8)?;
                Ok(i64::from_be_bytes([
                    raw[0], raw[1], raw[2], raw[3], raw[4], raw[5], raw[6], raw[7],
                ]))
            }
            _ => Err(err(format!("int type mismatch {}", hd.typ))),
        }
    }

    pub fn read_string(&mut self, tag: u8, required: bool) -> Result<String> {
        if !self.skip_to_tag(tag)? {
            if required {
                return Err(err(format!("required string tag {tag} missing")));
            }
            return Ok(String::new());
        }
        let hd = self.read_head()?;
        let len = match hd.typ {
            ty::STRING1 => self.read_u8()? as usize,
            ty::STRING4 => {
                let raw = self.read_exact(4)?;
                u32::from_be_bytes([raw[0], raw[1], raw[2], raw[3]]) as usize
            }
            ty::ZERO => 0,
            _ => return Err(err(format!("string type mismatch {}", hd.typ))),
        };
        if len == 0 {
            return Ok(String::new());
        }
        let bytes = self.read_exact(len)?;
        Ok(String::from_utf8_lossy(bytes).into_owned())
    }

    /// 在借用通用 TARS simple-list 编码的同时读取字节列表。
    ///
    /// 虎牙的 websocket 信封包含嵌套的 `simple list<byte>` 字段。它的实时解码器
    /// 只需同步检查这些字段，因此这样可以避免把两层信封都克隆进临时 `Vec`。
    /// 通用的 `list<byte>` 仍作为持有所有权的兜底方案受支持。
    pub fn read_bytes_cow(
        &mut self,
        tag: u8,
        required: bool,
    ) -> Result<std::borrow::Cow<'a, [u8]>> {
        if !self.skip_to_tag(tag)? {
            if required {
                return Err(err(format!("required bytes tag {tag} missing")));
            }
            return Ok(std::borrow::Cow::Borrowed(&[]));
        }
        let hd = self.read_head()?;
        match hd.typ {
            ty::SIMPLE_LIST => {
                let hh = self.read_head()?;
                if hh.typ != ty::BYTE {
                    return Err(err("simple list not byte"));
                }
                let size = self.read_i64(0, true)? as usize;
                Ok(std::borrow::Cow::Borrowed(self.read_exact(size)?))
            }
            ty::LIST => {
                let size = self.read_i64(0, true)? as usize;
                let mut out = Vec::with_capacity(size);
                for _ in 0..size {
                    out.push(self.read_i64(0, true)? as u8);
                }
                Ok(std::borrow::Cow::Owned(out))
            }
            _ => Err(err(format!("bytes type mismatch {}", hd.typ))),
        }
    }

    pub fn read_bytes(&mut self, tag: u8, required: bool) -> Result<Vec<u8>> {
        Ok(self.read_bytes_cow(tag, required)?.into_owned())
    }

    pub fn read_map_string_bytes(
        &mut self,
        tag: u8,
        required: bool,
    ) -> Result<Vec<(String, Vec<u8>)>> {
        if !self.skip_to_tag(tag)? {
            if required {
                return Err(err(format!("required map tag {tag} missing")));
            }
            return Ok(Vec::new());
        }
        let hd = self.read_head()?;
        if hd.typ != ty::MAP {
            return Err(err(format!("map type mismatch {}", hd.typ)));
        }
        let size = self.read_i64(0, true)?;
        if !(0..=16_384).contains(&size) {
            return Err(err(format!("invalid map size {size}")));
        }
        let mut out = Vec::with_capacity(size as usize);
        for _ in 0..size {
            out.push((self.read_string(0, true)?, self.read_bytes(1, true)?));
        }
        Ok(out)
    }

    /// 读取向量长度，并让读取器停在其第一个元素处。对于需要在继续读取后续
    /// 结构体字段之前跳过或校验空可选向量的调用方，这已经足够。
    pub fn read_list_len(&mut self, tag: u8, required: bool) -> Result<usize> {
        if !self.skip_to_tag(tag)? {
            if required {
                return Err(err(format!("required list tag {tag} missing")));
            }
            return Ok(0);
        }
        let hd = self.read_head()?;
        if hd.typ != ty::LIST {
            return Err(err(format!("list type mismatch {}", hd.typ)));
        }
        let size = self.read_i64(0, true)?;
        if !(0..=65_536).contains(&size) {
            return Err(err(format!("invalid list size {size}")));
        }
        Ok(size as usize)
    }

    pub fn read_struct_begin(&mut self, tag: u8, required: bool) -> Result<bool> {
        if !self.skip_to_tag(tag)? {
            if required {
                return Err(err(format!("required struct tag {tag} missing")));
            }
            return Ok(false);
        }
        let hd = self.read_head()?;
        if hd.typ != ty::STRUCT_BEGIN {
            return Err(err(format!("struct type mismatch {}", hd.typ)));
        }
        Ok(true)
    }

    pub fn read_struct_end(&mut self) -> Result<()> {
        self.skip_to_struct_end()
    }
}

/// 虎牙直播聊天 `sendMessage` 接口所需的 TARS WUP v3 响应的一小部分。
/// 把它放在这里，使协议分帧可以独立于 websocket 传输做测试。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WupV3Response {
    pub request_id: i64,
    pub servant: String,
    pub function: String,
    pub data: Vec<(String, Vec<u8>)>,
}

/// 编码一个 WUP v3 数据包。`fields` 中已经是序列化好的 TARS 值
/// （例如 key 为 `tReq` 的 `HUYA.SendMessageReq` 结构体）。
pub fn encode_wup_v3(
    servant: &str,
    function: &str,
    request_id: i64,
    fields: &[(&str, &[u8])],
) -> Vec<u8> {
    let mut field_map = TarsWriter::new();
    field_map.write_map_string_bytes(0, fields);
    let field_map = field_map.into_bytes();

    let mut envelope = TarsWriter::new();
    // Tars WUP RequestPacket 的字段从 tag 1 开始，而不是 0。
    envelope.write_i64(3, 1); // iVersion = WUP v3
    envelope.write_i64(0, 2); // cPacketType
    envelope.write_i64(0, 3); // iMessageType
    envelope.write_i64(request_id, 4);
    envelope.write_string(servant, 5);
    envelope.write_string(function, 6);
    envelope.write_bytes(&field_map, 7);
    envelope.write_i64(0, 8); // 9 一个日志文件的尾部，对应 `commands::diagnostics::LogFileContent`。
    envelope.write_map_string_string(9, &[]); // 1 "关于"面板的日志查看器。 Windows 发布版没有控制台，`rlive.log` 是用户反馈失败时唯一能引用的记录。 该日志在设计上只记录失败 —— `init_logging` 绝不写 Cookie 值、token 或聊天文本 —— 因此在这里展示它不会暴露凭据。
    envelope.write_map_string_string(10, &[]); // status
    let envelope = envelope.into_bytes();

    let total = envelope.len().saturating_add(4);
    let mut out = Vec::with_capacity(total);
    out.extend_from_slice(&(total as u32).to_be_bytes());
    out.extend_from_slice(&envelope);
    out
}

/// 解码在虎牙 websocket 命令中收到的 WUP v3 响应包。
pub fn decode_wup_v3(packet: &[u8]) -> Result<WupV3Response> {
    if packet.len() < 4 {
        return Err(err("wup packet shorter than length prefix"));
    }
    let total = u32::from_be_bytes([packet[0], packet[1], packet[2], packet[3]]) as usize;
    if total != packet.len() || total < 4 {
        return Err(err(format!(
            "wup length mismatch: declared {total}, got {}",
            packet.len()
        )));
    }

    let mut envelope = TarsReader::new(&packet[4..]);
    let version = envelope.read_i64(1, true)?;
    if version != 3 {
        return Err(err(format!("unsupported wup version {version}")));
    }
    let _packet_type = envelope.read_i64(2, true)?;
    let _message_type = envelope.read_i64(3, true)?;
    let request_id = envelope.read_i64(4, true)?;
    let servant = envelope.read_string(5, true)?;
    let function = envelope.read_string(6, true)?;
    let buffer = envelope.read_bytes(7, true)?;

    let mut fields = TarsReader::new(&buffer);
    let data = fields.read_map_string_bytes(0, true)?;
    Ok(WupV3Response {
        request_id,
        servant,
        function,
        data,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_read_join_shape() {
        // 对齐虎牙 getJoinData 的内层与外层信封。
        let mut inner = TarsWriter::new();
        inner.write_i64(1234567890, 0);
        inner.write_bool(true, 1);
        inner.write_string("", 2);
        inner.write_string("", 3);
        inner.write_i64(111, 4);
        inner.write_i64(111, 5);
        inner.write_i64(0, 6);
        inner.write_i64(0, 7);
        let inner_bytes = inner.into_bytes();

        let mut outer = TarsWriter::new();
        outer.write_i64(1, 0);
        outer.write_bytes(&inner_bytes, 1);
        let packet = outer.into_bytes();

        let mut r = TarsReader::new(&packet);
        assert_eq!(r.read_i64(0, true).unwrap(), 1);
        let body = r.read_bytes(1, true).unwrap();
        let mut ir = TarsReader::new(&body);
        assert_eq!(ir.read_i64(0, true).unwrap(), 1234567890);
        assert_eq!(ir.read_i64(1, true).unwrap(), 1); // bool true
        assert_eq!(ir.read_string(2, true).unwrap(), "");
        assert_eq!(ir.read_i64(4, true).unwrap(), 111);
    }

    #[test]
    fn simple_byte_list_borrows_the_source_buffer() {
        let mut writer = TarsWriter::new();
        writer.write_bytes(b"huya-push", 1);
        let packet = writer.into_bytes();

        let mut reader = TarsReader::new(&packet);
        let bytes = reader.read_bytes_cow(1, true).unwrap();
        assert!(matches!(bytes, std::borrow::Cow::Borrowed(_)));
        assert_eq!(bytes.as_ref(), b"huya-push");
    }

    #[test]
    fn wup_v3_round_trip_preserves_request_metadata_and_struct_bytes() {
        let mut request = TarsWriter::new();
        request.write_struct(0, |writer| {
            writer.write_string("hello", 3);
        });
        let request = request.into_bytes();
        let encoded = encode_wup_v3("liveui", "sendMessage", 42, &[("tReq", &request)]);

        let decoded = decode_wup_v3(&encoded).unwrap();
        assert_eq!(decoded.request_id, 42);
        assert_eq!(decoded.servant, "liveui");
        assert_eq!(decoded.function, "sendMessage");
        assert_eq!(decoded.data, vec![("tReq".into(), request)]);
    }

    #[test]
    fn wup_v3_rejects_a_tampered_length_prefix() {
        let mut packet = encode_wup_v3("liveui", "sendMessage", 1, &[]);
        packet[3] = packet[3].saturating_sub(1);
        assert!(decode_wup_v3(&packet).is_err());
    }
}
