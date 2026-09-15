//! Content-file parsing.
//!
//! Two things matter here:
//!   1. the credential fields are located by key words, and
//!   2. the *exact byte range* of every value is recorded, so syncing can
//!      replace only the password and leave every other byte untouched.
//!
//! Supported formats: JSON, .env, TOML, YAML, XML and plain text.

use std::path::Path;

use quick_xml::events::Event;
use quick_xml::Reader;

use crate::model::{
    now_string, FieldHit, FieldLocation, FileAnalysis, FileRecord, KeyMapping,
};
use crate::patch::{self, TextEncoding};

pub const KIND_URL: &str = "url";
pub const KIND_USERNAME: &str = "username";
pub const KIND_PASSWORD: &str = "password";
const KINDS: [&str; 3] = [KIND_URL, KIND_USERNAME, KIND_PASSWORD];

/// Guards against pulling a whole database dump into memory.
pub const MAX_ANALYZE_BYTES: u64 = 4 * 1024 * 1024;

const FORMATS: [&str; 6] = ["json", "env", "toml", "yaml", "xml", "text"];

/// Suffixes used to group `PREFIX_URL` / `PREFIX_USER` / `PREFIX_PASSWORD` keys.
const ENV_SUFFIXES: [&str; 12] = [
    "_url", "_uri", "_host", "_server", "_user", "_username", "_userid", "_login", "_password",
    "_passwd", "_pwd", "_secret",
];

#[derive(Debug, Clone)]
struct FlatValue {
    key: String,
    path: String,
    parent: String,
    value: String,
    start: usize,
    end: usize,
    quoted: bool,
    xml_attr: bool,
    line: u32,
}

/// A file read together with its parse result. The text and the offsets always
/// come from the same read, which is what makes in-place editing safe.
pub struct LoadedFile {
    pub text: String,
    pub encoding: TextEncoding,
    pub analysis: FileAnalysis,
}

// ---------------------------------------------------------------------------
// Format detection & loading
// ---------------------------------------------------------------------------

pub fn detect_format(path: &Path) -> String {
    let name = path
        .file_name()
        .map(|value| value.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    // `.env` and friends have no extension, so the name is checked first.
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
        "toml" | "ini" | "conf" | "cfg" | "properties" => "toml",
        "yaml" | "yml" => "yaml",
        "xml" | "plist" | "config" | "resx" => "xml",
        _ => "text",
    }
    .to_string()
}

pub fn is_supported(path: &Path) -> bool {
    FORMATS.contains(&detect_format(path).as_str())
}

/// Reads and parses a file. Errors are reported inside `analysis.error` so the
/// UI can show a per-file message.
pub fn load(path: &Path, mapping: &KeyMapping) -> LoadedFile {
    let format = detect_format(path);
    let error_analysis = |error: String| FileAnalysis {
        format: format.clone(),
        records: Vec::new(),
        missing: KINDS.iter().map(|kind| kind.to_string()).collect(),
        analyzed_at: now_string(),
        error: Some(error),
    };

    let metadata = match std::fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(err) => {
            return LoadedFile {
                text: String::new(),
                encoding: TextEncoding::Utf8,
                analysis: error_analysis(format!("无法读取文件信息：{err}")),
            }
        }
    };
    if metadata.len() > MAX_ANALYZE_BYTES {
        return LoadedFile {
            text: String::new(),
            encoding: TextEncoding::Utf8,
            analysis: error_analysis(format!(
                "文件过大（{} MB），超过 {} MB 的处理上限",
                metadata.len() / 1048576,
                MAX_ANALYZE_BYTES / 1048576
            )),
        };
    }

    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(err) => {
            return LoadedFile {
                text: String::new(),
                encoding: TextEncoding::Utf8,
                analysis: error_analysis(format!("无法读取文件：{err}")),
            }
        }
    };

    let Some((text, encoding)) = patch::decode(&bytes) else {
        return LoadedFile {
            text: String::new(),
            encoding: TextEncoding::Utf8,
            analysis: error_analysis("文件看起来是二进制内容，无法解析".to_string()),
        };
    };

    let analysis = analyze_text(&text, &format, mapping);
    LoadedFile {
        text,
        encoding,
        analysis,
    }
}

