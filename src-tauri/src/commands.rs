use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::clipboard;
use crate::crypto::{self, GeneratorOptions, PasswordStrength};
use crate::error::{AppError, AppResult};
use crate::keys;
use crate::model::{
    now_string, Category, Entry, EntrySummary, FileAnalysis, HistoryEntry, KeyMapping,
    PasswordRule, SapLaunch, SyncFile, Vault, VaultView, DEFAULT_CATEGORY_ID,
    MAX_PASSWORD_HISTORY, SAP_CATEGORY_ID,
};
use crate::rules;
use crate::saplogon::{self, Landscape};
use crate::sapgui::{self, LaunchOutcome};
use crate::state::{AppState, Unlocked};
use crate::store::{self, Settings, VaultMode};
use crate::sync::{self, FilePlan, SyncOutcome};

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
        settings,
        data_dir: store::data_dir().to_string_lossy().to_string(),
        vault_path: store::vault_path().to_string_lossy().to_string(),
        portable: store::is_portable(),
        supported_formats: keys::supported_labels(),
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
    pub notes: String,
    #[serde(default)]
    pub favorite: bool,
    /// `None` removes the rule from the entry.
    #[serde(default)]
    pub rule: Option<PasswordRule>,
    #[serde(default)]
    pub history_cycle: u32,
    /// Set by the UI after the user accepts a rule / cycle warning.
    #[serde(default)]
    pub force: bool,
    /// SAP GUI launch settings; `None` (or an empty value) clears them.
    #[serde(default)]
    pub sap: Option<SapLaunch>,
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
    let id = input.id.clone().filter(|value| !value.is_empty());
    let mut rule = input.rule.clone();
    if let Some(rule) = rule.as_mut() {
        rule.normalize();
    }
    let sap = input
        .sap
        .clone()
        .map(|mut sap| {
            sap.system_id = sap.system_id.trim().to_uppercase();
            sap.client = sap.client.trim().to_string();
            sap.language = sap.language.trim().to_uppercase();
            sap.guiparm = sap.guiparm.trim().to_string();
            sap.transaction = sap.transaction.trim().to_string();
            sap
        })
        .filter(|sap| !sap.is_empty());
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
                if previous != new_password && !previous.is_empty() {
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
                entry.notes = input.notes.clone();
                entry.favorite = input.favorite;
                entry.rule = rule.clone();
                entry.history_cycle = cycle;
                entry.sap = sap.clone();
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
                    notes: input.notes.clone(),
                    favorite: input.favorite,
                    rule,
                    history_cycle: cycle,
                    password_history: Vec::new(),
                    created_at: now_string(),
                    updated_at: now_string(),
                    last_used_at: None,
                    sap,
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
        Ok(EntrySummary::from(entry, vault))
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
// SAP GUI
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SapGuiStatus {
    /// `sapshcut.exe` we would start, when one was found.
    pub executable: Option<String>,
    /// Every path that was probed, so a failed detection can be explained.
    pub candidates: Vec<String>,
    pub landscape_files: Vec<String>,
    pub system_count: usize,
    pub password_mode: String,
    /// System IDs that SAP Logon knows more than once — those need the
    /// connection string to be pinned, otherwise the wrong system could open.
    pub duplicate_system_ids: Vec<String>,
}

/// The parsed SAP Logon configuration (cached; refreshed on demand).
#[tauri::command]
pub fn sap_landscape(state: State<'_, AppState>) -> Landscape {
    state.landscape()
}

#[tauri::command]
pub fn sap_refresh_landscape(state: State<'_, AppState>) -> Landscape {
    state.refresh_landscape()
}

#[tauri::command]
pub fn sap_gui_status(state: State<'_, AppState>) -> SapGuiStatus {
    let settings = state.settings_snapshot();
    let landscape = state.landscape();
    let mut ids: Vec<String> = landscape
        .systems
        .iter()
        .map(|system| system.system_id.clone())
        .filter(|id| !id.trim().is_empty())
        .collect();
    ids.sort();
    ids.dedup();
    let duplicate_system_ids: Vec<String> = ids
        .into_iter()
        .filter(|id| saplogon::count_system_id(&landscape.systems, id) > 1)
        .collect();
    SapGuiStatus {
        executable: sapgui::locate(&settings.sapshcut_path)
            .map(|path| path.to_string_lossy().to_string()),
        candidates: sapgui::candidate_paths()
            .into_iter()
            .map(|path| path.to_string_lossy().to_string())
            .collect(),
        landscape_files: landscape.files,
        system_count: landscape.systems.iter().filter(|s| s.is_launchable()).count(),
        password_mode: settings.sap_password_mode,
        duplicate_system_ids,
    }
}

/// Fills in whatever the account left open from the SAP Logon configuration.
fn enrich_from_landscape(state: &State<'_, AppState>, launch: &mut SapLaunch) {
    if !launch.guiparm.trim().is_empty() {
        return;
    }
    let landscape = state.landscape();
    let Some(system) = saplogon::find_system(&landscape.systems, &launch.service_uuid, &launch.system_id)
    else {
        return;
    };
    launch.guiparm = system.guiparm.clone();
    if launch.client.trim().is_empty() {
        launch.client = system.client.clone();
    }
    if launch.language.trim().is_empty() {
        launch.language = system.language.clone();
    }
}

fn launch_for(state: &State<'_, AppState>, id: &str) -> AppResult<(Entry, SapLaunch)> {
    let entry = state.with_vault(|vault| vault.entry(id).cloned())?;
    let mut launch = entry
        .sap
        .clone()
        .filter(SapLaunch::is_usable)
        .ok_or_else(|| AppError::Msg("这个条目还没有配置 SAP 登录信息".to_string()))?;
    enrich_from_landscape(state, &mut launch);
    Ok((entry, launch))
}

/// Starts SAP GUI for one account.
///
/// Two password paths, decided by `settings.sap_password_mode`:
/// * `commandLine` — pass `-pw=` to `sapshcut.exe` (one click, but the password
///   is visible in the process command line while SAP GUI starts).
/// * `clipboard` — hand `sapshcut.exe` the system, client, user and language but
///   no password, and put the password alone into the clipboard, so the login
///   prompt only needs one paste. This is the default.
#[tauri::command]
pub fn sap_launch(app: AppHandle, state: State<'_, AppState>, id: String) -> AppResult<LaunchOutcome> {
    state.touch();
    let settings = state.settings_snapshot();
    let (entry, launch) = launch_for(&state, &id)?;
    let executable = sapgui::locate(&settings.sapshcut_path).ok_or_else(|| {
        AppError::Msg(
            "没有找到 sapshcut.exe。请确认已安装 SAP GUI for Windows，或在设置里手动指定它的位置。"
                .to_string(),
        )
    })?;

    let username = entry.effective_username(&state.knox_id());
    // Anything that is not the explicit command-line mode behaves like the
    // clipboard mode, so an unknown value can never leak the password.
    let mode = if settings.sap_password_mode == sapgui::PASSWORD_MODE_COMMAND_LINE {
        sapgui::PASSWORD_MODE_COMMAND_LINE
    } else {
        sapgui::PASSWORD_MODE_CLIPBOARD
    };
    let command_line_mode = mode == sapgui::PASSWORD_MODE_COMMAND_LINE;
    let include_password = command_line_mode && !entry.password.is_empty();
    // The user name is always handed over; only the password depends on the mode.
    let arguments = sapgui::build_arguments(&launch, &username, &entry.password, include_password);
    sapgui::start(&executable, &arguments)?;

    let mut clipboard_seconds = 0;
    let mut message = if command_line_mode {
        "已启动 SAP GUI（密码随命令行传递）".to_string()
    } else {
        "已启动 SAP GUI，请在登录界面按 Ctrl+V 填入密码".to_string()
    };

    if !command_line_mode && !entry.password.is_empty() {
        // Only the password: SAP GUI already has the user name, and pasting a
        // two-line payload into a prefilled login screen would land both values
        // in the password field.
        clipboard::set_text(&entry.password)?;
        clipboard_seconds = settings.clipboard_clear_seconds;
        let handle = app.clone();
        clipboard::schedule_auto_clear(entry.password.clone(), clipboard_seconds as u64, move || {
            let _ = handle.emit(
                "app:notice",
                Notice {
                    kind: "info".to_string(),
                    message: "剪贴板已自动清空".to_string(),
                },
            );
        });
        message = "已启动 SAP GUI（用户名已填好），密码已复制，登录界面出现后按 Ctrl+V 即可".to_string();
    } else if !command_line_mode && entry.password.is_empty() {
        message = "已启动 SAP GUI（该条目没有保存密码）".to_string();
    }

    mark_used(&state, &id)?;

    Ok(LaunchOutcome {
        mode: mode.to_string(),
        executable: executable.to_string_lossy().to_string(),
        arguments: sapgui::mask_password(&arguments),
        password_on_command_line: include_password,
        clipboard_seconds,
        message,
    })
}

/// Writes a `.sap` shortcut for this account.
///
/// The file never contains the password — SAP GUI asks for it when the shortcut
/// is opened — and it carries no connection string either: SAP GUI resolves the
/// server from SAP Logon using the system ID, so the system has to be configured
/// there (which is exactly how a shortcut SAP GUI saves itself behaves).
/// `.sap` is the shortcut format of every SAP GUI above 6.20, and Windows
/// already knows it once `sapshcut -register` has run once.
#[tauri::command]
pub fn sap_export_shortcut(
    state: State<'_, AppState>,
    id: String,
    path: String,
) -> AppResult<String> {
    state.touch();
    let (entry, launch) = launch_for(&state, &id)?;
    let username = entry.effective_username(&state.knox_id());
    if launch.system_id.trim().is_empty() {
        return Err(AppError::Msg(
            ".sap 快捷方式是靠系统 ID 连接的，请先填写系统 ID（SAP Logon 里要有对应系统）".to_string(),
        ));
    }
    // `Description` is what SAP GUI shows for the connection; the name from SAP
    // Logon is the closest match we have.
    let landscape = state.landscape();
    let description = saplogon::find_system(&landscape.systems, &launch.service_uuid, &launch.system_id)
        .map(|system| system.name.clone())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| launch.system_id.trim().to_string());
    let work_dir = sapgui::default_work_dir()
        .map(|dir| {
            // SAP GUI creates this folder itself on first start; doing it here
            // keeps the shortcut valid on a freshly installed client.
            let _ = std::fs::create_dir_all(&dir);
            dir.to_string_lossy().to_string()
        })
        .unwrap_or_default();
    let mut target = PathBuf::from(path.trim());
    if target.as_os_str().is_empty() {
        return Err(AppError::Msg("请选择快捷方式的保存位置".to_string()));
    }
    if !target
        .extension()
        .map(|ext| ext.eq_ignore_ascii_case("sap"))
        .unwrap_or(false)
    {
        target.set_extension("sap");
    }
    sapgui::write_shortcut(
        &target,
        &sapgui::shortcut_text(&launch, &username, &description, &work_dir),
    )
}

