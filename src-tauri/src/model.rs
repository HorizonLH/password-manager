use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

/// Category id reserved for SAP accounts. It can never be renamed or removed.
pub const SAP_CATEGORY_ID: &str = "sap";
pub const DEFAULT_CATEGORY_ID: &str = "general";

/// Bumped when the on-disk shape changes so `store::normalize_vault` can migrate.
pub const VAULT_SCHEMA: u32 = 3;

/// Upper bound on stored passwords per account.
pub const MAX_PASSWORD_HISTORY: usize = 50;

pub fn now_string() -> String {
    chrono::Local::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

pub fn new_id() -> String {
    use aes_gcm::aead::rand_core::{OsRng, RngCore};
    let mut bytes = [0u8; 16];
    OsRng.fill_bytes(&mut bytes);
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Category {
    pub id: String,
    pub name: String,
    pub builtin: bool,
    pub sort: i32,
}

impl Category {
    pub fn sap() -> Self {
        Self {
            id: SAP_CATEGORY_ID.to_string(),
            name: "SAP 账号".to_string(),
            builtin: true,
            sort: 0,
        }
    }

    pub fn general() -> Self {
        Self {
            id: DEFAULT_CATEGORY_ID.to_string(),
            name: "通用账号".to_string(),
            builtin: true,
            sort: 1,
        }
    }
}

// ---------------------------------------------------------------------------
// Password rules
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PasswordRule {
    pub enabled: bool,
    pub description: String,
    pub min_length: usize,
    pub max_length: usize,
    pub upper: bool,
    pub lower: bool,
    pub digits: bool,
    pub symbols: bool,
    pub symbols_set: String,
    pub forbidden: String,
    pub start_with_letter: bool,
    pub avoid_ambiguous: bool,
}

impl Default for PasswordRule {
    fn default() -> Self {
        Self {
            enabled: true,
            description: String::new(),
            min_length: 8,
            max_length: 40,
            upper: true,
            lower: true,
            digits: true,
            symbols: false,
            symbols_set: "!@#$%^&*()-_=+[]{};:,.?".to_string(),
            forbidden: String::new(),
            start_with_letter: false,
            avoid_ambiguous: false,
        }
    }
}

impl PasswordRule {
    pub fn normalize(&mut self) {
        self.min_length = self.min_length.clamp(4, 128);
        self.max_length = self.max_length.clamp(self.min_length, 128);
        if self.symbols_set.is_empty() {
            self.symbols_set = PasswordRule::default().symbols_set;
        }
        if !(self.upper || self.lower || self.digits || self.symbols) {
            self.lower = true;
            self.digits = true;
        }
    }

    pub fn summary(&self) -> String {
        if !self.enabled {
            return "未设置规则".to_string();
        }
        let mut classes: Vec<&str> = Vec::new();
        if self.lower {
            classes.push("小写");
        }
        if self.upper {
            classes.push("大写");
        }
        if self.digits {
            classes.push("数字");
        }
        if self.symbols {
            classes.push("符号");
        }
        let mut text = format!("{}-{} 位 · {}", self.min_length, self.max_length, classes.join("+"));
        if !self.forbidden.is_empty() {
            text.push_str(&format!(" · 禁用 {}", self.forbidden));
        }
        if self.start_with_letter {
            text.push_str(" · 首字符字母");
        }
        text
    }
}

// ---------------------------------------------------------------------------
// Password history
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: String,
    pub password: String,
    pub recorded_at: String,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub automatic: bool,
}

// ---------------------------------------------------------------------------
// Content files
// ---------------------------------------------------------------------------

/// Which key names are treated as a password candidate when a file is parsed.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct KeyMapping {
    pub password: Vec<String>,
    pub ignore_case: bool,
    pub exact: bool,
}

impl Default for KeyMapping {
    fn default() -> Self {
        Self {
            password: vec![
                "password".into(),
                "passwd".into(),
                "pwd".into(),
                "pass".into(),
                "secret".into(),
                "passwort".into(),
                "kennwort".into(),
                "token".into(),
            ],
            ignore_case: true,
            exact: false,
        }
    }
}

