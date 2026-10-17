//! 站点响应中宽松字段的取值工具：上游常把数字和字符串混用。

use serde_json::Value;

/// 宽容读取整数：接受 JSON number（i64/u64）与十进制字符串（允许首尾空白）。
/// 超出 i64 的值视为无法识别，不回绕成负数。
pub(crate) fn json_i64_opt(v: &Value) -> Option<i64> {
    v.as_i64()
        .or_else(|| v.as_u64().and_then(|u| i64::try_from(u).ok()))
        .or_else(|| v.as_str()?.trim().parse().ok())
}

/// 同 [`json_i64_opt`]，缺失或无法解析时为 0；只用于展示类字段。
pub(crate) fn json_i64(v: &Value) -> i64 {
    json_i64_opt(v).unwrap_or(0)
}

/// 标量按文本取出，`null` 为空串，其他结构保留 JSON 文本。
pub(crate) fn json_str(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Null => String::new(),
        _ => v.to_string(),
    }
}