pub fn analyze_file(path: &Path, mapping: &KeyMapping) -> FileAnalysis {
    load(path, mapping).analysis
}

pub fn analyze_text(text: &str, format: &str, mapping: &KeyMapping) -> FileAnalysis {
    let values = extract(text, format);
    let records = group(&values, mapping, format);

    let missing: Vec<String> = KINDS
        .iter()
        .filter(|kind| !records.iter().any(|record| record.hit(kind).is_some()))
        .map(|kind| kind.to_string())
        .collect();

    FileAnalysis {
        format: format.to_string(),
        records,
        missing,
        analyzed_at: now_string(),
        error: None,
    }
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

fn extract(text: &str, format: &str) -> Vec<FlatValue> {
    match format {
        "json" => extract_json(text),
        "env" => extract_env(text),
        "toml" => extract_toml(text),
        "yaml" => extract_yaml(text),
        "xml" => extract_xml(text),
        _ => extract_text(text),
    }
}

/// Absolute byte offset of a sub-slice inside the document.
fn offset_of(text: &str, sub: &str) -> usize {
    sub.as_ptr() as usize - text.as_ptr() as usize
}

/// Precomputed line starts so line numbers are a binary search.
struct LineIndex {
    starts: Vec<usize>,
}

impl LineIndex {
    fn new(text: &str) -> Self {
        let mut starts = vec![0usize];
        for (index, byte) in text.bytes().enumerate() {
            if byte == b'\n' {
                starts.push(index + 1);
            }
        }
        Self { starts }
    }

    fn line_at(&self, offset: usize) -> u32 {
        match self.starts.binary_search(&offset) {
            Ok(index) => index as u32 + 1,
            Err(index) => index as u32,
        }
    }
}

/// Value range inside a `key=value` / `key: value` pair.
fn value_range(text: &str, raw_value: &str) -> (usize, usize, bool) {
    let trimmed = raw_value.trim();
    if trimmed.len() >= 2 {
        let first = trimmed.as_bytes()[0];
        let last = trimmed.as_bytes()[trimmed.len() - 1];
        if (first == b'"' || first == b'\'') && first == last {
            let inner = &trimmed[1..trimmed.len() - 1];
            let start = offset_of(text, inner);
            return (start, start + inner.len(), true);
        }
    }
    let start = offset_of(text, trimmed);
    (start, start + trimmed.len(), false)
}

fn unquote(value: &str) -> String {
    let trimmed = value.trim().trim_end_matches(',').trim();
    if trimmed.len() >= 2 {
        let first = trimmed.as_bytes()[0];
        let last = trimmed.as_bytes()[trimmed.len() - 1];
        if (first == b'"' || first == b'\'') && first == last {
            return trimmed[1..trimmed.len() - 1].to_string();
        }
    }
    trimmed.to_string()
}

/// Byte offset where a trailing `#` comment starts, respecting quotes.
fn comment_start(line: &str) -> usize {
    let mut in_single = false;
    let mut in_double = false;
    for (index, ch) in line.char_indices() {
        match ch {
            '\'' if !in_double => in_single = !in_single,
            '"' if !in_single => in_double = !in_double,
            '#' if !in_single && !in_double => return index,
            _ => {}
        }
    }
    line.len()
}

fn extract_env(text: &str) -> Vec<FlatValue> {
    let mut out = Vec::new();
    let lines = LineIndex::new(text);
    for raw_line in text.split_inclusive('\n') {
        let body = raw_line.trim_end_matches(['\n', '\r']);
        let line = body.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with("//") {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line).trim();
        let Some(equals) = line.find('=') else { continue };
        let key = line[..equals].trim();
        if key.is_empty() || key.len() > 64 {
            continue;
        }
        let raw_value = &line[equals + 1..];
        let (start, end, quoted) = value_range(text, raw_value);
        out.push(FlatValue {
            key: key.to_string(),
            path: key.to_string(),
            parent: String::new(),
            value: unquote(raw_value),
            start,
            end,
            quoted,
            xml_attr: false,
            line: lines.line_at(offset_of(text, key)),
        });
    }
    out
}

fn extract_toml(text: &str) -> Vec<FlatValue> {
    let mut out = Vec::new();
    let lines = LineIndex::new(text);
    let mut section = String::new();
    for raw_line in text.split_inclusive('\n') {
        let full = raw_line.trim_end_matches(['\n', '\r']);
        let cut = comment_start(full);
        let line = full[..cut].trim();
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
        let Some(equals) = line.find('=') else { continue };
        let key = line[..equals].trim();
        if key.is_empty() || key.len() > 64 {
            continue;
        }
        let raw_value = &line[equals + 1..];
        let trimmed = raw_value.trim();
        if trimmed.starts_with('[') || trimmed.starts_with('{') {
            continue;
        }
        let (start, end, quoted) = value_range(text, raw_value);
        let path = if section.is_empty() {
            key.to_string()
        } else {
            format!("{section}.{key}")
        };
        out.push(FlatValue {
            key: key.to_string(),
            path,
            parent: section.clone(),
            value: unquote(raw_value),
            start,
            end,
            quoted,
            xml_attr: false,
            line: lines.line_at(offset_of(text, key)),
        });
    }
    out
}

fn extract_yaml(text: &str) -> Vec<FlatValue> {
    let mut out = Vec::new();
    let lines = LineIndex::new(text);
    let mut stack: Vec<(usize, String)> = Vec::new();

    for raw_line in text.split_inclusive('\n') {
        let full = raw_line.trim_end_matches(['\n', '\r']);
        let cut = comment_start(full);
        let content = full[..cut].trim_end();
        if content.trim().is_empty() || content.trim() == "---" {
            continue;
        }
        let indent = content.len() - content.trim_start().len();
        let body = content.trim().strip_prefix("- ").unwrap_or(content.trim());
        let Some(colon) = body.find(':') else { continue };
        let key = body[..colon].trim().trim_matches('"').trim_matches('\'');
        if key.is_empty() || key.len() > 64 {
            continue;
        }
        let raw_value = &body[colon + 1..];

        while let Some((level, _)) = stack.last() {
            if *level >= indent {
                stack.pop();
            } else {
                break;
            }
        }

        if raw_value.trim().is_empty() || raw_value.trim() == "|" || raw_value.trim() == ">" {
            stack.push((indent, key.to_string()));
            continue;
        }

        let parent: Vec<&str> = stack.iter().map(|(_, name)| name.as_str()).collect();
        let parent_path = parent.join(".");
        let path = if parent_path.is_empty() {
            key.to_string()
        } else {
            format!("{parent_path}.{key}")
        };
        let (start, end, quoted) = value_range(text, raw_value);
        out.push(FlatValue {
            key: key.to_string(),
            path,
            parent: parent_path,
            value: unquote(raw_value),
            start,
            end,
            quoted,
            xml_attr: false,
            line: lines.line_at(offset_of(text, key)),
        });
    }
    out
}

/// Plain text: `key=value` / `key: value` pairs and bare URLs, grouped into
/// paragraphs so a file describing several systems still yields several records.
fn extract_text(text: &str) -> Vec<FlatValue> {
    let mut out = Vec::new();
    let lines = LineIndex::new(text);
    let mut block = 0usize;
    let mut previous_blank = true;

    for raw_line in text.split_inclusive('\n') {
        let full = raw_line.trim_end_matches(['\n', '\r']);
        if full.trim().is_empty() {
            previous_blank = true;
            continue;
        }
        if previous_blank {
            block += 1;
            previous_blank = false;
        }
        let parent = format!("段落 {block}");
        let line = full.trim();
        if line.starts_with('#') || line.starts_with("//") {
            continue;
        }

        let mut matched = false;
        for separator in ['=', ':'] {
            if let Some(index) = line.find(separator) {
                let key = line[..index]
                    .trim()
                    .trim_start_matches('-')
                    .trim()
                    .trim_matches('"')
                    .trim_matches('\'')
                    .trim();
                if key.is_empty() || key.len() > 64 {
                    continue;
                }
                let raw_value = &line[index + 1..];
                if raw_value.trim().is_empty() {
                    continue;
                }
                let (start, end, quoted) = value_range(text, raw_value);
                out.push(FlatValue {
                    key: key.to_string(),
                    path: key.to_string(),
                    parent: parent.clone(),
                    value: unquote(raw_value),
                    start,
                    end,
                    quoted,
                    xml_attr: false,
                    line: lines.line_at(offset_of(text, key)),
                });
                matched = true;
                break;
            }
        }
        if matched {
            continue;
        }
        // Bare URLs are useful even without a key.
        for token in line.split(|c: char| c.is_whitespace() || c == '"' || c == '\'' || c == ',') {
            if looks_like_url(token) {
                let start = offset_of(text, token);
                out.push(FlatValue {
                    key: "url".to_string(),
                    path: "url".to_string(),
                    parent: parent.clone(),
                    value: token.to_string(),
                    start,
                    end: start + token.len(),
                    quoted: false,
                    xml_attr: false,
                    line: lines.line_at(start),
                });
            }
        }
    }
    out
}

fn looks_like_url(value: &str) -> bool {
    let lower = value.trim().to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

// --------------------------------------------------------------- JSON -------

struct JsonScanner<'a> {
    text: &'a str,
    pos: usize,
    out: Vec<FlatValue>,
}

impl<'a> JsonScanner<'a> {
    fn new(text: &'a str) -> Self {
        Self {
            text,
            pos: 0,
            out: Vec::new(),
        }
    }

    fn bytes(&self) -> &[u8] {
        self.text.as_bytes()
    }

    fn peek(&self) -> Option<u8> {
        self.bytes().get(self.pos).copied()
    }

    fn skip_ws(&mut self) {
        while matches!(self.peek(), Some(b' ') | Some(b'\t') | Some(b'\n') | Some(b'\r')) {
            self.pos += 1;
        }
    }

    fn parse_document(&mut self) {
        self.skip_ws();
        self.parse_value("", "");
    }

    fn parse_value(&mut self, path: &str, parent: &str) {
        self.skip_ws();
        match self.peek() {
            Some(b'{') => self.parse_object(path),
            Some(b'[') => self.parse_array(path),
            Some(b'"') => {
                if let Some((start, end, value)) = self.parse_string() {
                    self.push(last_segment(path), path, parent, value, start, end, true);
                }
            }
            Some(_) => {
                let start = self.pos;
                while matches!(self.peek(), Some(byte) if !matches!(byte, b',' | b'}' | b']' | b' ' | b'\t' | b'\n' | b'\r'))
                {
                    self.pos += 1;
                }
                let raw = self.text[start..self.pos].trim().to_string();
                if !raw.is_empty() {
                    self.push(last_segment(path), path, parent, raw, start, self.pos, false);
                }
            }
            None => {}
        }
    }

    fn parse_object(&mut self, path: &str) {
        self.pos += 1; // consume `{`
        loop {
            self.skip_ws();
            match self.peek() {
                Some(b'}') => {
                    self.pos += 1;
                    return;
                }
                Some(b',') => {
                    self.pos += 1;
                    continue;
                }
                Some(b'"') => {}
                _ => return,
            }
            let Some((_, _, key)) = self.parse_string() else { return };
            self.skip_ws();
            if self.peek() == Some(b':') {
                self.pos += 1;
            }
            let child = if path.is_empty() {
                key.clone()
            } else {
                format!("{path}.{key}")
            };
            self.parse_value(&child, path);
            self.skip_ws();
        }
    }

    fn parse_array(&mut self, path: &str) {
        self.pos += 1; // consume `[`
        let mut index = 0usize;
        loop {
            self.skip_ws();
            match self.peek() {
                Some(b']') => {
                    self.pos += 1;
                    return;
                }
                Some(b',') => {
                    self.pos += 1;
                    continue;
                }
                _ => {}
            }
            let child = format!("{path}[{index}]");
            self.parse_value(&child, path);
            index += 1;
            self.skip_ws();
        }
    }

    /// Parses a string literal, returning the inner byte range and decoded value.
    fn parse_string(&mut self) -> Option<(usize, usize, String)> {
        if self.peek() != Some(b'"') {
            return None;
        }
        self.pos += 1;
        let start = self.pos;
        let mut out = String::new();
        while self.pos < self.bytes().len() {
            match self.bytes()[self.pos] {
                b'"' => {
                    let end = self.pos;
                    self.pos += 1;
                    return Some((start, end, out));
                }
                b'\\' => {
                    self.pos += 1;
                    match self.peek() {
                        Some(b'n') => out.push('\n'),
                        Some(b't') => out.push('\t'),
                        Some(b'r') => out.push('\r'),
                        Some(b'b') => out.push('\u{8}'),
                        Some(b'f') => out.push('\u{c}'),
                        Some(b'"') => out.push('"'),
                        Some(b'\\') => out.push('\\'),
                        Some(b'/') => out.push('/'),
                        Some(b'u') => {
                            let mut code = 0u32;
                            for _ in 0..4 {
                                self.pos += 1;
                                if let Some(digit) = self.peek().and_then(|b| (b as char).to_digit(16))
                                {
                                    code = code * 16 + digit;
                                }
                            }
                            if let Some(ch) = char::from_u32(code) {
                                out.push(ch);
                            }
                        }
                        Some(other) => out.push(other as char),
                        None => break,
                    }
                    self.pos += 1;
                }
                _ => {
                    let ch = self.text[self.pos..].chars().next()?;
                    out.push(ch);
                    self.pos += ch.len_utf8();
                }
            }
        }
        None
    }

    #[allow(clippy::too_many_arguments)]
    fn push(
        &mut self,
        key: &str,
        path: &str,
        parent: &str,
        value: String,
        start: usize,
        end: usize,
        quoted: bool,
    ) {
        if value.trim().is_empty() || key.trim().is_empty() {
            return;
        }
        self.out.push(FlatValue {
            key: key.to_string(),
            path: path.to_string(),
            parent: parent.to_string(),
            value,
            start,
            end,
            quoted,
            xml_attr: false,
            line: 0,
        });
    }
}

fn last_segment(path: &str) -> &str {
    let trimmed = path.trim_end_matches(']');
    match trimmed.rfind(['.', '[']) {
        Some(index) => &trimmed[index + 1..],
        None => trimmed,
    }
}

fn extract_json(text: &str) -> Vec<FlatValue> {
    let mut scanner = JsonScanner::new(text);
    scanner.parse_document();
    let mut values = scanner.out;
    let lines = LineIndex::new(text);
    for value in values.iter_mut() {
        value.line = lines.line_at(value.start);
    }
    values
}

// --------------------------------------------------------------- XML --------

/// Expands the predefined XML entities; the raw range is kept for writing.
fn unescape_entities(value: &str) -> String {
    value
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

fn xml_local_name(raw: &[u8]) -> String {
    let name = match raw.iter().rposition(|byte| *byte == b':') {
        Some(index) => &raw[index + 1..],
        None => raw,
    };
    String::from_utf8_lossy(name).to_string()
}

/// Finds `name="value"` (or `name='value'`) inside a raw start tag and returns the
/// byte range of the value's inner text.
fn attribute_range(tag: &str, name: &str, value: &str) -> Option<(usize, usize)> {
    for quote in ['"', '\''] {
        let needle = format!("{name}={quote}{value}{quote}");
        if let Some(index) = tag.find(&needle) {
            let quote_len = quote.len_utf8();
            let value_start = index + name.len() + 1 + quote_len;
            return Some((value_start, value_start + value.len()));
        }
        // The raw value may use entities, so fall back to a looser match.
        let prefix = format!("{name}={quote}");
        if let Some(index) = tag.find(&prefix) {
            let value_start = index + prefix.len();
            let rest = &tag[value_start..];
            if let Some(end) = rest.find(quote) {
                return Some((value_start, value_start + end));
            }
        }
    }
    None
}

fn stack_path(stack: &[(String, usize)]) -> String {
    stack
        .iter()
        .map(|(name, _)| name.as_str())
        .collect::<Vec<_>>()
        .join(".")
}

/// XML text is collected per *element* (from the end of its start tag to the
/// beginning of its end tag) because quick-xml splits entity references such as
/// `&amp;` into separate events. The recorded range therefore covers the whole
/// raw content, and the value is the unescaped text.
fn extract_xml(text: &str) -> Vec<FlatValue> {
    let mut out: Vec<FlatValue> = Vec::new();
    let lines = LineIndex::new(text);
    let mut reader = Reader::from_str(text);
    reader.config_mut().trim_text(false);
    // (element name, offset where its content starts)
    let mut stack: Vec<(String, usize)> = Vec::new();

    loop {
        let before = reader.buffer_position() as usize;
        match reader.read_event() {
            Ok(Event::Start(element)) => {
                let after = reader.buffer_position() as usize;
                let name = xml_local_name(element.local_name().as_ref());
                collect_xml_attributes(text, before, after, &stack, &name, &element, &lines, &mut out);
                stack.push((name, after));
            }
            Ok(Event::Empty(element)) => {
                let after = reader.buffer_position() as usize;
                let name = xml_local_name(element.local_name().as_ref());
                collect_xml_attributes(text, before, after, &stack, &name, &element, &lines, &mut out);
            }
            Ok(Event::End(_)) => {
                let Some((name, start)) = stack.pop() else {
                    continue;
                };
                if start > before || before > text.len() {
                    continue;
                }
                let raw = &text[start..before];
                if raw.trim().is_empty() {
                    continue;
                }
                let parent = stack_path(&stack);
                let path = if parent.is_empty() {
                    name.clone()
                } else {
                    format!("{parent}.{name}")
                };
                out.push(FlatValue {
                    key: name,
                    path,
                    parent,
                    value: unescape_entities(raw).trim().to_string(),
                    start,
                    end: before,
                    quoted: false,
                    xml_attr: false,
                    line: lines.line_at(start),
                });
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

#[allow(clippy::too_many_arguments)]
fn collect_xml_attributes(
    text: &str,
    before: usize,
    after: usize,
    stack: &[(String, usize)],
    element_name: &str,
    element: &quick_xml::events::BytesStart<'_>,
    lines: &LineIndex,
    out: &mut Vec<FlatValue>,
) {
    let tag = &text[before..after.max(before)];
    let parent = stack_path(stack);
    let element_path = if parent.is_empty() {
        element_name.to_string()
    } else {
        format!("{parent}.{element_name}")
    };
    for attribute in element.attributes().flatten() {
        let key = xml_local_name(attribute.key.local_name().as_ref());
        let value = attribute
            .unescape_value()
            .map(|value| value.into_owned())
            .unwrap_or_default();
        if value.trim().is_empty() {
            continue;
        }
        let Some((start, end)) = attribute_range(tag, &key, &value) else {
            continue;
        };
        out.push(FlatValue {
            key: key.clone(),
            path: format!("{element_path}@{key}"),
            parent: element_path.clone(),
            value: value.trim().to_string(),
            start: before + start,
            end: before + end,
            quoted: true,
            xml_attr: true,
            line: lines.line_at(before),
        });
    }
}

// ---------------------------------------------------------------------------
// Record grouping
// ---------------------------------------------------------------------------

/// Key kind for a value, or `None` when the key is not a credential keyword.
fn kind_of(key: &str, mapping: &KeyMapping) -> Option<&'static str> {
    // Password first: `user_password` should be a password, not a user name.
    for (kind, keys) in [
        (KIND_PASSWORD, &mapping.password),
        (KIND_USERNAME, &mapping.username),
        (KIND_URL, &mapping.url),
    ] {
        if keys.iter().any(|candidate| key_matches(key, candidate, mapping)) {
            return Some(kind);
        }
    }
    None
}

fn key_matches(candidate: &str, key: &str, mapping: &KeyMapping) -> bool {
    let equals = |a: &str, b: &str| {
        if mapping.ignore_case {
            a.eq_ignore_ascii_case(b)
        } else {
            a == b
        }
    };
    if equals(candidate, key) {
        return true;
    }
    if mapping.exact || key.chars().count() < 3 {
        return false;
    }
    if mapping.ignore_case {
        candidate.to_ascii_lowercase().contains(&key.to_ascii_lowercase())
    } else {
        candidate.contains(key)
    }
}

/// Group key for a value: the containing block for structured formats, and a
/// prefix for `PREFIX_URL` style env files.
fn group_key(value: &FlatValue, format: &str) -> String {
    match format {
        "env" => {
            let lower = value.key.to_ascii_lowercase();
            for suffix in ENV_SUFFIXES {
                if lower.ends_with(suffix) {
                    let cut = value.key.len() - suffix.len();
                    return value.key[..cut].to_string();
                }
            }
            String::new()
        }
        _ => value.parent.clone(),
    }
}

fn group(values: &[FlatValue], mapping: &KeyMapping, format: &str) -> Vec<FileRecord> {
    let mut order: Vec<String> = Vec::new();
    let mut buckets: std::collections::HashMap<String, Vec<(FlatValue, &'static str)>> =
        std::collections::HashMap::new();

    for value in values {
        let Some(kind) = kind_of(&value.key, mapping) else {
            continue;
        };
        let key = group_key(value, format);
        if !buckets.contains_key(&key) {
            order.push(key.clone());
        }
        buckets.entry(key).or_default().push((value.clone(), kind));
    }

    // A block that is missing a field often shares it with a parent block
    // (e.g. `[sap] url = ...` and `[sap.auth] password = ...`), so pull the
    // missing kinds down from the nearest ancestor before giving up.
    if matches!(format, "json" | "toml" | "yaml" | "xml") {
        for key in order.clone() {
            let ancestors = ancestor_paths(&key);
            let mut present: std::collections::HashSet<&'static str> = buckets
                .get(&key)
                .map(|items| items.iter().map(|(_, kind)| *kind).collect())
                .unwrap_or_default();
            for ancestor in ancestors {
                if ancestor == key {
                    continue;
                }
                let Some(items) = buckets.get(&ancestor).cloned() else {
                    continue;
                };
                for (value, kind) in items {
                    if present.insert(kind) {
                        buckets.entry(key.clone()).or_default().push((value, kind));
                    }
                }
            }
        }
    }

    let mut records = Vec::new();
    for key in order {
        let Some(items) = buckets.get(&key) else { continue };
        let mut fields: Vec<FieldHit> = Vec::new();
        for kind in KINDS {
            let candidate = items
                .iter()
                .filter(|(_, item_kind)| *item_kind == kind)
                .min_by_key(|(value, _)| {
                    let matchers = mapping.matchers(kind);
                    let exact = matchers.iter().any(|needle| {
                        if mapping.ignore_case {
                            value.key.eq_ignore_ascii_case(needle)
                        } else {
                            value.key == *needle
                        }
                    });
                    let specificity = matchers
                        .iter()
                        .filter(|needle| key_matches(&value.key, needle, mapping))
                        .map(|needle| needle.chars().count())
                        .max()
                        .unwrap_or(0);
                    (if exact { 0u8 } else { 1u8 }, usize::MAX - specificity)
                });
            let Some((value, _)) = candidate else { continue };
            fields.push(FieldHit {
                kind: kind.to_string(),
                key: value.key.clone(),
                path: value.path.clone(),
                value: value.value.clone(),
                line: value.line,
                location: Some(FieldLocation {
                    start: value.start,
                    end: value.end,
                    quoted: value.quoted,
                    xml_attr: value.xml_attr,
                    line: value.line,
                }),
            });
        }
        if fields.is_empty() {
            continue;
        }
        records.push(FileRecord {
            id: crate::model::new_id(),
            path: if key.is_empty() {
                "（文件级）".to_string()
            } else {
                key
            },
            fields,
        });
    }
    records
}

fn ancestor_paths(path: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = path.to_string();
    while let Some(index) = current.rfind('.') {
        current.truncate(index);
        out.push(current.clone());
    }
    out
}

impl KeyMapping {
    fn matchers(&self, kind: &str) -> &Vec<String> {
        match kind {
            KIND_URL => &self.url,
            KIND_USERNAME => &self.username,
            _ => &self.password,
        }
    }
}