impl KeyMapping {
    pub fn normalize(&mut self) {
        self.password
            .iter_mut()
            .for_each(|value| *value = value.trim().to_string());
        self.password.retain(|value| !value.is_empty());
        self.password.dedup();
        if self.password.is_empty() {
            self.password = KeyMapping::default().password;
        }
    }

    /// Does this key name look like a password?
    pub fn is_password_key(&self, key: &str) -> bool {
        let equals = |a: &str, b: &str| {
            if self.ignore_case {
                a.eq_ignore_ascii_case(b)
            } else {
                a == b
            }
        };
        if self.password.iter().any(|needle| equals(key, needle)) {
            return true;
        }
        if self.exact {
            return false;
        }
        self.password.iter().any(|needle| {
            if needle.len() < 3 {
                return false;
            }
            if self.ignore_case {
                key.to_ascii_lowercase().contains(&needle.to_ascii_lowercase())
            } else {
                key.contains(needle)
            }
        })
    }
}

/// Where a value lives inside the file so it can be replaced **in place**,
/// leaving every other byte untouched.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldLocation {
    /// Byte range of the replaceable value inside the decoded text (inside the
    /// quotes when the value is quoted).
    pub start: usize,
    pub end: usize,
    pub quoted: bool,
    /// The value came from an XML attribute and needs entity escaping.
    pub xml_attr: bool,
    pub line: u32,
}

/// One key/value pair found in a file, shown in the UI so the user can point at
/// the password themselves.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileValue {
    /// Last path segment, e.g. `password`.
    pub key: String,
    /// Full path, e.g. `sap.production.password` (also the binding key).
    pub path: String,
    /// Containing block, used to build the tree.
    pub parent: String,
    pub value: String,
    pub line: u32,
    pub location: FieldLocation,
    /// The key name matches the password keywords.
    pub password_candidate: bool,
}

/// Result of parsing one file.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileAnalysis {
    /// `json` | `env` | `toml` | `yaml` | `xml`
    pub format: String,
    pub values: Vec<FileValue>,
    pub analyzed_at: String,
    pub error: Option<String>,
}

impl FileAnalysis {
    pub fn value(&self, path: &str) -> Option<&FileValue> {
        self.values.iter().find(|value| value.path == path)
    }

}

/// (file, key) → account. This is the only thing that decides where a password
/// is written, so no URL matching is needed.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileBinding {
    pub id: String,
    pub key_path: String,
    pub entry_id: String,
}

impl FileBinding {
    pub fn new(key_path: &str, entry_id: &str) -> Self {
        Self {
            id: new_id(),
            key_path: key_path.to_string(),
            entry_id: entry_id.to_string(),
        }
    }
}

/// A file the user uploaded. Sync writes passwords back into it in place.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncFile {
    pub id: String,
    pub path: String,
    pub label: String,
    pub added_at: String,
    pub exists: bool,
    pub size: u64,
    pub modified_at: Option<String>,
    #[serde(default)]
    pub keys: KeyMapping,
    #[serde(default)]
    pub analysis: Option<FileAnalysis>,
    /// Key → account bindings (many keys and many accounts per file).
    #[serde(default)]
    pub bindings: Vec<FileBinding>,
    #[serde(default)]
    pub last_sync_at: Option<String>,
    #[serde(default)]
    pub last_status: Option<String>,
}

