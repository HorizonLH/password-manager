//! Byte-exact editing of content files.
//!
//! Sync must change *only* the password value, so nothing here re-serializes a
//! document: the original bytes are decoded, the recorded value ranges are
//! spliced, and the result is encoded back with the original encoding and BOM.

use crate::error::{AppError, AppResult};
use crate::model::FieldLocation;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextEncoding {
    Utf8,
    Utf8Bom,
    Utf16Le,
    Utf16Be,
}

/// Decodes a file, or returns `None` when it looks binary.
pub fn decode(bytes: &[u8]) -> Option<(String, TextEncoding)> {
    if bytes.is_empty() {
        return Some((String::new(), TextEncoding::Utf8));
    }
    if bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE {
        return Some((decode_utf16(&bytes[2..], true), TextEncoding::Utf16Le));
    }
    if bytes.len() >= 2 && bytes[0] == 0xFE && bytes[1] == 0xFF {
        return Some((decode_utf16(&bytes[2..], false), TextEncoding::Utf16Be));
    }
    if bytes.len() >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF {
        let text = String::from_utf8_lossy(&bytes[3..]).to_string();
        return Some((text, TextEncoding::Utf8Bom));
    }
    let sniff = bytes.len().min(8 * 1024);
    if bytes[..sniff].contains(&0) {
        return None;
    }
    Some((String::from_utf8_lossy(bytes).to_string(), TextEncoding::Utf8))
}

pub fn encode(text: &str, encoding: TextEncoding) -> Vec<u8> {
    match encoding {
        TextEncoding::Utf8 => text.as_bytes().to_vec(),
        TextEncoding::Utf8Bom => {
            let mut out = vec![0xEF, 0xBB, 0xBF];
            out.extend_from_slice(text.as_bytes());
            out
        }
        TextEncoding::Utf16Le => {
            let mut out = vec![0xFF, 0xFE];
            for unit in text.encode_utf16() {
                out.extend_from_slice(&unit.to_le_bytes());
            }
            out
        }
        TextEncoding::Utf16Be => {
            let mut out = vec![0xFE, 0xFF];
            for unit in text.encode_utf16() {
                out.extend_from_slice(&unit.to_be_bytes());
            }
            out
        }
    }
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Edit {
    pub start: usize,
    pub end: usize,
    pub text: String,
}

/// Applies ranges from the end of the document backwards so earlier offsets stay
/// valid. Overlapping edits are rejected instead of silently corrupting a file.
pub fn apply(text: &str, edits: &[Edit]) -> AppResult<String> {
    let mut sorted: Vec<&Edit> = edits.iter().collect();
    sorted.sort_by_key(|edit| edit.start);
    for pair in sorted.windows(2) {
        if pair[0].end > pair[1].start {
            return Err(AppError::Msg(
                "替换范围重叠，已取消写入以保护文件".to_string(),
            ));
        }
    }
    for edit in &sorted {
        if edit.start > edit.end || edit.end > text.len() {
            return Err(AppError::Msg("替换范围超出文件内容，已取消写入".to_string()));
        }
        if !text.is_char_boundary(edit.start) || !text.is_char_boundary(edit.end) {
            return Err(AppError::Msg(
                "替换范围不在字符边界上，已取消写入".to_string(),
            ));
        }
    }

    let mut out = text.to_string();
    for edit in sorted.iter().rev() {
        out.replace_range(edit.start..edit.end, &edit.text);
    }
    Ok(out)
}

/// Encodes a password for the exact place it is written to, keeping the original
/// quoting style whenever that is possible without changing the file's meaning.
pub fn encode_value(format: &str, location: &FieldLocation, value: &str) -> AppResult<String> {
    if location.xml_attr {
        return Ok(escape_xml(value, true));
    }
    match format {
        "json" => {
            if location.quoted {
                Ok(escape_json(value))
            } else {
                // An unquoted JSON token is a number/boolean/null; a password is
                // a string, so the whole token becomes a quoted string.
                Ok(format!("\"{}\"", escape_json(value)))
            }
        }
        "xml" => Ok(escape_xml(value, false)),
        "toml" | "yaml" | "env" | "text" => {
            if location.quoted {
                Ok(escape_backslash(value, '"'))
            } else if needs_quotes(format, value) {
                Ok(format!("\"{}\"", escape_backslash(value, '"')))
            } else {
                Ok(value.to_string())
            }
        }
        _ => Ok(value.to_string()),
    }
}

fn needs_quotes(format: &str, value: &str) -> bool {
    if value.is_empty() {
        return true;
    }
    let has = |needle: char| value.contains(needle);
    match format {
        "toml" | "yaml" => {
            has('#')
                || has(':')
                || has('"')
                || has('\'')
                || value.starts_with(' ')
                || value.ends_with(' ')
                || value.chars().any(|c| c.is_control())
        }
        "env" => {
            has('#')
                || has('=')
                || has('"')
                || has('\'')
                || value.chars().any(|c| c.is_whitespace())
        }
        // Plain text: keep `key=value` / `key: value` parseable.
        _ => {
            has('#')
                || has(':')
                || has('=')
                || has('"')
                || value.chars().any(|c| c.is_whitespace())
        }
    }
}

fn escape_json(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            control if control.is_control() => {
                out.push_str(&format!("\\u{:04x}", control as u32));
            }
            other => out.push(other),
        }
    }
    out
}

