//! Password rules: generation that satisfies a policy, and validation that
//! explains why a typed password does not.

use crate::crypto::random_bytes;
use crate::error::{AppError, AppResult};
use crate::model::PasswordRule;

const UPPER: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LOWER: &[u8] = b"abcdefghijklmnopqrstuvwxyz";
const DIGITS: &[u8] = b"0123456789";
/// Characters that look alike in most fonts; only removed on request.
const AMBIGUOUS: &[u8] = b"O0oIl1|`'\"";

/// Pools after forbidden / ambiguous characters have been removed.
fn pools(rule: &PasswordRule) -> Vec<Vec<u8>> {
    let forbidden = |candidate: u8| -> bool {
        rule.forbidden
            .chars()
            .any(|ch| ch == candidate as char)
            || (rule.avoid_ambiguous && AMBIGUOUS.contains(&candidate))
    };

    let mut out: Vec<Vec<u8>> = Vec::new();
    if rule.lower {
        out.push(LOWER.iter().copied().filter(|c| !forbidden(*c)).collect());
    }
    if rule.upper {
        out.push(UPPER.iter().copied().filter(|c| !forbidden(*c)).collect());
    }
    if rule.digits {
        out.push(DIGITS.iter().copied().filter(|c| !forbidden(*c)).collect());
    }
    if rule.symbols {
        let mut symbols: Vec<u8> = rule
            .symbols_set
            .bytes()
            .filter(|c| !c.is_ascii_alphanumeric() && !forbidden(*c))
            .collect();
        symbols.dedup();
        out.push(symbols);
    }
    out.retain(|pool| !pool.is_empty());
    out
}

pub fn generate(rule: &PasswordRule) -> AppResult<String> {
    let mut rule = rule.clone();
    rule.normalize();
    let pools = pools(&rule);
    if pools.is_empty() {
        return Err(AppError::Msg(
            "规则中的字符集为空：请检查启用的字符类型与禁用字符".to_string(),
        ));
    }

    if rule.start_with_letter && !(rule.upper || rule.lower) {
        return Err(AppError::Msg(
            "规则要求首字符为字母，但没有启用大写或小写字母".to_string(),
        ));
    }

    let combined: Vec<u8> = pools.iter().flatten().copied().collect();
    // Prefer 16 characters, but never below the rule's minimum or above its
    // maximum.
    let target = 16usize.clamp(rule.min_length, rule.max_length);
    let length = target.max(pools.len());

    let mut out: Vec<u8> = Vec::with_capacity(length);
    for pool in &pools {
        out.push(pool[random_bytes::<4>()[0] as usize % pool.len()]);
    }
    while out.len() < length {
        out.push(combined[random_bytes::<4>()[0] as usize % combined.len()]);
    }

    // Shuffle the tail, then move a letter into the first slot by *swapping*,
    // because overwriting would drop a character class that was placed there.
    for index in (2..out.len()).rev() {
        let swap = 1 + random_bytes::<4>()[0] as usize % index;
        out.swap(index, swap);
    }
    if rule.start_with_letter {
        let position = out
            .iter()
            .position(|candidate| candidate.is_ascii_alphabetic())
            .unwrap_or(0);
        out.swap(0, position);
    }

    Ok(String::from_utf8_lossy(&out).to_string())
}

