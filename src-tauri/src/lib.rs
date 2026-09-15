mod b64;
mod clipboard;
mod commands;
mod crypto;
mod error;
mod model;
mod sap;
mod scanner;
mod state;
mod store;
mod sync;

use std::time::Duration;

use tauri::{Emitter, Manager};

use crate::state::AppState;

/// How often the background guard checks whether the idle timer expired.
const AUTO_LOCK_TICK: Duration = Duration::from_secs(5);

pub fn run() {
    let settings = store::load_settings();
    let (envelope, startup_error) = match store::load_envelope() {
        Ok(envelope) => (envelope, None),
        Err(err) => {
            // A damaged vault must never look like "no vault yet", otherwise
            // creating a new one would silently overwrite the user's data.
            eprintln!("[SapVault] 读取保险库失败：{err}");
            (None, Some(err.to_string()))
        }
    };

    let state = AppState::new(settings, envelope, startup_error);

    tauri::Builder::default()
        .manage(state)
        .setup(|app| {
            let handle = app.handle().clone();
            std::thread::spawn(move || auto_lock_loop(handle));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_bootstrap,
            commands::app_paths,
            commands::app_quit,
            commands::settings_get,
            commands::settings_save,
            commands::vault_create,
            commands::vault_unlock,
            commands::vault_lock,
            commands::vault_view,
            commands::vault_status,
            commands::vault_change_password,
            commands::vault_backup_now,
            commands::vault_export,
            commands::vault_import,
            commands::knox_set,
            commands::category_create,
            commands::category_rename,
            commands::category_delete,
            commands::entry_get,
            commands::entry_save,
            commands::entry_delete,
            commands::entry_toggle_favorite,
            commands::entry_summary,
            commands::copy_password,
            commands::copy_username,
            commands::copy_sap_credentials,
            commands::clipboard_clear,
            commands::sap_systems,
            commands::sap_resolve,
            commands::sap_default_paths,
            commands::scan_run,
            commands::scan_cancel,
            commands::scan_attach,
            commands::link_add,
            commands::link_pick_and_add,
            commands::link_remove,
            commands::link_preview,
            commands::open_in_explorer,
            commands::open_path,
            commands::sync_presets,
            commands::sync_target_default,
            commands::sync_target_save,
            commands::sync_target_delete,
            commands::sync_preview,
            commands::sync_preview_template,
            commands::sync_run,
            commands::sync_run_all,
            commands::generate_password,
            commands::check_password_strength,
            commands::pick_files,
            commands::pick_folder,
            commands::pick_save_file,
        ])
        .run(tauri::generate_context!())
        .expect("SapVault 启动失败");
}

/// Locks the vault after the configured idle period. It lives in the backend so
/// a paused or hidden webview cannot keep secrets decrypted forever.
fn auto_lock_loop(handle: tauri::AppHandle) {
    loop {
        std::thread::sleep(AUTO_LOCK_TICK);
        let state = handle.state::<AppState>();
        if state.auto_lock_due() && state.lock() {
            let _ = handle.emit("vault:locked", true);
        }
    }
}
