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
    now_string, FieldLocation, FileAnalysis, FileValue, KeyMapping,
};
use crate::patch::{self, TextEncoding};

/// Guards against pulling a whole database dump into memory.
pub const MAX_ANALYZE_BYTES: u64 = 4 * 1024 * 1024;

/// Supported formats. Plain text was dropped on purpose: every sync target has
/// to be addressable by a key so the user can point at the password value.
pub const FORMATS: [&str; 8] = ["json", "env", "toml", "ini", "properties", "hcl", "yaml", "xml"];

/// Human readable names for the supported formats.
pub fn supported_labels() -> Vec<String> {
    vec![
        "JSON (.json)".to_string(),
        ".env".to_string(),
        "TOML / INI / properties (.toml .ini .conf .cfg .properties .tfvars)".to_string(),
        "YAML (.yaml .yml)".to_string(),
        "XML (.xml .config .plist .resx)".to_string(),
    ]
}

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
        "toml" => "toml",
        "ini" | "conf" | "cfg" | "cnf" => "ini",
        "properties" => "properties",
        "tfvars" | "hcl" => "hcl",
        "yaml" | "yml" => "yaml",
        "xml" | "config" | "plist" | "resx" | "xsd" | "svg" => "xml",
        _ => "unsupported",
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
        values: Vec::new(),
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
    if !FORMATS.contains(&format) {
        return FileAnalysis {
            format: format.to_string(),
            values: Vec::new(),
            analyzed_at: now_string(),
            error: Some("不支持的文件类型".to_string()),
        };
    }
    let values: Vec<FileValue> = extract(text, format)
        .into_iter()
        .map(|value| FileValue {
            password_candidate: mapping.is_password_key(&value.key),
            key: value.key,
            path: value.path,
            parent: value.parent,
            value: value.value,
            line: value.line,
            location: FieldLocation {
                start: value.start,
                end: value.end,
                quoted: value.quoted,
                xml_attr: value.xml_attr,
                line: value.line,
            },
        })
        .collect();

    FileAnalysis {
        format: format.to_string(),
        values,
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
        "toml" => extract_toml(text, CommentRule::Hash),
        "ini" | "properties" | "hcl" => extract_toml(text, CommentRule::Loose),
        "yaml" => extract_yaml(text),
        "xml" => extract_xml(text),
        _ => Vec::new(),
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

/// Which marker starts a comment in a `key = value` dialect.
#[derive(Clone, Copy)]
enum CommentRule {
    /// TOML / YAML: `#` starts a comment anywhere outside quotes.
    Hash,
    /// `.env` / INI / properties / HCL: `#`, `;`, `!` and `//` only at the line
    /// start or after whitespace, so values such as `PASSWORD=ab#cd` or
    /// `jdbc:sqlserver://host;databaseName=db` are never cut in half.
    Loose,
}

/// Byte offset where a trailing comment starts, respecting quotes. Everything
/// after it is treated as a comment and is never parsed nor overwritten.
fn comment_start(line: &str, rule: CommentRule) -> usize {
    let mut in_single = false;
    let mut in_double = false;
    let mut previous_space = true;
    let bytes = line.as_bytes();
    for (index, ch) in line.char_indices() {
        if in_single || in_double {
            match ch {
                '\'' if !in_double => in_single = false,
                '"' if !in_single => in_double = false,
                _ => {}
            }
            previous_space = ch.is_whitespace();
            continue;
        }
        if ch == '\'' {
            in_single = true;
        } else if ch == '"' {
            in_double = true;
        } else {
            let hash = match rule {
                CommentRule::Hash => ch == '#',
                CommentRule::Loose => ch == '#' && previous_space,
            };
            let loose_marker = matches!(rule, CommentRule::Loose)
                && previous_space
                && matches!(ch, ';' | '!');
            let slash = matches!(rule, CommentRule::Loose)
                && previous_space
                && ch == '/'
                && bytes.get(index + 1) == Some(&b'/');
            if hash || loose_marker || slash {
                return index;
            }
        }
        previous_space = ch.is_whitespace();
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
        // `KEY=value # note`: the note must never become part of the value.
        let raw_value = &line[equals + 1..];
        let raw_value = &raw_value[..comment_start(raw_value, CommentRule::Loose)];
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

fn extract_toml(text: &str, rule: CommentRule) -> Vec<FlatValue> {
    let mut out = Vec::new();
    let lines = LineIndex::new(text);
    let mut section = String::new();
    for raw_line in text.split_inclusive('\n') {
        let full = raw_line.trim_end_matches(['\n', '\r']);
        let cut = comment_start(full, rule);
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
    // Indentation of the `key: |` / `key: >` block we are currently inside.
    let mut block: Option<usize> = None;

    for raw_line in text.split_inclusive('\n') {
        let full = raw_line.trim_end_matches(['\n', '\r']);
        if let Some(level) = block {
            if full.trim().is_empty() {
                continue;
            }
            let indent = full.len() - full.trim_start().len();
            if indent > level {
                // Literal block content: `#` is data here, and a line that looks
                // like `password: x` is text, never a key.
                continue;
            }
            block = None;
        }
        let cut = comment_start(full, CommentRule::Hash);
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

        let plain = raw_value.trim();
        // `key: |`, `key: |-`, `key: >2` … — everything indented below is literal
        // text. A plain container key (`sap:`) is *not* a block scalar.
        let is_block_header = (plain.starts_with('|') || plain.starts_with('>'))
            && plain[1..].chars().all(|ch| matches!(ch, '-' | '+' | '0'..='9'));
        if plain.is_empty() || is_block_header {
            if is_block_header {
                block = Some(indent);
            }
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

    /// Whitespace *and* JSONC comments are skipped, so a commented-out key never
    /// shows up as a value and can therefore never be overwritten.
    fn skip_ws(&mut self) {
        loop {
            while matches!(self.peek(), Some(b' ') | Some(b'\t') | Some(b'\n') | Some(b'\r')) {
                self.pos += 1;
            }
            if self.peek() != Some(b'/') {
                return;
            }
            match self.bytes().get(self.pos + 1).copied() {
                Some(b'/') => {
                    while matches!(self.peek(), Some(byte) if byte != b'\n') {
                        self.pos += 1;
                    }
                }
                Some(b'*') => {
                    self.pos += 2;
                    while self.pos < self.bytes().len() {
                        if self.bytes()[self.pos] == b'*'
                            && self.bytes().get(self.pos + 1) == Some(&b'/')
                        {
                            self.pos += 2;
                            break;
                        }
                        self.pos += 1;
                    }
                }
                _ => return,
            }
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
                // Containers (elements with child markup) are not values: their
                // content is markup, and a child edit would "change" them.
                if raw.trim().is_empty() || raw.contains('<') {
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