/// Every reason the password violates the rule. An empty result means it passes.
pub fn validate(password: &str, rule: &PasswordRule) -> Vec<String> {
    if !rule.enabled {
        return Vec::new();
    }
    let mut rule = rule.clone();
    rule.normalize();
    let mut problems: Vec<String> = Vec::new();
    let length = password.chars().count();

    if length < rule.min_length {
        problems.push(format!("长度不足：至少 {} 位（当前 {length} 位）", rule.min_length));
    }
    if length > rule.max_length {
        problems.push(format!("长度超限：最多 {} 位（当前 {length} 位）", rule.max_length));
    }
    if rule.lower && !password.chars().any(|ch| ch.is_ascii_lowercase()) {
        problems.push("缺少小写字母".to_string());
    }
    if rule.upper && !password.chars().any(|ch| ch.is_ascii_uppercase()) {
        problems.push("缺少大写字母".to_string());
    }
    if rule.digits && !password.chars().any(|ch| ch.is_ascii_digit()) {
        problems.push("缺少数字".to_string());
    }
    if rule.symbols && !password.chars().any(|ch| !ch.is_alphanumeric()) {
        problems.push("缺少符号".to_string());
    }
    let forbidden: String = password
        .chars()
        .filter(|ch| rule.forbidden.contains(*ch))
        .collect();
    if !forbidden.is_empty() {
        problems.push(format!("包含禁用字符：{forbidden}"));
    }
    if rule.start_with_letter && !password.chars().next().map(|ch| ch.is_alphabetic()).unwrap_or(false)
    {
        problems.push("必须以字母开头".to_string());
    }
    if rule.avoid_ambiguous {
        let ambiguous: String = password
            .chars()
            .filter(|ch| AMBIGUOUS.contains(&(*ch as u8)))
            .collect();
        if !ambiguous.is_empty() {
            problems.push(format!("包含易混淆字符：{ambiguous}"));
        }
    }
    problems
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sap_rule() -> PasswordRule {
        PasswordRule {
            min_length: 8,
            max_length: 40,
            upper: true,
            lower: true,
            digits: true,
            symbols: false,
            ..PasswordRule::default()
        }
    }

    #[test]
    fn generated_password_satisfies_its_rule() {
        let rule = sap_rule();
        for _ in 0..25 {
            let password = generate(&rule).unwrap();
            assert!(
                validate(&password, &rule).is_empty(),
                "生成的密码不符合规则：{password}"
            );
        }
    }

    #[test]
    fn rule_bounds_are_respected() {
        let rule = PasswordRule {
            min_length: 12,
            max_length: 14,
            ..sap_rule()
        };
        for _ in 0..15 {
            let password = generate(&rule).unwrap();
            let length = password.chars().count();
            assert!((12..=14).contains(&length), "长度 {length} 超出 12-14");
        }
    }

    #[test]
    fn symbols_and_forbidden_characters_are_honoured() {
        let rule = PasswordRule {
            symbols: true,
            forbidden: "@".to_string(),
            avoid_ambiguous: true,
            ..sap_rule()
        };
        for _ in 0..25 {
            let password = generate(&rule).unwrap();
            assert!(!password.contains('@'));
            assert!(validate(&password, &rule).is_empty(), "失败：{password}");
        }
    }

    #[test]
    fn start_with_letter_is_honoured() {
        let rule = PasswordRule {
            start_with_letter: true,
            symbols: true,
            digits: true,
            ..sap_rule()
        };
        for _ in 0..25 {
            let password = generate(&rule).unwrap();
            assert!(
                password.chars().next().unwrap().is_alphabetic(),
                "首字符不是字母：{password}"
            );
            assert!(validate(&password, &rule).is_empty());
        }
    }

    #[test]
    fn start_with_letter_needs_a_letter_class() {
        let rule = PasswordRule {
            start_with_letter: true,
            lower: false,
            upper: false,
            digits: true,
            symbols: false,
            ..PasswordRule::default()
        };
        assert!(generate(&rule).is_err());
    }

    #[test]
    fn validation_reports_each_problem() {
        let rule = sap_rule();
        let problems = validate("abc", &rule);
        assert!(problems.iter().any(|text| text.contains("长度不足")));
        assert!(problems.iter().any(|text| text.contains("大写")));
        assert!(problems.iter().any(|text| text.contains("数字")));

        let uppercase_only = "ABCDEFGHIJ";
        assert!(validate(uppercase_only, &rule)
            .iter()
            .any(|text| text.contains("小写")));
    }

    #[test]
    fn disabled_rules_accept_anything() {
        let rule = PasswordRule {
            enabled: false,
            ..sap_rule()
        };
        assert!(validate("x", &rule).is_empty());
    }

    #[test]
    fn impossible_rule_is_reported() {
        // Every class is disabled, so normalization falls back to lower case +
        // digits; forbidding exactly those leaves nothing to build from.
        let rule = PasswordRule {
            lower: false,
            upper: false,
            digits: false,
            symbols: false,
            forbidden: "abcdefghijklmnopqrstuvwxyz0123456789".to_string(),
            ..PasswordRule::default()
        };
        assert!(generate(&rule).is_err());
    }

    #[test]
    fn summary_mentions_the_shape_of_the_rule() {
        let text = sap_rule().summary();
        assert!(text.contains("8-40"));
        assert!(text.contains("数字"));
        assert_eq!(
            PasswordRule {
                enabled: false,
                ..sap_rule()
            }
            .summary(),
            "未设置规则"
        );
    }
}