fn escape_backslash(value: &str, quote: char) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' if quote == '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            other => out.push(other),
        }
    }
    out
}

fn escape_xml(value: &str, attribute: bool) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' if attribute => out.push_str("&quot;"),
            other => out.push(other),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn location(start: usize, end: usize, quoted: bool, xml_attr: bool) -> FieldLocation {
        FieldLocation {
            start,
            end,
            quoted,
            xml_attr,
            line: 1,
        }
    }

    #[test]
    fn applies_edits_from_the_end() {
        let text = "{\"a\":\"111\",\"b\":\"2222\"}";
        let edits = vec![
            Edit { start: 6, end: 9, text: "X".to_string() },
            Edit { start: 16, end: 20, text: "YY".to_string() },
        ];
        assert_eq!(apply(text, &edits).unwrap(), "{\"a\":\"X\",\"b\":\"YY\"}");
    }

    #[test]
    fn refuses_overlapping_or_out_of_range_edits() {
        let text = "abcdef";
        let overlapping = vec![
            Edit { start: 0, end: 3, text: "x".into() },
            Edit { start: 2, end: 4, text: "y".into() },
        ];
        assert!(apply(text, &overlapping).is_err());
        let outside = vec![Edit { start: 4, end: 99, text: "y".into() }];
        assert!(apply(text, &outside).is_err());
    }

    #[test]
    fn json_values_keep_their_quoting() {
        let quoted = location(1, 4, true, false);
        assert_eq!(encode_value("json", &quoted, "a\"b").unwrap(), "a\\\"b");
        let bare = location(0, 3, false, false);
        assert_eq!(encode_value("json", &bare, "abc").unwrap(), "\"abc\"");
    }

    #[test]
    fn xml_values_are_escaped() {
        let attribute = location(1, 4, true, true);
        assert_eq!(
            encode_value("xml", &attribute, "a&b<c").unwrap(),
            "a&amp;b&lt;c"
        );
        let element = location(1, 4, false, false);
        assert_eq!(encode_value("xml", &element, "a&b").unwrap(), "a&amp;b");
    }

    #[test]
    fn unquoted_values_are_quoted_only_when_needed() {
        let bare = location(0, 3, false, false);
        assert_eq!(encode_value("env", &bare, "Simple123").unwrap(), "Simple123");
        assert_eq!(encode_value("env", &bare, "has space").unwrap(), "\"has space\"");
        assert_eq!(encode_value("toml", &bare, "a#b").unwrap(), "\"a#b\"");
        assert_eq!(encode_value("text", &bare, "plain").unwrap(), "plain");
    }

    #[test]
    fn round_trips_every_encoding() {
        for encoding in [
            TextEncoding::Utf8,
            TextEncoding::Utf8Bom,
            TextEncoding::Utf16Le,
            TextEncoding::Utf16Be,
        ] {
            let text = "ключ=значение\n中文行\n";
            let bytes = encode(text, encoding);
            let (decoded, detected) = decode(&bytes).unwrap();
            assert_eq!(decoded, text, "encoding {encoding:?}");
            assert_eq!(detected, encoding, "encoding {encoding:?}");
        }
    }

    #[test]
    fn binary_content_is_rejected() {
        assert!(decode(&[0x00, 0x01, 0x02]).is_none());
    }

    #[test]
    fn editing_keeps_every_other_byte() {
        let original = "{\n  \"user\": \"JDOE\",\n  \"password\": \"old\"\n}\n";
        let start = original.find("old").unwrap();
        let edit = Edit {
            start,
            end: start + 3,
            text: "NEW".to_string(),
        };
        let updated = apply(original, &[edit]).unwrap();
        assert_eq!(
            updated,
            "{\n  \"user\": \"JDOE\",\n  \"password\": \"NEW\"\n}\n"
        );
    }
}
