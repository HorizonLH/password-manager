/**
 * Fixture bridge for UI audits in a plain browser.
 *
 * Replaces the Tauri IPC bridge with canned responses shaped exactly like the
 * real Rust payloads, so every view can be rendered and measured without
 * building the desktop app. Injected by tools/serve-ui.mjs before app.js.
 *
 * The payload mirrors the current model: a file is parsed into `analysis.values`
 * (one entry per key, with the byte range used for in-place editing) and the
 * only relationship is `(file, key path) → account`.
 */
(() => {
  const keys = {
    password: ["password", "passwd", "pwd", "pass", "secret", "passwort", "kennwort", "token"],
    ignoreCase: true,
    exact: false,
  };

  const value = (path, text, line, passwordCandidate = false) => ({
    key: path.split(".").pop(),
    path,
    parent: path.split(".").slice(0, -1).join("."),
    value: text,
    line,
    location: { start: 100 + line, end: 100 + line + text.length, quoted: true, xmlAttr: false, line },
    passwordCandidate,
  });

  const jsonAnalysis = {
    format: "json",
    values: [
      value("provider", "claude-desktop", 2),
      value("sap.production.url", "https://prd.sap.corp.example:8443", 4),
      value("sap.production.username", "JDOE", 5),
      value("sap.production.password", "Str0ng!Passw0rd", 6, true),
      value("sap.test.url", "https://qa.sap.corp.example:8443", 9),
      value("sap.test.username", "QTEST", 10),
      value("sap.test.password", "QaPassw0rd", 11, true),
    ],
    analyzedAt: "2026-09-15T10:00:00+08:00",
    error: null,
  };

  const envAnalysis = {
    format: "env",
    values: [
      value("SAP_PRD_URL", "https://prd.sap.corp.example:8443", 2),
      value("SAP_PRD_USER", "JDOE", 3),
      value("SAP_PRD_PASSWORD", "NewPassw0rd!", 4, true),
    ],
    analyzedAt: "2026-09-15T10:00:00+08:00",
    error: null,
  };

  const jsonFile = {
    id: "f1",
    path: "C:\\Users\\me\\Documents\\mcp\\sap-login.json",
    label: "sap-login.json",
    addedAt: "2026-09-15T10:00:00+08:00",
    exists: true,
    size: 512,
    modifiedAt: "2026-09-14T09:00:00+08:00",
    keys: { ...keys },
    analysis: jsonAnalysis,
    bindings: [
      { id: "b1", keyPath: "sap.production.password", entryId: "e1" },
      { id: "b3", keyPath: "sap.test.password", entryId: "e2" },
    ],
    lastSyncAt: "2026-09-15T09:00:00+08:00",
    lastStatus: "已更新 1 处密码",
  };

  const envFile = {
    id: "f2",
    path: "C:\\Users\\me\\Documents\\mcp\\.env",
    label: ".env",
    addedAt: "2026-09-14T10:00:00+08:00",
    exists: true,
    size: 180,
    modifiedAt: "2026-09-13T09:00:00+08:00",
    keys: { ...keys },
    analysis: envAnalysis,
    bindings: [
      { id: "b2", keyPath: "SAP_PRD_PASSWORD", entryId: "e1" },
      { id: "b4", keyPath: "SAP_OLD_PASSWORD", entryId: "e1" },
    ],
    lastSyncAt: null,
    lastStatus: null,
  };

  const planRow = (over) => ({
    bindingId: "",
    keyPath: "",
    keyLabel: "",
    fileValue: "",
    action: "update",
    accountId: "e1",
    accountTitle: "SAP 生产机",
    newPassword: null,
    detail: "",
    ...over,
  });

  const jsonPlan = {
    fileId: "f1",
    path: jsonFile.path,
    label: jsonFile.label,
    format: "json",
    exists: true,
    rows: [
      planRow({
        bindingId: "b1",
        keyPath: "sap.production.password",
        keyLabel: "password",
        fileValue: "Str0ng!Passw0rd",
        action: "update",
        newPassword: "NewPassw0rd!",
      }),
      planRow({
        bindingId: "b3",
        keyPath: "sap.test.password",
        keyLabel: "password",
        fileValue: "QaPassw0rd",
        action: "same",
        accountId: "e2",
        accountTitle: "SAP 测试机",
        newPassword: "QaPassw0rd",
        detail: "文件里的密码已是最新",
      }),
    ],
    updates: 1,
    status: "1 处将更新",
    error: null,
  };

  const envPlan = {
    fileId: "f2",
    path: envFile.path,
    label: envFile.label,
    format: "env",
    exists: true,
    rows: [
      planRow({
        bindingId: "b2",
        keyPath: "SAP_PRD_PASSWORD",
        keyLabel: "SAP_PRD_PASSWORD",
        fileValue: "NewPassw0rd!",
        action: "same",
        newPassword: "NewPassw0rd!",
        detail: "文件里的密码已是最新",
      }),
      planRow({
        bindingId: "b4",
        keyPath: "SAP_OLD_PASSWORD",
        keyLabel: "SAP_OLD_PASSWORD",
        action: "missing-key",
        detail: "文件里已经没有这个键了",
      }),
    ],
    updates: 0,
    status: "有绑定失效",
    error: null,
  };

  const entry = {
    id: "e1",
    title: "SAP 生产机",
    categoryId: "sap",
    username: "JDOE",
    useKnoxId: true,
    password: "NewPassw0rd!",
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
    createdAt: "2026-01-01T00:00:00+08:00",
    updatedAt: "2026-09-15T10:00:00+08:00",
    lastUsedAt: "2026-09-15T09:30:00+08:00",
    sap: {
      systemId: "PRD",
      client: "100",
      language: "ZH",
      guiparm: "/H/sap-prd.example.com/S/3200",
      serviceUuid: "s-prd",
      transaction: "SE80",
      maximize: true,
    },
  };

  const summary = {
    id: "e1",
    title: "SAP 生产机",
    categoryId: "sap",
    username: "KNOX01",
    notes: "每季度轮换，注意不要与最近 5 次重复。",
    useKnoxId: true,
    hasPassword: true,
    favorite: true,
    fileCount: 2,
    keyCount: 3,
    hasRule: true,
    ruleSummary: "10-40 位 / 小写+大写+数字",
    historyCycle: 5,
    historyCount: 2,
    updatedAt: "2026-09-15T10:00:00+08:00",
    lastUsedAt: null,
    hasSapLogin: true,
  };

  const testSummary = {
    id: "e2",
    title: "SAP 测试机",
    categoryId: "sap",
    username: "QTEST",
    notes: "测试环境专用账号，仅内部使用。",
    useKnoxId: false,

    hasPassword: true,
    favorite: false,
    fileCount: 1,
    keyCount: 1,
    hasRule: false,
    ruleSummary: "未设置规则",
    historyCycle: 0,
    historyCount: 0,
    updatedAt: "2026-08-01T10:00:00+08:00",
    lastUsedAt: null,
    hasSapLogin: false,
  };

  const binding = (over) => ({
    bindingId: "",
    fileId: "",
    filePath: "",
    fileLabel: "",
    fileExists: true,
    format: "json",
    keyPath: "",
    value: "",
    passwordCandidate: true,
    ...over,
  });

  const vaultView = {
    knoxId: "KNOX01",
    categories: [
      { id: "sap", name: "SAP 账号", builtin: true, sort: 0 },
      { id: "general", name: "通用账号", builtin: true, sort: 1 },
      { id: "web", name: "内部系统", builtin: false, sort: 2 },
    ],
    entries: [summary, testSummary],
    files: [jsonFile, envFile],
    associations: [
      {
        entryId: "e1",
        entryTitle: "SAP 生产机",
        username: "KNOX01",
        bindings: [
          binding({
            bindingId: "b1",
            fileId: "f1",
            filePath: jsonFile.path,
            fileLabel: jsonFile.label,
            keyPath: "sap.production.password",
            value: "Str0ng!Passw0rd",
          }),
          binding({
            bindingId: "b2",
            fileId: "f2",
            filePath: envFile.path,
            fileLabel: envFile.label,
            format: "env",
            keyPath: "SAP_PRD_PASSWORD",
            value: "NewPassw0rd!",
          }),
          binding({
            bindingId: "b4",
            fileId: "f2",
            filePath: envFile.path,
            fileLabel: envFile.label,
            format: "env",
            keyPath: "SAP_OLD_PASSWORD",
            value: "",
          }),
        ],
      },
      {
        entryId: "e2",
        entryTitle: "SAP 测试机",
        username: "QTEST",
        bindings: [
          binding({
            bindingId: "b3",
            fileId: "f1",
            filePath: jsonFile.path,
            fileLabel: jsonFile.label,
            keyPath: "sap.test.password",
            value: "QaPassw0rd",
          }),
        ],
      },
    ],
    updatedAt: "2026-09-15T10:00:00+08:00",
  };

  const supportedFormats = [
    "JSON (.json)",
    ".env",
    "TOML / INI / properties (.toml .ini .conf .cfg .properties .tfvars)",
    "YAML (.yaml .yml)",
    "XML (.xml .config .plist .resx)",
  ];

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
    sapPasswordMode: "clipboard",
    sapshcutPath: "",
    sapLandscapePaths: [],
  };

  const paths = {
    dataDir: "C:\\Users\\me\\AppData\\Roaming\\SapVault",
    vaultPath: "C:\\Users\\me\\AppData\\Roaming\\SapVault\\vault.sapvault",
    supportedFormats,
  };

  const inspect = (file) => ({
    path: file.path,
    label: file.label,
    format: file.analysis.format,
    supported: true,
    exists: true,
    size: file.size,
    keys: { ...keys },
    analysis: file.analysis,
  });

  /** Mirrors `SAPUILandscape.xml`: one custom application server, one logon
   *  group, one repeated system ID and one Fiori entry. */
  const landscape = {
    files: ["C:\\Users\\me\\AppData\\Roaming\\SAP\\Common\\SAPUILandscape.xml"],
    warnings: [],
    systems: [
      {
        serviceUuid: "s-prd",
        name: "PRD 生产机",
        systemId: "PRD",
        entryType: "SAPGUI",
        kind: "applicationServer",
        server: "sap-prd.example.com:3200",
        host: "sap-prd.example.com",
        port: "3200",
        instance: "00",
        messageServer: "",
        messageServerPort: "",
        group: "",
        router: "",
        url: "",
        guiparm: "/H/sap-prd.example.com/S/3200",
        workspace: "生产系统",
        sourceFile: "C:\\Users\\me\\AppData\\Roaming\\SAP\\Common\\SAPUILandscape.xml",
        client: "",
        language: "",
        user: "",
      },
      {
        serviceUuid: "s-p20",
        name: "P20 登录组",
        systemId: "P20",
        entryType: "SAPGUI",
        kind: "serverGroup",
        server: "SPACE",
        host: "sapms.example.com",
        port: "3600",
        instance: "",
        messageServer: "sapms.example.com",
        messageServerPort: "3600",
        group: "SPACE",
        router: "",
        url: "",
        guiparm: "/R/P20/G/SPACE",
        workspace: "",
        sourceFile: "C:\\Users\\me\\AppData\\Roaming\\SAP\\Common\\SAPUILandscape.xml",
        client: "",
        language: "",
        user: "",
      },
      {
        serviceUuid: "s-prd-2",
        name: "PRD 备用入口",
        systemId: "PRD",
        entryType: "SAPGUI",
        kind: "applicationServer",
        server: "10.1.101.82:3200",
        host: "10.1.101.82",
        port: "3200",
        instance: "00",
        messageServer: "",
        messageServerPort: "",
        group: "",
        router: "",
        url: "",
        guiparm: "/H/10.1.101.82/S/3200",
        workspace: "",
        sourceFile: "C:\\Users\\me\\AppData\\Roaming\\SAP\\Common\\SAPUILandscape.xml",
        client: "",
        language: "",
        user: "",
      },
      {
        serviceUuid: "s-fiori",
        name: "Fiori 门户",
        systemId: "",
        entryType: "FIORI",
        kind: "web",
        server: "",
        host: "fiori.example.com",
        port: "",
        instance: "",
        messageServer: "",
        messageServerPort: "",
        group: "",
        router: "",
        url: "https://fiori.example.com/sap/bc/ui5_ui5",
        guiparm: "",
        workspace: "",
        sourceFile: "C:\\Users\\me\\AppData\\Roaming\\SAP\\Common\\SAPUILandscape.xml",
        client: "",
        language: "",
        user: "",
      },
    ],
  };

  const guiStatus = {
    executable: "C:\\Program Files (x86)\\SAP\\FrontEnd\\SAPGUI\\sapshcut.exe",
    candidates: ["C:\\Program Files (x86)\\SAP\\FrontEnd\\SAPGUI\\sapshcut.exe"],
    landscapeFiles: landscape.files,
    systemCount: 3,
    passwordMode: "clipboard",
    duplicateSystemIds: ["PRD"],
  };

  const responses = {
    app_bootstrap: {
      hasVault: true,
      mode: "windows",
      hint: "",
      unlocked: false,
      dataDir: paths.dataDir,
      vaultPath: paths.vaultPath,
      portable: false,
      supportedFormats,
      version: "1.0.1",

      startupError: null,
      settings,
    },
    app_paths: paths,
    vault_view: vaultView,
    entry_get: entry,
    entry_summary: summary,
    file_plan: jsonPlan,
    file_plans: [jsonPlan, envPlan],
    file_preview: {
      path: jsonFile.path,
      content: '{\n  "sap": {\n    "production": {\n      "password": "Str0ng!Passw0rd"\n    }\n  }\n}',
      truncated: false,
      size: 512,
    },
    file_update_keys: vaultView,
    file_reanalyze: vaultView,
    file_bind: vaultView,
    file_add: vaultView,
    file_remove: vaultView,
    file_sync: {
      fileId: "f1",
      path: jsonFile.path,
      changed: true,
      updates: 1,
      bytes: 512,
      status: "已更新 1 处密码",
    },
    file_sync_all: [
      {
        fileId: "f1",
        path: jsonFile.path,
        changed: true,
        updates: 1,
        bytes: 512,
        status: "已更新 1 处密码",
      },
    ],
    key_mapping_default: { ...keys },
    rule_default: settings.defaultRule,
    sap_landscape: landscape,
    sap_refresh_landscape: landscape,
    sap_gui_status: guiStatus,
    sap_launch: {
      mode: "clipboard",
      executable: guiStatus.executable,
      arguments: ["-system=PRD", "-client=100", "-guiparm=/H/sap-prd.example.com/S/3200"],
      passwordOnCommandLine: false,
      clipboardSeconds: 30,
      message: "已启动 SAP GUI（用户名已填好），密码已复制，登录界面出现后按 Ctrl+V 即可",
    },
    sap_export_shortcut: "C:\\Users\\me\\Desktop\\PRD.sap",
    check_password_strength: { score: 4, label: "强", entropyBits: 96.2, suggestions: [] },
    validate_password: [],
    generate_rule_password: "Abcd1234XyZ",
    generate_password: "Abcd1234XyZ",
  };

  /** Models what the backend does on sync: the file now contains the account
   *  password, so the re-analysis shows the new value and the plan says "same". */
  const syncOnce = (fileId) => {
    const file = fileId === envFile.id ? envFile : jsonFile;
    const plan = fileId === envFile.id ? envPlan : jsonPlan;
    let updates = 0;
    for (const row of plan.rows) {
      if (row.action !== "update") continue;
      const value = file.analysis.values.find((item) => item.path === row.keyPath);
      if (value && row.newPassword) value.value = row.newPassword;
      row.action = "same";
      row.fileValue = row.newPassword ?? row.fileValue;
      row.newPassword = row.fileValue;
      row.detail = "文件里的密码已是最新";
      updates += 1;
    }
    plan.updates = 0;
    plan.status = "已是最新";
    file.analysis.analyzedAt = "2026-09-15T12:00:00+08:00";
    file.lastSyncAt = "2026-09-15T12:00:00+08:00";
    file.lastStatus = updates ? `已更新 ${updates} 处密码` : "已是最新";
    return updates;
  };

  /** Minimal event bus, so the audit can replay window events (drag & drop,
   *  vault:locked) exactly the way the Tauri backend emits them. */
  const listeners = new Map();
  const listen = (event, handler) => {
    const set = listeners.get(event) ?? new Set();
    set.add(handler);
    listeners.set(event, set);
    return () => set.delete(handler);
  };
  const emit = (event, payload) => {
    for (const handler of listeners.get(event) ?? []) handler({ event, id: 0, payload });
  };

  window.__TAURI__ = {
    core: {
      invoke: async (command, args) => {
        if (command === "vault_unlock" || command === "vault_view") {
          return structuredClone(vaultView);
        }
        if (command === "file_sync") {
          const updates = syncOnce(args?.fileId ?? jsonFile.id);
          return {
            fileId: jsonFile.id,
            path: jsonFile.path,
            changed: updates > 0,
            updates,
            bytes: jsonFile.size,
            status: updates ? `已更新 ${updates} 处密码` : "已是最新，未写入",
          };
        }
        if (command === "file_sync_all") return [];
        if (command === "file_plan") {
          const wanted = args?.fileId;
          const plan = wanted === envFile.id ? envPlan : jsonPlan;
          return structuredClone(plan);
        }
        if (command === "file_inspect") {
          const wanted = args?.paths ?? [];
          return wanted.map((path) =>
            structuredClone(
              inspect(
                [jsonFile, envFile].find((file) => file.path === path) ??
                  { ...jsonFile, path, label: path.split("\\").pop() },
              ),
            ),
          );
        }
        if (command === "entry_toggle_favorite") {
          const target =
            [summary, testSummary].find((item) => item.id === args?.id) ?? summary;
          target.favorite = !target.favorite;
          return structuredClone(vaultView);
        }
        if (command === "entry_save") {
          const input = args?.input ?? {};
          if (input.title) {
            entry.title = input.title;
            summary.title = input.title;
          }
          if (typeof input.favorite === "boolean") {
            entry.favorite = input.favorite;
            summary.favorite = input.favorite;
          }
          if (input.password) entry.password = input.password;
          if (input.sap !== undefined) {
            entry.sap = input.sap;
            summary.hasSapLogin = Boolean(input.sap?.systemId || input.sap?.guiparm);
          }
          entry.updatedAt = "2026-09-16T10:00:00+08:00";
          return structuredClone(entry);
        }
        if (command.startsWith("copy_")) return "已复制";

        if (command === "pick_files") return [];
        if (command === "pick_folder" || command === "pick_save_file") return "";
        if (command === "open_in_explorer" || command === "open_path") return null;
        if (command in responses) return structuredClone(responses[command]);
        return null;
      },
    },
    event: { listen: async (event, handler) => listen(event, handler) },
  };

  window.__FIXTURES__ = {
    entry,
    vaultView,
    settings,
    paths,
    landscape,
    guiStatus,
    jsonFile,
    envFile,
    jsonPlan,
    envPlan,
    emit,
  };
})();
