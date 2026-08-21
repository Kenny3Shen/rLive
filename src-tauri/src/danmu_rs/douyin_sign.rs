//! Local Douyin webcast signature (MSSDK / X-Bogus style).
//!
//! The web IM WSS URL needs a short-lived `signature` query parameter derived
//! from room id + anonymous `user_unique_id`. The algorithm lives in Douyin's
//! browser `webmssdk` script; rLive evaluates that script with QuickJS.

use md5::{Digest, Md5};
use quickjs_rusty::Context;

use crate::error::{AppError, AppResult};
use crate::sites::douyin::DEFAULT_USER_AGENT;

/// Obfuscated Douyin web MSSDK entry that exports `getMSSDKSignature`.
const WEB_MS_SDK: &str = include_str!("../../assets/douyin_webmssdk.js");

const MAX_SIGNATURE_ATTEMPTS: usize = 16;

/// MD5 stub of the fixed webcast client parameters (Simple Live `getMsStub`).
pub fn ms_stub(room_id: &str, user_unique_id: &str) -> AppResult<String> {
    validate_numeric_component(room_id, "房间号")?;
    validate_web_id_component(user_unique_id, "用户标识")?;

    // Field order and values match the first-party web client used by Simple Live.
    let sig_params = format!(
        "live_id=1,aid=6383,version_code=180800,webcast_sdk_version=1.3.0,room_id={room_id},sub_room_id=,sub_channel_id=,did_rule=3,user_unique_id={user_unique_id},device_platform=web,device_type=,ac=,identity=audience"
    );
    Ok(hex::encode(Md5::digest(sig_params.as_bytes())))
}

/// Compute a WSS `signature` for the given internal room id and anonymous uid.
pub fn get_signature(room_id: &str, user_unique_id: &str) -> AppResult<String> {
    let stub = ms_stub(room_id, user_unique_id)?;
    // Keep CPU-heavy script evaluation out of the async runtime. QuickJS's
    // Context is created and consumed on this dedicated thread.
    let handle = std::thread::Builder::new()
        .name("douyin-sign".into())
        .spawn(move || evaluate_signature(&stub))
        .map_err(|error| {
            AppError::new(
                "douyin_sign_spawn",
                format!("抖音弹幕签名线程启动失败: {error}"),
            )
            .with_site("douyin")
        })?;
    handle.join().map_err(|_| {
        AppError::new("douyin_sign_panic", "抖音弹幕签名计算异常中断")
            .with_site("douyin")
            .retryable()
    })?
}

fn evaluate_signature(stub: &str) -> AppResult<String> {
    let ctx = Context::builder().build().map_err(|error| {
        AppError::new(
            "douyin_sign_runtime",
            format!("抖音弹幕签名运行时创建失败: {error}"),
        )
        .with_site("douyin")
    })?;
    ctx.update_stack_top();
    eval_js(&ctx, WEB_MS_SDK, "webmssdk")?;

    // The SDK occasionally emits base64 padding or hyphens that the WSS edge
    // rejects; Simple Live regenerates until the value is clean.
    for _ in 0..MAX_SIGNATURE_ATTEMPTS {
        let signature = call_get_mssdk_signature(&ctx, stub)?;
        if !signature.is_empty() && !signature.contains(['-', '=']) {
            return Ok(signature);
        }
    }

    Err(
        AppError::new("douyin_sign_invalid", "抖音弹幕签名生成失败，请稍后重试")
            .with_site("douyin")
            .retryable(),
    )
}

fn call_get_mssdk_signature(ctx: &Context, stub: &str) -> AppResult<String> {
    let value = ctx
        .call_function("getMSSDKSignature", vec![stub, DEFAULT_USER_AGENT])
        .map_err(|error| {
            AppError::new("douyin_sign_eval", format!("抖音弹幕签名计算失败: {error}"))
                .with_site("douyin")
                .retryable()
        })?;
    value.js_to_string().map_err(|error| {
        AppError::new("douyin_sign_eval", format!("抖音弹幕签名结果无效: {error}"))
            .with_site("douyin")
            .retryable()
    })
}

fn eval_js(ctx: &Context, src: &str, stage: &str) -> AppResult<()> {
    ctx.eval(src, false).map_err(|error| {
        AppError::new(
            "douyin_sign_eval",
            format!("抖音弹幕签名脚本加载失败 ({stage}): {error}"),
        )
        .with_site("douyin")
    })?;
    Ok(())
}

fn validate_numeric_component(value: &str, label: &str) -> AppResult<()> {
    if value.is_empty() || value.len() > 32 || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(
            AppError::new("douyin_invalid_room", format!("无效的抖音{label}")).with_site("douyin"),
        );
    }
    Ok(())
}

/// Whether a web id can be signed with.
///
/// [`ms_stub`] joins its fields with `,` and `=`, and the WSS query plus
/// `internal_ext` add `|` and `&`, so any id carrying a delimiter would forge
/// extra fields.  Douyin's own `user_unique_id` is a decimal snowflake, while
/// a browser session's `s_v_web_id` cookie is longer and contains `_`, `-` and
/// `%` — that shape is unusable here, so callers must fall back to a locally
/// generated anonymous id instead of failing the whole handshake.
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
        // `s_v_web_id` fallbacks are alphanumeric; the signature input accepts
        // them alongside numeric `user_unique_id` values.
        assert!(ms_stub("1234567890", "deadbeef1234").is_ok());
        assert!(ms_stub("1234567890", "7392091211001140287").is_ok());
        assert!(ms_stub("1234567890", "1|with-pipe").is_err());
    }

    /// A real `s_v_web_id` cookie is far longer than a snowflake and carries
    /// `_`/`-`/`%`, so it can never be signed with.  Callers rely on this
    /// predicate to fall back before reaching [`ms_stub`].
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

    #[test]
    fn get_signature_returns_non_empty_clean_token() {
        let signature = get_signature("1234567890", "9876543210").expect("signature");
        assert!(!signature.is_empty());
        assert!(!signature.contains('-'));
        assert!(!signature.contains('='));
        let again = get_signature("1234567890", "9876543210").expect("signature again");
        assert!(!again.is_empty());
    }
}
