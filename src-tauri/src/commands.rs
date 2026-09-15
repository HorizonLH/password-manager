use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::clipboard;
use crate::crypto::{self, GeneratorOptions, PasswordStrength};
use crate::error::{AppError, AppResult};
use crate::keys;
use crate::model::{
    now_string, Category, ContentLink, Entry, EntrySummary, HistoryEntry, KeyMapping, LinkParse,
    PasswordRule, SapAccount, SyncTarget, Vault, VaultView, DEFAULT_CATEGORY_ID,
    MAX_PASSWORD_HISTORY, SAP_CATEGORY_ID,
};
use crate::rules;
use crate::sap::{self, LandscapeReport, SapSystem};
use crate::state::{AppState, Unlocked};
use crate::store::{self, Settings, VaultMode};
use crate::sync::{self, SyncOutcome, TemplatePreset};

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Notice {
    pub kind: String,
    pub message: String,
}

fn notice(app: &AppHandle, kind: &str, message: impl Into<String>) {
    let _ = app.emit(
        "app:notice",
        Notice {
            kind: kind.to_string(),
            message: message.into(),
        },
    );
}

// ---------------------------------------------------------------------------
// Bootstrap / settings
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bootstrap {
    pub has_vault: bool,
    pub mode: Option<String>,
    pub hint: String,
    pub unlocked: bool,
    pub settings: Settings,
    pub data_dir: String,
    pub vault_path: String,
    pub portable: bool,
    pub landscape_defaults: Vec<String>,
    pub landscape_paths: Vec<String>,
    pub presets: Vec<TemplatePreset>,
    pub supported_formats: Vec<String>,
    pub version: String,
    pub startup_error: Option<String>,
}

#[tauri::command]
pub fn app_bootstrap(state: State<'_, AppState>) -> AppResult<Bootstrap> {
    let settings = state.settings_snapshot();
    let envelope = state.envelope_snapshot();
    Ok(Bootstrap {
        has_vault: envelope.is_some(),
        mode: envelope.as_ref().map(|envelope| match envelope.mode {
            VaultMode::Password => "password".to_string(),
            VaultMode::Windows => "windows".to_string(),
        }),
        hint: envelope
            .as_ref()
            .map(|envelope| envelope.hint.clone())
            .unwrap_or_default(),
        unlocked: state.is_unlocked(),
        landscape_paths: resolved_landscape_paths(&settings),
        settings,
        data_dir: store::data_dir().to_string_lossy().to_string(),
        vault_path: store::vault_path().to_string_lossy().to_string(),
        portable: store::is_portable(),
        landscape_defaults: sap::default_landscape_paths(),
        presets: sync::presets(),
        supported_formats: vec![
            "JSON".to_string(),
            ".env".to_string(),
            "TOML".to_string(),
            "YAML".to_string(),
            "XML".to_string(),
            "纯文本".to_string(),
        ],
        version: env!("CARGO_PKG_VERSION").to_string(),
        startup_error: state.startup_error(),
    })
}

#[tauri::command]
pub fn settings_get(state: State<'_, AppState>) -> Settings {
    state.settings_snapshot()
}

#[tauri::command]
pub fn settings_save(state: State<'_, AppState>, settings: Settings) -> AppResult<Settings> {
    state.update_settings(|current| *current = settings)?;
    Ok(state.settings_snapshot())
}

fn resolved_landscape_paths(settings: &Settings) -> Vec<String> {
    let custom: Vec<String> = settings
        .landscape_paths
        .iter()
        .map(|path| path.trim().to_string())
        .filter(|path| !path.is_empty())
        .collect();
    if custom.is_empty() {
        sap::default_landscape_paths()
    } else {
        custom
    }
}

// ---------------------------------------------------------------------------
// Vault lifecycle
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn vault_create(
    state: State<'_, AppState>,
    mode: String,
    password: Option<String>,
    hint: Option<String>,
) -> AppResult<()> {
    if state.has_vault() {
        return Err(AppError::VaultExists);
    }
    let mode = match mode.as_str() {
        "windows" => VaultMode::Windows,
        "password" => VaultMode::Password,
        other => return Err(AppError::Msg(format!("未知的保险库模式：{other}"))),
    };
    let vault = Vault::default();
    let envelope = store::create_envelope(
        mode,
        password.as_deref(),
        hint.as_deref().unwrap_or(""),
        &vault,
    )?;
    store::ensure_dirs()?;
    store::save_envelope(&envelope)?;
    let key = store::unlock_key(&envelope, password.as_deref())?;
    state.set_envelope(envelope);
    state.set_unlocked(Unlocked { vault, key });
    Ok(())
}

