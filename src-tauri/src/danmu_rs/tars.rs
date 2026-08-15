//! Minimal TARS binary codec (subset used by Huya WS join / push decode).
//! Ported from simple_live's `tars_dart` package.

#![allow(dead_code)]

/// TARS type tags (enum ordinal).
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

impl std::fmt::Display for TarsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "tars: {}", self.0)
    }
}

impl std::error::Error for TarsError {}

type Result<T> = std::result::Result<T, TarsError>;

fn err(msg: impl Into<String>) -> TarsError {
    TarsError(msg.into())
}

// ─── Writer ───────────────────────────────────────────────────────────────────

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

    pub fn as_slice(&self) -> &[u8] {
        &self.buf
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

    /// Write a nested TARS struct. The struct body owns the same writer so
    /// callers can use the ordinary scalar helpers for its fields.
    pub fn write_struct(&mut self, tag: u8, write_body: impl FnOnce(&mut Self)) {
        self.write_head(ty::STRUCT_BEGIN, tag);
        write_body(self);
        self.write_head(ty::STRUCT_END, 0);
    }

    /// Write an empty vector. Huya's send request includes a couple of
    /// optional vector fields which must still be present in the web client
    /// packet, even when no one is mentioned or tagged.
    pub fn write_empty_list(&mut self, tag: u8) {
        self.write_head(ty::LIST, tag);
        self.write_i64(0, 0);
    }

    /// Write `map<string, string>`, used by Huya websocket connection and
    /// WUP envelopes. The entry key/value tags are prescribed by TARS.
    pub fn write_map_string_string(&mut self, tag: u8, entries: &[(&str, &str)]) {
        self.write_head(ty::MAP, tag);
        self.write_i64(entries.len() as i64, 0);
        for (key, value) in entries {
            self.write_string(key, 0);
            self.write_string(value, 1);
        }
    }

    /// Write `map<string, bytes>`. WUP v3's `newdata` map stores every
    /// request/response field as one independently serialized byte buffer.
    pub fn write_map_string_bytes(&mut self, tag: u8, entries: &[(&str, &[u8])]) {
        self.write_head(ty::MAP, tag);
        self.write_i64(entries.len() as i64, 0);
        for (key, value) in entries {
            self.write_string(key, 0);
            self.write_bytes(value, 1);
        }
    }
}

// ─── Reader ───────────────────────────────────────────────────────────────────

pub struct TarsReader<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> TarsReader<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }

    pub fn remaining(&self) -> usize {
        self.data.len().saturating_sub(self.pos)
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

    /// Read a byte list while borrowing the common TARS simple-list encoding.
    ///
    /// Huya's websocket envelopes contain nested `simple list<byte>` fields.
    /// Its live decoder only needs to inspect those fields synchronously, so
    /// this avoids cloning both envelope layers into temporary `Vec`s. Generic
    /// `list<byte>` remains supported as an owned fallback.
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

    pub fn read_map_string_string(
        &mut self,
        tag: u8,
        required: bool,
    ) -> Result<Vec<(String, String)>> {
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
            out.push((self.read_string(0, true)?, self.read_string(1, true)?));
        }
        Ok(out)
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

    /// Read a vector length and leave the reader positioned at its first
    /// element. This is enough for callers that need to skip or validate an
    /// empty optional vector before continuing with following struct fields.
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

/// The small portion of a TARS WUP v3 response required by Huya's live-chat
/// `sendMessage` endpoint. Keeping it here makes the protocol framing easy to
/// test separately from the websocket transport.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WupV3Response {
    pub request_id: i64,
    pub servant: String,
    pub function: String,
    pub data: Vec<(String, Vec<u8>)>,
}

/// Encode a WUP v3 packet. `fields` are already serialized TARS values (for
/// example a `HUYA.SendMessageReq` struct at key `tReq`).
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
    // Tars WUP RequestPacket fields start at tag 1, not zero.
    envelope.write_i64(3, 1); // iVersion = WUP v3
    envelope.write_i64(0, 2); // cPacketType
    envelope.write_i64(0, 3); // iMessageType
    envelope.write_i64(request_id, 4);
    envelope.write_string(servant, 5);
    envelope.write_string(function, 6);
    envelope.write_bytes(&field_map, 7);
    envelope.write_i64(0, 8); // iTimeout
    envelope.write_map_string_string(9, &[]); // context
    envelope.write_map_string_string(10, &[]); // status
    let envelope = envelope.into_bytes();

    let total = envelope.len().saturating_add(4);
    let mut out = Vec::with_capacity(total);
    out.extend_from_slice(&(total as u32).to_be_bytes());
    out.extend_from_slice(&envelope);
    out
}

/// Decode a WUP v3 response packet received inside a Huya websocket command.
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
    let _timeout = envelope.read_i64(8, true)?;
    let _context = envelope.read_map_string_string(9, true)?;
    let _status = envelope.read_map_string_string(10, true)?;

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
        // Mirror Huya getJoinData inner + outer envelope.
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

    #[test]
    fn heartbeat_base64_decodes() {
        // simple_live: base64 "ABQdAAwsNgBM"
        let raw = base64_decode_std("ABQdAAwsNgBM").unwrap();
        assert!(!raw.is_empty());
        assert_eq!(raw[0], 0x00);
    }

    fn base64_decode_std(s: &str) -> Option<Vec<u8>> {
        const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut inv = [255u8; 256];
        for (i, &c) in T.iter().enumerate() {
            inv[c as usize] = i as u8;
        }
        let s: Vec<u8> = s
            .bytes()
            .filter(|c| !c.is_ascii_whitespace() && *c != b'=')
            .collect();
        let mut out = Vec::with_capacity(s.len() * 3 / 4);
        for chunk in s.chunks(4) {
            if chunk.len() < 2 {
                break;
            }
            let mut n = 0u32;
            let mut bits = 0;
            for &c in chunk {
                let v = inv[c as usize];
                if v == 255 {
                    return None;
                }
                n = (n << 6) | u32::from(v);
                bits += 6;
            }
            while bits >= 8 {
                bits -= 8;
                out.push((n >> bits) as u8);
                n &= (1 << bits) - 1;
            }
        }
        Some(out)
    }
}
