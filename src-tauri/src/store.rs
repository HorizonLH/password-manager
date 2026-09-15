use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::crypto::{self, KdfParams, KEY_LEN};
use crate::error::{AppError, AppResult};
use crate::model::{Vault, DEFAULT_CATEGORY_ID, SAP_CATEGORY_ID};
use crate::scanner;

pub const ENVELOPE_FILE: &str = "vault.sapvault";
pub const SETTINGS_FILE: &str = "settings.json";
pub const ENVELOPE_FORMAT: &str = "sapvault";
pub const ENVELOPE_VERSION: u32 = 1;
pub const MAX_VAULT_BACKUPS: usize = 10;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VaultMode {
    /// Master password + Argon2id.
    Password,
    /// Random key sealed with Windows DPAPI for the current Windows user.
    Windows,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultEnvelope {
    pub format: String,
    pub version: u32,
    pub mode: VaultMode,
    #[serde(default)]
    pub kdf: Option<KdfParams>,
    #[serde(default)]
    pub sealed_key: Option<String>,
    pub nonce: String,
    pub ciphertext: String,
    #[serde(default)]
    pub hint: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub theme: String,
    pub clipboard_clear_seconds: u32,
    pub auto_lock_minutes: u32,
    /// SAP GUI fills successive fields when a multi-line text is pasted, so the
    /// user name and password pair is joined with this separator.
    pub sap_line_separator: String,
    pub mask_passwords: bool,
    pub confirm_delete: bool,
    /// Empty means "auto-detect the standard SAP GUI locations".
    pub landscape_paths: Vec<String>,
    pub scan_roots: Vec<String>,
    pub scan_strict: bool,
    pub scan_max_file_bytes: u64,
    pub scan_max_files: usize,
    pub scan_max_depth: usize,
    pub scan_only_extensions: Vec<String>,
    pub scan_extra_skips: Vec<String>,
    /// Remembers the last category filter so the window reopens where the user
    /// left off.
    pub last_category: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: "system".to_string(),
            clipboard_clear_seconds: 30,
            auto_lock_minutes: 10,
            sap_line_separator: "\r\n".to_string(),
            mask_passwords: true,
            confirm_delete: true,
            landscape_paths: Vec::new(),
            scan_roots: vec![scanner::default_scan_root()],
            scan_strict: true,
            scan_max_file_bytes: 2 * 1024 * 1024,
            scan_max_files: 30_000,
            scan_max_depth: 10,
            scan_only_extensions: Vec::new(),
            scan_extra_skips: Vec::new(),
            last_category: SAP_CATEGORY_ID.to_string(),
        }
    }
}

impl Settings {
    pub fn normalize(&mut self) {
        if !matches!(self.theme.as_str(), "system" | "light" | "dark") {
            self.theme = "system".to_string();
        }
        if !matches!(self.sap_line_separator.as_str(), "\r\n" | "\n" | " ") {
            self.sap_line_separator = "\r\n".to_string();
        }
        self.clipboard_clear_seconds = self.clipboard_clear_seconds.min(600);
        self.auto_lock_minutes = self.auto_lock_minutes.min(240);
        self.scan_max_files = self.scan_max_files.clamp(100, 500_000);
        self.scan_max_depth = self.scan_max_depth.clamp(1, 64);
        self.scan_max_file_bytes = self.scan_max_file_bytes.clamp(1024, 64 * 1024 * 1024);
        if self.scan_roots.is_empty() {
            self.scan_roots = vec![scanner::default_scan_root()];
        }
        if self.last_category.is_empty() {
            self.last_category = DEFAULT_CATEGORY_ID.to_string();
        }
    }
}

pub fn data_dir() -> PathBuf {
    let base = dirs::data_dir()
        .or_else(dirs::config_dir)
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("SapVault")
}

pub fn backup_dir() -> PathBuf {
    data_dir().join("backups")
}

pub fn vault_path() -> PathBuf {
    data_dir().join(ENVELOPE_FILE)
}

pub fn settings_path() -> PathBuf {
    data_dir().join(SETTINGS_FILE)
}

pub fn ensure_dirs() -> AppResult<()> {
    std::fs::create_dir_all(data_dir())?;
    std::fs::create_dir_all(backup_dir())?;
    Ok(())
}

pub fn load_envelope() -> AppResult<Option<VaultEnvelope>> {
    let path = vault_path();
    if !path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&path)?;
    let envelope: VaultEnvelope = serde_json::from_str(&raw).map_err(|err| {
        AppError::Msg(format!(
            "保险库文件无法解析，可能已损坏（{}）：{err}",
            path.display()
        ))
    })?;
    if envelope.format != ENVELOPE_FORMAT {
        return Err(AppError::Msg(format!(
            "无法识别的保险库格式：{}",
            envelope.format
        )));
    }
    Ok(Some(envelope))
}

