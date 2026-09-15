/**
 * Fixture bridge for UI audits in a plain browser.
 *
 * Replaces the Tauri IPC bridge with canned responses shaped exactly like the
 * real Rust payloads, so every view can be rendered and measured without
 * building the desktop app. Injected by tools/serve-ui.mjs before app.js.
 */
(() => {
  const parsedJson = {
    format: "json",
    fields: [
      { kind: "url", key: "url", path: "sap.production.url", value: "https://prd.sap.corp.example:8443", line: 4 },
      { kind: "username", key: "username", path: "sap.production.username", value: "JDOE", line: 5 },
      { kind: "password", key: "password", path: "sap.production.password", value: "Str0ng!Passw0rd", line: 6 },
    ],
    missing: [],
    analyzedAt: "2026-09-15T10:00:00+08:00",
    error: null,
  };

  const parsedEnv = {
    format: "env",
    fields: [
      { kind: "url", key: "SAP_URL", path: "SAP_URL", value: "https://dev.corp.example", line: 1 },
      { kind: "username", key: "SAP_USER", path: "SAP_USER", value: "JDOE", line: 2 },
    ],
    missing: ["password"],
    analyzedAt: "2026-09-15T10:00:00+08:00",
    error: null,
  };

  const keys = {
    url: ["url", "server", "host"],
    username: ["username", "user", "login"],
    password: ["password", "pwd", "secret"],
    ignoreCase: true,
    exact: false,
  };

  const makeLink = (id, label, parse) => ({
    id,
    path: `C:\\Users\\me\\AppData\\Roaming\\SapVault\\${label}`,
    label,
    addedAt: "2026-09-15T10:00:00+08:00",
    exists: true,
    size: 512,
    modifiedAt: "2026-09-14T09:00:00+08:00",
    keys: { ...keys },
    parse,
  });

  const entry = {
    id: "e1",
    title: "SAP 生产机",
    categoryId: "sap",
    username: "JDOE",
    useKnoxId: true,
    password: "Str0ng!Passw0rd",
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
      {
        id: "h2",
        password: "OldPassw0rd#2",
        recordedAt: "2026-06-01T09:00:00+08:00",
        note: "2026Q2 轮换",
        automatic: true,
      },
      {
        id: "h1",
        password: "OldPassw0rd#1",
        recordedAt: "2026-01-05T09:00:00+08:00",
        note: "",
        automatic: true,
      },
    ],
    links: [makeLink("l1", "sap-login.json", parsedJson), makeLink("l2", ".env", parsedEnv)],
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
    linkCount: 2,
    hasRule: true,
    ruleSummary: "10-40 位 / 小写+大写+数字",
    historyCycle: 5,
    historyCount: 2,
    primaryUrl: "https://prd.sap.corp.example:8443",
    updatedAt: "2026-09-15T10:00:00+08:00",
    lastUsedAt: null,
  };

  const syncTarget = {
    id: "s1",
    name: "MCP / JSON",
    kind: "mcp",
    path: "C:\\Users\\me\\AppData\\Roaming\\Claude\\claude_desktop_config.json",
    format: "mcpJson",
    enabled: true,
    template:
      '{\n  "sapVault": {\n    "knoxId": {{knoxId|json}},\n    "accounts": {{accountsJson}},\n    "contentFiles": {{filesJson}}\n  }\n}\n',
    includeFiles: true,
    backup: true,
    lastSyncAt: "2026-09-15T09:00:00+08:00",
    lastStatus: "已写入 1024 字节",
  };

  const vaultView = {
    knoxId: "KNOX01",
    categories: [
      { id: "sap", name: "SAP 账号", builtin: true, sort: 0 },
      { id: "general", name: "通用账号", builtin: true, sort: 1 },
      { id: "web", name: "内部系统", builtin: false, sort: 2 },
    ],
    entries: [summary],
    syncTargets: [syncTarget],
    associations: [
      {
        entryId: "e1",
        entryTitle: "SAP 生产机",
        username: "KNOX01",
        links: entry.links,
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
      presets: [
        { format: "mcpJson", label: "MCP / JSON", description: "标准 JSON", template: syncTarget.template },
        { format: "credentialsJson", label: "凭据清单 (JSON)", description: "扁平清单", template: "{}" },
        { format: "dotenv", label: ".env", description: "环境变量", template: "x" },
        { format: "toml", label: "TOML", description: "TOML", template: "x" },
        { format: "yaml", label: "YAML", description: "YAML", template: "x" },
        { format: "csv", label: "CSV", description: "CSV", template: "x" },
        { format: "plain", label: "纯文本", description: "文本", template: "x" },
      ],
      supportedFormats: ["JSON", ".env", "TOML", "YAML", "XML", "纯文本"],
      version: "0.1.0",
      startupError: null,
      settings,
    },
    vault_view: vaultView,
    entry_get: entry,
    sync_presets: [
      { format: "mcpJson", label: "MCP / JSON", description: "标准 JSON", template: syncTarget.template },
      { format: "plain", label: "纯文本", description: "文本", template: "x" },
    ],
    sync_preview: {
      targetId: "s1",
      path: syncTarget.path,
      bytes: 1024,
      accountCount: 1,
      fileCount: 2,
      backupPath: null,
      changed: true,
      content: '{\n  "sapVault": { "knoxId": "KNOX01" }\n}\n',
    },
    link_inspect: [
      {
        path: "C:\\Users\\me\\AppData\\Roaming\\SapVault\\sap-login.json",
        label: "sap-login.json",
        format: "json",
        supported: true,
        exists: true,
        size: 512,
        keys: { ...keys },
        parse: parsedJson,
      },
    ],
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
        if (command === "vault_unlock") return structuredClone(vaultView);
        if (command === "vault_view") return structuredClone(vaultView);
        if (command === "pick_files") return [];
        if (command === "open_in_explorer" || command === "open_path") return null;
        if (command in responses) return structuredClone(responses[command]);
        return null;
      },
    },
    event: { listen: async () => () => {} },
  };

  window.__FIXTURES__ = { entry, vaultView, settings, syncTarget };
})();