#[tauri::command]
pub fn vault_unlock(state: State<'_, AppState>, password: Option<String>) -> AppResult<VaultView> {
    let envelope = state.envelope_snapshot().ok_or(AppError::NoVault)?;
    let key = store::unlock_key(&envelope, password.as_deref())?;
    // A wrong password surfaces here as a GCM authentication failure.
    let vault = store::decrypt_vault(&envelope, &key)?;
    let view = VaultView::build(&vault);
    state.set_unlocked(Unlocked { vault, key });
    Ok(view)
}

#[tauri::command]
pub fn vault_lock(app: AppHandle, state: State<'_, AppState>) -> bool {
    let locked = state.lock();
    if locked {
        let _ = app.emit("vault:locked", true);
    }
    locked
}

#[tauri::command]
pub fn vault_view(state: State<'_, AppState>) -> AppResult<VaultView> {
    state.touch();
    state.with_vault(|vault| Ok(VaultView::build(vault)))
}

#[tauri::command]
pub fn vault_status(state: State<'_, AppState>) -> serde_json::Value {
    serde_json::json!({
        "hasVault": state.has_vault(),
        "unlocked": state.is_unlocked(),
        "idleSeconds": state.idle_seconds(),
        "sessionLocked": crate::state::workstation_locked(),
        "startupError": state.startup_error(),
        "portable": store::is_portable(),
    })
}

#[tauri::command]
pub fn vault_change_password(
    state: State<'_, AppState>,
    current_password: Option<String>,
    new_password: String,
) -> AppResult<()> {
    let envelope = state.envelope_snapshot().ok_or(AppError::NoVault)?;
    // Verify the caller really knows the current secret before rotating.
    let _ = store::unlock_key(&envelope, current_password.as_deref())?;
    if new_password.chars().count() < 8 {
        return Err(AppError::Msg("新主密码至少需要 8 个字符".to_string()));
    }
    let params = crypto::KdfParams {
        salt: crypto::new_salt(),
        ..Default::default()
    };
    let key = crypto::derive_key(&new_password, &params)?;
    state.rekey_with_password(&key, params)?;
    Ok(())
}

#[tauri::command]
pub fn vault_backup_now(state: State<'_, AppState>) -> AppResult<Option<String>> {
    state.touch();
    Ok(store::rotate_vault_backups()?.map(|path| path.to_string_lossy().to_string()))
}

#[tauri::command]
pub fn vault_export(state: State<'_, AppState>, path: String) -> AppResult<String> {
    state.touch();
    let source = store::vault_path();
    if !source.exists() {
        return Err(AppError::NoVault);
    }
    let target = PathBuf::from(path.trim());
    if let Some(parent) = target.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }
    std::fs::copy(&source, &target)?;
    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
pub fn vault_import(
    state: State<'_, AppState>,
    path: String,
    password: Option<String>,
) -> AppResult<()> {
    let source = PathBuf::from(path.trim());
    let raw = std::fs::read_to_string(&source)?;
    let envelope: store::VaultEnvelope = serde_json::from_str(&raw)
        .map_err(|err| AppError::Msg(format!("导入文件不是有效的保险库：{err}")))?;
    if envelope.format != store::ENVELOPE_FORMAT {
        return Err(AppError::Msg("导入文件不是 SapVault 保险库".to_string()));
    }
    // Make sure the file can actually be opened before replacing anything.
    let key = store::unlock_key(&envelope, password.as_deref())?;
    let vault = store::decrypt_vault(&envelope, &key)?;
    let _ = store::rotate_vault_backups()?;
    store::save_envelope(&envelope)?;
    state.set_envelope(envelope);
    state.set_unlocked(Unlocked { vault, key });
    Ok(())
}

// ---------------------------------------------------------------------------
// Knox ID
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn knox_set(state: State<'_, AppState>, knox_id: String) -> AppResult<VaultView> {
    let trimmed = knox_id.trim().to_string();
    state.with_vault_mut(|vault| {
        vault.knox_id = trimmed;
        Ok(())
    })?;
    vault_view(state)
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn category_create(state: State<'_, AppState>, name: String) -> AppResult<VaultView> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::Msg("分类名称不能为空".to_string()));
    }
    state.with_vault_mut(|vault| {
        if vault.categories.iter().any(|category| category.name == name) {
            return Err(AppError::Msg(format!("分类「{name}」已存在")));
        }
        let sort = vault
            .categories
            .iter()
            .map(|category| category.sort)
            .max()
            .unwrap_or(0)
            + 1;
        vault.categories.push(Category {
            id: crate::model::new_id(),
            name,
            builtin: false,
            sort,
        });
        Ok(())
    })?;
    vault_view(state)
}

