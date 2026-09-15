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
  vaultImport: (path, password) => invoke("vault_import", { path, password }),

  knoxSet: (knoxId) => invoke("knox_set", { knoxId }),

  categoryCreate: (name) => invoke("category_create", { name }),
  categoryRename: (id, name) => invoke("category_rename", { id, name }),
  categoryDelete: (id) => invoke("category_delete", { id }),

  entryGet: (id) => invoke("entry_get", { id }),
  entrySave: (input) => invoke("entry_save", { input }),
  entryDelete: (id) => invoke("entry_delete", { id }),
  entryFavorite: (id) => invoke("entry_toggle_favorite", { id }),
  entrySummary: (id) => invoke("entry_summary", { id }),

  historyAdd: (entryId, password, note) => invoke("history_add", { entryId, password, note }),
  historyRemove: (entryId, historyId) => invoke("history_remove", { entryId, historyId }),
  historyClear: (entryId) => invoke("history_clear", { entryId }),

  copyPassword: (id) => invoke("copy_password", { id }),
  copyUsername: (id) => invoke("copy_username", { id }),
  copySap: (id) => invoke("copy_sap_credentials", { id }),
  copyText: (text, label) => invoke("copy_text", { text, label }),
  clipboardClear: () => invoke("clipboard_clear"),

  sapSystems: (refresh = false) => invoke("sap_systems", { refresh }),
  sapResolve: (systemId) => invoke("sap_resolve", { systemId }),
  sapDefaultPaths: () => invoke("sap_default_paths"),

  linkInspect: (paths, keys) => invoke("link_inspect", { paths, keys: keys ?? null }),
  linkAdd: (entryId, drafts) => invoke("link_add", { entryId, drafts }),
  linkUpdateKeys: (entryId, linkId, keys) =>
    invoke("link_update_keys", { entryId, linkId, keys }),
  linkReanalyze: (entryId, linkId) => invoke("link_reanalyze", { entryId, linkId }),
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
  ruleDefault: () => invoke("rule_default"),
  generateRulePassword: (rule) => invoke("generate_rule_password", { rule }),
  validatePassword: (password, rule) => invoke("validate_password", { password, rule }),
  keyMappingDefault: () => invoke("key_mapping_default"),

  pickFiles: () => invoke("pick_files"),
  pickFolder: (title) => invoke("pick_folder", { title }),
  pickSaveFile: (defaultName, extension) =>
    invoke("pick_save_file", { defaultName, extension }),
};

/** Normalizes an IPC rejection: validation errors arrive as a structured object,
 *  everything else as a plain string. */
export function describeError(error) {
  if (typeof error === "string") return { kind: "", message: error, details: [] };
  if (error && typeof error === "object") {
    return {
      kind: error.kind ?? "",
      message: error.message ?? JSON.stringify(error),
      details: Array.isArray(error.details) ? error.details : [],
    };
  }
  return { kind: "", message: String(error), details: [] };
}
