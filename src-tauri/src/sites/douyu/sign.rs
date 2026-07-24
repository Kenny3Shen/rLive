//! Douyu play-sign via embedded CryptoJS + room JS (simple_live DouyuSign).

use boa_engine::{Context, Source};

use crate::error::{AppError, AppResult};

const CRYPTO_JS: &str = include_str!("../../../assets/crypto-js.min.js");

/// Run `ub98484234(rid, did, tt)` after evaluating the room encrypt script.
pub fn get_sign(html_js: &str, rid: &str) -> AppResult<String> {
    let mut ctx = Context::default();
    ctx.eval(Source::from_bytes(CRYPTO_JS))
        .map_err(|e| AppError::new("douyu_sign", format!("crypto-js eval: {e}")).with_site("douyu"))?;
    ctx.eval(Source::from_bytes(html_js))
        .map_err(|e| AppError::new("douyu_sign", format!("room js eval: {e}")).with_site("douyu"))?;

    let did = "10000000000000000000000000001501";
    let time = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let call = format!("ub98484234('{rid}','{did}','{time}')");
    let value = ctx
        .eval(Source::from_bytes(&call))
        .map_err(|e| AppError::new("douyu_sign", format!("ub98484234: {e}")).with_site("douyu"))?;
    value
        .to_string(&mut ctx)
        .map(|js| js.to_std_string_escaped())
        .map_err(|e| AppError::new("douyu_sign", format!("to_string: {e}")).with_site("douyu"))
}