impl SyncFile {
    pub fn from_path(path: &str, keys: KeyMapping, analysis: Option<FileAnalysis>) -> Self {
        let label = std::path::Path::new(path)
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| path.to_string());
        let mut file = Self {
            id: new_id(),
            path: path.to_string(),
            label,
            added_at: now_string(),
            exists: true,
            size: 0,
            modified_at: None,
            keys,
            analysis,
            bindings: Vec::new(),
            last_sync_at: None,
            last_status: None,
        };
        file.refresh_stat();
        file
    }

    pub fn refresh_stat(&mut self) {
        match std::fs::metadata(&self.path) {
            Ok(meta) => {
                self.exists = true;
                self.size = meta.len();
                self.modified_at = meta.modified().ok().map(|time| {
                    let datetime: chrono::DateTime<chrono::Local> = time.into();
                    datetime.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
                });
            }
            Err(_) => {
                self.exists = false;
                self.size = 0;
                self.modified_at = None;
            }
        }
    }

}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    pub title: String,
    pub category_id: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub use_knox_id: bool,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub favorite: bool,
    #[serde(default)]
    pub rule: Option<PasswordRule>,
    #[serde(default)]
    pub history_cycle: u32,
    #[serde(default)]
    pub password_history: Vec<HistoryEntry>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub last_used_at: Option<String>,
}

impl Entry {
    pub fn effective_username(&self, knox_id: &str) -> String {
        if self.use_knox_id && !knox_id.is_empty() {
            knox_id.to_string()
        } else {
            self.username.clone()
        }
    }

