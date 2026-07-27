//! Local Douyin webcast signature (MSSDK / X-Bogus style).
//!
//! The web IM WSS URL needs a short-lived `signature` query parameter derived
//! from room id + anonymous `user_unique_id`.  The algorithm lives in Douyin's
//! browser `webmssdk` script; rLive evaluates that script with Boa, the same
//! approach used for Douyu room play-sign.

use boa_engine::{Context, JsString, Source, js_string};
use md5::{Digest, Md5};

use crate::error::{AppError, AppResult};
use crate::sites::douyin::DEFAULT_USER_AGENT;

/// Obfuscated Douyin web MSSDK entry that exports `getMSSDKSignature`.
const WEB_MS_SDK: &str = include_str!("../../assets/douyin_webmssdk.js");

const MAX_SIGNATURE_ATTEMPTS: usize = 16;
/// Debug builds of Boa need a much deeper native stack to parse/eval the
/// minified MSSDK; 16 MiB matches the working standalone boa-eval harness.
const SIGN_THREAD_STACK: usize = 16 * 1024 * 1024;

/// MD5 stub of the fixed webcast client parameters (Simple Live `getMsStub`).
pub fn ms_stub(room_id: &str, user_unique_id: &str) -> AppResult<String> {
    validate_numeric_component(room_id, "房间号")?;
    validate_numeric_component(user_unique_id, "用户标识")?;

    // Field order and values match the first-party web client used by Simple Live.
    let sig_params = format!(
        "live_id=1,aid=6383,version_code=180800,webcast_sdk_version=1.3.0,room_id={room_id},sub_room_id=,sub_channel_id=,did_rule=3,user_unique_id={user_unique_id},device_platform=web,device_type=,ac=,identity=audience"
    );
    let digest = Md5::digest(sig_params.as_bytes());
    Ok(format!("{digest:x}"))
}

/// Compute a WSS `signature` for the given internal room id and anonymous uid.
pub fn get_signature(room_id: &str, user_unique_id: &str) -> AppResult<String> {
    let stub = ms_stub(room_id, user_unique_id)?;
    // Boa is not Send across threads after construction, so evaluate on a
    // dedicated large-stack thread and return only the finished string.
    let handle = std::thread::Builder::new()
        .name("douyin-sign".into())
        .stack_size(SIGN_THREAD_STACK)
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
    let mut ctx = Context::default();
    // Raise Boa's own VM call-frame budget; the MSSDK is heavily nested.
    ctx.runtime_limits_mut().set_stack_size_limit(128 * 1024);
    eval_js(&mut ctx, WEB_MS_SDK, "webmssdk")?;

    // The SDK occasionally emits base64 padding or hyphens that the WSS edge
    // rejects; Simple Live regenerates until the value is clean.
    for _ in 0..MAX_SIGNATURE_ATTEMPTS {
        let signature = call_get_mssdk_signature(&mut ctx, stub)?;
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

fn call_get_mssdk_signature(ctx: &mut Context, stub: &str) -> AppResult<String> {
    // Prefer calling the function object with typed arguments so neither the
    // stub nor the fixed UA is interpolated into JS source.
    let global = ctx.global_object();
    let function = global
        .get(js_string!("getMSSDKSignature"), ctx)
        .map_err(|error| {
            AppError::new(
                "douyin_sign_eval",
                format!("抖音弹幕签名函数不可用: {error}"),
            )
            .with_site("douyin")
        })?;
    let Some(function) = function.as_callable() else {
        return Err(AppError::new("douyin_sign_eval", "抖音弹幕签名函数不可用").with_site("douyin"));
    };

    let stub_value = JsString::from(stub).into();
    let ua_value = JsString::from(DEFAULT_USER_AGENT).into();
    let value = function
        .call(&function.clone().into(), &[stub_value, ua_value], ctx)
        .map_err(|error| {
            AppError::new("douyin_sign_eval", format!("抖音弹幕签名计算失败: {error}"))
                .with_site("douyin")
                .retryable()
        })?;
    value
        .to_string(ctx)
        .map(|js| js.to_std_string_escaped())
        .map_err(|error| {
            AppError::new("douyin_sign_eval", format!("抖音弹幕签名结果无效: {error}"))
                .with_site("douyin")
                .retryable()
        })
}

fn eval_js(ctx: &mut Context, src: &str, stage: &str) -> AppResult<()> {
    ctx.eval(Source::from_bytes(src)).map_err(|error| {
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
    fn get_signature_returns_non_empty_clean_token() {
        let signature = get_signature("1234567890", "9876543210").expect("signature");
        assert!(!signature.is_empty());
        assert!(!signature.contains('-'));
        assert!(!signature.contains('='));
        // Second call reuses the cached runtime.
        let again = get_signature("1234567890", "9876543210").expect("signature again");
        assert!(!again.is_empty());
    }
}