pub fn save_envelope(envelope: &VaultEnvelope) -> AppResult<()> {
    ensure_dirs()?;
    let path = vault_path();
    let temp = path.with_extension("sapvault.new");
    let raw = serde_json::to_string_pretty(envelope)?;
    std::fs::write(&temp, raw.as_bytes())?;
    // Write to a sibling first so a crash mid-write cannot leave a half-written
    // vault behind.
    std::fs::rename(&temp, &path)?;
    Ok(())
}

pub fn rotate_vault_backups() -> AppResult<Option<PathBuf>> {
    let path = vault_path();
    if !path.exists() {
        return Ok(None);
    }
    ensure_dirs()?;
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
    let backup = backup_dir().join(format!("vault-{stamp}.sapvault"));
    std::fs::copy(&path, &backup)?;
    prune_backups()?;
    Ok(Some(backup))
}

fn prune_backups() -> AppResult<()> {
    let mut entries: Vec<PathBuf> = std::fs::read_dir(backup_dir())?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| path.extension().map(|ext| ext == "sapvault").unwrap_or(false))
        .collect();
    if entries.len() <= MAX_VAULT_BACKUPS {
        return Ok(());
    }
    entries.sort();
    let excess = entries.len() - MAX_VAULT_BACKUPS;
    for path in entries.into_iter().take(excess) {
        let _ = std::fs::remove_file(path);
    }
    Ok(())
}

pub fn load_settings() -> Settings {
    let path = settings_path();
    let mut settings = match std::fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str::<Settings>(&raw).unwrap_or_default(),
        Err(_) => Settings::default(),
    };
    settings.normalize();
    settings
}

pub fn save_settings(settings: &Settings) -> AppResult<()> {
    ensure_dirs()?;
    let mut settings = settings.clone();
    settings.normalize();
    let raw = serde_json::to_string_pretty(&settings)?;
    std::fs::write(settings_path(), raw.as_bytes())?;
    Ok(())
}

/// Normalizes a vault loaded from disk: guarantees the built-in categories
/// exist and that SAP entries always carry a SAP block.
pub fn normalize_vault(vault: &mut Vault) {
    if vault.schema == 0 {
        vault.schema = 1;
    }
    if !vault.categories.iter().any(|c| c.id == SAP_CATEGORY_ID) {
        vault.categories.insert(0, crate::model::Category::sap());
    }
    if !vault.categories.iter().any(|c| c.id == DEFAULT_CATEGORY_ID) {
        vault.categories.push(crate::model::Category::general());
    }
    let known: Vec<String> = vault.categories.iter().map(|c| c.id.clone()).collect();
    for entry in vault.entries.iter_mut() {
        if !known.contains(&entry.category_id) {
            entry.category_id = DEFAULT_CATEGORY_ID.to_string();
        }
        if entry.category_id == SAP_CATEGORY_ID && entry.sap.is_none() {
            entry.sap = Some(Default::default());
        }
        for link in entry.links.iter_mut() {
            link.refresh_stat();
        }
    }
    vault.categories.sort_by_key(|category| category.sort);
}

/// Creates a brand new envelope. The same `KdfParams` instance is used for the
/// derivation and stored in the envelope, otherwise the salt would not match and
/// the vault could never be unlocked again.
pub fn create_envelope(
    mode: VaultMode,
    password: Option<&str>,
    hint: &str,
    vault: &Vault,
) -> AppResult<VaultEnvelope> {
    let (key, kdf, sealed_key) = match mode {
        VaultMode::Password => {
            let password = password.ok_or_else(|| AppError::Msg("主密码不能为空".to_string()))?;
            if password.chars().count() < 8 {
                return Err(AppError::Msg("主密码至少需要 8 个字符".to_string()));
            }
            let params = KdfParams {
                salt: crypto::new_salt(),
                ..Default::default()
            };
            let key = crypto::derive_key(password, &params)?;
            (key, Some(params), None)
        }
        VaultMode::Windows => {
            let key = crypto::random_bytes::<KEY_LEN>();
            let sealed = crypto::seal_for_windows(&key)?;
            (key, None, Some(sealed))
        }
    };

    let plaintext = serde_json::to_vec(vault)?;
    let (nonce, ciphertext) = crypto::encrypt(&key, &plaintext)?;

    Ok(VaultEnvelope {
        format: ENVELOPE_FORMAT.to_string(),
        version: ENVELOPE_VERSION,
        mode,
        kdf,
        sealed_key,
        nonce,
        ciphertext,
        hint: hint.to_string(),
        updated_at: crate::model::now_string(),
    })
}

