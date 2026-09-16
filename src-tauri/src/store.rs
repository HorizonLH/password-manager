use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::crypto::{self, KdfParams, KEY_LEN};
use crate::error::{AppError, AppResult};
use crate::model::{
    KeyMapping, PasswordRule, Vault, DEFAULT_CATEGORY_ID, MAX_PASSWORD_HISTORY, SAP_CATEGORY_ID,
};

pub const ENVELOPE_FILE: &str = "vault.sapvault";
pub const SETTINGS_FILE: &str = "settings.json";
pub const ENVELOPE_FORMAT: &str = "sapvault";
pub const ENVELOPE_VERSION: u32 = 1;
pub const MAX_VAULT_BACKUPS: usize = 10;

/// Marker file that switches SapVault into portable ("绿色") mode.
pub const PORTABLE_MARKER: &str = "portable.txt";
/// Folder used for the vault when running in portable mode.
pub const PORTABLE_DATA_DIR: &str = "SapVaultData";

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
    /// Lock the vault as soon as the Windows session is locked (Win+L).
    pub lock_on_session_lock: bool,
    /// SAP GUI fills successive fields when a multi-line text is pasted, so the
    /// user name and password pair is joined with this separator.
    pub sap_line_separator: String,
    pub mask_passwords: bool,
    pub confirm_delete: bool,
    /// Default key words used when a content file is attached. Each file keeps
    /// its own copy so an override never changes other files.
    pub key_mapping: KeyMapping,
    /// Password policy offered for new entries. `None` means "no rule".
    pub default_rule: Option<PasswordRule>,
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
            lock_on_session_lock: true,
            sap_line_separator: "\r\n".to_string(),
            mask_passwords: true,
            confirm_delete: true,
            key_mapping: KeyMapping::default(),
            default_rule: None,
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
        self.key_mapping.normalize();
        if let Some(rule) = self.default_rule.as_mut() {
            rule.normalize();
        }
        if self.last_category.is_empty() {
            self.last_category = DEFAULT_CATEGORY_ID.to_string();
        }
    }
}

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

fn roaming_dir() -> PathBuf {
    dirs::data_dir()
        .or_else(dirs::config_dir)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("SapVault")
}

/// Portable ("绿色免安装") mode: a `portable.txt` marker next to the executable —
/// or an existing `SapVaultData` folder — keeps every file beside the app
/// instead of inside the user profile.
pub fn portable_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    portable_dir_in(exe.parent()?)
}

/// The actual rule, split out so it can be unit tested without moving the
/// executable around.
pub fn portable_dir_in(exe_dir: &Path) -> Option<PathBuf> {
    let data = exe_dir.join(PORTABLE_DATA_DIR);
    if exe_dir.join(PORTABLE_MARKER).exists() || data.is_dir() {
        Some(data)
    } else {
        None
    }
}

pub fn is_portable() -> bool {
    portable_dir().is_some()
}

pub fn data_dir() -> PathBuf {
    portable_dir().unwrap_or_else(roaming_dir)
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

// ---------------------------------------------------------------------------
// Vault envelope
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Vault normalization
// ---------------------------------------------------------------------------

/// Normalizes a vault loaded from disk: guarantees the built-in categories
/// exist, that rules and key mappings are valid, and that no password history
/// grows past the cap.
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
        if let Some(rule) = entry.rule.as_mut() {
            rule.normalize();
        }
        entry.password_history.truncate(MAX_PASSWORD_HISTORY);
        for recorded in entry.password_history.iter_mut() {
            if recorded.recorded_at.is_empty() {
                recorded.recorded_at = crate::model::now_string();
            }
        }
    }

    migrate_legacy_links(vault);

    let known_entries: Vec<String> = vault.entries.iter().map(|entry| entry.id.clone()).collect();
    for file in vault.files.iter_mut() {
        file.keys.normalize();
        // Drop bindings that point at deleted entries or at keys that are gone.
        file.bindings.retain(|binding| {
            known_entries.contains(&binding.entry_id)
                && file
                    .analysis
                    .as_ref()
                    .map(|analysis| analysis.value(&binding.key_path).is_some())
                    .unwrap_or(false)
        });
        if file.bindings.len() > 1 {
            let mut seen: Vec<(String, String)> = Vec::new();
            file.bindings.retain(|binding| {
                let key = (binding.key_path.clone(), binding.entry_id.clone());
                if seen.contains(&key) {
                    false
                } else {
                    seen.push(key);
                    true
                }
            });
        }
        file.refresh_stat();
    }
    // Two files must not point at the same path twice.
    let mut seen_paths: Vec<String> = Vec::new();
    vault.files.retain(|file| {
        let key = file.path.to_ascii_lowercase();
        if seen_paths.contains(&key) {
            false
        } else {
            seen_paths.push(key);
            true
        }
    });

    vault.categories.sort_by_key(|category| category.sort);
}

