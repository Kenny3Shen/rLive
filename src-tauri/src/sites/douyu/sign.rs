//! 经内嵌 CryptoJS 与房间 JS 完成斗鱼播放签名。

use quickjs_rusty::Context;

use crate::error::{AppError, AppResult};

const CRYPTO_JS: &str = include_str!("../../../assets/crypto-js.min.js");

/// QuickJS 原生提供旧版浏览器辅助对象；
/// 这些别名让动态下发的房间脚本兼容浏览器全局变量。
const BROWSER_ALIASES: &str = r#"
var global = globalThis;
var window = globalThis;
var self = globalThis;
if (typeof console === 'undefined') {
  var console = { log: function () {}, error: function () {}, warn: function () {} };
}
"#;

fn eval_js(ctx: &Context, src: &str, stage: &str) -> AppResult<()> {
    ctx.eval(src, false)
        .map_err(|e| AppError::new("douyu_sign", format!("{stage}: {e}")).with_site("douyu"))?;
    Ok(())
}

/// 执行房间加密脚本后运行 `ub98484234(rid, did, tt)`。
pub fn get_sign(html_js: &str, rid: &str) -> AppResult<String> {
    let ctx = Context::builder().build().map_err(|e| {
        AppError::new("douyu_sign", format!("JS 运行时创建失败: {e}")).with_site("douyu")
    })?;
    ctx.update_stack_top();

    eval_js(&ctx, BROWSER_ALIASES, "aliases eval")?;
    eval_js(&ctx, CRYPTO_JS, "crypto-js eval")?;
    eval_js(&ctx, html_js, "room js eval")?;

    let did = "10000000000000000000000000001501";
    let time = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
        .to_string();
    let value = ctx
        .call_function("ub98484234", vec![rid, did, time.as_str()])
        .map_err(|e| AppError::new("douyu_sign", format!("ub98484234: {e}")).with_site("douyu"))?;
    value
        .js_to_string()
        .map_err(|e| AppError::new("douyu_sign", format!("to_string: {e}")).with_site("douyu"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_provides_annex_b_escape_unescape() {
        let ctx = Context::builder().build().unwrap();
        ctx.update_stack_top();
        let value = ctx.eval(r#"unescape(escape("ab/cd_ef"))"#, false).unwrap();
        assert_eq!(value.js_to_string().unwrap(), "ab/cd_ef");
    }

    #[test]
    fn engine_provides_string_substr() {
        let ctx = Context::builder().build().unwrap();
        ctx.update_stack_top();
        let value = ctx
            .eval(r#""0123456789abcdef".substr(8, 2)"#, false)
            .unwrap();
        assert_eq!(value.js_to_string().unwrap(), "89");
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
