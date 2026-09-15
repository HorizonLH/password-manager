//! Syncing = writing each account's password back into the uploaded files.
//!
//! Only the password value is replaced; every other byte of the file is kept.
//! Before writing, the updated document is re-parsed and compared with the
//! original so a bad match can never corrupt a file.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::keys;
use crate::model::{now_string, Entry, FileAnalysis, FileRecord, SyncFile, Vault};
use crate::patch::{self, Edit};

/// What sync will do with one credential block inside a file.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordPlan {
    pub record_id: String,
    pub path: String,
    pub url: String,
    pub username: String,
    pub password: String,
    /// `update` | `same` | `unbound` | `no-password` | `unreachable`
    pub action: String,
    #[serde(default)]
    pub account_id: Option<String>,
    #[serde(default)]
    pub account_title: Option<String>,
    #[serde(default)]
    pub new_password: Option<String>,
    #[serde(default)]
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnmatchedAccount {
    pub account_id: String,
    pub account_title: String,
    pub match_url: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePlan {
    pub file_id: String,
    pub path: String,
    pub label: String,
    pub format: String,
    pub exists: bool,
    pub records: Vec<RecordPlan>,
    pub unmatched: Vec<UnmatchedAccount>,
    pub updates: usize,
    pub status: String,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncOutcome {
    pub file_id: String,
    pub path: String,
    pub changed: bool,
    pub updates: usize,
    pub bytes: usize,
    pub backup_path: Option<String>,
    pub status: String,
}

// ---------------------------------------------------------------------------
// URL matching
// ---------------------------------------------------------------------------

fn normalize_url(value: &str) -> String {
    let trimmed = value.trim().to_ascii_lowercase();
    let without_scheme = match trimmed.find("://") {
        Some(index) => trimmed[index + 3..].to_string(),
        None => trimmed,
    };
    without_scheme.trim_end_matches('/').to_string()
}

fn host_of(value: &str) -> String {
    let normalized = normalize_url(value);
    let host = normalized.split(['/', '?', '#']).next().unwrap_or("");
    let host = host.rsplit('@').next().unwrap_or(host);
    // Files often store `host:8443` while the account records just the host, so
    // the port is ignored when comparing (IPv6 literals keep their brackets).
    if host.starts_with('[') {
        return host.split(']').next().unwrap_or(host).to_string() + "]";
    }
    host.split(':').next().unwrap_or(host).to_string()
}

/// Two URLs refer to the same system when their hosts match; the full URL is
/// accepted too, so a path can disambiguate several blocks on one host.
fn url_matches(account_url: &str, record_url: &str) -> bool {
    let account = normalize_url(account_url);
    let record = normalize_url(record_url);
    if account.is_empty() || record.is_empty() {
        return false;
    }
    if account == record {
        return true;
    }
    let account_host = host_of(&account);
    let record_host = host_of(&record);
    !account_host.is_empty() && account_host == record_host
}

fn same_username(account: &str, record: &str) -> bool {
    !account.is_empty() && !record.is_empty() && account.eq_ignore_ascii_case(record)
}

/// Picks the credential block that belongs to an account.
fn match_record(
    records: &[FileRecord],
    account: &Entry,
    account_username: &str,
    bound_accounts: usize,
) -> Result<usize, String> {
    if records.is_empty() {
        return Err("文件里没有解析到任何凭据块".to_string());
    }

    if !account.match_url.trim().is_empty() {
        let candidates: Vec<usize> = records
            .iter()
            .enumerate()
            .filter(|(_, record)| url_matches(&account.match_url, &record.url()))
            .map(|(index, _)| index)
            .collect();
        match candidates.len() {
            1 => return Ok(candidates[0]),
            0 => {
                return Err(format!(
                    "文件里没有 URL 匹配「{}」的凭据块",
                    account.match_url
                ))
            }
            _ => {
                if let Some(index) = candidates
                    .iter()
                    .copied()
                    .find(|index| same_username(account_username, &records[*index].username()))
                {
                    return Ok(index);
                }
                return Err(format!(
                    "有 {} 个凭据块的 URL 都匹配「{}」，且用户名无法区分",
                    candidates.len(),
                    account.match_url
                ));
            }
        }
    }

    // No match URL: only unambiguous cases are allowed through.
    if records.len() == 1 {
        return Ok(0);
    }
    if bound_accounts == 1 {
        if let Some(index) = records
            .iter()
            .position(|record| same_username(account_username, &record.username()))
        {
            return Ok(index);
        }
        return Ok(0);
    }
    Err("文件包含多个凭据块：请为该账号填写「匹配用 URL」".to_string())
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

fn plan_for(
    analysis: &FileAnalysis,
    entries: &[(Entry, String)],
    rows: &mut Vec<RecordPlan>,
    unmatched: &mut Vec<UnmatchedAccount>,
) -> AppResult<usize> {
    let mut assigned: Vec<Option<usize>> = vec![None; analysis.records.len()];
    let mut updates = 0usize;

    for (index, (entry, username)) in entries.iter().enumerate() {
        match match_record(&analysis.records, entry, username, entries.len()) {
            Ok(record_index) => {
                if let Some(previous) = assigned[record_index] {
                    unmatched.push(UnmatchedAccount {
                        account_id: entry.id.clone(),
                        account_title: entry.title.clone(),
                        match_url: entry.match_url.clone(),
                        reason: format!("该凭据块已分配给「{}」", entries[previous].0.title),
                    });
                    continue;
                }
                assigned[record_index] = Some(index);
                if entry.password.is_empty() {
                    unmatched.push(UnmatchedAccount {
                        account_id: entry.id.clone(),
                        account_title: entry.title.clone(),
                        match_url: entry.match_url.clone(),
                        reason: "该账号没有保存密码".to_string(),
                    });
                }
            }
            Err(reason) => unmatched.push(UnmatchedAccount {
                account_id: entry.id.clone(),
                account_title: entry.title.clone(),
                match_url: entry.match_url.clone(),
                reason,
            }),
        }
    }

    for (index, record) in analysis.records.iter().enumerate() {
        let owner = assigned[index].map(|slot| &entries[slot]);
        let password_hit = record.hit("password");
        let row = match owner {
            None => RecordPlan {
                record_id: record.id.clone(),
                path: record.path.clone(),
                url: record.url(),
                username: record.username(),
                password: record.password(),
                action: "unbound".to_string(),
                account_id: None,
                account_title: None,
                new_password: None,
                detail: "该凭据块没有绑定账号".to_string(),
            },
            Some((entry, username)) => {
                let mut notes: Vec<String> = Vec::new();
                if !record.username().is_empty() && !same_username(username, &record.username()) {
                    notes.push(format!(
                        "用户名不一致（文件 {} / 账号 {}），未修改",
                        record.username(),
                        username
                    ));
                }
                let (action, new_password, detail) = if entry.password.is_empty() {
                    (
                        "no-password".to_string(),
                        None,
                        "账号没有保存密码".to_string(),
                    )
                } else if password_hit.is_none() {
                    (
                        "no-password".to_string(),
                        None,
                        "该凭据块没有识别到密码字段".to_string(),
                    )
                } else if password_hit.and_then(|hit| hit.location.as_ref()).is_none() {
                    (
                        "unreachable".to_string(),
                        None,
                        "无法定位密码在文件中的位置".to_string(),
                    )
                } else if record.password() == entry.password {
                    (
                        "same".to_string(),
                        Some(entry.password.clone()),
                        "文件里的密码已是最新".to_string(),
                    )
                } else {
                    updates += 1;
                    (
                        "update".to_string(),
                        Some(entry.password.clone()),
                        notes.join("；"),
                    )
                };
                RecordPlan {
                    record_id: record.id.clone(),
                    path: record.path.clone(),
                    url: record.url(),
                    username: record.username(),
                    password: record.password(),
                    action,
                    account_id: Some(entry.id.clone()),
                    account_title: Some(entry.title.clone()),
                    new_password,
                    detail,
                }
            }
        };
        rows.push(row);
    }

    Ok(updates)
}

fn bound_entries(vault: &Vault, file: &SyncFile) -> Vec<(Entry, String)> {
    file.entry_ids
        .iter()
        .filter_map(|id| vault.entry(id).ok())
        .map(|entry| (entry.clone(), entry.effective_username(&vault.knox_id)))
        .collect()
}

fn plan_from_analysis(
    vault: &Vault,
    file: &SyncFile,
    analysis: &FileAnalysis,
) -> AppResult<FilePlan> {
    let mut rows: Vec<RecordPlan> = Vec::new();
    let mut unmatched: Vec<UnmatchedAccount> = Vec::new();
    let updates = plan_for(analysis, &bound_entries(vault, file), &mut rows, &mut unmatched)?;

    let status = if file.entry_ids.is_empty() {
        "尚未绑定账号".to_string()
    } else if updates > 0 {
        format!("{updates} 处将更新")
    } else if !unmatched.is_empty() {
        format!("无更新（{} 个账号未匹配）", unmatched.len())
    } else {
        "已是最新".to_string()
    };

    Ok(FilePlan {
        file_id: file.id.clone(),
        path: file.path.clone(),
        label: file.label.clone(),
        format: analysis.format.clone(),
        exists: file.exists,
        records: rows,
        unmatched,
        updates,
        status,
        error: analysis.error.clone(),
    })
}

/// Re-reads the file from disk and reports what syncing would change.
pub fn plan_file(vault: &Vault, file: &SyncFile) -> AppResult<FilePlan> {
    let loaded = keys::load(Path::new(&file.path), &file.keys);
    plan_from_analysis(vault, file, &loaded.analysis)
}

pub fn plan_all(vault: &Vault) -> Vec<FilePlan> {
    vault
        .files
        .iter()
        .map(|file| {
            plan_file(vault, file).unwrap_or_else(|err| FilePlan {
                file_id: file.id.clone(),
                path: file.path.clone(),
                label: file.label.clone(),
                format: String::new(),
                exists: file.exists,
                records: Vec::new(),
                unmatched: Vec::new(),
                updates: 0,
                status: "计划失败".to_string(),
                error: Some(err.to_string()),
            })
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/// Verifies that the edited document still parses to the same structure and that
/// only the intended password values changed.
fn verify(
    before: &FileAnalysis,
    after: &FileAnalysis,
    expected: &[(usize, String)],
) -> AppResult<()> {
    if before.records.len() != after.records.len() {
        return Err(AppError::Msg(
            "写入后的文件结构发生变化，已取消（未写入任何内容）".to_string(),
        ));
    }
    for (index, (record_before, record_after)) in
        before.records.iter().zip(after.records.iter()).enumerate()
    {
        let new_password = expected
            .iter()
            .find(|(target, _)| *target == index)
            .map(|(_, value)| value.clone());
        for kind in ["url", "username", "password"] {
            let value_before = record_before.value(kind);
            let value_after = record_after.value(kind);
            if kind == "password" {
                match &new_password {
                    Some(expected_value) if value_after == *expected_value => {}
                    Some(_) => {
                        return Err(AppError::Msg(
                            "写入后的密码校验失败，已取消（未写入任何内容）".to_string(),
                        ))
                    }
                    None if value_after == value_before => {}
                    None => {
                        return Err(AppError::Msg(
                            "写入后的文件内容发生变化，已取消（未写入任何内容）".to_string(),
                        ))
                    }
                }
            } else if value_after != value_before {
                return Err(AppError::Msg(format!(
                    "写入影响了 {kind} 字段，已取消（未写入任何内容）"
                )));
            }
        }
    }
    Ok(())
}

pub fn sync_file(vault: &Vault, file: &SyncFile, backup: bool) -> AppResult<SyncOutcome> {
    let path = Path::new(&file.path);
    let loaded = keys::load(path, &file.keys);
    if let Some(error) = &loaded.analysis.error {
        return Err(AppError::Msg(error.clone()));
    }
    if !file.exists {
        return Err(AppError::Msg(format!("文件不存在：{}", file.path)));
    }

    let plan = plan_from_analysis(vault, file, &loaded.analysis)?;
    let targets: Vec<(usize, String)> = plan
        .records
        .iter()
        .enumerate()
        .filter(|(_, row)| row.action == "update")
        .filter_map(|(index, row)| row.new_password.clone().map(|value| (index, value)))
        .collect();

    if targets.is_empty() {
        return Ok(SyncOutcome {
            file_id: file.id.clone(),
            path: file.path.clone(),
            changed: false,
            updates: 0,
            bytes: file.size as usize,
            backup_path: None,
            status: plan.status.clone(),
        });
    }

    let mut edits: Vec<Edit> = Vec::new();
    for (index, password) in &targets {
        let record = &loaded.analysis.records[*index];
        let location = record
            .hit("password")
            .and_then(|hit| hit.location.as_ref())
            .ok_or_else(|| AppError::Msg("无法定位密码位置".to_string()))?;
        let text = patch::encode_value(&loaded.analysis.format, location, password)?;
        edits.push(Edit {
            start: location.start,
            end: location.end,
            text,
        });
    }

    let updated_text = patch::apply(&loaded.text, &edits)?;
    let after = keys::analyze_text(&updated_text, &loaded.analysis.format, &file.keys);
    verify(&loaded.analysis, &after, &targets)?;

    let bytes = patch::encode(&updated_text, loaded.encoding);
    let mut backup_path = None;
    if backup {
        let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
        let candidate = path.with_extension(format!(
            "{}bak-{stamp}",
            path.extension()
                .map(|value| format!("{}.", value.to_string_lossy()))
                .unwrap_or_default()
        ));
        if std::fs::copy(path, &candidate).is_ok() {
            backup_path = Some(candidate.to_string_lossy().to_string());
        }
    }
    std::fs::write(path, &bytes)?;

    Ok(SyncOutcome {
        file_id: file.id.clone(),
        path: file.path.clone(),
        changed: true,
        updates: targets.len(),
        bytes: bytes.len(),
        backup_path,
        status: format!("已更新 {} 处密码", targets.len()),
    })
}

/// Records the outcome on the file so the UI can show when it last ran.
pub fn stamp(file: &mut SyncFile, outcome: &SyncOutcome) {
    file.last_sync_at = Some(now_string());
    file.last_status = Some(if outcome.changed {
        outcome.status.clone()
    } else {
        format!("无变化（{}）", outcome.status)
    });
    file.refresh_stat();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Category, KeyMapping, PasswordRule};

    fn account(id: &str, title: &str, username: &str, match_url: &str, password: &str) -> Entry {
        Entry {
            id: id.to_string(),
            title: title.to_string(),
            category_id: crate::model::SAP_CATEGORY_ID.to_string(),
            username: username.to_string(),
            use_knox_id: false,
            password: password.to_string(),
            match_url: match_url.to_string(),
            notes: String::new(),
            favorite: false,
            rule: Some(PasswordRule::default()),
            history_cycle: 0,
            password_history: Vec::new(),
            created_at: String::new(),
            updated_at: String::new(),
            last_used_at: None,
        }
    }

    fn temp_dir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("sapvault-sync-{}", crate::model::new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn vault_with(entries: Vec<Entry>, file: SyncFile) -> (Vault, SyncFile) {
        let mut vault = Vault {
            categories: vec![Category::sap(), Category::general()],
            entries,
            ..Vault::default()
        };
        vault.files.push(file);
        let file = vault.files[0].clone();
        (vault, file)
    }

    fn sample_file(path: &str, text: &str, format: &str, entry_ids: Vec<String>) -> SyncFile {
        let keys = KeyMapping::default();
        let analysis = keys::analyze_text(text, format, &keys);
        let mut file = SyncFile::from_path(path, keys, Some(analysis));
        file.entry_ids = entry_ids;
        file
    }

    #[test]
    fn single_record_file_syncs_without_a_match_url() {
        let dir = temp_dir();
        let path = dir.join("single.json");
        let original = "{\n  \"url\": \"https://prd.corp.example\",\n  \"username\": \"JDOE\",\n  \"password\": \"old-pw\"\n}\n";
        std::fs::write(&path, original).unwrap();

        let entry = account("e1", "PRD", "JDOE", "", "new-pw");
        let file = sample_file(&path.to_string_lossy(), original, "json", vec!["e1".into()]);
        let (vault, file) = vault_with(vec![entry], file);

        let plan = plan_file(&vault, &file).unwrap();
        assert_eq!(plan.updates, 1, "{:?}", plan.records);
        assert_eq!(plan.records[0].action, "update");

        let outcome = sync_file(&vault, &file, false).unwrap();
        assert!(outcome.changed);
        assert_eq!(outcome.updates, 1);
        let updated = std::fs::read_to_string(&path).unwrap();
        assert!(updated.contains("\"password\": \"new-pw\""));
        assert!(updated.contains("\"username\": \"JDOE\""));
        assert!(updated.starts_with("{\n  \"url\": \"https://prd.corp.example\","));
    }

    #[test]
    fn multiple_records_use_the_match_url() {
        let dir = temp_dir();
        let path = dir.join("multi.json");
        let original = r#"{
  "systems": {
    "prd": { "url": "https://prd.corp.example", "username": "PRDUSER", "password": "prd-old" },
    "dev": { "url": "https://dev.corp.example", "username": "DEVUSER", "password": "dev-old" }
  }
}
"#;
        std::fs::write(&path, original).unwrap();

        let prd = account("e1", "PRD", "PRDUSER", "prd.corp.example", "prd-new");
        let dev = account("e2", "DEV", "DEVUSER", "https://dev.corp.example/", "dev-new");
        let file = sample_file(
            &path.to_string_lossy(),
            original,
            "json",
            vec!["e1".into(), "e2".into()],
        );
        let (vault, file) = vault_with(vec![prd, dev], file);

        let plan = plan_file(&vault, &file).unwrap();
        assert_eq!(plan.updates, 2, "{:?}", plan.records);
        assert_eq!(plan.unmatched.len(), 0, "{:?}", plan.unmatched);
        assert!(
            plan.records.iter().all(|row| row.action == "update"),
            "{:?}",
            plan.records
        );

        sync_file(&vault, &file, true).unwrap();
        let updated = std::fs::read_to_string(&path).unwrap();
        assert!(updated.contains("\"password\": \"prd-new\""));
        assert!(updated.contains("\"password\": \"dev-new\""));
        assert!(updated.contains("\"username\": \"PRDUSER\""));
        assert!(updated.contains("\"username\": \"DEVUSER\""));
        assert_eq!(updated.matches('\n').count(), original.matches('\n').count());
    }

    #[test]
    fn a_port_in_the_url_does_not_prevent_matching() {
        let text = "{\"url\":\"https://prd.corp.example:8443\",\"username\":\"u\",\"password\":\"old\"}";
        let entry = account("e1", "PRD", "u", "prd.corp.example", "new");
        let file = sample_file("C:/demo/port.json", text, "json", vec!["e1".into()]);
        let (vault, file) = vault_with(vec![entry], file);
        let plan = plan_from_analysis(&vault, &file, &file.analysis.clone().unwrap()).unwrap();
        assert_eq!(plan.updates, 1, "{:?}", plan.records);
    }

    #[test]
    fn env_files_group_by_key_prefix() {
        let text = "SAP_PRD_URL=https://prd.corp.example\nSAP_PRD_USER=JDOE\nSAP_PRD_PASSWORD=old\n\nSAP_DEV_URL=https://dev.corp.example\nSAP_DEV_USER=JDOE\nSAP_DEV_PASSWORD=old\n";
        let keys = KeyMapping::default();
        let analysis = keys::analyze_text(text, "env", &keys);
        assert_eq!(analysis.records.len(), 2, "{:?}", analysis.records);
        assert_eq!(analysis.records[0].path, "SAP_PRD");
        assert_eq!(analysis.records[1].path, "SAP_DEV");
        assert!(analysis.missing.is_empty());
    }

    #[test]
    fn ambiguous_files_ask_for_a_match_url() {
        let dir = temp_dir();
        let path = dir.join("ambiguous.json");
        let text = "{\"a\":{\"url\":\"https://a.example\",\"password\":\"1\"},\"b\":{\"url\":\"https://b.example\",\"password\":\"2\"}}";
        std::fs::write(&path, text).unwrap();
        let entry = account("e1", "A", "user", "", "new");
        let other = account("e2", "B", "user", "", "new");
        let file = sample_file(
            &path.to_string_lossy(),
            text,
            "json",
            vec!["e1".into(), "e2".into()],
        );
        let (vault, file) = vault_with(vec![entry, other], file);
        let plan = plan_file(&vault, &file).unwrap();
        assert_eq!(plan.updates, 0);
        assert!(
            plan.unmatched.iter().any(|item| item.reason.contains("匹配用 URL")),
            "{:?}",
            plan.unmatched
        );
    }

    #[test]
    fn unbound_records_are_reported_not_changed() {
        let dir = temp_dir();
        let path = dir.join("unbound.json");
        let text = "{\"url\":\"https://a.example\",\"password\":\"1\"}";
        std::fs::write(&path, text).unwrap();
        let file = sample_file(&path.to_string_lossy(), text, "json", Vec::new());
        let (vault, file) = vault_with(Vec::new(), file);
        let plan = plan_file(&vault, &file).unwrap();
        assert_eq!(plan.updates, 0);
        assert_eq!(plan.records[0].action, "unbound");
    }

    #[test]
    fn sync_keeps_the_original_encoding_and_comments() {
        let dir = temp_dir();
        let path = dir.join("app.conf");
        let original = "# 生产环境配置\nurl = \"https://prd.corp.example\"\nuser = \"JDOE\"\npassword = \"old\" # 每季度轮换\n";
        std::fs::write(&path, original).unwrap();

        let entry = account("e1", "PRD", "JDOE", "", "new-pw!");
        let file = sample_file(&path.to_string_lossy(), original, "toml", vec!["e1".into()]);
        let (vault, file) = vault_with(vec![entry], file);
        sync_file(&vault, &file, false).unwrap();

        let updated = std::fs::read_to_string(&path).unwrap();
        assert_eq!(
            updated,
            "# 生产环境配置\nurl = \"https://prd.corp.example\"\nuser = \"JDOE\"\npassword = \"new-pw!\" # 每季度轮换\n"
        );
    }

    #[test]
    fn xml_sync_only_touches_the_password_text() {
        let dir = temp_dir();
        let path = dir.join("logon.xml");
        let original = "<config>\n  <system id=\"PRD\">\n    <url>https://prd.corp.example</url>\n    <username>JDOE</username>\n    <password>old&amp;1</password>\n  </system>\n</config>\n";
        std::fs::write(&path, original).unwrap();

        let entry = account("e1", "PRD", "JDOE", "", "a&b<c");
        let file = sample_file(&path.to_string_lossy(), original, "xml", vec!["e1".into()]);
        let (vault, file) = vault_with(vec![entry], file);
        let plan = plan_file(&vault, &file).unwrap();
        assert_eq!(plan.updates, 1, "{:?}", plan.records);

        sync_file(&vault, &file, false).unwrap();
        let updated = std::fs::read_to_string(&path).unwrap();
        assert!(updated.contains("<password>a&amp;b&lt;c</password>"), "{updated}");
        assert!(updated.contains("<url>https://prd.corp.example</url>"));
        assert!(updated.contains("<system id=\"PRD\">"));
    }

    #[test]
    fn blank_line_separated_text_blocks_are_separate_records() {
        let text = "系统一\nurl: https://a.example\nuser: JDOE\npassword: one\n\n系统二\nurl: https://b.example\nuser: JDOE\npassword: two\n";
        let keys = KeyMapping::default();
        let analysis = keys::analyze_text(text, "text", &keys);
        assert_eq!(analysis.records.len(), 2, "{:?}", analysis.records);
        assert_eq!(analysis.records[0].password(), "one");
        assert_eq!(analysis.records[1].password(), "two");
    }

    #[test]
    fn passwords_needing_quotes_are_quoted() {
        let dir = temp_dir();
        let path = dir.join("plain.env");
        let original = "url=https://prd.corp.example\nuser=JDOE\npassword=old\n";
        std::fs::write(&path, original).unwrap();

        let entry = account("e1", "PRD", "JDOE", "", "has space#and=signs");
        let file = sample_file(&path.to_string_lossy(), original, "env", vec!["e1".into()]);
        let (vault, file) = vault_with(vec![entry], file);
        sync_file(&vault, &file, false).unwrap();

        let updated = std::fs::read_to_string(&path).unwrap();
        assert!(
            updated.contains("password=\"has space#and=signs\""),
            "{updated}"
        );
    }

    #[test]
    fn backup_contains_the_original_file() {
        let dir = temp_dir();
        let path = dir.join("b.json");
        let original = "{\"url\":\"https://a.example\",\"username\":\"u\",\"password\":\"old\"}";
        std::fs::write(&path, original).unwrap();

        let entry = account("e1", "A", "u", "", "new");
        let file = sample_file(&path.to_string_lossy(), original, "json", vec!["e1".into()]);
        let (vault, file) = vault_with(vec![entry], file);
        let outcome = sync_file(&vault, &file, true).unwrap();
        let backup = outcome.backup_path.expect("backup path");
        assert_eq!(std::fs::read_to_string(&backup).unwrap(), original);
    }

    #[test]
    fn a_second_sync_is_a_no_op() {
        let dir = temp_dir();
        let path = dir.join("c.json");
        let original = "{\"url\":\"https://a.example\",\"username\":\"u\",\"password\":\"old\"}";
        std::fs::write(&path, original).unwrap();
        let entry = account("e1", "A", "u", "", "new");
        let file = sample_file(&path.to_string_lossy(), original, "json", vec!["e1".into()]);
        let (vault, file) = vault_with(vec![entry], file);
        sync_file(&vault, &file, false).unwrap();

        let after_first = std::fs::read_to_string(&path).unwrap();
        let outcome = sync_file(&vault, &file, false).unwrap();
        assert!(!outcome.changed);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), after_first);
    }
}
