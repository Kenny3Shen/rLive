//! Douyu play-sign via embedded CryptoJS + room JS (simple_live DouyuSign).
//!
//! Boa is not a browser:
//! - CryptoJS UMD must attach to `globalThis` (script `this` is unreliable)
//! - room scripts call legacy `escape` / `unescape`
//! - decrypted payload uses deprecated `String.prototype.substr`

use boa_engine::{Context, Source};

use crate::error::{AppError, AppResult};

const CRYPTO_JS: &str = include_str!("../../../assets/crypto-js.min.js");

/// Browser-ish globals required by CryptoJS and Douyu's obfuscated room script.
const BROWSER_POLYFILL: &str = r#"
var global = globalThis;
var window = globalThis;
var self = globalThis;
if (typeof console === 'undefined') {
  var console = { log: function () {}, error: function () {}, warn: function () {} };
}
function escape(str) {
  str = String(str);
  var out = "";
  for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i);
    if (
      (c >= 0x30 && c <= 0x39) ||
      (c >= 0x41 && c <= 0x5a) ||
      (c >= 0x61 && c <= 0x7a) ||
      c === 0x40 || c === 0x2a || c === 0x5f ||
      c === 0x2b || c === 0x2d || c === 0x2e || c === 0x2f
    ) {
      out += str.charAt(i);
    } else if (c < 256) {
      var h = c.toString(16).toUpperCase();
      out += "%" + (h.length < 2 ? "0" + h : h);
    } else {
      var u = c.toString(16).toUpperCase();
      while (u.length < 4) u = "0" + u;
      out += "%u" + u;
    }
  }
  return out;
}
function unescape(str) {
  str = String(str);
  return str.replace(/%u([0-9A-Fa-f]{4})/g, function (_, hex) {
    return String.fromCharCode(parseInt(hex, 16));
  }).replace(/%([0-9A-Fa-f]{2})/g, function (_, hex) {
    return String.fromCharCode(parseInt(hex, 16));
  });
}
// Boa has no String.prototype.substr; Douyu's eval'd payload calls it.
if (typeof String.prototype.substr !== 'function') {
  String.prototype.substr = function (start, length) {
    start = Number(start) || 0;
    var s = String(this);
    if (start < 0) start = Math.max(s.length + start, 0);
    if (length === undefined || length === null) return s.substring(start);
    length = Number(length);
    if (isNaN(length) || length <= 0) return '';
    return s.substring(start, start + length);
  };
}
"#;

fn eval_js(ctx: &mut Context, src: &str, stage: &str) -> AppResult<()> {
    ctx.eval(Source::from_bytes(src)).map_err(|e| {
        AppError::new("douyu_sign", format!("{stage}: {e}")).with_site("douyu")
    })?;
    Ok(())
}

/// Run `ub98484234(rid, did, tt)` after evaluating the room encrypt script.
pub fn get_sign(html_js: &str, rid: &str) -> AppResult<String> {
    let mut ctx = Context::default();

    eval_js(&mut ctx, BROWSER_POLYFILL, "polyfill eval")?;

    // CryptoJS UMD: `t.CryptoJS = e()` with `t` = first IIFE arg. Force globalThis.
    let crypto_js = CRYPTO_JS.replacen("(this,", "(globalThis,", 1);
    eval_js(&mut ctx, &crypto_js, "crypto-js eval")?;

    eval_js(&mut ctx, html_js, "room js eval")?;

    let did = "10000000000000000000000000001501";
    let time = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // rid/did/time are digits; keep as plain string literals.
    let call = format!("ub98484234('{rid}','{did}','{time}')");
    let value = ctx.eval(Source::from_bytes(&call)).map_err(|e| {
        AppError::new("douyu_sign", format!("ub98484234: {e}")).with_site("douyu")
    })?;
    value
        .to_string(&mut ctx)
        .map(|js| js.to_std_string_escaped())
        .map_err(|e| AppError::new("douyu_sign", format!("to_string: {e}")).with_site("douyu"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn polyfill_escape_unescape_roundtrip() {
        let mut ctx = Context::default();
        ctx.eval(Source::from_bytes(BROWSER_POLYFILL)).unwrap();
        let v = ctx
            .eval(Source::from_bytes(r#"unescape(escape("ab/cd_ef"))"#))
            .unwrap();
        let s = v.to_string(&mut ctx).unwrap().to_std_string_escaped();
        assert_eq!(s, "ab/cd_ef");
    }

    #[test]
    fn polyfill_substr() {
        let mut ctx = Context::default();
        ctx.eval(Source::from_bytes(BROWSER_POLYFILL)).unwrap();
        let v = ctx
            .eval(Source::from_bytes(r#""0123456789abcdef".substr(8, 2)"#))
            .unwrap();
        let s = v.to_string(&mut ctx).unwrap().to_std_string_escaped();
        assert_eq!(s, "89");
    }

    #[test]
    fn sign_minimal_script_with_cryptojs_md5() {
        let room_js = r#"
            function ub98484234(rid, did, tt) {
                var v = CryptoJS.MD5(rid + did + tt).toString();
                return "v=220120250101&did=" + did + "&tt=" + tt + "&sign=" + v + "&rid=" + rid;
            }
        "#;
        let out = get_sign(room_js, "9999").expect("sign");
        assert!(out.contains("did="), "{out}");
        assert!(out.contains("sign="), "{out}");
        assert!(out.contains("rid=9999"), "{out}");
    }

    #[test]
    fn sign_real_room_script_if_present() {
        let path = "/tmp/douyu_room_real.js";
        let Ok(js) = std::fs::read_to_string(path) else {
            return;
        };
        if js.is_empty() || !js.contains("ub98484234") {
            return;
        }
        let out = get_sign(&js, "252140").expect("real room sign");
        assert!(out.contains("sign="), "{out}");
        assert!(out.contains("did="), "{out}");
    }
}