// ---------------------------------------------------------------------------
// Content files
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDraft {
    pub path: String,
    /// Omit to use the global default key words.
    #[serde(default)]
    pub keys: Option<KeyMapping>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInspection {
    pub path: String,
    pub label: String,
    pub format: String,
    pub supported: bool,
    pub exists: bool,
    pub size: u64,
    pub keys: KeyMapping,
    pub analysis: FileAnalysis,
}

fn inspect_file(path: &str, keys: KeyMapping) -> FileInspection {
    let target = PathBuf::from(path.trim());
    let mut keys = keys;
    keys.normalize();
    let analysis = keys::analyze_file(&target, &keys);
    let metadata = std::fs::metadata(&target).ok();
    FileInspection {
        path: target.to_string_lossy().to_string(),
        label: target
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| path.to_string()),
        format: analysis.format.clone(),
        supported: keys::is_supported(&target),
        exists: metadata.is_some(),
        size: metadata.map(|meta| meta.len()).unwrap_or(0),
        keys,
        analysis,
    }
}

/// Parses files without storing them, so the UI can show what was found and ask
/// for different key words when a credential field is missing.
#[tauri::command]
pub fn file_inspect(
    state: State<'_, AppState>,
    paths: Vec<String>,
    keys: Option<KeyMapping>,
) -> AppResult<Vec<FileInspection>> {
    let mapping = keys.unwrap_or_else(|| state.settings_snapshot().key_mapping);
    Ok(paths
        .iter()
        .map(|path| inspect_file(path, mapping.clone()))
        .collect())
}

