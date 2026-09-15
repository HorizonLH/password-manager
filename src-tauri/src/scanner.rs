use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use walkdir::WalkDir;

use crate::error::{AppError, AppResult};

const BINARY_SNIFF_BYTES: usize = 8 * 1024;
const EXCERPT_LIMIT: usize = 240;

/// Known-binary extensions are skipped by default: matching inside them is
/// meaningless noise, and decoding them wastes the whole scan budget.
const BINARY_EXTENSIONS: &[&str] = &[
    "exe", "dll", "sys", "msi", "cab", "zip", "7z", "rar", "gz", "tar", "bz2", "xz", "png",
    "jpg", "jpeg", "gif", "bmp", "ico", "webp", "tif", "tiff", "svgz", "mp3", "mp4", "avi",
    "mkv", "mov", "wav", "flac", "iso", "img", "vhd", "vhdx", "bin", "dat", "db", "sqlite",
    "sqlite3", "ldb", "pf", "etl", "evtx", "pak", "woff", "woff2", "ttf", "otf", "pdf", "doc",
    "docx", "xls", "xlsx", "ppt", "pptx", "class", "jar", "pyc", "pyd", "so", "o", "obj", "pdb",
];

/// Directories that never contain hand-written credentials but can hold tens of
/// thousands of files. Matched against the directory *name*, case-insensitive.
const SKIP_DIR_NAMES: &[&str] = &[
    "node_modules",
    ".git",
    ".svn",
    ".hg",
    "__pycache__",
    ".venv",
    "venv",
    ".gradle",
    ".m2",
    ".nuget",
    ".npm",
    ".cargo",
    ".rustup",
    ".conda",
    "$recycle.bin",
    "system volume information",
    "target",
    "crashdumps",
    "webcache",
    "gpucache",
    "code cache",
    "shadercache",
    "d3dscache",
];

/// Directories skipped by absolute path prefix, expanded from the environment.
const SKIP_PATH_TEMPLATES: &[&str] = &[
    r"%LOCALAPPDATA%\Temp",
    r"%LOCALAPPDATA%\Microsoft",
    r"%LOCALAPPDATA%\Packages",
    r"%LOCALAPPDATA%\Google",
    r"%LOCALAPPDATA%\Mozilla",
    r"%APPDATA%\Mozilla",
    r"%APPDATA%\Microsoft\Windows\Recent",
    r"%LOCALAPPDATA%\CrashDumps",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanOptions {
    /// Directories to walk. Defaults to the current user profile.
    #[serde(default)]
    pub roots: Vec<String>,
    /// Candidate host names / domain suffixes from the SAP landscape.
    #[serde(default)]
    pub hosts: Vec<String>,
    #[serde(default)]
    pub system_ids: Vec<String>,
    #[serde(default)]
    pub usernames: Vec<String>,
    /// `true` requires host + system id + user name in the same file (the rule
    /// from the specification). `false` accepts any two of the three.
    #[serde(default = "default_true")]
    pub strict: bool,
    #[serde(default = "default_max_file_bytes")]
    pub max_file_bytes: u64,
    #[serde(default = "default_max_files")]
    pub max_files: usize,
    #[serde(default = "default_max_depth")]
    pub max_depth: usize,
    #[serde(default)]
    pub follow_links: bool,
    /// When non-empty only these extensions are read.
    #[serde(default)]
    pub only_extensions: Vec<String>,
    /// Extra absolute paths to skip, e.g. the vault's own data directory.
    #[serde(default)]
    pub extra_skip_paths: Vec<String>,
    /// Human label of the account being searched for, echoed in the report.
    #[serde(default)]
    pub label: String,
}

fn default_true() -> bool {
    true
}
fn default_max_file_bytes() -> u64 {
    2 * 1024 * 1024
}
fn default_max_files() -> usize {
    30_000
}
fn default_max_depth() -> usize {
    10
}

impl Default for ScanOptions {
    fn default() -> Self {
        Self {
            roots: vec![default_scan_root()],
            hosts: Vec::new(),
            system_ids: Vec::new(),
            usernames: Vec::new(),
            strict: true,
            max_file_bytes: default_max_file_bytes(),
            max_files: default_max_files(),
            max_depth: default_max_depth(),
            follow_links: false,
            only_extensions: Vec::new(),
            extra_skip_paths: Vec::new(),
            label: String::new(),
        }
    }
}

pub fn default_scan_root() -> String {
    std::env::var_os("USERPROFILE")
        .map(|value| PathBuf::from(value).to_string_lossy().to_string())
        .unwrap_or_else(|| "C:\\".to_string())
}

pub fn skip_paths() -> Vec<String> {
    let mut out: Vec<String> = SKIP_PATH_TEMPLATES
        .iter()
        .map(|template| expand_env(template))
        .filter(|path| !path.is_empty())
        .collect();
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        out.push(
            PathBuf::from(local)
                .join("SapVault")
                .to_string_lossy()
                .to_string(),
        );
    }
    out
}

