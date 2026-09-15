//! Content-file parsing.
//!
//! Instead of guessing which file on the disk belongs to an account, SapVault
//! now lets the user attach the files explicitly and then pulls the credential
//! fields out of them. Only the formats below are understood; anything else is
//! read as plain text.
//!
//! Supported: JSON, .env, TOML, YAML, XML, plain text.

use std::path::Path;

use quick_xml::events::Event;
use quick_xml::Reader;
use serde_json::Value;

use crate::model::{now_string, FieldHit, KeyMapping, LinkParse};

pub const KIND_URL: &str = "url";
pub const KIND_USERNAME: &str = "username";
pub const KIND_PASSWORD: &str = "password";

/// Guards against pulling a whole database dump into memory.
pub const MAX_ANALYZE_BYTES: u64 = 4 * 1024 * 1024;

const FORMATS: [&str; 6] = ["json", "env", "toml", "yaml", "xml", "text"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FlatValue {
    pub key: String,
    pub path: String,
    pub value: String,
    pub line: u32,
}

/// File-name based format detection. `.env` and friends have no extension, so
/// the file name is checked as well.
pub fn detect_format(path: &Path) -> String {
    let name = path
        .file_name()
        .map(|value| value.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if name == ".env" || name.starts_with(".env.") || name.ends_with(".env") {
        return "env".to_string();
    }
    let extension = path
        .extension()
        .map(|value| value.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    match extension.as_str() {
        "json" | "jsonc" => "json",
        "env" => "env",
        "toml" | "ini" | "conf" | "cfg" | "properties" | "lock" => "toml",
        "yaml" | "yml" => "yaml",
        "xml" | "plist" | "config" | "resx" => "xml",
        _ => "text",
    }
    .to_string()
}

pub fn is_supported(path: &Path) -> bool {
    FORMATS.contains(&detect_format(path).as_str())
}

/// Reads a file and returns its text, or an error description when the file is
/// missing, too large or looks binary.
pub fn read_text(path: &Path) -> Result<String, String> {
    let metadata = std::fs::metadata(path).map_err(|err| format!("无法读取文件信息：{err}"))?;
    if metadata.len() > MAX_ANALYZE_BYTES {
        return Err(format!(
            "文件过大（{} MB），超过 {} MB 的分析上限",
            metadata.len() / 1048576,
            MAX_ANALYZE_BYTES / 1048576
        ));
    }
    let bytes = std::fs::read(path).map_err(|err| format!("无法读取文件：{err}"))?;
    decode_text(&bytes).ok_or_else(|| "文件看起来是二进制内容，无法解析".to_string())
}

/// UTF-8 (with or without BOM) and UTF-16 are decoded; anything with a stray
/// NUL byte is treated as binary.
pub fn decode_text(bytes: &[u8]) -> Option<String> {
    if bytes.is_empty() {
        return Some(String::new());
    }
    if bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE {
        return Some(decode_utf16(&bytes[2..], true));
    }
    if bytes.len() >= 2 && bytes[0] == 0xFE && bytes[1] == 0xFF {
        return Some(decode_utf16(&bytes[2..], false));
    }
    let sniff = bytes.len().min(8 * 1024);
    if bytes[..sniff].contains(&0) {
        return None;
    }
    let text = String::from_utf8_lossy(bytes);
    Some(text.trim_start_matches('\u{feff}').to_string())
}

fn decode_utf16(bytes: &[u8], little_endian: bool) -> String {
    let mut units: Vec<u16> = Vec::with_capacity(bytes.len() / 2);
    for chunk in bytes.chunks_exact(2) {
        units.push(if little_endian {
            u16::from_le_bytes([chunk[0], chunk[1]])
        } else {
            u16::from_be_bytes([chunk[0], chunk[1]])
        });
    }
    String::from_utf16_lossy(&units)
}

/// Analyses an already-loaded document.
pub fn analyze_text(text: &str, format: &str, mapping: &KeyMapping) -> LinkParse {
    let values = extract(text, format);
    let mut fields: Vec<FieldHit> = Vec::new();
    let mut missing: Vec<String> = Vec::new();

    for (kind, keys) in [
        (KIND_URL, &mapping.url),
        (KIND_USERNAME, &mapping.username),
        (KIND_PASSWORD, &mapping.password),
    ] {
        match pick(&values, keys, mapping) {
            Some(value) => fields.push(FieldHit {
                kind: kind.to_string(),
                key: value.key.clone(),
                path: value.path.clone(),
                value: value.value.clone(),
                line: value.line,
            }),
            None => missing.push(kind.to_string()),
        }
    }

    // A literal URL is unambiguous even when no key matches.
    if missing.iter().any(|kind| kind == KIND_URL) {
        if let Some(value) = values.iter().find(|value| looks_like_url(&value.value)) {
            fields.push(FieldHit {
                kind: KIND_URL.to_string(),
                key: value.key.clone(),
                path: value.path.clone(),
                value: value.value.clone(),
                line: value.line,
            });
            missing.retain(|kind| kind != KIND_URL);
        }
    }

    LinkParse {
        format: format.to_string(),
        fields,
        missing,
        analyzed_at: now_string(),
        error: None,
    }
}

pub fn analyze_file(path: &Path, mapping: &KeyMapping) -> LinkParse {
    let format = detect_format(path);
    match read_text(path) {
        Ok(text) => analyze_text(&text, &format, mapping),
        Err(error) => LinkParse {
            format,
            fields: Vec::new(),
            missing: vec![
                KIND_URL.to_string(),
                KIND_USERNAME.to_string(),
                KIND_PASSWORD.to_string(),
            ],
            analyzed_at: now_string(),
            error: Some(error),
        },
    }
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

pub fn extract(text: &str, format: &str) -> Vec<FlatValue> {
    match format {
        "json" => extract_json(text),
        "env" => extract_env(text),
        "toml" => extract_toml(text),
        "yaml" => extract_yaml(text),
        "xml" => extract_xml(text),
        _ => extract_text(text),
    }
}

fn push(into: &mut Vec<FlatValue>, key: &str, path: &str, value: &str, line: u32) {
    let value = value.trim();
    if value.is_empty() || key.trim().is_empty() {
        return;
    }
    into.push(FlatValue {
        key: key.to_string(),
        path: path.to_string(),
        value: value.to_string(),
        line,
    });
}

fn extract_json(text: &str) -> Vec<FlatValue> {
    let Ok(root) = serde_json::from_str::<Value>(text) else {
        // Not valid JSON: fall back to the text scanner so a slightly broken
        // file can still yield something useful.
        return extract_text(text);
    };
    let mut out: Vec<FlatValue> = Vec::new();
    walk_json(&root, "", text, &mut out);
    out
}

fn walk_json(value: &Value, path: &str, text: &str, out: &mut Vec<FlatValue>) {
    match value {
        Value::Object(map) => {
            for (key, child) in map {
                let child_path = if path.is_empty() {
                    key.clone()
                } else {
                    format!("{path}.{key}")
                };
                walk_json(child, &child_path, text, out);
            }
        }
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                walk_json(item, &format!("{path}[{index}]"), text, out);
            }
        }
        Value::String(text_value) => {
            let line = line_of(text, text_value);
            push(
                out,
                last_segment(path),
                path,
                text_value,
                line,
            );
        }
        Value::Number(number) => {
            let rendered = number.to_string();
            let line = line_of(text, &rendered);
            push(out, last_segment(path), path, &rendered, line);
        }
        Value::Bool(flag) => {
            let rendered = flag.to_string();
            let line = line_of(text, &rendered);
            push(out, last_segment(path), path, &rendered, line);
        }
        Value::Null => {}
    }
}

fn last_segment(path: &str) -> &str {
    let trimmed = path.trim_end_matches(']');
    match trimmed.rfind(['.', '[']) {
        Some(index) => &trimmed[index + 1..],
        None => trimmed,
    }
}

fn extract_env(text: &str) -> Vec<FlatValue> {
    let mut out = Vec::new();
    for (index, raw_line) in text.lines().enumerate() {
        let line_no = index as u32 + 1;
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with("//") {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line).trim();
        if let Some((key, value)) = line.split_once('=') {
            let unquoted = unquote(value.trim());
            push(&mut out, key.trim(), key.trim(), &unquoted, line_no);
        }
    }
    out
}

fn extract_toml(text: &str) -> Vec<FlatValue> {
    let mut out = Vec::new();
    let mut section = String::new();
    for (index, raw_line) in text.lines().enumerate() {
        let line_no = index as u32 + 1;
        let cleaned = strip_comment(raw_line);
        let line = cleaned.trim();
        if line.is_empty() {
            continue;
        }
        if line.starts_with('[') {
            section = line
                .trim_start_matches('[')
                .trim_end_matches(']')
                .trim()
                .to_string();
            continue;
        }
        if let Some((key, value)) = line.split_once('=') {
            let key = key.trim();
            let path = if section.is_empty() {
                key.to_string()
            } else {
                format!("{section}.{key}")
            };
            let value = unquote(value.trim());
            if !value.starts_with('[') {
                push(&mut out, key, &path, &value, line_no);
            }
        }
    }
    out
}

fn extract_yaml(text: &str) -> Vec<FlatValue> {
    let mut out = Vec::new();
    // (indent, key) stack so nested mappings produce dotted paths.
    let mut stack: Vec<(usize, String)> = Vec::new();

    for (index, raw_line) in text.lines().enumerate() {
        let line_no = index as u32 + 1;
        let without_comment = strip_comment(raw_line);
        if without_comment.trim().is_empty() {
            continue;
        }
        let indent = without_comment.len() - without_comment.trim_start().len();
        let content = without_comment.trim();
        if content == "---" || content.starts_with('%') {
            continue;
        }
        let content = content.strip_prefix("- ").unwrap_or(content).trim();
        let Some((key, value)) = content.split_once(':') else {
            continue;
        };
        let key = key.trim().trim_matches('"').trim_matches('\'').trim();
        if key.is_empty() {
            continue;
        }

        while let Some((level, _)) = stack.last() {
            if *level >= indent {
                stack.pop();
            } else {
                break;
            }
        }

        let value = value.trim();
        if value.is_empty() || value == "|" || value == ">" {
            stack.push((indent, key.to_string()));
            continue;
        }

        let mut path: Vec<&str> = stack.iter().map(|(_, key)| key.as_str()).collect();
        path.push(key);
        let unquoted = unquote(value);
        push(&mut out, key, &path.join("."), &unquoted, line_no);
    }
    out
}

fn extract_xml(text: &str) -> Vec<FlatValue> {
    let mut out: Vec<FlatValue> = Vec::new();
    let mut reader = Reader::from_str(text);
    reader.config_mut().trim_text(true);
    let mut stack: Vec<String> = Vec::new();

    loop {
        match reader.read_event() {
            Ok(Event::Start(element)) => {
                let name = String::from_utf8_lossy(element.local_name().as_ref()).to_string();
                for attribute in element.attributes().flatten() {
                    let key = String::from_utf8_lossy(attribute.key.local_name().as_ref()).to_string();
                    let value = attribute
                        .unescape_value()
                        .map(|value| value.into_owned())
                        .unwrap_or_default();
                    let path = if stack.is_empty() {
                        format!("{name}@{key}")
                    } else {
                        format!("{}.{name}@{key}", stack.join("."))
                    };
                    let line = line_of(text, &value);
                    push(&mut out, &key, &path, &value, line);
                }
                stack.push(name);
            }
            Ok(Event::Empty(element)) => {
                let name = String::from_utf8_lossy(element.local_name().as_ref()).to_string();
                for attribute in element.attributes().flatten() {
                    let key = String::from_utf8_lossy(attribute.key.local_name().as_ref()).to_string();
                    let value = attribute
                        .unescape_value()
                        .map(|value| value.into_owned())
                        .unwrap_or_default();
                    let path = if stack.is_empty() {
                        format!("{name}@{key}")
                    } else {
                        format!("{}.{name}@{key}", stack.join("."))
                    };
                    let line = line_of(text, &value);
                    push(&mut out, &key, &path, &value, line);
                }
            }
            Ok(Event::Text(text_node)) => {
                let value = text_node
                    .decode()
                    .map(|value| unescape_entities(&value))
                    .unwrap_or_default();
                if let Some(name) = stack.last() {
                    let line = line_of(text, &value);
                    push(&mut out, &name.clone(), &stack.join("."), &value, line);
                }
            }
            Ok(Event::End(_)) => {
                stack.pop();
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
    }
    if out.is_empty() {
        return extract_text(text);
    }
    out
}

/// Plain text: `key=value`, `key: value`, and bare URLs.
fn extract_text(text: &str) -> Vec<FlatValue> {
    let mut out = Vec::new();
    for (index, raw_line) in text.lines().enumerate() {
        let line_no = index as u32 + 1;
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with("//") {
            continue;
        }
        let mut matched = false;
        for separator in ['=', ':'] {
            if let Some((key, value)) = line.split_once(separator) {
                let key = key
                    .trim()
                    .trim_start_matches('-')
                    .trim()
                    .trim_matches('"')
                    .trim_matches('\'')
                    .trim();
                let value = unquote(value.trim());
                if !key.is_empty() && !value.is_empty() && key.len() < 64 {
                    push(&mut out, key, key, &value, line_no);
                    matched = true;
                    break;
                }
            }
        }
        for token in line.split(|c: char| c.is_whitespace() || c == '"' || c == '\'' || c == ',') {
            if looks_like_url(token) {
                push(&mut out, "url", "url", token, line_no);
                matched = true;
            }
        }
        let _ = matched;
    }
    out
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

fn looks_like_url(value: &str) -> bool {
    let lower = value.trim().to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

/// Picks the best match for one field kind. Exact key matches win over partial
/// ones, and longer keys win over shorter ones (`username` beats `user`).
fn pick<'a>(values: &'a [FlatValue], keys: &[String], mapping: &KeyMapping) -> Option<&'a FlatValue> {
    let mut best: Option<(u8, usize, usize, &'a FlatValue)> = None;
    for (index, value) in values.iter().enumerate() {
        for key in keys {
            let (matched, exact) = if mapping.exact {
                (key_eq(&value.key, key, mapping.ignore_case), true)
            } else if key_eq(&value.key, key, mapping.ignore_case) {
                (true, true)
            } else {
                (key_contains(&value.key, key, mapping.ignore_case), false)
            };
            if !matched {
                continue;
            }
            let score = if exact { 2u8 } else { 1u8 };
            let specificity = key.chars().count();
            let better = match best {
                None => true,
                Some((best_score, best_specificity, _, _)) => {
                    (score, specificity) > (best_score, best_specificity)
                }
            };
            if better {
                best = Some((score, specificity, index, value));
            }
        }
    }
    best.map(|(_, _, _, value)| value)
}

fn key_eq(candidate: &str, key: &str, ignore_case: bool) -> bool {
    if ignore_case {
        candidate.eq_ignore_ascii_case(key)
    } else {
        candidate == key
    }
}

fn key_contains(candidate: &str, key: &str, ignore_case: bool) -> bool {
    if key.is_empty() || key.chars().count() < 3 {
        // Two-letter keys such as `pw` would match far too much.
        return key_eq(candidate, key, ignore_case);
    }
    if ignore_case {
        candidate.to_ascii_lowercase().contains(&key.to_ascii_lowercase())
    } else {
        candidate.contains(key)
    }
}

// ---------------------------------------------------------------------------
// Small text helpers
// ---------------------------------------------------------------------------

fn unquote(value: &str) -> String {
    let trimmed = value.trim().trim_end_matches(',');
    let trimmed = trimmed.trim();
    if trimmed.len() >= 2 {
        let first = trimmed.chars().next().unwrap_or(' ');
        let last = trimmed.chars().last().unwrap_or(' ');
        if (first == '"' && last == '"') || (first == '\'' && last == '\'') {
            return trimmed[1..trimmed.len() - 1].to_string();
        }
    }
    trimmed.to_string()
}

/// Removes a trailing `#` comment while respecting quoted strings.
fn strip_comment(line: &str) -> String {
    let mut in_single = false;
    let mut in_double = false;
    for (index, ch) in line.char_indices() {
        match ch {
            '\'' if !in_double => in_single = !in_single,
            '"' if !in_single => in_double = !in_double,
            '#' if !in_single && !in_double => return line[..index].to_string(),
            _ => {}
        }
    }
    line.to_string()
}

/// Expands the predefined XML entities that `BytesText::decode` leaves as
/// written; credential values rarely contain anything else.
fn unescape_entities(value: &str) -> String {
    value
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&amp;", "&")
}

fn line_of(text: &str, needle: &str) -> u32 {
    let needle = needle.trim();
    if needle.chars().count() < 3 {
        return 0;
    }
    for (index, line) in text.lines().enumerate() {
        if line.contains(needle) {
            return index as u32 + 1;
        }
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn mapping() -> KeyMapping {
        KeyMapping::default()
    }

    fn find<'a>(values: &'a [FlatValue], path: &str) -> Option<&'a FlatValue> {
        values.iter().find(|value| value.path == path)
    }

    #[test]
    fn detects_formats_from_name_and_extension() {
        assert_eq!(detect_format(PathBuf::from("C:/x/.env").as_path()), "env");
        assert_eq!(detect_format(PathBuf::from("C:/x/.env.local").as_path()), "env");
        assert_eq!(detect_format(PathBuf::from("C:/x/a.json").as_path()), "json");
        assert_eq!(detect_format(PathBuf::from("C:/x/a.toml").as_path()), "toml");
        assert_eq!(detect_format(PathBuf::from("C:/x/a.yml").as_path()), "yaml");
        assert_eq!(detect_format(PathBuf::from("C:/x/a.xml").as_path()), "xml");
        assert_eq!(detect_format(PathBuf::from("C:/x/notes.md").as_path()), "text");
    }

    #[test]
    fn json_is_flattened_with_paths() {
        let text = "{\n  \"sap\": {\n    \"url\": \"https://prd.corp.example\",\n    \"username\": \"JDOE\",\n    \"password\": \"S3cret\"\n  }\n}";
        let values = extract(text, "json");
        assert_eq!(
            find(&values, "sap.url").unwrap().value,
            "https://prd.corp.example"
        );
        assert_eq!(find(&values, "sap.username").unwrap().value, "JDOE");
        assert_eq!(find(&values, "sap.username").unwrap().line, 4);
        assert_eq!(find(&values, "sap.password").unwrap().value, "S3cret");

        let parse = analyze_text(text, "json", &mapping());
        assert!(parse.is_complete());
        assert_eq!(parse.value_of(KIND_USERNAME), "JDOE");
    }

    #[test]
    fn env_files_are_parsed() {
        let text = "# comment\nSAP_URL=https://dev.corp.example\nexport SAP_USER='JDOE'\nSAP_PASSWORD=\"p@ss=word\"\n";
        let parse = analyze_text(text, "env", &mapping());
        assert_eq!(parse.value_of(KIND_URL), "https://dev.corp.example");
        assert_eq!(parse.value_of(KIND_USERNAME), "JDOE");
        assert_eq!(parse.value_of(KIND_PASSWORD), "p@ss=word");
        assert!(parse.is_complete());
    }

    #[test]
    fn toml_sections_become_paths() {
        let text = "[sap]\nurl = \"https://prd.corp.example\"\nuser = \"JDOE\"\n\n[sap.auth]\npassword = \"S3cret\" # inline\n";
        let values = extract(text, "toml");
        assert_eq!(find(&values, "sap.url").unwrap().value, "https://prd.corp.example");
        assert_eq!(find(&values, "sap.auth.password").unwrap().value, "S3cret");
        let parse = analyze_text(text, "toml", &mapping());
        assert!(parse.is_complete());
    }

    #[test]
    fn yaml_nesting_builds_paths() {
        let text = "sap:\n  production:\n    url: https://prd.corp.example\n    username: JDOE\n    password: S3cret\nother: 1\n";
        let values = extract(text, "yaml");
        assert_eq!(
            find(&values, "sap.production.url").unwrap().value,
            "https://prd.corp.example"
        );
        assert!(find(&values, "other").is_some());
        let parse = analyze_text(text, "yaml", &mapping());
        assert!(parse.is_complete());
    }

    #[test]
    fn xml_elements_and_attributes_are_read() {
        let text = "<?xml version=\"1.0\"?>\n<config>\n  <connection host=\"prd.corp.example\">\n    <user>JDOE</user>\n    <password>S3cret</password>\n  </connection>\n</config>";
        let parse = analyze_text(text, "xml", &mapping());
        assert_eq!(parse.value_of(KIND_URL), "prd.corp.example");
        assert_eq!(parse.value_of(KIND_USERNAME), "JDOE");
        assert_eq!(parse.value_of(KIND_PASSWORD), "S3cret");
        assert!(parse.is_complete());
    }

    #[test]
    fn plain_text_finds_keys_and_bare_urls() {
        let text = "登录信息\nURL: https://prd.corp.example/sap\nUser: JDOE\nPass: S3cret!\n";
        let parse = analyze_text(text, "text", &mapping());
        assert_eq!(parse.value_of(KIND_URL), "https://prd.corp.example/sap");
        assert_eq!(parse.value_of(KIND_USERNAME), "JDOE");
        assert_eq!(parse.value_of(KIND_PASSWORD), "S3cret!");
    }

    #[test]
    fn missing_fields_are_reported() {
        let text = "{\"note\":\"nothing useful here\"}";
        let parse = analyze_text(text, "json", &mapping());
        assert_eq!(
            parse.missing,
            vec![
                KIND_URL.to_string(),
                KIND_USERNAME.to_string(),
                KIND_PASSWORD.to_string()
            ]
        );
        assert!(!parse.is_complete());
        assert!(parse.fields.is_empty());
    }

    #[test]
    fn custom_keys_rescue_unusual_files() {
        let text = "{\"verbindung\":\"https://prd.corp.example\",\"kennung\":\"JDOE\",\"geheim\":\"S3cret\"}";
        let mut mapping = mapping();
        mapping.username = vec!["kennung".into()];
        mapping.password = vec!["geheim".into()];
        mapping.url = vec!["verbindung".into()];
        let parse = analyze_text(text, "json", &mapping);
        assert!(parse.is_complete());
        assert_eq!(parse.value_of(KIND_USERNAME), "JDOE");
    }

    #[test]
    fn exact_matching_can_be_requested() {
        let text = "{\"user_name\":\"A\",\"user\":\"B\"}";
        let mut mapping = mapping();
        mapping.exact = true;
        mapping.username = vec!["user".into()];
        let parse = analyze_text(text, "json", &mapping);
        assert_eq!(parse.value_of(KIND_USERNAME), "B");
    }

    #[test]
    fn more_specific_key_wins() {
        let text = "{\"user\":\"short\",\"username\":\"exact\"}";
        let parse = analyze_text(text, "json", &mapping());
        assert_eq!(parse.value_of(KIND_USERNAME), "exact");
    }

    #[test]
    fn binary_files_are_rejected() {
        assert!(decode_text(&[0u8, 1, 2, 3]).is_none());
        let parse = analyze_file(PathBuf::from("C:/definitely/not/here.json").as_path(), &mapping());
        assert!(parse.error.is_some());
        assert!(!parse.is_complete());
    }

    #[test]
    fn utf16_files_are_decoded() {
        let mut bytes: Vec<u8> = vec![0xFF, 0xFE];
        for unit in "user=JDOE".encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        assert_eq!(decode_text(&bytes).unwrap(), "user=JDOE");
    }
}