/// Stores uploaded files and binds them to the chosen accounts.
#[tauri::command]
pub fn file_add(state: State<'_, AppState>, drafts: Vec<FileDraft>) -> AppResult<VaultView> {
    let fallback = state.settings_snapshot().key_mapping;
    state.with_vault_mut(|vault| {
        for draft in &drafts {
            let trimmed = draft.path.trim();
            if trimmed.is_empty() {
                continue;
            }
            let mut keys = draft.keys.clone().unwrap_or_else(|| fallback.clone());
            keys.normalize();

            // A path may already be registered; then only its parse is refreshed.
            if let Some(existing) = vault
                .files
                .iter_mut()
                .find(|file| file.path.eq_ignore_ascii_case(trimmed))
            {
                let analysis = keys::analyze_file(Path::new(trimmed), &keys);
                existing.keys = keys;
                existing.analysis = Some(analysis);
                existing.refresh_stat();
                continue;
            }

            let analysis = keys::analyze_file(Path::new(trimmed), &keys);
            let file = SyncFile::from_path(trimmed, keys, Some(analysis));
            vault.files.push(file);
        }
        Ok(())
    })?;
    vault_view(state)
}

#[tauri::command]
pub fn file_update_keys(
    state: State<'_, AppState>,
    file_id: String,
    keys: KeyMapping,
) -> AppResult<VaultView> {
    state.with_vault_mut(|vault| {
        let file = vault.file_mut(&file_id)?;
        let mut keys = keys;
        keys.normalize();
        file.keys = keys;
        file.analysis = Some(keys::analyze_file(Path::new(&file.path), &file.keys));
        file.refresh_stat();
        Ok(())
    })?;
    vault_view(state)
}