/// Expands `%VAR%` placeholders. Returns an empty string when a variable is
/// missing, so callers can filter the entry out instead of skipping a literal.
fn expand_env(template: &str) -> String {
    let mut out = template.to_string();
    for (key, value) in std::env::vars() {
        let token = format!("%{key}%");
        if out.to_ascii_lowercase().contains(&token.to_ascii_lowercase()) {
            out = replace_case_insensitive(&out, &token, &value);
        }
    }
    if out.contains('%') {
        return String::new();
    }
    out
}

fn replace_case_insensitive(haystack: &str, needle: &str, replacement: &str) -> String {
    let lower_hay = haystack.to_ascii_lowercase();
    let lower_needle = needle.to_ascii_lowercase();
    let mut result = String::with_capacity(haystack.len());
    let mut cursor = 0usize;
    while let Some(found) = lower_hay[cursor..].find(&lower_needle) {
        let start = cursor + found;
        result.push_str(&haystack[cursor..start]);
        result.push_str(replacement);
        cursor = start + needle.len();
    }
    result.push_str(&haystack[cursor..]);
    result
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanHit {
    pub path: String,
    pub label: String,
    pub size: u64,
    pub modified_at: Option<String>,
    pub matched_hosts: Vec<String>,
    pub matched_system_ids: Vec<String>,
    pub matched_usernames: Vec<String>,
    pub score: u8,
    pub first_line: u32,
    pub excerpt: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanReport {
    pub label: String,
    pub roots: Vec<String>,
    pub scanned_files: usize,
    pub skipped_files: usize,
    pub hits: Vec<ScanHit>,
    pub elapsed_ms: u64,
    pub cancelled: bool,
    pub truncated: bool,
    pub started_at: String,
    pub errors: Vec<String>,
}

/// Runs a scan. `on_progress` receives `(files_seen, current_path)` and is
/// throttled internally so the UI can update without flooding the channel.
pub fn run_scan(
    options: &ScanOptions,
    cancel: &AtomicBool,
    mut on_progress: impl FnMut(usize, &str),
) -> AppResult<ScanReport> {
    let started = Instant::now();
    let roots: Vec<String> = if options.roots.is_empty() {
        vec![default_scan_root()]
    } else {
        options.roots.clone()
    };

    let hosts: Vec<String> = normalize(&options.hosts, false);
    let system_ids: Vec<String> = normalize(&options.system_ids, true);
    let usernames: Vec<String> = normalize(&options.usernames, true);

    let require_host = !hosts.is_empty();
    let require_sid = !system_ids.is_empty();
    let require_user = !usernames.is_empty();
    let active_groups = [require_host, require_sid, require_user]
        .iter()
        .filter(|flag| **flag)
        .count();
    let needed = if options.strict {
        active_groups
    } else {
        active_groups.saturating_sub(1).max(1)
    };
    if active_groups == 0 {
        return Err(AppError::Msg(
            "没有可用的匹配条件：请至少提供系统 ID、用户名或主机名".to_string(),
        ));
    }

    let mut skip_prefixes: Vec<String> = skip_paths();
    skip_prefixes.extend(options.extra_skip_paths.iter().cloned());
    let skip_prefixes: Vec<String> = skip_prefixes
        .iter()
        .map(|path| path.trim_end_matches('\\').to_ascii_lowercase())
        .filter(|path| !path.is_empty())
        .collect();

    let only_extensions: Vec<String> = options
        .only_extensions
        .iter()
        .map(|extension| {
            extension
                .trim_start_matches('.')
                .to_ascii_lowercase()
        })
        .filter(|extension| !extension.is_empty())
        .collect();

    let mut report = ScanReport {
        label: options.label.clone(),
        roots: roots.clone(),
        started_at: crate::model::now_string(),
        ..Default::default()
    };

    for root in &roots {
        if cancel.load(Ordering::Relaxed) {
            report.cancelled = true;
            break;
        }
        let root_path = PathBuf::from(root);
        if !root_path.is_dir() {
            report.errors.push(format!("目录不存在或不可访问：{root}"));
            continue;
        }

        let walker = WalkDir::new(&root_path)
            .max_depth(options.max_depth.max(1))
            .follow_links(options.follow_links)
            .into_iter()
            .filter_entry(|entry| {
                if !entry.file_type().is_dir() {
                    return true;
                }
                let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
                if SKIP_DIR_NAMES.contains(&name.as_str()) {
                    return false;
                }
                let full = entry
                    .path()
                    .to_string_lossy()
                    .trim_end_matches('\\')
                    .to_ascii_lowercase();
                entry.path() == root_path.as_path()
                    || !skip_prefixes.iter().any(|skip| full.starts_with(skip))
            });

        for entry in walker {
            if cancel.load(Ordering::Relaxed) {
                report.cancelled = true;
                break;
            }
            let entry = match entry {
                Ok(entry) => entry,
                Err(err) => {
                    if report.errors.len() < 50 {
                        report.errors.push(err.to_string());
                    }
                    continue;
                }
            };
            if entry.file_type().is_dir() {
                continue;
            }
            if report.scanned_files >= options.max_files {
                report.truncated = true;
                break;
            }
            if report.scanned_files % 200 == 0 {
                on_progress(report.scanned_files, &entry.path().to_string_lossy());
            }

            let path = entry.path();
            let extension = path
                .extension()
                .map(|value| value.to_string_lossy().to_ascii_lowercase())
                .unwrap_or_default();
            if !only_extensions.is_empty() {
                if !only_extensions.contains(&extension) {
                    continue;
                }
            } else if BINARY_EXTENSIONS.contains(&extension.as_str()) {
                report.skipped_files += 1;
                continue;
            }

            let metadata = match entry.metadata() {
                Ok(metadata) => metadata,
                Err(_) => {
                    report.skipped_files += 1;
                    continue;
                }
            };
            if metadata.len() == 0 || metadata.len() > options.max_file_bytes {
                report.skipped_files += 1;
                continue;
            }

            report.scanned_files += 1;
            let bytes = match read_text_candidate(path) {
                Some(bytes) => bytes,
                None => {
                    report.skipped_files += 1;
                    continue;
                }
            };

            let matched_hosts = matched_values(&bytes, &hosts, false);
            let matched_system_ids = matched_values(&bytes, &system_ids, true);
            let matched_usernames = matched_values(&bytes, &usernames, true);
            let score = u8::from(!matched_hosts.is_empty())
                + u8::from(!matched_system_ids.is_empty())
                + u8::from(!matched_usernames.is_empty());
            if (score as usize) < needed {
                continue;
            }

            let mut all_tokens: Vec<&String> = Vec::new();
            all_tokens.extend(matched_hosts.iter());
            all_tokens.extend(matched_system_ids.iter());
            all_tokens.extend(matched_usernames.iter());
            let (first_line, excerpt) = locate(&bytes, &all_tokens);

            report.hits.push(ScanHit {
                path: path.to_string_lossy().to_string(),
                label: path
                    .file_name()
                    .map(|name| name.to_string_lossy().to_string())
                    .unwrap_or_default(),
                size: metadata.len(),
                modified_at: metadata.modified().ok().map(|time| {
                    let datetime: chrono::DateTime<chrono::Local> = time.into();
                    datetime.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
                }),
                matched_hosts,
                matched_system_ids,
                matched_usernames,
                score,
                first_line,
                excerpt,
            });
        }

        if report.truncated || report.cancelled {
            break;
        }
    }

    report.hits.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then_with(|| b.matched_hosts.len().cmp(&a.matched_hosts.len()))
            .then_with(|| a.path.cmp(&b.path))
    });
    report.elapsed_ms = started.elapsed().as_millis() as u64;
    Ok(report)
}

