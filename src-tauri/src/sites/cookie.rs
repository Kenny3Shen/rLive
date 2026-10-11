//! 抖音与斗鱼共用的 Cookie 字符串处理；发送 URL 的作用域仍由各站点判断。

pub(super) fn normalize_cookie(value: &str) -> String {
    merge_cookie_values(
        "",
        value.trim().strip_prefix("Cookie:").unwrap_or(value).trim(),
    )
}

pub(super) fn cookie_pairs(value: &str) -> Vec<(String, String)> {
    value
        .split(';')
        .filter_map(|part| {
            let (key, value) = part.trim().split_once('=')?;
            let key = key.trim();
            (!key.is_empty()).then(|| (key.to_string(), value.trim().to_string()))
        })
        .collect()
}

/// 保留 base 的顺序、键名及重复键；更新只覆盖首个 ASCII 忽略大小写匹配的键。
pub(super) fn merge_cookie_values(base: &str, updates: &str) -> String {
    let mut merged = cookie_pairs(base);
    for (key, value) in cookie_pairs(updates) {
        if let Some((_, previous)) = merged
            .iter_mut()
            .find(|(previous_key, _)| previous_key.eq_ignore_ascii_case(&key))
        {
            *previous = value;
        } else {
            merged.push((key, value));
        }
    }
    merged
        .into_iter()
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>()
        .join("; ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalization_preserves_exact_prefix_and_value_rules() {
        for (input, expected) in [
            (
                " \tCookie: a = old ; A = new ; empty= ; token=a=b== ; flag ; =bad; ",
                "a=new; empty=; token=a=b==",
            ),
            (" cookie: a=1 ", "cookie: a=1"),
            (" COOKIE: a=1 ", "COOKIE: a=1"),
            ("Cookie: Cookie: a=1", "Cookie: a=1"),
            (" a=1 ; flag ; b=2 ", "a=1; b=2"),
            ("Cookie:", ""),
            (" ; flag; =bad; ", ""),
            ("", ""),
        ] {
            assert_eq!(normalize_cookie(input), expected, "input: {input:?}");
        }
    }

    #[test]
    fn pairs_preserve_duplicates_empty_values_and_embedded_equals() {
        assert_eq!(
            cookie_pairs(" A = first; a=second ; empty= ; token=a=b== ; flag ; =bad; "),
            [
                ("A", "first"),
                ("a", "second"),
                ("empty", ""),
                ("token", "a=b==")
            ]
            .map(|(key, value)| (key.to_string(), value.to_string()))
        );
    }

    #[test]
    fn merge_preserves_base_order_and_only_updates_first_ascii_match() {
        for (base, updates, expected) in [
            (
                "A=first; a=second; z=last",
                "a=new; b=added; A=final; B=revised",
                "A=final; a=second; z=last; b=revised",
            ),
            ("A=first; a=second", "", "A=first; a=second"),
            (
                "a=1; b=2",
                "b=; token=a=b==; =bad; flag",
                "a=1; b=; token=a=b==",
            ),
            ("Ä=old; A=old", "ä=new; a=new", "Ä=old; A=new; ä=new"),
            ("", "a=1; A=2", "a=2"),
            ("a=1", "Cookie: a=2", "a=1; Cookie: a=2"),
            ("", "", ""),
        ] {
            assert_eq!(
                merge_cookie_values(base, updates),
                expected,
                "base: {base:?}, updates: {updates:?}"
            );
        }
    }
}
