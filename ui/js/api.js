/** Thin wrapper over Tauri's injected IPC bridge. The frontend is deliberately
 *  dependency-free, so commands are reached through the global bridge. */

function bridge() {
  const api = window.__TAURI__;
  if (!api || !api.core || !api.core.invoke) {
    throw new Error("Tauri IPC 不可用：请通过 SapVault 桌面应用启动");
  }
  return api;
}

export function invoke(command, args = {}) {
  return bridge().core.invoke(command, args);
}

export function listen(event, handler) {
  const api = bridge();
  if (!api.event || !api.event.listen) return Promise.resolve(() => {});
  return api.event.listen(event, handler);
}

export const api = {
  bootstrap: () => invoke("app_bootstrap"),
  paths: () => invoke("app_paths"),
  quit: () => invoke("app_quit"),

  settingsGet: () => invoke("settings_get"),
  settingsSave: (settings) => invoke("settings_save", { settings }),

  vaultCreate: (mode, password, hint) => invoke("vault_create", { mode, password, hint }),
  vaultUnlock: (password) => invoke("vault_unlock", { password }),
  vaultLock: () => invoke("vault_lock"),
  vaultView: () => invoke("vault_view"),
  vaultStatus: () => invoke("vault_status"),
  vaultChangePassword: (currentPassword, newPassword) =>
    invoke("vault_change_password", { currentPassword, newPassword }),
  vaultBackupNow: () => invoke("vault_backup_now"),
  vaultExport: (path) => invoke("vault_export", { path }),
  vaultImport: (path) => invoke("vault_import", { path }),

  knoxSet: (knoxId) => invoke("knox_set", { knoxId }),

  categoryCreate: (name) => invoke("category_create", { name }),
  categoryRename: (id, name) => invoke("category_rename", { id, name }),
  categoryDelete: (id) => invoke("category_delete", { id }),

  entryGet: (id) => invoke("entry_get", { id }),
  entrySave: (input) => invoke("entry_save", { input }),
  entryDelete: (id) => invoke("entry_delete", { id }),
  entryFavorite: (id) => invoke("entry_toggle_favorite", { id }),
  entrySummary: (id) => invoke("entry_summary", { id }),

  copyPassword: (id) => invoke("copy_password", { id }),
  copyUsername: (id) => invoke("copy_username", { id }),
  copySap: (id) => invoke("copy_sap_credentials", { id }),
  clipboardClear: () => invoke("clipboard_clear"),

  sapSystems: (refresh = false) => invoke("sap_systems", { refresh }),
  sapResolve: (systemId) => invoke("sap_resolve", { systemId }),
  sapDefaultPaths: () => invoke("sap_default_paths"),

  scanRun: (options) => invoke("scan_run", { options }),
  scanCancel: () => invoke("scan_cancel"),
  scanAttach: (entryId, hits, replace = false) =>
    invoke("scan_attach", { entryId, hits, replace }),

  linkAdd: (entryId, paths) => invoke("link_add", { entryId, paths }),
  linkPickAndAdd: (entryId) => invoke("link_pick_and_add", { entryId }),
  linkRemove: (entryId, linkId) => invoke("link_remove", { entryId, linkId }),
  linkPreview: (path, limit) => invoke("link_preview", { path, limit }),
  openInExplorer: (path) => invoke("open_in_explorer", { path }),
  openPath: (path) => invoke("open_path", { path }),

  syncPresets: () => invoke("sync_presets"),
  syncTargetDefault: (format) => invoke("sync_target_default", { format }),
  syncTargetSave: (target) => invoke("sync_target_save", { target }),
  syncTargetDelete: (id) => invoke("sync_target_delete", { id }),
  syncPreview: (id) => invoke("sync_preview", { id }),
  syncPreviewTemplate: (target) => invoke("sync_preview_template", { target }),
  syncRun: (id) => invoke("sync_run", { id }),
  syncRunAll: () => invoke("sync_run_all"),

  generatePassword: (options) => invoke("generate_password", { options }),
  strength: (password) => invoke("check_password_strength", { password }),

  pickFiles: () => invoke("pick_files"),
  pickFolder: (title) => invoke("pick_folder", { title }),
  pickSaveFile: (defaultName, extension) =>
    invoke("pick_save_file", { defaultName, extension }),
};