fn normalize(values: &[String], uppercase: bool) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for value in values {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            continue;
        }
        let normalized = if uppercase {
            trimmed.to_ascii_uppercase()
        } else {
            trimmed.to_ascii_lowercase()
        };
        if !out.contains(&normalized) {
            out.push(normalized);
        }
    }
    out
}

/// Returns the decoded text, or `None` for anything that looks binary.
fn read_text_candidate(path: &Path) -> Option<Vec<u8>> {
    let bytes = std::fs::read(path).ok()?;
    if bytes.is_empty() {
        return None;
    }
    if bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE {
        return Some(decode_utf16(&bytes[2..], true));
    }
    if bytes.len() >= 2 && bytes[0] == 0xFE && bytes[1] == 0xFF {
        return Some(decode_utf16(&bytes[2..], false));
    }
    let sniff_len = bytes.len().min(BINARY_SNIFF_BYTES);
    if bytes[..sniff_len].contains(&0) {
        return None;
    }
    Some(bytes)
}

fn decode_utf16(bytes: &[u8], little_endian: bool) -> Vec<u8> {
    let mut units: Vec<u16> = Vec::with_capacity(bytes.len() / 2);
    for chunk in bytes.chunks_exact(2) {
        units.push(if little_endian {
            u16::from_le_bytes([chunk[0], chunk[1]])
        } else {
            u16::from_be_bytes([chunk[0], chunk[1]])
        });
    }
    String::from_utf16_lossy(&units).into_bytes()
}