#[tauri::command]
pub fn category_rename(
    state: State<'_, AppState>,
    id: String,
    name: String,
) -> AppResult<VaultView> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::Msg("分类名称不能为空".to_string()));
    }
    state.with_vault_mut(|vault| {
        if id == SAP_CATEGORY_ID {
            return Err(AppError::Msg("SAP 分类是固定分类，不能重命名".to_string()));
        }
        let category = vault
            .categories
            .iter_mut()
            .find(|category| category.id == id)
            .ok_or_else(|| AppError::NotFound(format!("分类 {id}")))?;
        category.name = name;
        Ok(())
    })?;
    vault_view(state)
}

#[tauri::command]
pub fn category_delete(state: State<'_, AppState>, id: String) -> AppResult<VaultView> {
    if id == SAP_CATEGORY_ID {
        return Err(AppError::Msg("SAP 分类是固定分类，不能删除".to_string()));
    }
    if id == DEFAULT_CATEGORY_ID {
        return Err(AppError::Msg("默认分类不能删除".to_string()));
    }
    state.with_vault_mut(|vault| {
        vault.categories.retain(|category| category.id != id);
        for entry in vault.entries.iter_mut() {
            if entry.category_id == id {
                entry.category_id = DEFAULT_CATEGORY_ID.to_string();
            }
        }
        Ok(())
    })?;
    vault_view(state)
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryInput {
    #[serde(default)]
    pub id: Option<String>,
    pub title: String,
    pub category_id: String,
    #[serde(default)]
    pub username: String,
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
    /// `None` removes the rule from the entry.
    #[serde(default)]
    pub rule: Option<PasswordRule>,
    #[serde(default)]
    pub history_cycle: u32,
    /// Set by the UI after the user accepts a rule / cycle warning.
    #[serde(default)]
    pub force: bool,
}

#[tauri::command]
pub fn entry_get(state: State<'_, AppState>, id: String) -> AppResult<Entry> {
    state.touch();
    state.with_vault(|vault| vault.entry(&id).cloned())
}

#[tauri::command]
pub fn entry_save(state: State<'_, AppState>, input: EntryInput) -> AppResult<Entry> {
    let title = input.title.trim().to_string();
    if title.is_empty() {
        return Err(AppError::Msg("标题不能为空".to_string()));
    }
    let is_sap = input.category_id == SAP_CATEGORY_ID;
    let mut sap_block = input.sap.clone().unwrap_or_default();
    if is_sap {
        sap_block.system_id = sap_block.system_id.trim().to_ascii_uppercase();
        if sap_block.system_id.is_empty() {
            return Err(AppError::Msg("SAP 账号必须填写系统 ID".to_string()));
        }
        if sap_block.hosts.is_empty() {
            if let Ok(report) = ensure_landscape(&state, false) {
                let hosts = report.hosts_for(&sap_block.system_id);
                if !hosts.is_empty() {
                    sap_block.hosts = hosts;
                }
                if let Some(matched) = report.resolve(&sap_block.system_id).first() {
                    if sap_block.system_name.is_empty() {
                        sap_block.system_name = matched.name.clone();
                    }
                    if sap_block.client.is_empty() {
                        sap_block.client = matched.client.clone();
                    }
                    sap_block.landscape_source = matched.source_file.clone();
                }
            }
        }
    }

    let id = input.id.clone().filter(|value| !value.is_empty());
    let mut rule = input.rule.clone();
    if let Some(rule) = rule.as_mut() {
        rule.normalize();
    }
    let cycle = input.history_cycle.min(MAX_PASSWORD_HISTORY as u32);
    let force = input.force;
    let new_password = input.password.clone();

    state.with_vault_mut(|vault| {
        // Validates the category and gives a clear error for a stale id.
        vault.category(&input.category_id)?;

        let existing = match &id {
            Some(id) => Some(vault.entry(id)?.clone()),
            None => None,
        };

        // --- policy checks ------------------------------------------------
        let rule_problems = match rule.as_ref() {
            Some(rule) if !new_password.is_empty() => rules::validate(&new_password, rule),
            _ => Vec::new(),
        };
        let mut cycle_problems: Vec<String> = Vec::new();
        if let Some(existing) = existing.as_ref() {
            if !new_password.is_empty() && new_password != existing.password {
                let mut probe = existing.clone();
                probe.history_cycle = cycle;
                let reused = probe
                    .forbidden_reuse(&existing.password)
                    .iter()
                    .any(|value| value.as_str() == new_password.as_str());
                if reused {
                    cycle_problems.push(format!(
                        "该密码在最近 {} 次维护中使用过，系统通常会拒绝重复",
                        cycle
                    ));
                }
            }
        }

        if !force {
            if !rule_problems.is_empty() {
                return Err(AppError::validation(
                    "password-rule",
                    "密码不符合该条目的规则",
                    rule_problems,
                ));
            }
            if !cycle_problems.is_empty() {
                return Err(AppError::validation(
                    "password-cycle",
                    "密码与历史密码重复",
                    cycle_problems,
                ));
            }
        }

        match id {
            Some(id) => {
                let entry = vault.entry_mut(&id)?;
                let previous = entry.password.clone();
                let changed = previous != new_password;
                if changed && !previous.is_empty() {
                    entry.password_history.insert(
                        0,
                        HistoryEntry {
                            id: crate::model::new_id(),
                            password: previous,
                            recorded_at: now_string(),
                            note: "密码变更时自动记录".to_string(),
                            automatic: true,
                        },
                    );
                    entry.password_history.truncate(MAX_PASSWORD_HISTORY);
                }
                entry.title = title;
                entry.category_id = input.category_id.clone();
                entry.username = input.username.clone();
                entry.use_knox_id = input.use_knox_id;
                entry.password = new_password;
                entry.url = input.url.clone();
                entry.notes = input.notes.clone();
                entry.favorite = input.favorite;
                entry.rule = rule.clone();
                entry.history_cycle = cycle;
                // Moving out of the SAP category drops the SAP block, moving
                // into it (re)installs the one we just resolved.
                entry.sap = if is_sap { Some(sap_block.clone()) } else { None };
                entry.updated_at = now_string();
                Ok(entry.clone())
            }
            None => {
                let entry = Entry {
                    id: crate::model::new_id(),
                    title,
                    category_id: input.category_id.clone(),
                    username: input.username.clone(),
                    use_knox_id: input.use_knox_id,
                    password: new_password,
                    url: input.url.clone(),
                    notes: input.notes.clone(),
                    favorite: input.favorite,
                    sap: if is_sap { Some(sap_block.clone()) } else { None },
                    rule,
                    history_cycle: cycle,
                    password_history: Vec::new(),
                    links: Vec::new(),
                    created_at: now_string(),
                    updated_at: now_string(),
                    last_used_at: None,
                };
                vault.entries.push(entry.clone());
                Ok(entry)
            }
        }
    })
}

#[tauri::command]
pub fn entry_delete(state: State<'_, AppState>, id: String) -> AppResult<VaultView> {
    state.with_vault_mut(|vault| {
        let before = vault.entries.len();
        vault.entries.retain(|entry| entry.id != id);
        if vault.entries.len() == before {
            return Err(AppError::NotFound(format!("条目 {id}")));
        }
        Ok(())
    })?;
    vault_view(state)
}

#[tauri::command]
pub fn entry_toggle_favorite(state: State<'_, AppState>, id: String) -> AppResult<VaultView> {
    state.with_vault_mut(|vault| {
        let entry = vault.entry_mut(&id)?;
        entry.favorite = !entry.favorite;
        Ok(())
    })?;
    vault_view(state)
}

#[tauri::command]
pub fn entry_summary(state: State<'_, AppState>, id: String) -> AppResult<EntrySummary> {
    state.with_vault(|vault| {
        let entry = vault.entry(&id)?;
        Ok(EntrySummary::from(entry, &vault.knox_id))
    })
}

// ---------------------------------------------------------------------------
// Password history
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn history_add(
    state: State<'_, AppState>,
    entry_id: String,
    password: String,
    note: Option<String>,
) -> AppResult<Entry> {
    if password.is_empty() {
        return Err(AppError::Msg("历史密码不能为空".to_string()));
    }
    state.with_vault_mut(|vault| {
        let entry = vault.entry_mut(&entry_id)?;
        entry.password_history.insert(
            0,
            HistoryEntry {
                id: crate::model::new_id(),
                password,
                recorded_at: now_string(),
                note: note.unwrap_or_default(),
                automatic: false,
            },
        );
        entry.password_history.truncate(MAX_PASSWORD_HISTORY);
        entry.updated_at = now_string();
        Ok(entry.clone())
    })
}

#[tauri::command]
pub fn history_remove(
    state: State<'_, AppState>,
    entry_id: String,
    history_id: String,
) -> AppResult<Entry> {
    state.with_vault_mut(|vault| {
        let entry = vault.entry_mut(&entry_id)?;
        let before = entry.password_history.len();
        entry.password_history.retain(|item| item.id != history_id);
        if entry.password_history.len() == before {
            return Err(AppError::NotFound(format!("历史密码 {history_id}")));
        }
        entry.updated_at = now_string();
        Ok(entry.clone())
    })
}

#[tauri::command]
pub fn history_clear(state: State<'_, AppState>, entry_id: String) -> AppResult<Entry> {
    state.with_vault_mut(|vault| {
        let entry = vault.entry_mut(&entry_id)?;
        entry.password_history.clear();
        entry.updated_at = now_string();
        Ok(entry.clone())
    })
}

// ---------------------------------------------------------------------------
// Clipboard
// ---------------------------------------------------------------------------

fn mark_used(state: &State<'_, AppState>, id: &str) -> AppResult<()> {
    state.with_vault_mut(|vault| {
        let entry = vault.entry_mut(id)?;
        entry.last_used_at = Some(now_string());
        Ok(())
    })
}

fn copy_with_notice(
    app: &AppHandle,
    state: &State<'_, AppState>,
    text: String,
    message: String,
) -> AppResult<String> {
    let settings = state.settings_snapshot();
    clipboard::set_text(&text)?;
    let handle = app.clone();
    clipboard::schedule_auto_clear(text, settings.clipboard_clear_seconds as u64, move || {
        let _ = handle.emit(
            "app:notice",
            Notice {
                kind: "info".to_string(),
                message: "剪贴板已自动清空".to_string(),
            },
        );
    });
    let seconds = settings.clipboard_clear_seconds;
    let suffix = if seconds == 0 {
        String::new()
    } else {
        format!("（{seconds} 秒后自动清空）")
    };
    Ok(format!("{message}{suffix}"))
}

#[tauri::command]
pub fn copy_password(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> AppResult<String> {
    state.touch();
    let entry = state.with_vault(|vault| vault.entry(&id).cloned())?;
    if entry.password.is_empty() {
        return Err(AppError::Msg("该条目没有保存密码".to_string()));
    }
    mark_used(&state, &id)?;
    copy_with_notice(&app, &state, entry.password, "密码已复制".to_string())
}

#[tauri::command]
pub fn copy_username(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> AppResult<String> {
    state.touch();
    let knox = state.knox_id();
    let entry = state.with_vault(|vault| vault.entry(&id).cloned())?;
    let username = entry.effective_username(&knox);
    if username.is_empty() {
        return Err(AppError::Msg("该条目没有用户名".to_string()));
    }
    copy_with_notice(&app, &state, username, "用户名已复制".to_string())
}

/// The SAP-specific copy: user name and password on two lines, which SAP GUI
/// distributes across the successive fields of the login screen on paste.
#[tauri::command]
pub fn copy_sap_credentials(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> AppResult<String> {
    state.touch();
    let settings = state.settings_snapshot();
    let knox = state.knox_id();
    let entry = state.with_vault(|vault| vault.entry(&id).cloned())?;
    let username = entry.effective_username(&knox);
    if username.is_empty() || entry.password.is_empty() {
        return Err(AppError::Msg(
            "需要同时具备用户名和密码才能复制 SAP 凭据".to_string(),
        ));
    }
    mark_used(&state, &id)?;
    let payload = clipboard::sap_credentials_payload(
        &username,
        &entry.password,
        &settings.sap_line_separator,
    );
    copy_with_notice(
        &app,
        &state,
        payload,
        "SAP 用户名 + 密码已复制（换行分隔）".to_string(),
    )
}

/// Copies arbitrary text (a historical password, a parsed field value) using
/// the same auto-clear policy as the credential copies.
#[tauri::command]
pub fn copy_text(
    app: AppHandle,
    state: State<'_, AppState>,
    text: String,
    label: Option<String>,
) -> AppResult<String> {
    if text.is_empty() {
        return Err(AppError::Msg("没有可复制的内容".to_string()));
    }
    let label = label.unwrap_or_else(|| "内容".to_string());
    copy_with_notice(&app, &state, text, format!("{label}已复制"))
}

#[tauri::command]
pub fn clipboard_clear() -> AppResult<()> {
    let mut clipboard =
        arboard::Clipboard::new().map_err(|err| AppError::Msg(format!("无法访问剪贴板：{err}")))?;
    clipboard
        .clear()
        .map_err(|err| AppError::Msg(format!("清空剪贴板失败：{err}")))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// SAP landscape
// ---------------------------------------------------------------------------

fn ensure_landscape(state: &State<'_, AppState>, refresh: bool) -> AppResult<LandscapeReport> {
    if !refresh {
        if let Some(report) = state.landscape_snapshot() {
            return Ok(report);
        }
    }
    let settings = state.settings_snapshot();
    let report = sap::parse_files(&resolved_landscape_paths(&settings))?;
    state.set_landscape(report.clone());
    Ok(report)
}

#[tauri::command]
pub fn sap_systems(
    state: State<'_, AppState>,
    refresh: Option<bool>,
) -> AppResult<LandscapeReport> {
    state.touch();
    ensure_landscape(&state, refresh.unwrap_or(false))
}

#[tauri::command]
pub fn sap_resolve(state: State<'_, AppState>, system_id: String) -> AppResult<Vec<SapSystem>> {
    let report = ensure_landscape(&state, false)?;
    Ok(report.resolve(&system_id))
}

#[tauri::command]
pub fn sap_default_paths() -> Vec<String> {
    sap::default_landscape_paths()
}

// ---------------------------------------------------------------------------
// Content files
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkDraft {
    pub path: String,
    /// Omit to use the global default key words.
    #[serde(default)]
    pub keys: Option<KeyMapping>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkInspection {
    pub path: String,
    pub label: String,
    pub format: String,
    pub supported: bool,
    pub exists: bool,
    pub size: u64,
    pub keys: KeyMapping,
    pub parse: LinkParse,
}

fn inspect(path: &str, keys: KeyMapping) -> LinkInspection {
    let target = PathBuf::from(path.trim());
    let mut keys = keys;
    keys.normalize();
    let parse = keys::analyze_file(&target, &keys);
    let metadata = std::fs::metadata(&target).ok();
    LinkInspection {
        path: target.to_string_lossy().to_string(),
        label: target
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| path.to_string()),
        format: parse.format.clone(),
        supported: keys::is_supported(&target),
        exists: metadata.is_some(),
        size: metadata.map(|meta| meta.len()).unwrap_or(0),
        keys,
        parse,
    }
}

/// Analyses files without attaching them, so the UI can show what was found and
/// ask the user for different key words when a field is missing.
#[tauri::command]
pub fn link_inspect(
    state: State<'_, AppState>,
    paths: Vec<String>,
    keys: Option<KeyMapping>,
) -> AppResult<Vec<LinkInspection>> {
    let mapping = keys.unwrap_or_else(|| state.settings_snapshot().key_mapping);
    Ok(paths
        .iter()
        .map(|path| inspect(path, mapping.clone()))
        .collect())
}

#[tauri::command]
pub fn link_add(
    state: State<'_, AppState>,
    entry_id: String,
    drafts: Vec<LinkDraft>,
) -> AppResult<Entry> {
    let fallback = state.settings_snapshot().key_mapping;
    let mut prepared: Vec<ContentLink> = Vec::new();
    for draft in &drafts {
        let trimmed = draft.path.trim();
        if trimmed.is_empty() {
            continue;
        }
        let mut keys = draft.keys.clone().unwrap_or_else(|| fallback.clone());
        keys.normalize();
        let parse = keys::analyze_file(Path::new(trimmed), &keys);
        prepared.push(ContentLink::from_path(trimmed, keys, Some(parse)));
    }

    state.with_vault_mut(|vault| {
        let entry = vault.entry_mut(&entry_id)?;
        let mut added = 0usize;
        for link in prepared {
            if entry.links.iter().any(|existing| existing.path == link.path) {
                continue;
            }
            entry.links.push(link);
            added += 1;
        }
        if added == 0 && !drafts.is_empty() {
            return Err(AppError::Msg("所选文件已全部关联".to_string()));
        }
        entry.updated_at = now_string();
        Ok(entry.clone())
    })
}

#[tauri::command]
pub fn link_update_keys(
    state: State<'_, AppState>,
    entry_id: String,
    link_id: String,
    keys: KeyMapping,
) -> AppResult<Entry> {
    state.with_vault_mut(|vault| {
        let entry = vault.entry_mut(&entry_id)?;
        let link = entry
            .links
            .iter_mut()
            .find(|link| link.id == link_id)
            .ok_or_else(|| AppError::NotFound(format!("关联文件 {link_id}")))?;
        let mut keys = keys;
        keys.normalize();
        link.keys = keys;
        link.parse = Some(keys::analyze_file(Path::new(&link.path), &link.keys));
        link.refresh_stat();
        entry.updated_at = now_string();
        Ok(entry.clone())
    })
}

#[tauri::command]
pub fn link_reanalyze(
    state: State<'_, AppState>,
    entry_id: String,
    link_id: String,
) -> AppResult<Entry> {
    state.with_vault_mut(|vault| {
        let entry = vault.entry_mut(&entry_id)?;
        for link in entry.links.iter_mut() {
            if link.id == link_id {
                link.parse = Some(keys::analyze_file(Path::new(&link.path), &link.keys));
                link.refresh_stat();
            }
        }
        entry.updated_at = now_string();
        Ok(entry.clone())
    })
}

#[tauri::command]
pub fn link_remove(
    state: State<'_, AppState>,
    entry_id: String,
    link_id: String,
) -> AppResult<Entry> {
    state.with_vault_mut(|vault| {
        let entry = vault.entry_mut(&entry_id)?;
        let before = entry.links.len();
        entry.links.retain(|link| link.id != link_id);
        if entry.links.len() == before {
            return Err(AppError::NotFound(format!("关联文件 {link_id}")));
        }
        entry.updated_at = now_string();
        Ok(entry.clone())
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkPreview {
    pub path: String,
    pub exists: bool,
    pub size: u64,
    pub content: String,
    pub truncated: bool,
}

#[tauri::command]
pub fn link_preview(path: String, limit: Option<usize>) -> AppResult<LinkPreview> {
    let target = PathBuf::from(path.trim());
    let metadata = std::fs::metadata(&target)?;
    let limit = limit.unwrap_or(4000).clamp(200, 40_000);
    let bytes = std::fs::read(&target)?;
    let truncated = bytes.len() > limit;
    let slice = &bytes[..bytes.len().min(limit)];
    Ok(LinkPreview {
        path: target.to_string_lossy().to_string(),
        exists: true,
        size: metadata.len(),
        content: String::from_utf8_lossy(slice).to_string(),
        truncated,
    })
}

#[tauri::command]
pub fn open_in_explorer(path: String) -> AppResult<()> {
    let target = PathBuf::from(path.trim());
    if !target.exists() {
        return Err(AppError::NotFound(target.to_string_lossy().to_string()));
    }
    #[cfg(windows)]
    {
        if target.is_dir() {
            std::process::Command::new("explorer")
                .arg(target.as_os_str())
                .spawn()
                .map_err(|err| AppError::Msg(format!("无法打开资源管理器：{err}")))?;
        } else {
            let argument = format!("/select,{}", target.to_string_lossy());
            std::process::Command::new("explorer")
                .arg(argument)
                .spawn()
                .map_err(|err| AppError::Msg(format!("无法打开资源管理器：{err}")))?;
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = target;
        Err(AppError::Msg("仅支持 Windows".to_string()))
    }
}

#[tauri::command]
pub fn open_path(path: String) -> AppResult<()> {
    let target = PathBuf::from(path.trim());
    if !target.exists() {
        return Err(AppError::NotFound(target.to_string_lossy().to_string()));
    }
    #[cfg(windows)]
    {
        std::process::Command::new("explorer")
            .arg(target.as_os_str())
            .spawn()
            .map_err(|err| AppError::Msg(format!("无法打开：{err}")))?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = target;
        Err(AppError::Msg("仅支持 Windows".to_string()))
    }
}

// ---------------------------------------------------------------------------
// Sync targets
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn sync_presets() -> Vec<TemplatePreset> {
    sync::presets()
}

#[tauri::command]
pub fn sync_target_default(format: String) -> SyncTarget {
    sync::default_target(&format)
}

#[tauri::command]
pub fn sync_target_save(state: State<'_, AppState>, target: SyncTarget) -> AppResult<VaultView> {
    state.with_vault_mut(|vault| {
        let mut target = target;
        if target.id.trim().is_empty() {
            target.id = crate::model::new_id();
        }
        if target.name.trim().is_empty() {
            target.name = "未命名同步目标".to_string();
        }
        match vault
            .sync_targets
            .iter_mut()
            .find(|existing| existing.id == target.id)
        {
            Some(existing) => *existing = target,
            None => vault.sync_targets.push(target),
        }
        Ok(())
    })?;
    vault_view(state)
}

#[tauri::command]
pub fn sync_target_delete(state: State<'_, AppState>, id: String) -> AppResult<VaultView> {
    state.with_vault_mut(|vault| {
        let before = vault.sync_targets.len();
        vault.sync_targets.retain(|target| target.id != id);
        if vault.sync_targets.len() == before {
            return Err(AppError::NotFound(format!("同步目标 {id}")));
        }
        Ok(())
    })?;
    vault_view(state)
}

fn find_target(vault: &Vault, id: &str) -> AppResult<SyncTarget> {
    vault
        .sync_targets
        .iter()
        .find(|target| target.id == id)
        .cloned()
        .ok_or_else(|| AppError::NotFound(format!("同步目标 {id}")))
}

#[tauri::command]
pub fn sync_preview(state: State<'_, AppState>, id: String) -> AppResult<SyncOutcome> {
    state.touch();
    let settings = state.settings_snapshot();
    state.with_vault(|vault| {
        let target = find_target(vault, &id)?;
        sync::preview(vault, &target, &settings.sap_line_separator)
    })
}

#[tauri::command]
pub fn sync_preview_template(
    state: State<'_, AppState>,
    target: SyncTarget,
) -> AppResult<SyncOutcome> {
    let settings = state.settings_snapshot();
    state.with_vault(|vault| sync::preview(vault, &target, &settings.sap_line_separator))
}

#[tauri::command]
pub fn sync_run(app: AppHandle, state: State<'_, AppState>, id: String) -> AppResult<SyncOutcome> {
    let settings = state.settings_snapshot();
    let target = state.with_vault(|vault| find_target(vault, &id))?;
    let outcome =
        state.with_vault(|vault| sync::execute(vault, &target, &settings.sap_line_separator))?;
    let status = if outcome.changed {
        format!("已写入 {} 字节", outcome.bytes)
    } else {
        "内容未变化，跳过写入".to_string()
    };
    state.with_vault_mut(|vault| {
        if let Some(existing) = vault.sync_targets.iter_mut().find(|item| item.id == id) {
            existing.last_sync_at = Some(now_string());
            existing.last_status = Some(status);
        }
        Ok(())
    })?;
    notice(&app, "success", format!("已写入 {}", outcome.path));
    Ok(outcome)
}

#[tauri::command]
pub fn sync_run_all(app: AppHandle, state: State<'_, AppState>) -> AppResult<Vec<SyncOutcome>> {
    let settings = state.settings_snapshot();
    let targets: Vec<SyncTarget> = state.with_vault(|vault| {
        Ok(vault
            .sync_targets
            .iter()
            .filter(|target| target.enabled && !target.path.trim().is_empty())
            .cloned()
            .collect())
    })?;

    let mut outcomes = Vec::new();
    for target in targets {
        let result =
            state.with_vault(|vault| sync::execute(vault, &target, &settings.sap_line_separator));
        let (status, outcome) = match result {
            Ok(outcome) => (
                if outcome.changed {
                    format!("已写入 {} 字节", outcome.bytes)
                } else {
                    "内容未变化".to_string()
                },
                Some(outcome),
            ),
            Err(err) => (format!("失败：{err}"), None),
        };
        let id = target.id.clone();
        let _ = state.with_vault_mut(|vault| {
            if let Some(existing) = vault.sync_targets.iter_mut().find(|item| item.id == id) {
                existing.last_sync_at = Some(now_string());
                existing.last_status = Some(status);
            }
            Ok(())
        });
        if let Some(outcome) = outcome {
            outcomes.push(outcome);
        }
    }
    notice(&app, "success", format!("已同步 {} 个目标", outcomes.len()));
    Ok(outcomes)
}

// ---------------------------------------------------------------------------
// Tools & dialogs
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn generate_password(options: GeneratorOptions) -> AppResult<String> {
    crypto::generate_password(&options)
}

#[tauri::command]
pub fn check_password_strength(password: String) -> PasswordStrength {
    crypto::password_strength(&password)
}

#[tauri::command]
pub fn rule_default() -> PasswordRule {
    PasswordRule::default()
}

#[tauri::command]
pub fn generate_rule_password(rule: PasswordRule) -> AppResult<String> {
    rules::generate(&rule)
}

#[tauri::command]
pub fn validate_password(password: String, rule: PasswordRule) -> Vec<String> {
    rules::validate(&password, &rule)
}

#[tauri::command]
pub fn key_mapping_default() -> KeyMapping {
    KeyMapping::default()
}

async fn pick_files_inner() -> AppResult<Vec<String>> {
    tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("选择需要关联的文件")
            .pick_files()
            .unwrap_or_default()
            .into_iter()
            .map(|path| path.to_string_lossy().to_string())
            .collect::<Vec<String>>()
    })
    .await
    .map_err(|err| AppError::Msg(format!("文件选择失败：{err}")))
}

#[tauri::command]
pub async fn pick_files() -> AppResult<Vec<String>> {
    pick_files_inner().await
}

#[tauri::command]
pub async fn pick_folder(title: Option<String>) -> AppResult<Option<String>> {
    let label = title.unwrap_or_else(|| "选择目录".to_string());
    tauri::async_runtime::spawn_blocking(move || {
        rfd::FileDialog::new()
            .set_title(label)
            .pick_folder()
            .map(|path| path.to_string_lossy().to_string())
    })
    .await
    .map_err(|err| AppError::Msg(format!("目录选择失败：{err}")))
}

#[tauri::command]
pub async fn pick_save_file(
    default_name: Option<String>,
    extension: Option<String>,
) -> AppResult<Option<String>> {
    let name = default_name.unwrap_or_else(|| "sapvault-output.txt".to_string());
    tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = rfd::FileDialog::new().set_file_name(name);
        if let Some(extension) = extension {
            dialog = dialog.add_filter(extension.clone(), &[extension]);
        }
        dialog
            .save_file()
            .map(|path| path.to_string_lossy().to_string())
    })
    .await
    .map_err(|err| AppError::Msg(format!("保存对话框失败：{err}")))
}

#[tauri::command]
pub fn app_paths() -> serde_json::Value {
    serde_json::json!({
        "dataDir": store::data_dir().to_string_lossy(),
        "vaultPath": store::vault_path().to_string_lossy(),
        "settingsPath": store::settings_path().to_string_lossy(),
        "backupDir": store::backup_dir().to_string_lossy(),
        "portable": store::is_portable(),
        "landscapeDefaults": sap::default_landscape_paths(),
        "supportedFormats": ["json", ".env", "toml", "yaml", "xml", "text"],
    })
}

#[tauri::command]
pub fn app_quit(app: AppHandle) {
    app.exit(0);
}
