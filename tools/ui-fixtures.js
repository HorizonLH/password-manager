/**
 * Fixture bridge for UI audits in a plain browser.
 *
 * Replaces the Tauri IPC bridge with canned responses shaped exactly like the
 * real Rust payloads, so every view can be rendered and measured without
 * building the desktop app. Injected by tools/serve-ui.mjs before app.js.
 */
(() => {
  const keys = {
    url: ["url", "server", "host"],
    username: ["username", "user", "login"],
    password: ["password", "pwd", "secret"],
    ignoreCase: true,
    exact: false,
  };

  const field = (kind, key, value, line) => ({
    kind,
    key,
    path: `sap.production.${key}`,
    value,
    line,
    location: { start: 10, end: 10 + value.length, quoted: true, xmlAttr: false, line },
  });

  const record = (id, path, url, username, password) => ({
    id,
    path,
    fields: [
      field("url", "url", url, 4),
      field("username", "username", username, 5),
      field("password", "password", password, 6),
    ],
  });

  const analysis = {
    format: "json",
    records: [record("r1", "sap.production", "https://prd.sap.corp.example:8443", "JDOE", "Str0ng!Passw0rd")],
    missing: [],
    analyzedAt: "2026-09-15T10:00:00+08:00",
    error: null,
  };

  const file = {
    id: "f1",
    path: "C:\\Users\\me\\AppData\\Roaming\\Claude\\sap-login.json",
    label: "sap-login.json",
    addedAt: "2026-09-15T10:00:00+08:00",
    exists: true,
    size: 512,
    modifiedAt: "2026-09-14T09:00:00+08:00",
    keys: { ...keys },
    analysis,
    entryIds: ["e1"],
    lastSyncAt: "2026-09-15T09:00:00+08:00",
    lastStatus: "已更新 1 处密码",
  };

  const plan = {
    fileId: "f1",
    path: file.path,
    label: file.label,
    format: "json",
    exists: true,
    records: [
      {
        recordId: "r1",
        path: "sap.production",
        url: "https://prd.sap.corp.example:8443",
        username: "JDOE",
        password: "Str0ng!Passw0rd",
        action: "update",
        accountId: "e1",
        accountTitle: "SAP 生产机",
        newPassword: "NewPassw0rd!",
        detail: "",
      },
    ],
    unmatched: [],
    updates: 1,
    status: "1 处将更新",
    error: null,
  };

  const entry = {
    id: "e1",
    title: "SAP 生产机",
    categoryId: "sap",
    username: "JDOE",
    useKnoxId: true,
    password: "NewPassw0rd!",
    matchUrl: "prd.sap.corp.example",
    notes: "每季度轮换，注意不要与最近 5 次重复。",
    favorite: true,
    rule: {
      enabled: true,
      description: "集团口令策略 2024",
      minLength: 10,
      maxLength: 40,
      lower: true,
      upper: true,
      digits: true,
      symbols: false,
      symbolsSet: "!@#$%^&*()-_=+[]{};:,.?",
      forbidden: "@",
      startWithLetter: true,
      avoidAmbiguous: false,
    },
    historyCycle: 5,
    passwordHistory: [
      { id: "h2", password: "OldPassw0rd#2", recordedAt: "2026-06-01T09:00:00+08:00", note: "2026Q2 轮换", automatic: true },
      { id: "h1", password: "OldPassw0rd#1", recordedAt: "2026-01-05T09:00:00+08:00", note: "", automatic: true },
    ],
    createdAt: "2026-01-01T00:00:00+08:00",
    updatedAt: "2026-09-15T10:00:00+08:00",
    lastUsedAt: "2026-09-15T09:30:00+08:00",
  };

  const summary = {
    id: "e1",
    title: "SAP 生产机",
    categoryId: "sap",
    username: "KNOX01",
    useKnoxId: true,
    hasPassword: true,
    favorite: true,
    matchUrl: "prd.sap.corp.example",
    fileCount: 1,
    hasRule: true,
    ruleSummary: "10-40 位 / 小写+大写+数字",
    historyCycle: 5,
    historyCount: 2,
    updatedAt: "2026-09-15T10:00:00+08:00",
    lastUsedAt: null,
  };

  const vaultView = {
    knoxId: "KNOX01",
    categories: [
      { id: "sap", name: "SAP 账号", builtin: true, sort: 0 },
      { id: "general", name: "通用账号", builtin: true, sort: 1 },
      { id: "web", name: "内部系统", builtin: false, sort: 2 },
    ],
    entries: [summary],
    files: [file],
    associations: [
      {
        entryId: "e1",
        entryTitle: "SAP 生产机",
        username: "KNOX01",
        matchUrl: "prd.sap.corp.example",
        files: [file],
      },
    ],
    updatedAt: "2026-09-15T10:00:00+08:00",
  };

  const settings = {
    theme: "system",
    clipboardClearSeconds: 30,
    autoLockMinutes: 10,
    lockOnSessionLock: true,
    sapLineSeparator: "\r\n",
    maskPasswords: true,
    confirmDelete: true,
    syncBackup: true,
    keyMapping: { ...keys },
    defaultRule: {
      enabled: true,
      description: "集团口令策略",
      minLength: 8,
      maxLength: 40,
      lower: true,
      upper: true,
      digits: true,
      symbols: false,
      symbolsSet: "!@#$%^&*()",
      forbidden: "",
      startWithLetter: false,
      avoidAmbiguous: false,
    },
    lastCategory: "sap",
  };

  const responses = {
    app_bootstrap: {
      hasVault: true,
      mode: "windows",
      hint: "",
      unlocked: false,
      dataDir: "C:\\Users\\me\\AppData\\Roaming\\SapVault",
      vaultPath: "C:\\Users\\me\\AppData\\Roaming\\SapVault\\vault.sapvault",
      portable: false,
      supportedFormats: ["JSON", ".env", "TOML", "YAML", "XML", "纯文本"],
      version: "0.1.0",
      startupError: null,
      settings,
    },
    vault_view: vaultView,
    entry_get: entry,
    file_inspect: [
      {
        path: file.path,
        label: file.label,
        format: "json",
        supported: true,
        exists: true,
        size: 512,
        keys: { ...keys },
        analysis,
      },
    ],
    file_plan: plan,
    file_plans: [plan],
    file_update_keys: vaultView,
    file_reanalyze: vaultView,
    file_bind: vaultView,
    file_add: vaultView,
    file_remove: vaultView,
    file_sync: {
      fileId: "f1",
      path: file.path,
      changed: true,
      updates: 1,
      bytes: 512,
      backupPath: null,
      status: "已更新 1 处密码",
    },
    file_sync_all: [],
    key_mapping_default: { ...keys },
    rule_default: settings.defaultRule,
    check_password_strength: { score: 4, label: "强", entropyBits: 96.2, suggestions: [] },
    validate_password: [],
    generate_rule_password: "Abcd1234XyZ",
    generate_password: "Abcd1234XyZ",
  };

  window.__TAURI__ = {
    core: {
      invoke: async (command) => {
        if (command === "vault_unlock" || command === "vault_view") {
          return structuredClone(vaultView);
        }
        if (command === "pick_files") return [];
        if (command === "open_in_explorer" || command === "open_path") return null;
        if (command in responses) return structuredClone(responses[command]);
        return null;
      },
    },
    event: { listen: async () => () => {} },
  };

  window.__FIXTURES__ = { entry, vaultView, settings, file, plan };
})();