fn matched_values(haystack: &[u8], needles: &[String], boundary: bool) -> Vec<String> {
    needles
        .iter()
        .filter(|needle| find_ci(haystack, needle.as_bytes(), boundary).is_some())
        .cloned()
        .collect()
}

/// Case-insensitive byte search. With `boundary` enabled the match must not be
/// glued to an alphanumeric character, which keeps a 3-letter SID such as `DEV`
/// from matching inside words like `device`.
fn find_ci(haystack: &[u8], needle: &[u8], boundary: bool) -> Option<usize> {
    if needle.is_empty() || needle.len() > haystack.len() {
        return None;
    }
    let first = needle[0];
    let last_index = haystack.len() - needle.len();
    for start in 0..=last_index {
        if !haystack[start].eq_ignore_ascii_case(&first) {
            continue;
        }
        let mut matched = true;
        for offset in 1..needle.len() {
            if !haystack[start + offset].eq_ignore_ascii_case(&needle[offset]) {
                matched = false;
                break;
            }
        }
        if !matched {
            continue;
        }
        if boundary {
            if start > 0 && haystack[start - 1].is_ascii_alphanumeric() {
                continue;
            }
            let end = start + needle.len();
            if end < haystack.len() && haystack[end].is_ascii_alphanumeric() {
                continue;
            }
        }
        return Some(start);
    }
    None
}

/// Finds the first matching line so the UI can show a concrete snippet instead
/// of just a file name.
fn locate(bytes: &[u8], tokens: &[&String]) -> (u32, String) {
    let mut line_no = 1u32;
    let mut line_start = 0usize;
    let mut index = 0usize;
    while index <= bytes.len() {
        let at_end = index == bytes.len();
        if at_end || bytes[index] == b'\n' {
            let line = &bytes[line_start..index];
            if let Some(hit) = tokens
                .iter()
                .find(|token| find_ci(line, token.as_bytes(), false).is_some())
            {
                return (line_no, excerpt_of(line, hit.as_bytes()));
            }
            line_no += 1;
            line_start = index + 1;
        }
        index += 1;
    }
    (0, String::new())
}

fn excerpt_of(line: &[u8], needle: &[u8]) -> String {
    let text = String::from_utf8_lossy(line).trim().to_string();
    if text.chars().count() <= EXCERPT_LIMIT {
        return redact(&text);
    }
    let position = find_ci(line, needle, false).unwrap_or(0);
    let start = position.saturating_sub(EXCERPT_LIMIT / 2);
    let slice: String = text.chars().skip(start).take(EXCERPT_LIMIT).collect();
    redact(&slice)
}

