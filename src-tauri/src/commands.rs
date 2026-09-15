use std::path::PathBuf;
use std::sync::atomic::Ordering;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::clipboard;
use crate::crypto::{self, GeneratorOptions, PasswordStrength};
use crate::error::{AppError, AppResult};
use crate::model::{
    now_string, Category, ContentLink, Entry, EntrySummary, LinkOrigin, SapAccount, ScanEvidence,
    SyncTarget, Vault, VaultView, DEFAULT_CATEGORY_ID, SAP_CATEGORY_ID,
};
use crate::sap::{self, LandscapeReport, SapSystem};
use crate::scanner::{self, ScanHit, ScanOptions, ScanReport};
use crate::state::{AppState, Unlocked};
use crate::store::{self, Settings, VaultMode};
use crate::sync::{self, SyncOutcome, TemplatePreset};

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanProgress {
    scanned: usize,
    path: String,
}

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
    pub landscape_defaults: Vec<String>,
    pub landscape_paths: Vec<String>,
    pub scan_root_default: String,
    pub presets: Vec<TemplatePreset>,
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
        landscape_defaults: sap::default_landscape_paths(),
        scan_root_default: scanner::default_scan_root(),
        presets: sync::presets(),
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
        "startupError": state.startup_error(),
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
        // Resolve host names from the landscape so scanning and sync always
        // agree with SAP GUI's own configuration.
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
    let saved = state.with_vault_mut(|vault| {
        // Validates the category and gives a clear error for a stale id.
        vault.category(&input.category_id)?;
        let mut updated: Entry;
        match id {
            Some(id) => {
                let entry = vault.entry_mut(&id)?;
                entry.title = title;
                entry.category_id = input.category_id.clone();
                entry.username = input.username.clone();
                entry.use_knox_id = input.use_knox_id;
                entry.password = input.password.clone();
                entry.url = input.url.clone();
                entry.notes = input.notes.clone();
                entry.favorite = input.favorite;
                // Moving out of the SAP category drops the SAP block, moving
                // into it (re)installs the one we just resolved.
                entry.sap = if is_sap { Some(sap_block.clone()) } else { None };
                entry.updated_at = now_string();
                updated = entry.clone();
            }
            None => {
                let entry = Entry {
                    id: crate::model::new_id(),
                    title,
                    category_id: input.category_id.clone(),
                    username: input.username.clone(),
                    use_knox_id: input.use_knox_id,
                    password: input.password.clone(),
                    url: input.url.clone(),
                    notes: input.notes.clone(),
                    favorite: input.favorite,
                    sap: if is_sap { Some(sap_block.clone()) } else { None },
                    links: Vec::new(),
                    created_at: now_string(),
                    updated_at: now_string(),
                    last_used_at: None,
                };
                vault.entries.push(entry.clone());
                updated = entry;
            }
        }
        let _ = &mut updated;
        Ok(updated)
    })?;
    Ok(saved)
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
    clipboard::schedule_auto_clear(
        text,
        settings.clipboard_clear_seconds as u64,
        move || {
            let _ = handle.emit(
                "app:notice",
                Notice {
                    kind: "info".to_string(),
                    message: "剪贴板已自动清空".to_string(),
                },
            );
        },
    );
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
// Scanning
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn scan_run(
    app: AppHandle,
    state: State<'_, AppState>,
    options: ScanOptions,
) -> AppResult<ScanReport> {
    if state.scan_running.swap(true, Ordering::SeqCst) {
        return Err(AppError::Msg("已有扫描任务在进行中".to_string()));
    }
    state.scan_cancel.store(false, Ordering::Relaxed);
    let cancel = state.scan_cancel.clone();

    let settings = state.settings_snapshot();
    let mut effective = options;
    if effective.roots.is_empty() {
        effective.roots = settings.scan_roots.clone();
    }
    effective.max_files = effective.max_files.max(1);
    effective
        .extra_skip_paths
        .push(store::data_dir().to_string_lossy().to_string());

    let progress_app = app.clone();
    let handle = tauri::async_runtime::spawn_blocking(move || {
        scanner::run_scan(&effective, &cancel, |scanned, path| {
            let _ = progress_app.emit(
                "scan:progress",
                ScanProgress {
                    scanned,
                    path: path.to_string(),
                },
            );
        })
    });

    let joined = handle
        .await
        .map_err(|err| AppError::Msg(format!("扫描任务异常结束：{err}")));
    state.scan_running.store(false, Ordering::SeqCst);
    let report = joined??;
    state.touch();
    notice(
        &app,
        "info",
        format!(
            "扫描完成：检查 {} 个文件，命中 {} 个",
            report.scanned_files,
            report.hits.len()
        ),
    );
    Ok(report)
}

