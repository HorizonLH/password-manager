//! Syncing = writing each account's password into the key it is bound to.
//!
//! The binding `(file, key path) → account` is decided by the user in the UI, so
//! nothing has to be guessed here. Only that key's value is replaced; every other
//! byte of the file is kept, and the result is re-parsed before it is written.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::keys;
use crate::model::{now_string, FileAnalysis, SyncFile, Vault};
use crate::patch::{self, Edit};

/// What syncing will do for one binding.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanRow {
    pub binding_id: String,
    pub key_path: String,
    pub key_label: String,
    /// Current value in the file.
    pub file_value: String,
    /// `update` | `same` | `missing-key` | `no-password`
    pub action: String,
    pub account_id: String,
    pub account_title: String,
    #[serde(default)]
    pub new_password: Option<String>,
    #[serde(default)]
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePlan {
    pub file_id: String,
    pub path: String,
    pub label: String,
    pub format: String,
    pub exists: bool,
    pub rows: Vec<PlanRow>,
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
    pub status: String,
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

fn plan_from_analysis(vault: &Vault, file: &SyncFile, analysis: &FileAnalysis) -> FilePlan {
    let mut rows: Vec<PlanRow> = Vec::new();
    let mut updates = 0usize;

    for binding in &file.bindings {
        let Some(value) = analysis.value(&binding.key_path) else {
            rows.push(PlanRow {
                binding_id: binding.id.clone(),
                key_path: binding.key_path.clone(),
                key_label: key_label(&binding.key_path),
                file_value: String::new(),
                action: "missing-key".to_string(),
                account_id: binding.entry_id.clone(),
                account_title: account_title(vault, &binding.entry_id),
                new_password: None,
                detail: "文件里已经没有这个键了".to_string(),
            });
            continue;
        };
        let Ok(account) = vault.entry(&binding.entry_id) else {
            continue;
        };
        let (action, new_password, detail) = if account.password.is_empty() {
            (
                "no-password".to_string(),
                None,
                "账号没有保存密码".to_string(),
            )
        } else if value.value == account.password {
            (
                "same".to_string(),
                Some(account.password.clone()),
                "文件里的密码已是最新".to_string(),
            )
        } else {
            updates += 1;
            (
                "update".to_string(),
                Some(account.password.clone()),
                String::new(),
            )
        };
        rows.push(PlanRow {
            binding_id: binding.id.clone(),
            key_path: binding.key_path.clone(),
            key_label: key_label(&binding.key_path),
            file_value: value.value.clone(),
            action,
            account_id: account.id.clone(),
            account_title: account.title.clone(),
            new_password,
            detail,
        });
    }

    let status = if file.bindings.is_empty() {
        "尚未选择密码键".to_string()
    } else if updates > 0 {
        format!("{updates} 处将更新")
    } else if rows.iter().any(|row| row.action == "missing-key") {
        "有绑定失效".to_string()
    } else if rows.iter().any(|row| row.action == "no-password") {
        "账号缺少密码".to_string()
    } else {
        "已是最新".to_string()
    };

    FilePlan {
        file_id: file.id.clone(),
        path: file.path.clone(),
        label: file.label.clone(),
        format: analysis.format.clone(),
        exists: file.exists,
        rows,
        updates,
        status,
        error: analysis.error.clone(),
    }
}

fn account_title(vault: &Vault, id: &str) -> String {
    vault
        .entry(id)
        .map(|entry| entry.title.clone())
        .unwrap_or_else(|_| "（已删除的账号）".to_string())
}

fn key_label(path: &str) -> String {
    match path.rfind(['.', '@']) {
        Some(index) => path[index + 1..].to_string(),
        None => path.to_string(),
    }
}

/// Re-reads the file from disk and reports what syncing would change.
pub fn plan_file(vault: &Vault, file: &SyncFile) -> FilePlan {
    let loaded = keys::load(Path::new(&file.path), &file.keys);
    plan_from_analysis(vault, file, &loaded.analysis)
}

pub fn plan_all(vault: &Vault) -> Vec<FilePlan> {
    vault.files.iter().map(|file| plan_file(vault, file)).collect()
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/// The file must still parse to the same keys, and only the bound ones may have
/// changed — otherwise nothing is written.
fn verify(
    before: &FileAnalysis,
    after: &FileAnalysis,
    expected: &[(String, String)],
) -> AppResult<()> {
    if before.values.len() != after.values.len() {
        return Err(AppError::Msg(
            "写入后的文件结构发生变化，已取消（未写入任何内容）".to_string(),
        ));
    }
    for (old, new) in before.values.iter().zip(after.values.iter()) {
        if old.path != new.path {
            return Err(AppError::Msg(
                "写入后的键顺序发生变化，已取消（未写入任何内容）".to_string(),
            ));
        }
        match expected.iter().find(|(path, _)| *path == old.path) {
            Some((_, value)) if new.value == *value => {}
            Some(_) => {
                return Err(AppError::Msg(
                    "写入后的密码校验失败，已取消（未写入任何内容）".to_string(),
                ))
            }
            None if new.value == old.value => {}
            None => {
                return Err(AppError::Msg(format!(
                    "写入影响了未绑定的键 {}，已取消（未写入任何内容）",
                    old.path
                )))
            }
        }
    }
    Ok(())
}

pub fn sync_file(vault: &Vault, file: &SyncFile) -> AppResult<SyncOutcome> {
    let path = Path::new(&file.path);
    let loaded = keys::load(path, &file.keys);
    if let Some(error) = &loaded.analysis.error {
        return Err(AppError::Msg(error.clone()));
    }
    if !file.exists {
        return Err(AppError::Msg(format!("文件不存在：{}", file.path)));
    }

    let plan = plan_from_analysis(vault, file, &loaded.analysis);
    let mut edits: Vec<Edit> = Vec::new();
    let mut expected: Vec<(String, String)> = Vec::new();
    for row in &plan.rows {
        if row.action != "update" {
            continue;
        }
        let Some(password) = row.new_password.clone() else {
            continue;
        };
        let Some(value) = loaded.analysis.value(&row.key_path) else {
            continue;
        };
        let text = patch::encode_value(&loaded.analysis.format, &value.location, &password)?;
        edits.push(Edit {
            start: value.location.start,
            end: value.location.end,
            text,
        });
        expected.push((row.key_path.clone(), password));
    }

    if edits.is_empty() {
        return Ok(SyncOutcome {
            file_id: file.id.clone(),
            path: file.path.clone(),
            changed: false,
            updates: 0,
            bytes: file.size as usize,
            status: plan.status,
        });
    }

    let updated_text = patch::apply(&loaded.text, &edits)?;
    let after = keys::analyze_text(&updated_text, &loaded.analysis.format, &file.keys);
    verify(&loaded.analysis, &after, &expected)?;

    let bytes = patch::encode(&updated_text, loaded.encoding);
    replace_contents(path, &bytes)?;

    Ok(SyncOutcome {
        file_id: file.id.clone(),
        path: file.path.clone(),
        changed: true,
        updates: expected.len(),
        bytes: bytes.len(),
        status: format!("已更新 {} 处密码", expected.len()),
    })
}

/// Replaces a file in one step: the new bytes are written to a sibling
/// temporary file, which is then renamed over the target. A crash, a full disk
/// or a power cut can therefore never leave a half-written configuration behind,
/// which is what makes a second copy of the old passwords (`<file>.bak-*`)
/// unnecessary.
fn replace_contents(path: &Path, bytes: &[u8]) -> AppResult<()> {
    let directory = path.parent().unwrap_or_else(|| Path::new("."));
    let name = path
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| "sapvault".to_string());
    let temp = directory.join(format!(".{name}.{}.tmp", std::process::id()));
    std::fs::write(&temp, bytes)?;
    if let Err(error) = std::fs::rename(&temp, path) {
        let _ = std::fs::remove_file(&temp);
        return Err(AppError::from(error));
    }
    Ok(())
}

/// Records the outcome on the file so the UI can show when it last ran.
pub fn stamp(file: &mut SyncFile, outcome: &SyncOutcome) {
    file.last_sync_at = Some(now_string());
    file.last_status = Some(if outcome.changed {
        outcome.status.clone()
    } else {
        format!("无变化（{}）", outcome.status)
    });
    reanalyze(file);
}

/// Re-reads the file from disk and replaces the cached parse, so the UI shows the
/// values that are actually in the file after a sync instead of the old ones.
pub fn reanalyze(file: &mut SyncFile) {
    file.analysis = Some(keys::analyze_file(Path::new(&file.path), &file.keys));
    file.refresh_stat();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Category, Entry, FileBinding, KeyMapping, PasswordRule};

    fn temp_dir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("sapvault-sync-{}", crate::model::new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn account(id: &str, title: &str, username: &str, password: &str) -> Entry {
        Entry {
            id: id.to_string(),
            title: title.to_string(),
            category_id: crate::model::SAP_CATEGORY_ID.to_string(),
            username: username.to_string(),
            use_knox_id: false,
            password: password.to_string(),
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

    fn setup(path: &std::path::Path, text: &str, format: &str, bindings: &[(&str, &str)]) -> (Vault, SyncFile) {
        std::fs::write(path, text).unwrap();
        let keys = KeyMapping::default();
        let analysis = keys::analyze_text(text, format, &keys);
        let mut file = SyncFile::from_path(&path.to_string_lossy(), keys, Some(analysis));
        file.bindings = bindings
            .iter()
            .map(|(key, entry)| FileBinding::new(key, entry))
            .collect();
        let mut vault = Vault {
            categories: vec![Category::sap(), Category::general()],
            ..Vault::default()
        };
        vault.files.push(file.clone());
        (vault, file)
    }

    #[test]
    fn one_file_two_keys_two_accounts() {
        let dir = temp_dir();
        let path = dir.join("two.json");
        let original = "{\n  \"prd\": { \"password\": \"old-prd\" },\n  \"dev\": { \"password\": \"old-dev\" }\n}\n";
        let (vault, file) = setup(
            &path,
            original,
            "json",
            &[("prd.password", "e1"), ("dev.password", "e2")],
        );
        let mut vault = vault;
        vault.entries.push(account("e1", "PRD", "u", "new-prd"));
        vault.entries.push(account("e2", "DEV", "u", "new-dev"));

        let plan = plan_file(&vault, &file);
        assert_eq!(plan.updates, 2, "{:?}", plan.rows);

        sync_file(&vault, &file).unwrap();
        let updated = std::fs::read_to_string(&path).unwrap();
        assert!(updated.contains("\"password\": \"new-prd\""), "{updated}");
        assert!(updated.contains("\"password\": \"new-dev\""), "{updated}");
        // Structure, spacing and order are untouched.
        assert_eq!(updated.matches('\n').count(), original.matches('\n').count());
        assert!(updated.starts_with("{\n  \"prd\": { \"password\":"));
    }

    #[test]
    fn a_deleted_key_is_reported_not_written() {
        let dir = temp_dir();
        let path = dir.join("gone.json");
        let (vault, file) = setup(&path, "{\"a\":{\"password\":\"x\"}}", "json", &[("b.password", "e1")]);
        let mut vault = vault;
        vault.entries.push(account("e1", "A", "u", "new"));
        let plan = plan_file(&vault, &file);
        assert_eq!(plan.updates, 0);
        assert_eq!(plan.rows[0].action, "missing-key");
        let outcome = sync_file(&vault, &file).unwrap();
        assert!(!outcome.changed);
    }

    #[test]
    fn only_the_bound_key_changes() {
        let dir = temp_dir();
        let path = dir.join("mixed.env");
        let original = "SAP_PRD_URL=https://prd.example\nSAP_PRD_PASSWORD=old\nSAP_DEV_PASSWORD=keep-me\n";
        let (vault, file) = setup(&path, original, "env", &[("SAP_PRD_PASSWORD", "e1")]);
        let mut vault = vault;
        vault.entries.push(account("e1", "PRD", "u", "new-pw"));

        sync_file(&vault, &file).unwrap();
        let updated = std::fs::read_to_string(&path).unwrap();
        assert_eq!(
            updated,
            "SAP_PRD_URL=https://prd.example\nSAP_PRD_PASSWORD=new-pw\nSAP_DEV_PASSWORD=keep-me\n"
        );
    }

    #[test]
    fn xml_element_and_attribute_values_can_be_bound() {
        let dir = temp_dir();
        let path = dir.join("logon.xml");
        let original = "<config>\n  <system id=\"PRD\" password=\"old-attr\">\n    <password>old-text</password>\n  </system>\n</config>\n";
        let (vault, file) = setup(
            &path,
            original,
            "xml",
            &[("config.system@password", "e1"), ("config.system.password", "e2")],
        );
        let mut vault = vault;
        vault.entries.push(account("e1", "PRD", "u", "a&b<c"));
        vault.entries.push(account("e2", "PRD2", "u", "text-new"));

        let plan = plan_file(&vault, &file);
        assert_eq!(plan.updates, 2, "{:?}", plan.rows);
        sync_file(&vault, &file).unwrap();
        let updated = std::fs::read_to_string(&path).unwrap();
        assert!(updated.contains("password=\"a&amp;b&lt;c\""), "{updated}");
        assert!(updated.contains("<password>text-new</password>"), "{updated}");
        assert!(updated.contains("<system id=\"PRD\""));
    }

    #[test]
    fn toml_comments_and_quoting_survive() {
        let dir = temp_dir();
        let path = dir.join("app.conf");
        let original = "# 生产环境\n[prd]\nurl = \"https://prd.example\"\npassword = \"old\" # 每季度轮换\n";
        let (vault, file) = setup(&path, original, "toml", &[("prd.password", "e1")]);
        let mut vault = vault;
        vault.entries.push(account("e1", "PRD", "u", "has space#and=signs"));

        sync_file(&vault, &file).unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "# 生产环境\n[prd]\nurl = \"https://prd.example\"\npassword = \"has space#and=signs\" # 每季度轮换\n"
        );
    }

    #[test]
    fn yaml_nested_keys_are_addressable() {
        let dir = temp_dir();
        let path = dir.join("app.yml");
        let original = "sap:\n  prd:\n    password: old\n  dev:\n    password: old2\n";
        let (vault, file) = setup(
            &path,
            original,
            "yaml",
            &[("sap.prd.password", "e1"), ("sap.dev.password", "e2")],
        );
        let mut vault = vault;
        vault.entries.push(account("e1", "PRD", "u", "p1"));
        vault.entries.push(account("e2", "DEV", "u", "p2"));
        sync_file(&vault, &file).unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "sap:\n  prd:\n    password: p1\n  dev:\n    password: p2\n"
        );
    }

    #[test]
    fn sync_writes_in_place_and_leaves_no_extra_files_behind() {
        let dir = temp_dir();
        let path = dir.join("b.json");
        let original = "{\"a\":{\"password\":\"old\"}}";
        let (vault, file) = setup(&path, original, "json", &[("a.password", "e1")]);
        let mut vault = vault;
        vault.entries.push(account("e1", "A", "u", "new"));

        let outcome = sync_file(&vault, &file).unwrap();
        assert!(outcome.changed);
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "{\"a\":{\"password\":\"new\"}}"
        );

        // The folder must hold the file and nothing else: no `.bak-*` copy and
        // no leftover temporary file.
        let mut names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        names.sort();
        assert_eq!(names, vec!["b.json".to_string()], "unexpected files: {names:?}");

        let after_first = std::fs::read_to_string(&path).unwrap();
        let second = sync_file(&vault, &file).unwrap();
        assert!(!second.changed);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), after_first);
    }

    #[test]
    fn password_candidates_come_from_the_key_names() {
        let text = "{\"sap\":{\"password\":\"x\",\"user\":\"u\",\"token\":\"t\",\"url\":\"https://a\"}}";
        let analysis = keys::analyze_text(text, "json", &KeyMapping::default());
        let candidates: Vec<String> = analysis
            .values
            .iter()
            .filter(|value| value.password_candidate)
            .map(|value| value.path.clone())
            .collect();
        assert!(candidates.contains(&"sap.password".to_string()), "{candidates:?}");
        assert!(candidates.contains(&"sap.token".to_string()), "{candidates:?}");
        assert!(!candidates.contains(&"sap.user".to_string()), "{candidates:?}");
        assert_eq!(analysis.values.len(), 4);
    }

    /// A comment that looks like a password must never be parsed as a value
    /// (otherwise syncing would overwrite the comment), and a trailing comment
    /// must stay byte-identical after a sync.
    #[test]
    fn comments_are_never_parsed_or_overwritten() {
        let cases: [(&str, &str, &str, &str); 7] = [
            (
                "toml",
                "[sap]\n# password = \"COMMENTED\"\npassword = \"old\" # keep me\n",
                "sap.password",
                "\"old\"",
            ),
            (
                "ini",
                "[sap]\n; password = COMMENTED\npassword = old ; keep me\n",
                "sap.password",
                "old ;",
            ),
            (
                "properties",
                "# password=COMMENTED\npassword=old # keep me\n",
                "password",
                "old #",
            ),
            (
                "hcl",
                "// password = \"COMMENTED\"\npassword = \"old\" // keep me\n",
                "password",
                "\"old\"",
            ),
            (
                "env",
                "# PASSWORD=COMMENTED\nPASSWORD=old # keep me\n",
                "PASSWORD",
                "old #",
            ),
            (
                "yaml",
                "sap:\n  # password: COMMENTED\n  password: old # keep me\n",
                "sap.password",
                "old #",
            ),
            (
                "json",
                "{\n  // \"password\": \"COMMENTED\",\n  /* \"password\": \"COMMENTED\" */\n  \"password\": \"old\", // keep me\n  \"user\": \"JDOE\"\n}\n",
                "password",
                "\"old\"",
            ),
        ];

        for (format, original, key, old_pair) in cases {
            let dir = temp_dir();
            let path = dir.join(format!("comments-{format}.{format}"));
            let (vault, file) = setup(&path, original, format, &[(key, "e1")]);
            let mut vault = vault;
            vault.entries.push(account("e1", "PRD", "u", "new#value!1"));

            let analysis = keys::analyze_text(original, format, &KeyMapping::default());
            assert!(
                !analysis
                    .values
                    .iter()
                    .any(|value| value.value.contains("COMMENTED")),
                "{format}: 注释被当成了值 {:?}",
                analysis.values
            );
            assert_eq!(
                analysis.value(key).map(|value| value.value.as_str()),
                Some("old"),
                "{format}: 真实值没解析出来"
            );
            assert_eq!(
                analysis.value(key).map(|value| value.value.as_str()),
                Some("old"),
                "{format}: 值里混进了注释"
            );

            let outcome = sync_file(&vault, &file).unwrap();
            assert!(outcome.changed, "{format}: 应当写入");
            let updated = std::fs::read_to_string(&path).unwrap();
            assert!(updated.contains("COMMENTED"), "{format}: 注释被删掉了\n{updated}");
            assert!(updated.contains("keep me"), "{format}: 行尾注释被删掉了\n{updated}");
            assert!(!updated.contains(old_pair), "{format}: 旧值没被替换\n{updated}");
            assert!(
                updated.contains("new") && updated.contains("value!1"),
                "{format}: 新密码没写进去\n{updated}"
            );
        }
    }

    /// Values that merely contain a comment marker must survive untouched: only a
    /// marker that actually starts a comment cuts the value.
    #[test]
    fn values_may_contain_comment_markers() {
        let dir = temp_dir();
        let path = dir.join("markers.env");
        let original = "PASSWORD=ab#cd\nexport TOKEN=http://host;db=x\n";
        let (vault, file) = setup(&path, original, "env", &[("PASSWORD", "e1"), ("TOKEN", "e2")]);
        let mut vault = vault;
        vault.entries.push(account("e1", "PRD", "u", "ab#cd"));
        vault.entries.push(account("e2", "TOK", "u", "http://host;db=x"));

        let analysis = keys::analyze_text(original, "env", &KeyMapping::default());
        assert_eq!(
            analysis.value("PASSWORD").map(|value| value.value.as_str()),
            Some("ab#cd")
        );
        assert_eq!(
            analysis.value("TOKEN").map(|value| value.value.as_str()),
            Some("http://host;db=x")
        );

        // Both values already equal the stored passwords: nothing may be written.
        let plan = plan_file(&vault, &file);
        assert_eq!(plan.updates, 0, "{:?}", plan.rows);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original);

        // A real password containing `#` round-trips without touching the file
        // structure: only the value's own range is replaced.
        vault.entries[0].password = "xy#zw".to_string();
        sync_file(&vault, &file).unwrap();
        let updated = std::fs::read_to_string(&path).unwrap();
        assert!(updated.contains("export TOKEN=http://host;db=x"), "{updated}");
        assert_eq!(updated.lines().count(), original.lines().count(), "{updated}");
    }
    /// The cached parse must describe the file as it is on disk right after a
    /// sync, otherwise the view keeps showing the password that was replaced.
    #[test]
    fn syncing_refreshes_the_cached_analysis() {
        let dir = temp_dir();
        let path = dir.join("refresh.json");
        let (vault, mut file) = setup(
            &path,
            "{\n  \"a\": { \"password\": \"old\" }\n}\n",
            "json",
            &[("a.password", "e1")],
        );
        let mut vault = vault;
        vault.entries.push(account("e1", "PRD", "u", "new"));

        let outcome = sync_file(&vault, &file).unwrap();
        assert!(outcome.changed);
        stamp(&mut file, &outcome);

        let cached = file.analysis.as_ref().expect("analysis");
        assert_eq!(
            cached.value("a.password").map(|value| value.value.as_str()),
            Some("new"),
            "同步后缓存里还是旧密码"
        );
        assert!(file.analysis.as_ref().unwrap().analyzed_at >= cached.analyzed_at);

        // And the plan agrees that there is nothing left to do.
        let plan = plan_file(&vault, &file);
        assert_eq!(plan.updates, 0, "{:?}", plan.rows);
        assert_eq!(plan.status, "已是最新");
    }
    #[test]
    fn unsupported_formats_are_rejected() {
        let analysis = keys::analyze_text("hello", "unsupported", &KeyMapping::default());
        assert!(analysis.error.is_some());
        assert!(analysis.values.is_empty());
        assert!(keys::detect_format(std::path::Path::new("C:/x/notes.txt")) == "unsupported");
        assert!(keys::is_supported(std::path::Path::new("C:/x/app.properties")));
        assert!(keys::is_supported(std::path::Path::new("C:/x/app.xml")));
    }

    /// Common configuration files share the `key = value` shape but keep their
    /// own label, so the UI can say INI / properties / tfvars instead of TOML.
    #[test]
    fn config_dialects_keep_their_own_label() {
        let detect = |name: &str| keys::detect_format(std::path::Path::new(name)).to_string();
        assert_eq!(detect("C:/x/app.ini"), "ini");
        assert_eq!(detect("C:/x/app.conf"), "ini");
        assert_eq!(detect("C:/x/app.properties"), "properties");
        assert_eq!(detect("C:/x/main.tfvars"), "hcl");
        assert_eq!(detect("C:/x/app.toml"), "toml");
        assert_eq!(detect("C:/x/.env"), "env");
        for name in ["C:/x/app.ini", "C:/x/app.properties", "C:/x/main.tfvars"] {
            assert!(keys::is_supported(std::path::Path::new(name)), "{name}");
        }

        let text = "[sap]\r\npassword = \"Geheim1!\"\r\n# comment\r\n";
        for format in ["ini", "properties", "hcl"] {
            let analysis = keys::analyze_text(text, format, &KeyMapping::default());
            assert!(analysis.error.is_none(), "{format}: {:?}", analysis.error);
            let value = analysis.value("sap.password").expect("sap.password");
            assert_eq!(value.value, "Geheim1!");
            assert!(value.password_candidate);
        }
    }
}