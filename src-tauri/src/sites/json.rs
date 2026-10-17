//! 站点响应中宽松字段的取值工具：上游常把数字和字符串混用。

use serde_json::Value;

/// 兼容数字与数字字符串；缺失或无法解析时为 0。
pub(crate) fn json_i64(v: &Value) -> i64 {
    v.as_i64()
        .or_else(|| v.as_u64().map(|u| u as i64))
        .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
        .unwrap_or(0)
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