#[tauri::command]
pub fn scan_cancel(state: State<'_, AppState>) {
    state.cancel_scan();
}

#[tauri::command]
pub fn scan_attach(
    state: State<'_, AppState>,
    entry_id: String,
    hits: Vec<ScanHit>,
    replace: Option<bool>,
) -> AppResult<Entry> {
    let replace = replace.unwrap_or(false);
    state.with_vault_mut(|vault| {
        let entry = vault.entry_mut(&entry_id)?;
        if replace {
            entry.links.retain(|link| link.origin != LinkOrigin::Scan);
        }
        for hit in &hits {
            if entry.links.iter().any(|link| link.path == hit.path) {
                continue;
            }
            let evidence = ScanEvidence {
                host: hit.matched_hosts.first().cloned().unwrap_or_default(),
                system_id: hit.matched_system_ids.first().cloned().unwrap_or_default(),
                username: hit.matched_usernames.first().cloned().unwrap_or_default(),
                matched: hit
                    .matched_hosts
                    .iter()
                    .chain(hit.matched_system_ids.iter())
                    .chain(hit.matched_usernames.iter())
                    .cloned()
                    .collect(),
                first_line: hit.first_line,
                excerpt: hit.excerpt.clone(),
            };
            entry.links.push(ContentLink::from_path(
                &hit.path,
                LinkOrigin::Scan,
                Some(evidence),
            ));
        }
        entry.updated_at = now_string();
        Ok(entry.clone())
    })
}

// ---------------------------------------------------------------------------
// Linked content files
// ---------------------------------------------------------------------------

fn attach_paths(entry: &mut Entry, paths: &[String]) -> usize {
    let mut added = 0usize;
    for path in paths {
        let trimmed = path.trim();
        if trimmed.is_empty() || entry.links.iter().any(|link| link.path == trimmed) {
            continue;
        }
        entry
            .links
            .push(ContentLink::from_path(trimmed, LinkOrigin::Manual, None));
        added += 1;
    }
    added
}

#[tauri::command]
pub fn link_add(
    state: State<'_, AppState>,
    entry_id: String,
    paths: Vec<String>,
) -> AppResult<Entry> {
    state.with_vault_mut(|vault| {
        let entry = vault.entry_mut(&entry_id)?;
        let added = attach_paths(entry, &paths);
        if added == 0 && !paths.is_empty() {
            return Err(AppError::Msg("所选文件已全部关联".to_string()));
        }
        entry.updated_at = now_string();
        Ok(entry.clone())
    })
}

#[tauri::command]
pub async fn link_pick_and_add(
    state: State<'_, AppState>,
    entry_id: String,
) -> AppResult<Option<Entry>> {
    let picked = pick_files_inner().await?;
    if picked.is_empty() {
        return Ok(None);
    }
    link_add(state, entry_id, picked).map(Some)
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
pub fn sync_run(state: State<'_, AppState>, id: String) -> AppResult<SyncOutcome> {
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
    Ok(outcome)
}

#[tauri::command]
pub fn sync_run_all(state: State<'_, AppState>) -> AppResult<Vec<SyncOutcome>> {
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
        "scanRootDefault": scanner::default_scan_root(),
        "landscapeDefaults": sap::default_landscape_paths(),
    })
}

#[tauri::command]
pub fn app_quit(app: AppHandle) {
    app.exit(0);
}