/// Re-derives or unseals the vault key for an existing envelope.
pub fn unlock_key(envelope: &VaultEnvelope, password: Option<&str>) -> AppResult<[u8; KEY_LEN]> {
    match envelope.mode {
        VaultMode::Password => {
            let params = envelope
                .kdf
                .as_ref()
                .ok_or_else(|| AppError::Msg("保险库缺少 KDF 参数".to_string()))?;
            let password = password.ok_or_else(|| AppError::Msg("请输入主密码".to_string()))?;
            crypto::derive_key(password, params)
        }
        VaultMode::Windows => {
            let sealed = envelope
                .sealed_key
                .as_ref()
                .ok_or_else(|| AppError::Msg("保险库缺少 DPAPI 密钥".to_string()))?;
            crypto::unseal_for_windows(sealed)
        }
    }
}

pub fn decrypt_vault(envelope: &VaultEnvelope, key: &[u8; KEY_LEN]) -> AppResult<Vault> {
    let plaintext = crypto::decrypt(key, &envelope.nonce, &envelope.ciphertext)?;
    let mut vault: Vault = serde_json::from_slice(&plaintext)?;
    normalize_vault(&mut vault);
    Ok(vault)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Entry;

    fn blank_entry(id: &str, category: &str) -> Entry {
        Entry {
            id: id.to_string(),
            title: id.to_string(),
            category_id: category.to_string(),
            username: String::new(),
            use_knox_id: false,
            password: String::new(),
            url: String::new(),
            notes: String::new(),
            favorite: false,
            sap: None,
            links: Vec::new(),
            created_at: String::new(),
            updated_at: String::new(),
            last_used_at: None,
        }
    }

    #[test]
    fn password_mode_round_trip() {
        let vault = Vault::default();
        let envelope =
            create_envelope(VaultMode::Password, Some("correct horse"), "提示", &vault).unwrap();
        let key = unlock_key(&envelope, Some("correct horse")).unwrap();
        let restored = decrypt_vault(&envelope, &key).unwrap();
        assert_eq!(restored.categories.len(), 2);
        assert_eq!(restored.schema, 1);
        let wrong = unlock_key(&envelope, Some("wrong password")).unwrap(); assert!(decrypt_vault(&envelope, &wrong).is_err());
    }

    #[test]
    fn password_mode_matches_its_stored_salt() {
        let vault = Vault::default();
        let envelope = create_envelope(VaultMode::Password, Some("a-long-password"), "", &vault)
            .unwrap();
        let params = envelope.kdf.as_ref().unwrap();
        let rederived = crypto::derive_key("a-long-password", params).unwrap();
        let from_unlock = unlock_key(&envelope, Some("a-long-password")).unwrap();
        assert_eq!(rederived, from_unlock);
        assert!(decrypt_vault(&envelope, &rederived).is_ok());
    }

    #[test]
    fn short_or_missing_password_is_rejected() {
        let vault = Vault::default();
        assert!(create_envelope(VaultMode::Password, Some("short"), "", &vault).is_err());
        assert!(create_envelope(VaultMode::Password, None, "", &vault).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn windows_mode_round_trip() {
        let vault = Vault::default();
        let envelope = create_envelope(VaultMode::Windows, None, "", &vault).unwrap();
        let key = unlock_key(&envelope, None).unwrap();
        let restored = decrypt_vault(&envelope, &key).unwrap();
        assert_eq!(restored.schema, 1);
    }

    #[test]
    fn normalize_repairs_category_and_missing_sap_block() {
        let mut vault = Vault::default();
        vault.entries.push(blank_entry("orphan", "deleted-category"));
        vault.entries.push(blank_entry("sap-entry", SAP_CATEGORY_ID));
        normalize_vault(&mut vault);
        assert_eq!(vault.entries[0].category_id, DEFAULT_CATEGORY_ID);
        assert!(vault.entries[1].sap.is_some());
    }

    #[test]
    fn settings_normalize_clamps_values() {
        let mut settings = Settings {
            theme: "neon".into(),
            sap_line_separator: "\t".into(),
            clipboard_clear_seconds: 100_000,
            auto_lock_minutes: 100_000,
            scan_max_files: 1,
            scan_max_depth: 0,
            scan_max_file_bytes: 1,
            scan_roots: Vec::new(),
            ..Settings::default()
        };
        settings.normalize();
        assert_eq!(settings.theme, "system");
        assert_eq!(settings.sap_line_separator, "\r\n");
        assert_eq!(settings.clipboard_clear_seconds, 600);
        assert_eq!(settings.auto_lock_minutes, 240);
        assert_eq!(settings.scan_max_files, 100);
        assert_eq!(settings.scan_max_depth, 1);
        assert!(!settings.scan_roots.is_empty());
    }
}