#[tauri::command]
pub fn file_reanalyze(state: State<'_, AppState>, file_id: String) -> AppResult<VaultView> {
    state.with_vault_mut(|vault| {
        let file = vault.file_mut(&file_id)?;
        file.analysis = Some(keys::analyze_file(Path::new(&file.path), &file.keys));
        file.refresh_stat();
        Ok(())
    })?;
    vault_view(state)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BindingInput {
    pub key_path: String,
    pub entry_id: String,
}

/// Replaces the `(file, key) → account` bindings of one file. The key path is
/// what sync writes to, so a file can serve several accounts unambiguously.
#[tauri::command]
pub fn file_bind(
    state: State<'_, AppState>,
    file_id: String,
    bindings: Vec<BindingInput>,
) -> AppResult<VaultView> {
    state.with_vault_mut(|vault| {
        let known: Vec<String> = vault.entries.iter().map(|entry| entry.id.clone()).collect();
        let file = vault.file_mut(&file_id)?;
        let mut next: Vec<crate::model::FileBinding> = Vec::new();
        for input in bindings {
            let key = input.key_path.trim();
            if key.is_empty() || !known.contains(&input.entry_id) {
                continue;
            }
            if file
                .analysis
                .as_ref()
                .map(|analysis| analysis.value(key).is_none())
                .unwrap_or(true)
            {
                continue;
            }
            if next
                .iter()
                .any(|binding| binding.key_path == key && binding.entry_id == input.entry_id)
            {
                continue;
            }
            let existing = file
                .bindings
                .iter()
                .find(|binding| binding.key_path == key && binding.entry_id == input.entry_id);
            next.push(match existing {
                Some(binding) => binding.clone(),
                None => crate::model::FileBinding::new(key, &input.entry_id),
            });
        }
        file.bindings = next;
        Ok(())
    })?;
    vault_view(state)
}

#[tauri::command]
pub fn file_remove(state: State<'_, AppState>, file_id: String) -> AppResult<VaultView> {
    state.with_vault_mut(|vault| {
        let before = vault.files.len();
        vault.files.retain(|file| file.id != file_id);
        if vault.files.len() == before {
            return Err(AppError::NotFound(format!("同步文件 {file_id}")));
        }
        Ok(())
    })?;
    vault_view(state)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePreview {
    pub path: String,
    pub exists: bool,
    pub size: u64,
    pub content: String,
    pub truncated: bool,
}

#[tauri::command]
pub fn file_preview(path: String, limit: Option<usize>) -> AppResult<FilePreview> {
    let target = PathBuf::from(path.trim());
    let metadata = std::fs::metadata(&target)?;
    let limit = limit.unwrap_or(4000).clamp(200, 40_000);
    let bytes = std::fs::read(&target)?;
    let truncated = bytes.len() > limit;
    let slice = &bytes[..bytes.len().min(limit)];
    Ok(FilePreview {
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

/// Opens a link from a note with the system's default handler.
///
/// Only `http`, `https` and `mailto` are accepted: a note is user text, and it
/// must never be able to launch an arbitrary command through the shell. The
/// value is passed as a single argument to `rundll32 url.dll,FileProtocolHandler`
/// (no shell), which is the documented way to reach the default browser.
#[tauri::command]
pub fn open_link(url: String) -> AppResult<()> {
    let trimmed = url.trim();
    let lower = trimmed.to_ascii_lowercase();
    let allowed = lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("mailto:");
    if !allowed || trimmed.chars().any(|ch| ch.is_control()) {
        return Err(AppError::Msg(
            "只支持 http / https / mailto 链接".to_string(),
        ));
    }
    #[cfg(windows)]
    {
        std::process::Command::new("rundll32.exe")
            .arg("url.dll,FileProtocolHandler")
            .arg(trimmed)
            .spawn()
            .map_err(|err| AppError::Msg(format!("无法打开链接：{err}")))?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = trimmed;
        Err(AppError::Msg("仅支持 Windows".to_string()))
    }
}

// ---------------------------------------------------------------------------
// Sync targets
// ---------------------------------------------------------------------------

/// What syncing would change in one file (no writes).
#[tauri::command]
pub fn file_plan(state: State<'_, AppState>, file_id: String) -> AppResult<FilePlan> {
    state.touch();
    state.with_vault(|vault| {
        let file = vault.file(&file_id)?.clone();
        Ok(sync::plan_file(vault, &file))
    })
}

#[tauri::command]
pub fn file_plans(state: State<'_, AppState>) -> AppResult<Vec<FilePlan>> {
    state.touch();
    state.with_vault(|vault| Ok(sync::plan_all(vault)))
}

/// Writes the password of every bound account back into the file, in place.
#[tauri::command]
pub fn file_sync(
    app: AppHandle,
    state: State<'_, AppState>,
    file_id: String,
) -> AppResult<SyncOutcome> {
    state.touch();
    let outcome = state.with_vault(|vault| {
        let file = vault.file(&file_id)?.clone();
        sync::sync_file(vault, &file)
    })?;
    state.with_vault_mut(|vault| {
        if let Some(file) = vault.files.iter_mut().find(|file| file.id == file_id) {
            sync::stamp(file, &outcome);
        }
        Ok(())
    })?;
    notice(&app, "success", format!("{}：{}", outcome.path, outcome.status));
    Ok(outcome)
}

#[tauri::command]
pub fn file_sync_all(app: AppHandle, state: State<'_, AppState>) -> AppResult<Vec<SyncOutcome>> {
    let ids: Vec<String> =
        state.with_vault(|vault| Ok(vault.files.iter().map(|file| file.id.clone()).collect()))?;
    let mut outcomes: Vec<SyncOutcome> = Vec::new();
    for id in ids {
        let result = state.with_vault(|vault| {
            let file = vault.file(&id)?.clone();
            sync::sync_file(vault, &file)
        });
        match result {
            Ok(outcome) => {
                state.with_vault_mut(|vault| {
                    if let Some(file) = vault.files.iter_mut().find(|file| file.id == id) {
                        sync::stamp(file, &outcome);
                    }
                    Ok(())
                })?;
                outcomes.push(outcome);
            }
            Err(err) => {
                state.with_vault_mut(|vault| {
                    if let Some(file) = vault.files.iter_mut().find(|file| file.id == id) {
                        file.last_sync_at = Some(now_string());
                        file.last_status = Some(format!("失败：{err}"));
                        // The file may have been changed by another program.
                        sync::reanalyze(file);
                    }
                    Ok(())
                })?;
            }
        }
    }
    let updated: usize = outcomes.iter().map(|outcome| outcome.updates).sum();
    notice(
        &app,
        "success",
        format!(
            "同步完成：{} 个文件，共更新 {} 处密码",
            outcomes.len(),
            updated
        ),
    );
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
        "supportedFormats": ["json", ".env", "toml", "yaml", "xml", "text"],
    })
}

#[tauri::command]
pub fn app_quit(app: AppHandle) {
    app.exit(0);
}