    /// Passwords the target system would still remember, newest first.
    pub fn forbidden_reuse(&self, current: &str) -> Vec<String> {
        let cycle = self.history_cycle as usize;
        if cycle == 0 {
            return Vec::new();
        }
        let mut list: Vec<String> = Vec::new();
        if !current.is_empty() {
            list.push(current.to_string());
        }
        for entry in self.password_history.iter().take(cycle) {
            if !entry.password.is_empty() {
                list.push(entry.password.clone());
            }
        }
        list.truncate(cycle);
        list
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Vault {
    pub schema: u32,
    #[serde(default)]
    pub knox_id: String,
    pub categories: Vec<Category>,
    pub entries: Vec<Entry>,
    #[serde(default)]
    pub files: Vec<SyncFile>,
    /// Legacy per-entry file lists (schema 1/2), migrated on load.
    #[serde(default, skip_serializing)]
    pub legacy_links: Vec<LegacyEntryLinks>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyEntryLinks {
    pub entry_id: String,
    pub links: Vec<LegacyLink>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyLink {
    pub path: String,
    #[serde(default)]
    pub keys: KeyMapping,
}

impl Default for Vault {
    fn default() -> Self {
        Self {
            schema: VAULT_SCHEMA,
            knox_id: String::new(),
            categories: vec![Category::sap(), Category::general()],
            entries: Vec::new(),
            files: Vec::new(),
            legacy_links: Vec::new(),
            updated_at: now_string(),
        }
    }
}

impl Vault {
    pub fn category(&self, id: &str) -> AppResult<&Category> {
        self.categories
            .iter()
            .find(|category| category.id == id)
            .ok_or_else(|| AppError::NotFound(format!("分类 {id}")))
    }

    pub fn entry(&self, id: &str) -> AppResult<&Entry> {
        self.entries
            .iter()
            .find(|entry| entry.id == id)
            .ok_or_else(|| AppError::NotFound(format!("条目 {id}")))
    }

    pub fn entry_mut(&mut self, id: &str) -> AppResult<&mut Entry> {
        self.entries
            .iter_mut()
            .find(|entry| entry.id == id)
            .ok_or_else(|| AppError::NotFound(format!("条目 {id}")))
    }

    pub fn file(&self, id: &str) -> AppResult<&SyncFile> {
        self.files
            .iter()
            .find(|file| file.id == id)
            .ok_or_else(|| AppError::NotFound(format!("同步文件 {id}")))
    }

    pub fn file_mut(&mut self, id: &str) -> AppResult<&mut SyncFile> {
        self.files
            .iter_mut()
            .find(|file| file.id == id)
            .ok_or_else(|| AppError::NotFound(format!("同步文件 {id}")))
    }

    pub fn sap_entries(&self) -> impl Iterator<Item = &Entry> {
        self.entries
            .iter()
            .filter(|entry| entry.category_id == SAP_CATEGORY_ID)
    }

    pub fn files_for(&self, entry_id: &str) -> Vec<&SyncFile> {
        self.files
            .iter()
            .filter(|file| file.bindings.iter().any(|b| b.entry_id == entry_id))
            .collect()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntrySummary {
    pub id: String,
    pub title: String,
    pub category_id: String,
    pub username: String,
    /// Carried into the list so the search box can match notes as well.
    pub notes: String,
    pub use_knox_id: bool,
    pub has_password: bool,
    pub favorite: bool,
    pub file_count: usize,
    pub key_count: usize,
    pub has_rule: bool,
    pub rule_summary: String,
    pub history_cycle: u32,
    pub history_count: usize,
    pub updated_at: String,
    pub last_used_at: Option<String>,
}

impl EntrySummary {
    pub fn from(entry: &Entry, vault: &Vault) -> Self {
        let files = vault.files_for(&entry.id);
        let key_count = files
            .iter()
            .map(|file| {
                file.bindings
                    .iter()
                    .filter(|binding| binding.entry_id == entry.id)
                    .count()
            })
            .sum();
        Self {
            id: entry.id.clone(),
            title: entry.title.clone(),
            category_id: entry.category_id.clone(),
            username: entry.effective_username(&vault.knox_id),
            notes: entry.notes.clone(),
            use_knox_id: entry.use_knox_id,
            has_password: !entry.password.is_empty(),

            favorite: entry.favorite,
            file_count: files.len(),
            key_count,
            has_rule: entry.rule.as_ref().map(|rule| rule.enabled).unwrap_or(false),
            rule_summary: entry
                .rule
                .as_ref()
                .map(|rule| rule.summary())
                .unwrap_or_else(|| "未设置规则".to_string()),
            history_cycle: entry.history_cycle,
            history_count: entry.password_history.len(),
            updated_at: entry.updated_at.clone(),
            last_used_at: entry.last_used_at.clone(),
        }
    }
}

/// One (file, key) pair bound to an account, used by the relationship view.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountBinding {
    pub binding_id: String,
    pub file_id: String,
    pub file_path: String,
    pub file_label: String,
    pub file_exists: bool,
    pub format: String,
    pub key_path: String,
    pub value: String,
    pub password_candidate: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Association {
    pub entry_id: String,
    pub entry_title: String,
    pub username: String,
    pub bindings: Vec<AccountBinding>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultView {
    pub knox_id: String,
    pub categories: Vec<Category>,
    pub entries: Vec<EntrySummary>,
    pub files: Vec<SyncFile>,
    pub associations: Vec<Association>,
    pub updated_at: String,
}

impl VaultView {
    pub fn build(vault: &Vault) -> Self {
        let associations = vault
            .sap_entries()
            .map(|entry| Association {
                entry_id: entry.id.clone(),
                entry_title: entry.title.clone(),
                username: entry.effective_username(&vault.knox_id),
                bindings: vault
                    .files
                    .iter()
                    .flat_map(|file| {
                        file.bindings
                            .iter()
                            .filter(|binding| binding.entry_id == entry.id)
                            .map(|binding| {
                                let value = file
                                    .analysis
                                    .as_ref()
                                    .and_then(|analysis| analysis.value(&binding.key_path));
                                AccountBinding {
                                    binding_id: binding.id.clone(),
                                    file_id: file.id.clone(),
                                    file_path: file.path.clone(),
                                    file_label: file.label.clone(),
                                    file_exists: file.exists,
                                    format: file
                                        .analysis
                                        .as_ref()
                                        .map(|analysis| analysis.format.clone())
                                        .unwrap_or_default(),
                                    key_path: binding.key_path.clone(),
                                    value: value.map(|item| item.value.clone()).unwrap_or_default(),
                                    password_candidate: value
                                        .map(|item| item.password_candidate)
                                        .unwrap_or(false),
                                }
                            })
                    })
                    .collect(),
            })
            .collect();
        Self {
            knox_id: vault.knox_id.clone(),
            categories: vault.categories.clone(),
            entries: vault
                .entries
                .iter()
                .map(|entry| EntrySummary::from(entry, vault))
                .collect(),
            files: vault.files.clone(),
            associations,
            updated_at: vault.updated_at.clone(),
        }
    }
}