/// Long opaque strings next to a user name are usually the password itself, so
/// they are collapsed and a scanned snippet never puts a secret on screen.
fn redact(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut run = String::new();
    for ch in text.chars() {
        // `/` and `+` are included so base64-ish blobs form a single run, while
        // delimiters such as `=` and `:` keep the key name readable.
        if ch.is_alphanumeric() || ch == '+' || ch == '/' {
            run.push(ch);
        } else {
            flush_run(&mut out, &mut run);
            out.push(ch);
        }
    }
    flush_run(&mut out, &mut run);
    out
}

fn flush_run(out: &mut String, run: &mut String) {
    if run.chars().count() >= 24 {
        let head: String = run.chars().take(4).collect();
        out.push_str(&head);
        out.push_str("••••••");
    } else {
        out.push_str(run);
    }
    run.clear();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    fn temp_root(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("sapvault-scan-{tag}-{}", crate::model::new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn options_for(root: &Path, strict: bool) -> ScanOptions {
        ScanOptions {
            roots: vec![root.to_string_lossy().to_string()],
            hosts: vec!["prd.sap.corp.example".into()],
            system_ids: vec!["PRD".into()],
            usernames: vec!["JDOE".into()],
            strict,
            ..ScanOptions::default()
        }
    }

    #[test]
    fn finds_file_matching_all_three_tokens() {
        let root = temp_root("triple");
        std::fs::write(
            root.join("sap_login.json"),
            r#"{"systemid":"PRD","server":"prd.sap.corp.example:3200","client":"100","user":"JDOE"}"#,
        )
        .unwrap();
        std::fs::write(root.join("unrelated.txt"), "hello world").unwrap();

        let report = run_scan(&options_for(&root, true), &AtomicBool::new(false), |_, _| {})
            .unwrap();
        assert_eq!(report.hits.len(), 1);
        assert_eq!(report.hits[0].score, 3);
        assert_eq!(report.hits[0].first_line, 1);
    }

    #[test]
    fn strict_mode_rejects_partial_matches() {
        let root = temp_root("partial");
        std::fs::write(root.join("half.ini"), "server=prd.sap.corp.example SID=PRD").unwrap();

        let strict = run_scan(&options_for(&root, true), &AtomicBool::new(false), |_, _| {})
            .unwrap();
        assert!(strict.hits.is_empty());

        let relaxed = run_scan(&options_for(&root, false), &AtomicBool::new(false), |_, _| {})
            .unwrap();
        assert_eq!(relaxed.hits.len(), 1);
        assert_eq!(relaxed.hits[0].score, 2);
    }

    #[test]
    fn short_system_id_needs_boundaries() {
        assert!(find_ci(b"this device is ready", b"DEV", true).is_none());
        assert!(find_ci(b"SID=DEV;", b"DEV", true).is_some());
    }

    #[test]
    fn binary_and_oversized_files_are_skipped() {
        let root = temp_root("binary");
        std::fs::write(root.join("blob.txt"), [0u8, 1, 2, 3, 0u8]).unwrap();
        std::fs::write(
            root.join("big.txt"),
            "JDOE PRD prd.sap.corp.example".repeat(200),
        )
        .unwrap();

        let options = ScanOptions {
            max_file_bytes: 64,
            ..options_for(&root, true)
        };
        let report = run_scan(&options, &AtomicBool::new(false), |_, _| {}).unwrap();
        assert!(report.hits.is_empty());
        assert!(report.skipped_files >= 2);
    }

    #[test]
    fn secrets_in_excerpts_are_collapsed() {
        assert_eq!(redact("pass=SuperSecretValue1234567890"), "pass=Supe••••••");
        assert_eq!(redact("user=JDOE"), "user=JDOE");
    }

    #[test]
    fn environment_templates_expand() {
        std::env::set_var("SAPVAULT_TEST_ROOT", "C:\\demo");
        assert_eq!(expand_env(r"%SAPVAULT_TEST_ROOT%\Temp"), "C:\\demo\\Temp");
        assert_eq!(expand_env(r"%NOPE_NOT_SET%\Temp"), "");
        std::env::remove_var("SAPVAULT_TEST_ROOT");
    }

    #[test]
    fn missing_conditions_are_reported() {
        let root = temp_root("empty-condition");
        let options = ScanOptions {
            roots: vec![root.to_string_lossy().to_string()],
            ..ScanOptions::default()
        };
        assert!(run_scan(&options, &AtomicBool::new(false), |_, _| {}).is_err());
    }
}