/// Schema 1 stored content files inside each entry (`entry.links`). Fold those
/// into the shared file list so a file can be bound to several accounts.
fn migrate_legacy_links(vault: &mut Vault) {
    if vault.schema >= 3 || vault.legacy_links.is_empty() {
        vault.legacy_links.clear();
        vault.schema = crate::model::VAULT_SCHEMA;
        return;
    }
    let legacy = std::mem::take(&mut vault.legacy_links);
    for group in legacy {
        for link in group.links {
            let existing = vault
                .files
                .iter_mut()
                .find(|file| file.path.eq_ignore_ascii_case(&link.path));
            match existing {
                Some(_) => {}
                None => {
                    let mut keys = link.keys;
                    keys.normalize();
                    let analysis = crate::keys::analyze_file(std::path::Path::new(&link.path), &keys);
                    let file = crate::model::SyncFile::from_path(&link.path, keys, Some(analysis));
                    vault.files.push(file);
                }
            }
        }
    }
    vault.schema = crate::model::VAULT_SCHEMA;
}

// ---------------------------------------------------------------------------
// Envelope creation / unlocking
// ---------------------------------------------------------------------------

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
    use crate::model::{Entry, HistoryEntry, KeyMapping, SyncFile};

    fn blank_entry(id: &str, category: &str) -> Entry {
        Entry {
            id: id.to_string(),
            title: id.to_string(),
            category_id: category.to_string(),
            username: String::new(),
            use_knox_id: false,
            password: String::new(),
            notes: String::new(),
            favorite: false,
            rule: None,
            history_cycle: 0,
            password_history: Vec::new(),
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
        assert_eq!(restored.schema, crate::model::VAULT_SCHEMA);
        let wrong = unlock_key(&envelope, Some("wrong password")).unwrap();
        assert!(decrypt_vault(&envelope, &wrong).is_err());
    }

    #[test]
    fn password_mode_matches_its_stored_salt() {
        let vault = Vault::default();
        let envelope =
            create_envelope(VaultMode::Password, Some("a-long-password"), "", &vault).unwrap();
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
        assert_eq!(restored.schema, crate::model::VAULT_SCHEMA);
    }

    #[test]
    fn normalize_repairs_an_unknown_category() {
        let mut vault = Vault::default();
        vault.entries.push(blank_entry("orphan", "deleted-category"));
        vault.entries.push(blank_entry("sap-entry", SAP_CATEGORY_ID));
        normalize_vault(&mut vault);
        assert_eq!(vault.entries[0].category_id, DEFAULT_CATEGORY_ID);
        assert_eq!(vault.entries[1].category_id, SAP_CATEGORY_ID);
    }

    #[test]
    fn normalize_caps_history_and_fills_timestamps() {
        let mut vault = Vault::default();
        let mut entry = blank_entry("sap", SAP_CATEGORY_ID);
        for index in 0..(MAX_PASSWORD_HISTORY + 20) {
            entry.password_history.push(HistoryEntry {
                id: format!("h{index}"),
                password: format!("pw{index}"),
                recorded_at: String::new(),
                note: String::new(),
                automatic: true,
            });
        }
        vault.entries.push(entry);
        normalize_vault(&mut vault);
        assert_eq!(
            vault.entries[0].password_history.len(),
            MAX_PASSWORD_HISTORY
        );
        assert!(!vault.entries[0].password_history[0].recorded_at.is_empty());
    }

    #[test]
    fn normalize_migrates_legacy_entry_links_into_shared_files() {
        let mut vault = Vault::default();
        let mut entry = blank_entry("sap", SAP_CATEGORY_ID);
        entry.id = "sap".to_string();
        vault.entries.push(entry);
        vault.entries.push(blank_entry("second", SAP_CATEGORY_ID));
        vault.schema = 1;
        vault.legacy_links = vec![crate::model::LegacyEntryLinks {
            entry_id: "sap".to_string(),
            links: vec![crate::model::LegacyLink {
                path: "C:/demo/not-there.json".to_string(),
                keys: KeyMapping::default(),
            }],
        }];

        normalize_vault(&mut vault);
        assert_eq!(vault.schema, crate::model::VAULT_SCHEMA);
        assert_eq!(vault.files.len(), 1);
        assert!(vault.files[0].bindings.is_empty());
        assert!(vault.legacy_links.is_empty());
    }

    #[test]
    fn normalize_prunes_dangling_bindings() {
        let mut vault = Vault::default();
        vault.entries.push(blank_entry("sap", SAP_CATEGORY_ID));
        let keys = KeyMapping::default();
        let analysis = crate::keys::analyze_text("{\"a\":{\"password\":\"x\"}}", "json", &keys);
        let mut file = SyncFile::from_path("C:/demo/a.json", keys, Some(analysis));
        file.bindings = vec![
            crate::model::FileBinding::new("a.password", "sap"),
            crate::model::FileBinding::new("a.password", "deleted"),
            crate::model::FileBinding::new("a.gone", "sap"),
        ];
        vault.files.push(file);

        normalize_vault(&mut vault);
        assert_eq!(vault.files.len(), 1);
        assert_eq!(vault.files[0].bindings.len(), 1);
        assert_eq!(vault.files[0].bindings[0].entry_id, "sap");
        assert_eq!(vault.files[0].bindings[0].key_path, "a.password");
    }

    #[test]
    fn settings_normalize_clamps_values() {
        let mut settings = Settings {
            theme: "neon".into(),
            sap_line_separator: "\t".into(),
            clipboard_clear_seconds: 100_000,
            auto_lock_minutes: 100_000,
            key_mapping: KeyMapping {
                password: Vec::new(),
                ignore_case: true,
                exact: false,
            },
            default_rule: Some(PasswordRule {
                min_length: 99,
                max_length: 4,
                ..PasswordRule::default()
            }),
            ..Settings::default()
        };
        settings.normalize();
        assert_eq!(settings.theme, "system");
        assert_eq!(settings.sap_line_separator, "\r\n");
        assert_eq!(settings.clipboard_clear_seconds, 600);
        assert_eq!(settings.auto_lock_minutes, 240);
        assert!(!settings.key_mapping.password.is_empty());
        let rule = settings.default_rule.unwrap();
        assert!(rule.max_length >= rule.min_length);
    }

    #[test]
    fn portable_marker_switches_the_data_directory() {
        let dir = std::env::temp_dir().join(format!("sapvault-portable-{}", crate::model::new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(portable_dir_in(&dir).is_none());

        std::fs::write(dir.join(PORTABLE_MARKER), "portable").unwrap();
        assert_eq!(portable_dir_in(&dir).unwrap(), dir.join(PORTABLE_DATA_DIR));

        // An existing data folder is a marker on its own.
        std::fs::remove_file(dir.join(PORTABLE_MARKER)).unwrap();
        std::fs::create_dir_all(dir.join(PORTABLE_DATA_DIR)).unwrap();
        assert_eq!(portable_dir_in(&dir).unwrap(), dir.join(PORTABLE_DATA_DIR));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn data_dir_lives_under_an_expected_folder_name() {
        let dir = data_dir();
        let name = dir
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        assert!(
            name == "SapVault" || name == PORTABLE_DATA_DIR,
            "unexpected data directory: {dir:?}"
        );
    }
}
