use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

/// Category id reserved for SAP accounts. It can never be renamed or removed,
/// and it is the only category that participates in the SAP sync pipeline.
pub const SAP_CATEGORY_ID: &str = "sap";
pub const DEFAULT_CATEGORY_ID: &str = "general";

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

/// Where a linked content file came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LinkOrigin {
    Manual,
    Scan,
}

/// Proof produced by the scanner, kept so the UI can explain *why* a file is
/// considered to belong to an SAP account.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanEvidence {
    pub host: String,
    pub system_id: String,
    pub username: String,
    pub matched: Vec<String>,
    pub first_line: u32,
    pub excerpt: String,
}

/// A file that is associated with an account. Together these form the content
/// that gets pushed into the global (e.g. MCP) configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentLink {
    pub id: String,
    pub path: String,
    pub label: String,
    pub origin: LinkOrigin,
    pub evidence: Option<ScanEvidence>,
    pub added_at: String,
    pub exists: bool,
    pub size: u64,
    pub modified_at: Option<String>,
}

impl ContentLink {
    pub fn from_path(path: &str, origin: LinkOrigin, evidence: Option<ScanEvidence>) -> Self {
        let label = std::path::Path::new(path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| path.to_string());
        let mut link = Self {
            id: new_id(),
            path: path.to_string(),
            label,
            origin,
            evidence,
            added_at: now_string(),
            exists: true,
            size: 0,
            modified_at: None,
        };
        link.refresh_stat();
        link
    }

    pub fn refresh_stat(&mut self) {
        match std::fs::metadata(&self.path) {
            Ok(meta) => {
                self.exists = true;
                self.size = meta.len();
                self.modified_at = meta.modified().ok().map(|t| {
                    let dt: chrono::DateTime<chrono::Local> = t.into();
                    dt.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
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

/// SAP specific metadata. The system id is mandatory for SAP entries; hosts are
/// resolved from the SAP GUI landscape so the scanner knows what to look for.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SapAccount {
    #[serde(default)]
    pub system_id: String,
    #[serde(default)]
    pub client: String,
    #[serde(default)]
    pub language: String,
    #[serde(default)]
    pub system_name: String,
    #[serde(default)]
    pub hosts: Vec<String>,
    #[serde(default)]
    pub landscape_source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    pub title: String,
    pub category_id: String,
    #[serde(default)]
    pub username: String,
    /// When true the entry uses the global Knox ID as its user name. The stored
    /// `username` is kept as a fallback so switching back is lossless.
    #[serde(default)]
    pub use_knox_id: bool,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub favorite: bool,
    #[serde(default)]
    pub sap: Option<SapAccount>,
    #[serde(default)]
    pub links: Vec<ContentLink>,
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

    pub fn system_id(&self) -> String {
        self.sap
            .as_ref()
            .map(|s| s.system_id.trim().to_uppercase())
            .unwrap_or_default()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncTarget {
    pub id: String,
    pub name: String,
    /// `mcp` targets are highlighted in the UI as the primary use case.
    #[serde(default)]
    pub kind: String,
    pub path: String,
    pub format: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    pub template: String,
    #[serde(default)]
    pub include_files: bool,
    #[serde(default)]
    pub backup: bool,
    #[serde(default)]
    pub last_sync_at: Option<String>,
    #[serde(default)]
    pub last_status: Option<String>,
}

fn default_true() -> bool {
    true
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
    pub sync_targets: Vec<SyncTarget>,
    pub updated_at: String,
}

impl Default for Vault {
    fn default() -> Self {
        Self {
            schema: 1,
            knox_id: String::new(),
            categories: vec![Category::sap(), Category::general()],
            entries: Vec::new(),
            sync_targets: Vec::new(),
            updated_at: now_string(),
        }
    }
}

impl Vault {
    pub fn category(&self, id: &str) -> AppResult<&Category> {
        self.categories
            .iter()
            .find(|c| c.id == id)
            .ok_or_else(|| AppError::NotFound(format!("分类 {id}")))
    }

    pub fn entry(&self, id: &str) -> AppResult<&Entry> {
        self.entries
            .iter()
            .find(|e| e.id == id)
            .ok_or_else(|| AppError::NotFound(format!("条目 {id}")))
    }

    pub fn entry_mut(&mut self, id: &str) -> AppResult<&mut Entry> {
        self.entries
            .iter_mut()
            .find(|e| e.id == id)
            .ok_or_else(|| AppError::NotFound(format!("条目 {id}")))
    }

    pub fn sap_entries(&self) -> impl Iterator<Item = &Entry> {
        self.entries
            .iter()
            .filter(|e| e.category_id == SAP_CATEGORY_ID)
    }
}

/// Trimmed entry payload used for list rendering. Passwords never travel in the
/// list payload; the frontend asks for a single entry when it needs the secret.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntrySummary {
    pub id: String,
    pub title: String,
    pub category_id: String,
    pub username: String,
    pub use_knox_id: bool,
    pub has_password: bool,
    pub url: String,
    pub favorite: bool,
    pub system_id: String,
    pub client: String,
    pub language: String,
    pub hosts: Vec<String>,
    pub link_count: usize,
    pub updated_at: String,
    pub last_used_at: Option<String>,
}

impl EntrySummary {
    pub fn from(entry: &Entry, knox_id: &str) -> Self {
        let sap = entry.sap.clone().unwrap_or_default();
        Self {
            id: entry.id.clone(),
            title: entry.title.clone(),
            category_id: entry.category_id.clone(),
            username: entry.effective_username(knox_id),
            use_knox_id: entry.use_knox_id,
            has_password: !entry.password.is_empty(),
            url: entry.url.clone(),
            favorite: entry.favorite,
            system_id: sap.system_id,
            client: sap.client,
            language: sap.language,
            hosts: sap.hosts,
            link_count: entry.links.len(),
            updated_at: entry.updated_at.clone(),
            last_used_at: entry.last_used_at.clone(),
        }
    }
}

/// Row used by the "关联关系" screen: one SAP account and what is tied to it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Association {
    pub entry_id: String,
    pub entry_title: String,
    pub system_id: String,
    pub username: String,
    pub hosts: Vec<String>,
    pub links: Vec<ContentLink>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultView {
    pub knox_id: String,
    pub categories: Vec<Category>,
    pub entries: Vec<EntrySummary>,
    pub sync_targets: Vec<SyncTarget>,
    pub associations: Vec<Association>,
    pub updated_at: String,
}

impl VaultView {
    pub fn build(vault: &Vault) -> Self {
        let associations = vault
            .sap_entries()
            .map(|e| Association {
                entry_id: e.id.clone(),
                entry_title: e.title.clone(),
                system_id: e.system_id(),
                username: e.effective_username(&vault.knox_id),
                hosts: e.sap.clone().unwrap_or_default().hosts,
                links: e.links.clone(),
            })
            .collect();
        Self {
            knox_id: vault.knox_id.clone(),
            categories: vault.categories.clone(),
            entries: vault
                .entries
                .iter()
                .map(|e| EntrySummary::from(e, &vault.knox_id))
                .collect(),
            sync_targets: vault.sync_targets.clone(),
            associations,
            updated_at: vault.updated_at.clone(),
        }
    }
}
