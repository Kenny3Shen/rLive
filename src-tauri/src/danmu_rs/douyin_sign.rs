//! 本地生成抖音 webcast 签名（MSSDK / X-Bogus 风格）。
//!
//! Web IM 的 WSS URL 需要一个由房间 id + 匿名 `user_unique_id` 派生的短时效
//! `signature` 查询参数。算法位于抖音浏览器端的 `webmssdk` 脚本中；
//! rLive 用 QuickJS 执行该脚本。

use md5::{Digest, Md5};
use quickjs_rusty::Context;

use crate::error::{AppError, AppResult};
use crate::sites::douyin::DEFAULT_USER_AGENT;

/// 经过混淆的抖音 Web MSSDK 入口，导出 `getMSSDKSignature`。
const WEB_MS_SDK: &str = include_str!("../../assets/douyin_webmssdk.js");

const MAX_SIGNATURE_ATTEMPTS: usize = 16;

/// 固定 webcast 客户端参数的 MD5 stub。
pub fn ms_stub(room_id: &str, user_unique_id: &str) -> AppResult<String> {
    validate_numeric_component(room_id, "房间号")?;
    validate_web_id_component(user_unique_id, "用户标识")?;

    // 字段顺序与取值与第一方 Web 客户端一致。
    let sig_params = format!(
        "live_id=1,aid=6383,version_code=180800,webcast_sdk_version=1.3.0,room_id={room_id},sub_room_id=,sub_channel_id=,did_rule=3,user_unique_id={user_unique_id},device_platform=web,device_type=,ac=,identity=audience"
    );
    Ok(hex::encode(Md5::digest(sig_params.as_bytes())))
}

/// 为给定的内部房间 id 与匿名 uid 计算 WSS `signature`。
pub fn get_signature(room_id: &str, user_unique_id: &str) -> AppResult<String> {
    let stub = ms_stub(room_id, user_unique_id)?;
    // 把 CPU 密集的脚本执行放在异步运行时之外。QuickJS 的 Context
    // 在这个专用线程上创建并消费。
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

    // SDK 偶尔会产生 WSS 边缘节点拒绝的 base64 填充符或连字符；
    // 这里不断重新生成直到取值干净。
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

/// 判断某个 web id 是否可用于签名。
///
/// [`ms_stub`] 用 `,` 和 `=` 拼接字段，WSS query 与 `internal_ext` 又引入
/// `|` 和 `&`，因此任何带分隔符的 id 都会伪造出额外字段。抖音自己的
/// `user_unique_id` 是十进制雪花 id，而浏览器会话的 `s_v_web_id` cookie
/// 更长且包含 `_`、`-` 和 `%` —— 这种形态在这里不可用，
/// 所以调用方必须回退到本地生成的匿名 id，而不是让整个握手失败。
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
        // `s_v_web_id` 兜底值是字母数字混合的；
        // 签名输入既接受它们，也接受数字型的 `user_unique_id`。
        assert!(ms_stub("1234567890", "deadbeef1234").is_ok());
        assert!(ms_stub("1234567890", "7392091211001140287").is_ok());
        assert!(ms_stub("1234567890", "1|with-pipe").is_err());
    }

    /// 真实的 `s_v_web_id` cookie 比雪花 id 长得多，且带有 `_`/`-`/`%`，
    /// 因此绝不可能用于签名。调用方依赖这个判定函数，
    /// 在走到 [`ms_stub`] 之前完成回退。
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
